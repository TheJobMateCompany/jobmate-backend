/**
 * discoveryGrpc.js — gRPC client for discovery-service
 *
 * Environment variables:
 *   DISCOVERY_GRPC_ADDR — host:port (default: discovery-service:9083)
 */

import { fileURLToPath } from 'url';
import path from 'path';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROTO_PATH = path.resolve(__dirname, '../../../../proto/discovery.proto');

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.resolve(__dirname, '../../../../proto')],
});

const grpcObj = grpc.loadPackageDefinition(packageDef);
const DiscoveryService = grpcObj.discovery.DiscoveryService;

const addr = process.env.DISCOVERY_GRPC_ADDR || 'discovery-service:9083';

const client = new DiscoveryService(addr, grpc.credentials.createInsecure());

// ─── Helpers ─────────────────────────────────────────────────────────────────

function userMeta(userId) {
  const meta = new grpc.Metadata();
  meta.set('x-user-id', userId);
  return meta;
}

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
 * Add a job by scraping a URL.
 * @param {string} userId
 * @param {string|null} searchConfigId
 * @param {string} url
 * @returns {Promise<{ jobFeedId: string, message: string }>}
 */
export async function addJobByUrl(userId, searchConfigId, url) {
  return call('addJobByUrl', { searchConfigId: searchConfigId ?? '', url }, userMeta(userId));
}

/**
 * Add a job manually via form input.
 * @param {string} userId
 * @param {object} input — { searchConfigId, companyName, companyDescription, location, profileWanted, startDate, duration, whyUs }
 * @returns {Promise<{ jobFeedId: string, message: string }>}
 */
export async function addJobManually(userId, input) {
  return call('addJobManually', {
    searchConfigId:     input.searchConfigId     ?? '',
    companyName:        input.companyName        ?? '',
    companyDescription: input.companyDescription ?? '',
    location:           input.location           ?? '',
    profileWanted:      input.profileWanted      ?? '',
    startDate:          input.startDate          ?? '',
    duration:           input.duration           ?? '',
    whyUs:              input.whyUs              ?? '',
  }, userMeta(userId));
}

/**
 * Trigger an on-demand scrape for the user's search configs.
 * @param {string} userId
 * @returns {Promise<{ message: string }>}
 */
export async function triggerScan(userId) {
  return call('triggerScan', { userId }, userMeta(userId));
}
