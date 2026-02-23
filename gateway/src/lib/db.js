/**
 * PostgreSQL connection pool
 * Shared across the gateway for all DB operations.
 * Uses pg Pool — safe for concurrent queries, auto-reconnects.
 */

import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('[db] FATAL: DATABASE_URL is not set. Exiting.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,                // Max concurrent connections
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

// Verify connectivity on startup
pool.connect()
  .then((client) => {
    console.log('[db] PostgreSQL connected.');
    client.release();
  })
  .catch((err) => {
    console.error('[db] FATAL: Cannot connect to PostgreSQL:', err.message);
    process.exit(1);
  });

/**
 * Execute a parameterized query.
 * @param {string} text  - SQL statement
 * @param {any[]}  params - Query parameters ($1, $2, ...)
 */
export const query = (text, params) => pool.query(text, params);

export default pool;
