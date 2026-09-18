'use strict';
const bcrypt = require('bcryptjs');
const db = require('./db');

async function verifyLogin(email, password) {
  const user = await db.one(
    'select * from users where lower(email) = lower($1) and active = true',
    [String(email || '').trim()]
  );
  if (!user) return null;
  const ok = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!ok) return null;
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'not_authenticated' });
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'forbidden', need: roles });
    }
    next();
  };
}

async function audit(req, action, entity, entityId, detail) {
  try {
    await db.query(
      'insert into audit_log (user_id, action, entity, entity_id, detail) values ($1,$2,$3,$4,$5)',
      [req.session?.user?.id || null, action, entity || null, entityId || null,
       detail ? JSON.stringify(detail) : null]
    );
  } catch (e) {
    console.error('[audit] failed:', e.message);
  }
}

module.exports = { verifyLogin, requireAuth, requireRole, audit, hash: (p) => bcrypt.hash(p, 12) };
