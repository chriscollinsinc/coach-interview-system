'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { waitForDb } = require('./wait-for-db');

(async () => {
  await waitForDb();
  await db.query(`create table if not exists schema_migrations (
    filename text primary key, applied_at timestamptz not null default now())`);
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const done = await db.one('select 1 from schema_migrations where filename = $1', [f]);
    if (done) { console.log(`  = ${f} (already applied)`); continue; }
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await db.tx(async (c) => {
      await c.query(sql);
      await c.query('insert into schema_migrations (filename) values ($1)', [f]);
    });
    console.log(`  + ${f}`);
  }
  console.log('migrations complete');
  await db.pool.end();
})().catch((e) => { console.error('migration failed:', e.message); process.exit(1); });
