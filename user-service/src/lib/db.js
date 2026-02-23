/**
 * PostgreSQL connection pool — User Service
 */

import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('[db] FATAL: DATABASE_URL is not set. Exiting.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

pool.connect()
  .then((client) => { console.log('[db] PostgreSQL connected.'); client.release(); })
  .catch((err) => { console.error('[db] FATAL:', err.message); process.exit(1); });

export const query = (text, params) => pool.query(text, params);
export default pool;
