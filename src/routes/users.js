'use strict';
// User management. Two entry points: an unauthenticated bootstrap that only
// works while the database has zero users (so the very first admin can be
// created from a browser instead of a Render shell), and admin CRUD after that.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, audit, hash } = require('../auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ROLES = ['consultant', 'lead', 'admin'];
const MIN_PW = 10;

function badPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PW) return `Password must be at least ${MIN_PW} characters.`;
  if (/^\d+$/.test(pw)) return 'Password cannot be all digits.';
  const common = ['password', 'changeme', '1234567890', 'qwertyuiop', 'letmein123'];
  if (common.some((c) => pw.toLowerCase().includes(c))) return 'Password is too predictable.';
  return null;
}

async function activeAdminCount(exceptId) {
  const r = await db.one(
    `select count(*)::int as n from users
      where role = 'admin' and active = true and ($1::uuid is null or id <> $1)`, [exceptId || null]);
  return r.n;
}

// ---- first-run bootstrap (no auth, only while there are no users) ----

router.get('/setup/status', wrap(async (req, res) => {
  const r = await db.one('select count(*)::int as n from users');
  res.json({ needs_setup: r.n === 0, user_count: r.n });
}));

router.post('/setup/bootstrap', wrap(async (req, res) => {
  const existing = await db.one('select count(*)::int as n from users');
  if (existing.n > 0) {
    // Not an error worth explaining in detail — just never allow a second one.
    return res.status(409).json({ error: 'already_initialised' });
  }
  const { email, name, password } = req.body || {};
  if (!email || !name) return res.status(400).json({ error: 'email_and_name_required' });
  const pwErr = badPassword(password);
  if (pwErr) return res.status(400).json({ error: 'weak_password', message: pwErr });

  const user = await db.one(
    `insert into users (email, name, password_hash, role) values ($1,$2,$3,'admin')
     returning id, email, name, role, active`,
    [String(email).trim(), String(name).trim(), await hash(password)]);

  req.session.user = { id: user.id, email: user.email, name: user.name, role: user.role };
  await audit(req, 'setup.bootstrap', 'user', user.id, { email: user.email });
  res.status(201).json({ user });
}));

// ---- everything below requires an admin ----
// NOTE: no router-level `use(requireAuth)` here. This router is mounted first
// on /api, so router-level middleware would run for EVERY /api request --
// including /auth/login, which lives in the core router. Guards go per route.

router.get('/users', requireRole('admin'), wrap(async (req, res) => {
  res.json(await db.many(
    `select u.id, u.email, u.name, u.role, u.active, u.created_at,
            (select count(*)::int from interviews i where i.interviewer_id = u.id) as interview_count,
            (select max(i.completed_at) from interviews i where i.interviewer_id = u.id) as last_interview_at
       from users u order by u.active desc, u.name`));
}));

router.post('/users', requireRole('admin'), wrap(async (req, res) => {
  const { email, name, password, role } = req.body || {};
  if (!email || !name) return res.status(400).json({ error: 'email_and_name_required' });
  if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'bad_role', allowed: ROLES });
  const pwErr = badPassword(password);
  if (pwErr) return res.status(400).json({ error: 'weak_password', message: pwErr });

  const dupe = await db.one('select id from users where lower(email) = lower($1)', [String(email).trim()]);
  if (dupe) return res.status(409).json({ error: 'email_taken' });

  const row = await db.one(
    `insert into users (email, name, password_hash, role) values ($1,$2,$3,$4)
     returning id, email, name, role, active, created_at`,
    [String(email).trim(), String(name).trim(), await hash(password), role || 'consultant']);
  await audit(req, 'user.create', 'user', row.id, { email: row.email, role: row.role });
  res.status(201).json(row);
}));

router.patch('/users/:id', requireRole('admin'), wrap(async (req, res) => {
  const target = await db.one('select * from users where id = $1', [req.params.id]);
  if (!target) return res.status(404).json({ error: 'not_found' });

  const { name, role, active } = req.body || {};
  if (role !== undefined && !ROLES.includes(role)) {
    return res.status(400).json({ error: 'bad_role', allowed: ROLES });
  }

  // Never let the last active admin be demoted or switched off — that locks
  // everyone out of user management with no way back in from the browser.
  const losingAdmin = (target.role === 'admin' && target.active) &&
    ((role !== undefined && role !== 'admin') || active === false);
  if (losingAdmin && (await activeAdminCount(target.id)) === 0) {
    return res.status(409).json({ error: 'last_admin',
      message: 'This is the only active admin. Promote someone else first.' });
  }
  if (active === false && target.id === req.session.user.id) {
    return res.status(409).json({ error: 'cannot_deactivate_self' });
  }

  const sets = [], vals = [];
  if (name !== undefined)   { vals.push(String(name).trim()); sets.push(`name = $${vals.length}`); }
  if (role !== undefined)   { vals.push(role);   sets.push(`role = $${vals.length}`); }
  if (active !== undefined) { vals.push(!!active); sets.push(`active = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
  vals.push(req.params.id);

  const row = await db.one(
    `update users set ${sets.join(',')} where id = $${vals.length}
     returning id, email, name, role, active, created_at`, vals);

  // Keep this session honest if the admin changed their own role.
  if (row.id === req.session.user.id) {
    req.session.user = { id: row.id, email: row.email, name: row.name, role: row.role };
  }
  await audit(req, 'user.update', 'user', row.id, { name, role, active });
  res.json(row);
}));

router.post('/users/:id/password', requireRole('admin'), wrap(async (req, res) => {
  const pwErr = badPassword(req.body?.password);
  if (pwErr) return res.status(400).json({ error: 'weak_password', message: pwErr });
  const row = await db.one(
    `update users set password_hash = $1 where id = $2 returning id, email, name`,
    [await hash(req.body.password), req.params.id]);
  if (!row) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'user.password_reset', 'user', row.id);
  res.json({ ok: true, user: row });
}));

// Anyone can change their own password, with their current one.
router.post('/me/password', requireAuth, wrap(async (req, res) => {
  const { current_password, password } = req.body || {};
  const pwErr = badPassword(password);
  if (pwErr) return res.status(400).json({ error: 'weak_password', message: pwErr });
  const { verifyLogin } = require('../auth');
  const ok = await verifyLogin(req.session.user.email, current_password);
  if (!ok) return res.status(401).json({ error: 'current_password_incorrect' });
  await db.query('update users set password_hash = $1 where id = $2',
    [await hash(password), req.session.user.id]);
  await audit(req, 'user.password_change_self', 'user', req.session.user.id);
  res.json({ ok: true });
}));

module.exports = router;
