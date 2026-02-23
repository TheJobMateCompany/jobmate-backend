/**
 * jobmate-user-service
 *
 * Internal REST API consumed by the Gateway via Docker internal network.
 * Not exposed to the internet — Traefik only routes external traffic to the gateway.
 *
 * Routes:
 *   GET    /health
 *   GET    /profile/:userId
 *   PUT    /profile/:userId
 *   GET    /search-configs          (x-user-id header)
 *   POST   /search-configs          (x-user-id header)
 *   PUT    /search-configs/:id      (x-user-id header)
 *   DELETE /search-configs/:id      (x-user-id header)
 *   POST   /upload/cv/:userId       (x-user-id header, multipart/form-data)
 */

import express from 'express';
import profileRouter      from './routes/profile.js';
import searchConfigRouter from './routes/searchConfig.js';
import uploadRouter       from './routes/upload.js';

const app  = express();
const PORT = process.env.PORT || 4001;

// ── Middleware ─────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Serve uploaded CVs statically (dev only — use S3 in prod)
app.use('/uploads', express.static('./uploads'));

// ── Health ─────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'user-service', version: '1.0.0' });
});

// ── Routes ─────────────────────────────────────────────────────
app.use('/profile',        profileRouter);
app.use('/search-configs', searchConfigRouter);
app.use('/upload',         uploadRouter);

// ── 404 ────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

// ── Global error handler ───────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[user-service] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ── Start ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[user-service] Listening on port ${PORT}`);
});
