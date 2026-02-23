/**
 * Redis clients — Publisher + Subscriber
 *
 * Redis requires two separate client instances for Pub/Sub:
 *  - `publisher`  : used by resolvers to emit commands (CMD_ANALYZE_JOB, etc.)
 *  - `subscriber` : long-lived connection listening for events (EVENT_ANALYSIS_DONE, etc.)
 *
 * Channels:
 *   CMD_ANALYZE_JOB   → payload: { applicationId, userId }
 *   EVENT_ANALYSIS_DONE → payload: { applicationId, userId }
 */

import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';

// ── Publisher ─────────────────────────────────────────────────
export const publisher = createClient({ url: REDIS_URL });

publisher.on('error', (err) => console.error('[redis:publisher] Error:', err.message));

await publisher.connect();
console.log('[redis:publisher] Connected.');

// ── Subscriber ────────────────────────────────────────────────
export const subscriber = createClient({ url: REDIS_URL });

subscriber.on('error', (err) => console.error('[redis:subscriber] Error:', err.message));

await subscriber.connect();
console.log('[redis:subscriber] Connected.');

/**
 * Publish a command to a Redis channel.
 * @param {string} channel - e.g. 'CMD_ANALYZE_JOB'
 * @param {object} payload - will be JSON-serialized
 */
export const publish = (channel, payload) =>
  publisher.publish(channel, JSON.stringify(payload));
