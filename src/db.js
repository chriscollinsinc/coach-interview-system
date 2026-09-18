'use strict';
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Render's managed Postgres requires SSL from outside its network but presents
// a cert that fails default verification, hence rejectUnauthorized:false there.
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
const pool = new Pool({
  connectionString,
  ssl: isLocal || process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000
});

pool.on('error', (err) => console.error('[pg] idle client error', err.message));

async function query(text, params) { return pool.query(text, params); }

async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

async function many(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, one, many, tx };
