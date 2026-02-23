/**
 * user-service gRPC server
 *
 * Implements UserService from proto/user.proto.
 * Delegates all storage operations to PostgreSQL via the shared db helper.
 * Authentication: trusts the x-user-id gRPC metadata forwarded by the Gateway
 * (same pattern as tracker-service gRPC server).
 *
 * Error mapping:
 *   NOT_FOUND       → grpc.status.NOT_FOUND
 *   Validation      → grpc.status.INVALID_ARGUMENT
 *   else            → grpc.status.INTERNAL
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { query } from '../lib/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Proto loading ────────────────────────────────────────────────────────────

const PROTO_PATH = path.resolve(__dirname, '../../../../proto/user.proto');

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.resolve(__dirname, '../../../../proto')],
});

const grpcObj  = grpc.loadPackageDefinition(packageDef);
const { UserService } = grpcObj.user;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract x-user-id from gRPC metadata. Returns null if missing.
 */
function getUserId(call) {
  const meta = call.metadata.get('x-user-id');
  return meta.length > 0 ? meta[0] : null;
}

/**
 * Terminate a call with NOT_FOUND.
 */
function notFound(callback, msg = 'Not found.') {
  callback({ code: grpc.status.NOT_FOUND, message: msg });
}

/**
 * Terminate a call with INVALID_ARGUMENT.
 */
function invalidArg(callback, msg) {
  callback({ code: grpc.status.INVALID_ARGUMENT, message: msg });
}

/**
 * Terminate a call with UNAUTHENTICATED.
 */
function unauthenticated(callback) {
  callback({ code: grpc.status.UNAUTHENTICATED, message: 'Missing x-user-id metadata.' });
}

/**
 * Convert a PostgreSQL search_config row to a SearchConfigProto-compatible object.
 */
function rowToProto(r) {
  return {
    id:           r.id,
    jobTitles:    r.job_titles    ?? [],
    locations:    r.locations     ?? [],
    remotePolicy: r.remote_policy ?? 'HYBRID',
    keywords:     r.keywords      ?? [],
    redFlags:     r.red_flags     ?? [],
    salaryMin:    r.salary_min    ?? 0,
    salaryMax:    r.salary_max    ?? 0,
    isActive:     r.is_active     ?? true,
    createdAt:    r.created_at ? { seconds: Math.floor(new Date(r.created_at).getTime() / 1000), nanos: 0 } : null,
    updatedAt:    r.updated_at ? { seconds: Math.floor(new Date(r.updated_at).getTime() / 1000), nanos: 0 } : null,
  };
}

// ─── Upload directory setup ───────────────────────────────────────────────────

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── RPC handlers ─────────────────────────────────────────────────────────────

async function getSearchConfigs(call, callback) {
  const userId = getUserId(call);
  if (!userId) return unauthenticated(callback);

  try {
    const { rows } = await query(
      `SELECT id, job_titles, locations, remote_policy, keywords, red_flags,
              salary_min, salary_max, is_active, created_at, updated_at
       FROM search_configs
       WHERE user_id = $1 AND is_active = true
       ORDER BY created_at DESC`,
      [userId]
    );
    callback(null, { configs: rows.map(rowToProto) });
  } catch (err) {
    console.error('[gRPC] getSearchConfigs error:', err.message);
    callback({ code: grpc.status.INTERNAL, message: 'Internal server error.' });
  }
}

async function createSearchConfig(call, callback) {
  const userId = getUserId(call);
  if (!userId) return unauthenticated(callback);

  const { jobTitles, locations, remotePolicy, keywords, redFlags, salaryMin, salaryMax } = call.request;

  if (!jobTitles || jobTitles.length === 0) {
    return invalidArg(callback, 'jobTitles[] is required.');
  }
  if (!locations || locations.length === 0) {
    return invalidArg(callback, 'locations[] is required.');
  }

  try {
    const { rows } = await query(
      `INSERT INTO search_configs
         (user_id, job_titles, locations, remote_policy, keywords, red_flags, salary_min, salary_max)
       VALUES
         ($1, $2, $3, $4::remote_policy, $5, $6, $7, $8)
       RETURNING id, job_titles, locations, remote_policy, keywords, red_flags,
                 salary_min, salary_max, is_active, created_at, updated_at`,
      [
        userId,
        jobTitles,
        locations,
        remotePolicy || 'HYBRID',
        keywords  ?? [],
        redFlags  ?? [],
        salaryMin || null,
        salaryMax || null,
      ]
    );
    callback(null, rowToProto(rows[0]));
  } catch (err) {
    console.error('[gRPC] createSearchConfig error:', err.message);
    callback({ code: grpc.status.INTERNAL, message: 'Internal server error.' });
  }
}

