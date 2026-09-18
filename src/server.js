'use strict';
require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const db = require('./db');
const users = require('./routes/users');
const core = require('./routes/core');
const interviews = require('./routes/interviews');
const analysis = require('./routes/analysis');

const app = express();
const PROD = process.env.NODE_ENV === 'production';
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // No CDNs anywhere: the app has to work on dealership wifi and offline.
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: '2mb' }));
app.use(session({
  store: new PgSession({ pool: db.pool, tableName: 'session', createTableIfMissing: true }),
  name: 'cci.sid',
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: PROD,
    // Long session: an interviewer should not be logged out mid-visit.
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
}));

app.get('/healthz', async (req, res) => {
  try { await db.query('select 1'); res.json({ ok: true }); }
  catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

// users first: /api/setup/* must resolve before core's auth wall.
app.use('/api', users);
app.use('/api', core);
app.use('/api', interviews);
app.use('/api', analysis);

app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, p) => { if (p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); }
}));

// SPA fallback, but never swallow an unmatched API route.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, _next) => {
  console.error('[error]', req.method, req.path, err.message);
  if (err.code === '23505') return res.status(409).json({ error: 'duplicate', detail: err.detail });
  if (err.code === '23503') return res.status(400).json({ error: 'bad_reference', detail: err.detail });
  res.status(500).json({ error: 'server_error', message: PROD ? undefined : err.message });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`CCI Staff Interviews listening on :${PORT}`));
}
module.exports = app;
