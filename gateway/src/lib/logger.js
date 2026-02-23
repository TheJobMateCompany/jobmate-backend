/**
 * Structured JSON logger — powered by pino.
 *
 * Outputs newline-delimited JSON in all environments so logs can be
 * parsed by log aggregators (Loki, CloudWatch, Datadog, etc.).
 *
 * Usage:
 *   import { logger } from './lib/logger.js';
 *   logger.info({ event: 'user_registered', userId }, 'New user registered');
 *   logger.error({ err }, 'Unexpected error');
 */

import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Always output JSON — no pino-pretty in any environment.
  // During local dev, pipe to: node src/index.js | npx pino-pretty
  base: {
    service: 'gateway',
    version: process.env.npm_package_version || '0.1.0',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});
