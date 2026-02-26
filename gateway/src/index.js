/**
 * jobmate-gateway — Main entry point
 *
 * Stack:
 *  - Express (HTTP server + middleware)
 *  - Apollo Server v4 (GraphQL at POST /graphql)
 *  - SSE (GET /events) — authenticated via ?token=<jwt>
 *  - Redis subscriber — pushes AI events to SSE clients
 */

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import rateLimit from 'express-rate-limit';
import graphqlUploadExpress from 'graphql-upload/graphqlUploadExpress.mjs';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import jwt from 'jsonwebtoken';

import { typeDefs } from './schema/typeDefs.js';
import { resolvers } from './schema/resolvers.js';
import { buildContext } from './middleware/auth.js';
import { sseManager } from './sse/manager.js';
import { subscriber } from './lib/redis.js';
import { query } from './lib/db.js';
import { logger } from './lib/logger.js';

// ─────────────────────────────────────────────────────────────
// Expo Push Notification helper (no API key required)
// ─────────────────────────────────────────────────────────────
async function sendExpoPush(token, title, body, data = {}) {
  try {
    if (!token || !token.startsWith('ExponentPushToken[')) return;
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to: token, title, body, data, sound: 'default' }),
    });
  } catch (err) {
    console.error('[expo-push] Failed to send push notification:', err.message);
  }
}

async function getPushToken(userId) {
  try {
    const { rows } = await query(
      'SELECT expo_push_token FROM users WHERE id = $1',
      [userId]
    );
    return rows[0]?.expo_push_token ?? null;
  } catch {
    return null;
  }
}

const PORT = process.env.PORT || 4000;

// ─────────────────────────────────────────────────────────────
// Rate limiting
// ─────────────────────────────────────────────────────────────
const graphqlLimiter = rateLimit({
  windowMs: 60 * 1000,          // 1 minute window
  max: 120,                     // 120 requests per window per IP
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { errors: [{ message: 'Too many requests — please slow down.' }] },
  skip: (req) => {
    // Skip rate-limiting for introspection queries (used by Apollo Sandbox / tooling)
    const body = req.body;
    return typeof body?.query === 'string' && body.query.trim().startsWith('query IntrospectionQuery');
  },
});

// ─────────────────────────────────────────────────────────────
// Apollo Server
// ─────────────────────────────────────────────────────────────
const apollo = new ApolloServer({
  typeDefs,
  resolvers,
  formatError: (formattedError, error) => {
    console.error('[graphql] Error:', formattedError.message);
    return formattedError;
  },
});

await apollo.start();
logger.info('Apollo Server started.');

// ─────────────────────────────────────────────────────────────
// Express App
// ─────────────────────────────────────────────────────────────
const app = express();

// Trust the first proxy (Traefik) so express-rate-limit reads X-Forwarded-For correctly.
app.set('trust proxy', 1);

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Health check (public) ──────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'gateway', version: '1.0.0' });
});

// ── GraphQL endpoint ─────────────────────────────
app.use(
  '/graphql',
  graphqlLimiter,
  // Must come before bodyParser — intercepts multipart/form-data for file uploads
  // and converts them to standard GraphQL operations (graphql-multipart-request-spec)
  graphqlUploadExpress({ maxFileSize: 10 * 1024 * 1024, maxFiles: 1 }),
  bodyParser.json(),
  expressMiddleware(apollo, {
    context: buildContext,
  })
);

// ── SSE endpoint ───────────────────────────────────────────
// Browser EventSource cannot send custom headers, so the JWT is
// accepted as a query parameter: GET /events?token=<jwt>
app.get('/events', (req, res) => {
  const token = req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'Missing token query parameter.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }

  const userId = decoded.userId;

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx/Traefik buffering
  res.flushHeaders();

  // Register connection
  sseManager.add(userId, res);

  // Keepalive ping every 25s to prevent proxy timeouts
  const keepalive = setInterval(() => {
    res.write(': ping\n\n');
  }, 25_000);

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(keepalive);
    sseManager.remove(userId);
  });
});

// ─────────────────────────────────────────────────────────────
// Redis — Subscribe to internal events from other services
// ─────────────────────────────────────────────────────────────

/**
 * EVENT_JOB_DISCOVERED — published by Discovery Service whenever a new job
 * lands in the user's inbox (PENDING). Triggers an inbox badge refresh on
 * the frontend without requiring a page reload.
 * Payload: { jobFeedId, userId, searchConfigId }
 */
