'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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

// index.html carries one tiny inline script: it applies the saved theme before
// first paint so light-mode users don't get a flash of dark. Rather than
// loosening CSP with 'unsafe-inline', hash whatever is actually in the file at
// boot -- edit the script and the hash follows automatically.
function inlineScriptHashes() {
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const hashes = [];
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const body = m[1];
      if (!body.trim()) continue;
      hashes.push("'sha256-" + crypto.createHash('sha256').update(body, 'utf8').digest('base64') + "'");
    }
    return hashes;
  } catch (e) {
    console.error('[csp] could not hash inline scripts:', e.message);
    return [];
  }
}
const INLINE_HASHES = inlineScriptHashes();
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // No CDNs anywhere: the app has to work on dealership wifi and offline.
      scriptSrc: ["'self'", ...INLINE_HASHES],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      // Self-hosted only. A webfont fetched from a CDN would fail on
      // dealership wifi, which is exactly when the app has to work.
      fontSrc: ["'self'"],
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

// SPA fallback. Two things it must NOT swallow: an unmatched API route, and a
// missing static file. Returning index.html for a mistyped /icons/x.png would
// be a 200 full of HTML, which renders as a broken image and hides the typo.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  if (/\.[a-z0-9]{2,5}$/i.test(req.path)) {
    return res.status(404).type('text/plain').send('Not found');
  }
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
