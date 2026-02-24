/**
 * trackerGrpc.js — gRPC client for tracker-service
 *
 * Uses @grpc/grpc-js with @grpc/proto-loader (dynamic loading — no JS
 * codegen required). The proto file is loaded at startup from the shared
 * proto/ directory at the monorepo root.
 *
 * The userId is forwarded via gRPC metadata key "x-user-id", mirroring
 * the previous HTTP x-user-id header approach.
 *
 * Environment variables:
 *   TRACKER_GRPC_ADDR — host:port for the tracker gRPC server
 *                       (default: tracker-service:9082)
 */

import { fileURLToPath } from 'url';
import path from 'path';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the shared proto file from the monorepo root.
// In Docker the working directory is /app (gateway), so we go up to find proto/.
const PROTO_PATH = path.resolve(__dirname, '../../../../proto/tracker.proto');

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,        // convert snake_case fields to camelCase
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.resolve(__dirname, '../../../../proto')],
});

const grpcObj = grpc.loadPackageDefinition(packageDef);
const TrackerService = grpcObj.tracker.TrackerService;

const addr = process.env.TRACKER_GRPC_ADDR || 'tracker-service:9082';

const client = new TrackerService(addr, grpc.credentials.createInsecure());

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build gRPC metadata carrying the userId so the server can identify the caller
 * without needing a JWT (the Gateway already validated it).
 */
function userMeta(userId) {
  const meta = new grpc.Metadata();
  meta.set('x-user-id', userId);
  return meta;
}

/**
 * Wrap a gRPC unary call in a Promise, mapping gRPC errors to JS Error objects.
 */
function call(method, request, meta) {
  return new Promise((resolve, reject) => {
    client[method](request, meta, (err, response) => {
      if (err) {
        const mapped = new Error(err.details || err.message);
        mapped.grpcCode = err.code;
        reject(mapped);
      } else {
        resolve(response);
      }
    });
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * List all applications for the given user, optionally filtered by status.
 * @param {string} userId
 * @param {string} [statusFilter] — optional ApplicationStatus enum value
 * @returns {Promise<object[]>} array of ApplicationProto objects (camelCase)
 */
export async function listApplications(userId, statusFilter = '') {
  const res = await call('listApplications', { statusFilter }, userMeta(userId));
  return res.applications ?? [];
}

/**
 * Create a new application for the given job feed entry.
 * The tracker-service handles idempotency and publishes CMD_ANALYZE_JOB.
 * @param {string} userId
 * @param {string} jobFeedId
 * @returns {Promise<object>} created ApplicationProto
 */
export async function createApplication(userId, jobFeedId) {
  return call('createApplication', { jobFeedId }, userMeta(userId));
}

/**
 * Move an application card to a new Kanban status.
 * @param {string} userId
 * @param {string} applicationId
 * @param {string} newStatus
 * @returns {Promise<object>} updated ApplicationProto
 */
export async function moveCard(userId, applicationId, newStatus) {
  return call('moveCard', { applicationId, newStatus }, userMeta(userId));
}

/**
 * Update the free-text note on an application.
 * @param {string} userId
 * @param {string} applicationId
 * @param {string} note
 * @returns {Promise<object>} updated ApplicationProto
 */
export async function addNote(userId, applicationId, note) {
  return call('addNote', { applicationId, note }, userMeta(userId));
}

/**
 * Set a numeric rating (1–5) on an application.
 * @param {string} userId
 * @param {string} applicationId
 * @param {number} rating
 * @returns {Promise<object>} updated ApplicationProto
 */
export async function rateApplication(userId, applicationId, rating) {
  return call('rateApplication', { applicationId, rating }, userMeta(userId));
}

/**
 * Set a follow-up reminder date/time on an application.
 * @param {string} userId
 * @param {string} applicationId
 * @param {string} remindAt — ISO 8601 timestamp string
 * @returns {Promise<object>} updated ApplicationProto
 */
export async function setRelanceReminder(userId, applicationId, remindAt) {
  return call('setRelanceReminder', { applicationId, remindAt }, userMeta(userId));
}