await subscriber.subscribe('EVENT_JOB_DISCOVERED', async (raw) => {
  try {
    const payload = JSON.parse(raw);
    console.log(
      `[redis] EVENT_JOB_DISCOVERED — user ${payload.userId}, job ${payload.jobFeedId}`
    );
    sseManager.send(payload.userId, {
      type: 'JOB_DISCOVERED',
      jobFeedId: payload.jobFeedId,
      searchConfigId: payload.searchConfigId ?? null,
    });
    const pushToken = await getPushToken(payload.userId);
    await sendExpoPush(pushToken, 'Nouvelle offre 🔔', 'Une offre correspond à votre profil', {
      type: 'JOB_DISCOVERED',
      jobFeedId: payload.jobFeedId,
    });
  } catch (err) {
    console.error('[redis] Failed to parse EVENT_JOB_DISCOVERED:', err.message);
  }
});

/**
 * EVENT_CV_PARSED — published by AI Coach after enriching a profile from a CV.
 * Payload: { type, userId, fieldsUpdated } or { type, userId, error }
 */
await subscriber.subscribe('EVENT_CV_PARSED', async (raw) => {
  try {
    const payload = JSON.parse(raw);
    console.log(`[redis] EVENT_CV_PARSED — user ${payload.userId}`);
    sseManager.send(payload.userId, {
      type: 'CV_PARSED',
      fieldsUpdated: payload.fieldsUpdated ?? null,
      error: payload.error ?? null,
    });
    const pushToken = await getPushToken(payload.userId);
    await sendExpoPush(pushToken, 'CV analysé 📄', 'Votre profil a été mis à jour', {
      type: 'CV_PARSED',
    });
  } catch (err) {
    console.error('[redis] Failed to parse EVENT_CV_PARSED:', err.message);
  }
});

/**
 * EVENT_ANALYSIS_DONE — published by AI Coach after processing an application.
 * Payload: { type, applicationId, userId, matchScore, hasCoverLetter, analyzedAt }
 */
await subscriber.subscribe('EVENT_ANALYSIS_DONE', async (raw) => {
  try {
    const payload = JSON.parse(raw);
    console.log(
      `[redis] EVENT_ANALYSIS_DONE — user ${payload.userId}, application ${payload.applicationId}, score ${payload.matchScore}`
    );
    sseManager.send(payload.userId, {
      type: 'ANALYSIS_DONE',
      applicationId: payload.applicationId,
      matchScore: payload.matchScore ?? null,
      hasCoverLetter: payload.hasCoverLetter ?? false,
      analyzedAt: payload.analyzedAt ?? null,
    });
    const pushToken = await getPushToken(payload.userId);
    await sendExpoPush(
      pushToken,
      'Analyse IA terminée ✅',
      `Score : ${payload.matchScore ?? '–'}/100`,
      { type: 'ANALYSIS_DONE', applicationId: payload.applicationId }
    );
  } catch (err) {
    console.error('[redis] Failed to parse EVENT_ANALYSIS_DONE:', err.message);
  }
});

/**
 * EVENT_CARD_MOVED — published by Tracker Service after a Kanban card transition.
 * Payload: { type, applicationId, userId, from, to }
 */
await subscriber.subscribe('EVENT_CARD_MOVED', async (raw) => {
  try {
    const payload = JSON.parse(raw);
    console.log(
      `[redis] EVENT_CARD_MOVED — user ${payload.userId}, application ${payload.applicationId}, ${payload.from} → ${payload.to}`
    );
    sseManager.send(payload.userId, {
      type: 'CARD_MOVED',
      applicationId: payload.applicationId,
      from: payload.from,
      to: payload.to,
    });
    const pushToken = await getPushToken(payload.userId);
    await sendExpoPush(
      pushToken,
      'Candidature mise à jour 📋',
      `Statut : ${payload.to}`,
      { type: 'CARD_MOVED', applicationId: payload.applicationId }
    );
  } catch (err) {
    console.error('[redis] Failed to parse EVENT_CARD_MOVED:', err.message);
  }
});

console.log('[redis] Subscribed to: EVENT_JOB_DISCOVERED, EVENT_CV_PARSED, EVENT_ANALYSIS_DONE, EVENT_CARD_MOVED');

// ─────────────────────────────────────────────────────────────
// Start HTTP Server
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info({ port: PORT }, `Gateway v1.0.0 listening`);
  logger.info(`GraphQL: http://localhost:${PORT}/graphql`);
  logger.info(`SSE:     http://localhost:${PORT}/events?token=<jwt>`);
  logger.info(`Health:  http://localhost:${PORT}/health`);
});
