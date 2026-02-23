/**
 * userGrpc.js — gRPC client for user-service
 *
 * Dynamic proto loading via @grpc/proto-loader (no JS codegen required).
 * Follows the exact same pattern as trackerGrpc.js.
 *
 * All RPCs forward the authenticated userId via gRPC metadata key "x-user-id".
 * The Gateway has already validated the JWT; the user-service trusts this header
 * on the internal Docker network.
 *
 * Environment variables:
 *   USER_GRPC_ADDR — host:port for the user-service gRPC server
 *                    (default: user-service:9081)
 */

import { fileURLToPath } from 'url';
import path from 'path';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROTO_PATH = path.resolve(__dirname, '../../../../proto/user.proto');

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,        // snake_case → camelCase
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.resolve(__dirname, '../../../../proto')],
});

const grpcObj = grpc.loadPackageDefinition(packageDef);
const UserService = grpcObj.user.UserService;

const addr = process.env.USER_GRPC_ADDR || 'user-service:9081';

const client = new UserService(addr, grpc.credentials.createInsecure());

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build gRPC metadata carrying the userId so the server can authorize the caller
 * without re-validating the JWT (the Gateway already did that).
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
 * List all active SearchConfigs for the given user.
 * @param {string} userId
 * @returns {Promise<object[]>} array of SearchConfigProto objects (camelCase)
 */
export async function getSearchConfigs(userId) {
  const res = await call('getSearchConfigs', {}, userMeta(userId));
  return res.configs ?? [];
}

/**
 * Create a new SearchConfig.
 * @param {string} userId
 * @param {object} input — { jobTitles, locations, remotePolicy, keywords, redFlags, salaryMin, salaryMax }
 * @returns {Promise<object>} created SearchConfigProto
 */
export async function createSearchConfig(userId, input) {
  return call('createSearchConfig', {
    jobTitles:    input.jobTitles    ?? [],
    locations:    input.locations    ?? [],
    remotePolicy: input.remotePolicy ?? 'HYBRID',
    keywords:     input.keywords     ?? [],
    redFlags:     input.redFlags     ?? [],
    salaryMin:    input.salaryMin    ?? 0,
    salaryMax:    input.salaryMax    ?? 0,
  }, userMeta(userId));
}

/**
 * Partially update a SearchConfig.
 * @param {string} userId
 * @param {string} id — SearchConfig UUID
 * @param {object} input — partial fields to update
 * @returns {Promise<object>} updated SearchConfigProto
 */
export async function updateSearchConfig(userId, id, input) {
  return call('updateSearchConfig', {
    id,
    jobTitles:    input.jobTitles    ?? [],
    locations:    input.locations    ?? [],
    remotePolicy: input.remotePolicy ?? '',
    keywords:     input.keywords     ?? [],
    redFlags:     input.redFlags     ?? [],
    salaryMin:    input.salaryMin    ?? 0,
    salaryMax:    input.salaryMax    ?? 0,
  }, userMeta(userId));
}

/**
 * Soft-delete (deactivate) a SearchConfig.
 * @param {string} userId
 * @param {string} id — SearchConfig UUID
 * @returns {Promise<{ success: boolean }>}
 */
export async function deleteSearchConfig(userId, id) {
  return call('deleteSearchConfig', { id }, userMeta(userId));
}

/**
 * Upload a CV file to the user-service.
 * @param {string} userId
 * @param {Buffer} fileBytes — raw file buffer
 * @param {string} fileName  — original filename (e.g. "resume.pdf")
 * @param {string} mimeType  — must be "application/pdf"
 * @returns {Promise<{ cvUrl: string, message: string }>}
 */
export async function uploadCV(userId, fileBytes, fileName, mimeType) {
  return call('uploadCV', { fileBytes, fileName, mimeType }, userMeta(userId));
}
