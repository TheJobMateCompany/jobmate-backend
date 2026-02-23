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
import { logger } from './lib/logger.js';

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
 * EVENT_ANALYSIS_DONE — published by AI Coach after processing an application.
 * Payload: { type, applicationId, userId, matchScore, hasCoverLetter, analyzedAt }
 */
await subscriber.subscribe('EVENT_ANALYSIS_DONE', (raw) => {
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
  } catch (err) {
    console.error('[redis] Failed to parse EVENT_ANALYSIS_DONE:', err.message);
  }
});

/**
 * EVENT_CARD_MOVED — published by Tracker Service after a Kanban card transition.
 * Payload: { type, applicationId, userId, from, to }
 */
await subscriber.subscribe('EVENT_CARD_MOVED', (raw) => {
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
  } catch (err) {
    console.error('[redis] Failed to parse EVENT_CARD_MOVED:', err.message);
  }
});

console.log('[redis] Subscribed to: EVENT_ANALYSIS_DONE, EVENT_CARD_MOVED');

// ─────────────────────────────────────────────────────────────
// Start HTTP Server
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info({ port: PORT }, `Gateway v1.0.0 listening`);
  logger.info(`GraphQL: http://localhost:${PORT}/graphql`);
  logger.info(`SSE:     http://localhost:${PORT}/events?token=<jwt>`);
  logger.info(`Health:  http://localhost:${PORT}/health`);
});
