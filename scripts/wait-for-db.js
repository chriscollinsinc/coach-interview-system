'use strict';
// Render provisions the web service and Postgres in parallel, so the first
// boot of a new blueprint regularly beats the database to readiness and gets
// ECONNREFUSED. Render also restarts Postgres for maintenance without notice.
// Neither should crash-loop the app, so wait rather than exit.
const { Client } = require('pg');

const TRANSIENT = new Set([
  'ECONNREFUSED',    // database not accepting connections yet
  'ENOTFOUND',       // internal DNS not published yet
  'EAI_AGAIN',       // transient DNS failure
  'ETIMEDOUT',
  'ECONNRESET',
  '57P03',           // cannot_connect_now: server still starting up
  '53300'            // too_many_connections, usually momentary
]);

async function waitForDb({ timeoutMs = 180000, log = console.log } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const isLocal = /localhost|127\.0\.0\.1/.test(url);
  const ssl = isLocal || process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false };

  const started = Date.now();
  let attempt = 0;

  for (;;) {
    attempt++;
    const client = new Client({ connectionString: url, ssl, connectionTimeoutMillis: 8000 });
    try {
      await client.connect();
      await client.query('select 1');
      await client.end();
      if (attempt > 1) log(`  database ready after ${attempt} attempts (${Math.round((Date.now() - started) / 1000)}s)`);
      return true;
    } catch (err) {
      await client.end().catch(() => {});
      const code = err.code || '';
      const elapsed = Date.now() - started;

      // A wrong password or missing database is not going to fix itself.
      if (!TRANSIENT.has(code)) {
        throw new Error(`database error that will not resolve by waiting (${code || 'no code'}): ${err.message}`);
      }
      if (elapsed > timeoutMs) {
        throw new Error(`database not reachable after ${Math.round(elapsed / 1000)}s (last error ${code})`);
      }
      // 1s, 2s, 4s… capped at 10s.
      const delay = Math.min(1000 * 2 ** (attempt - 1), 10000);
      if (attempt === 1 || attempt % 3 === 0) {
        log(`  waiting for database (${code}), retrying in ${delay / 1000}s…`);
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

module.exports = { waitForDb };