async function updateSearchConfig(call, callback) {
  const userId = getUserId(call);
  if (!userId) return unauthenticated(callback);

  const { id, jobTitles, locations, remotePolicy, keywords, redFlags, salaryMin, salaryMax } = call.request;

  if (!id) return invalidArg(callback, 'id is required.');

  try {
    const { rows } = await query(
      `UPDATE search_configs SET
         job_titles    = COALESCE(NULLIF($1::text[], '{}'), job_titles),
         locations     = COALESCE(NULLIF($2::text[], '{}'), locations),
         remote_policy = COALESCE(NULLIF($3, '')::remote_policy, remote_policy),
         keywords      = COALESCE(NULLIF($4::text[], '{}'), keywords),
         red_flags     = COALESCE(NULLIF($5::text[], '{}'), red_flags),
         salary_min    = COALESCE(NULLIF($6, 0), salary_min),
         salary_max    = COALESCE(NULLIF($7, 0), salary_max),
         updated_at    = NOW()
       WHERE id = $8 AND user_id = $9
       RETURNING id, job_titles, locations, remote_policy, keywords, red_flags,
                 salary_min, salary_max, is_active, created_at, updated_at`,
      [
        jobTitles  ?? [],
        locations  ?? [],
        remotePolicy ?? '',
        keywords   ?? [],
        redFlags   ?? [],
        salaryMin  ?? 0,
        salaryMax  ?? 0,
        id,
        userId,
      ]
    );

    if (rows.length === 0) return notFound(callback, 'SearchConfig not found or not yours.');
    callback(null, rowToProto(rows[0]));
  } catch (err) {
    console.error('[gRPC] updateSearchConfig error:', err.message);
    callback({ code: grpc.status.INTERNAL, message: 'Internal server error.' });
  }
}

async function deleteSearchConfig(call, callback) {
  const userId = getUserId(call);
  if (!userId) return unauthenticated(callback);

  const { id } = call.request;
  if (!id) return invalidArg(callback, 'id is required.');

  try {
    const { rowCount } = await query(
      `UPDATE search_configs SET is_active = false, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (rowCount === 0) return notFound(callback, 'SearchConfig not found or not yours.');
    callback(null, { success: true });
  } catch (err) {
    console.error('[gRPC] deleteSearchConfig error:', err.message);
    callback({ code: grpc.status.INTERNAL, message: 'Internal server error.' });
  }
}

async function uploadCV(call, callback) {
  const userId = getUserId(call);
  if (!userId) return unauthenticated(callback);

  const { fileBytes, fileName, mimeType } = call.request;

  if (!fileBytes || fileBytes.length === 0) {
    return invalidArg(callback, 'file_bytes is required.');
  }
  if (mimeType !== 'application/pdf') {
    return invalidArg(callback, 'Only PDF files are accepted (mime_type must be application/pdf).');
  }
  if (fileBytes.length > 10 * 1024 * 1024) {
    return invalidArg(callback, 'File size exceeds 10 MB limit.');
  }

  try {
    const ext      = path.extname(fileName || 'resume.pdf') || '.pdf';
    const unique   = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const filename = `${unique}${ext}`;
    const filePath = path.join(UPLOAD_DIR, filename);

    fs.writeFileSync(filePath, fileBytes);

    const relativePath = `/uploads/${filename}`;

    await query(
      `UPDATE profiles SET cv_url = $1, updated_at = NOW() WHERE user_id = $2`,
      [relativePath, userId]
    );

    callback(null, {
      cvUrl:   relativePath,
      message: 'CV uploaded successfully. AI enrichment pending.',
    });
  } catch (err) {
    console.error('[gRPC] uploadCV error:', err.message);
    callback({ code: grpc.status.INTERNAL, message: 'Internal server error.' });
  }
}

// ─── Server factory ───────────────────────────────────────────────────────────

/**
 * Create and start a gRPC server on the given port.
 * @param {string|number} port
 * @returns {grpc.Server}
 */
export function createGrpcServer(port) {
  const server = new grpc.Server();

  server.addService(UserService.service, {
    getSearchConfigs,
    createSearchConfig,
    updateSearchConfig,
    deleteSearchConfig,
    uploadCV,
  });

  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        console.error(`[gRPC] Failed to bind on port ${port}:`, err.message);
        process.exit(1);
      }
      console.log(`[user-service] gRPC server listening on port ${boundPort}`);
    }
  );

  return server;
}
