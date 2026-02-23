/**
 * jobmate-user-service
 *
 * Exposes two servers on the internal Docker network:
 *
 *   HTTP (Express) on port 4001:
 *     GET  /health         — Traefik health check
 *     GET  /profile/:userId
 *     PUT  /profile/:userId
 *
 *   gRPC on port 9081 (UserService — see proto/user.proto):
 *     GetSearchConfigs  DeleteSearchConfig
 *     CreateSearchConfig  UpdateSearchConfig
 *     UploadCV
 *
 * Neither server is exposed to the internet — Traefik routes only to the Gateway.
 */

import express from 'express';
import profileRouter      from './routes/profile.js';
import { createGrpcServer } from './grpc/server.js';

const app  = express();
const PORT      = process.env.PORT      || 4001;
const GRPC_PORT = process.env.USER_GRPC_PORT || 9081;

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
// Profile HTTP routes (GET/PUT) kept on Express for direct DB access.
app.use('/profile', profileRouter);
// SearchConfig and CV upload are now served exclusively over gRPC (see src/grpc/server.js).

// ── 404 ────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

// ── Global error handler ───────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[user-service] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ── Start HTTP ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[user-service] HTTP listening on port ${PORT}`);
});

// ── Start gRPC ─────────────────────────────────────────────────
createGrpcServer(GRPC_PORT);
