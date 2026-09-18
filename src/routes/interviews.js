'use strict';
// Interview capture. Built around the fact that dealership wifi is bad: the
// iPad owns the draft, the server accepts idempotent upserts, and a sync that
// arrives twice (or out of order) cannot duplicate or clobber.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, audit } = require('../auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireAuth);

// Start (or recover) an interview. client_ref makes this safe to call twice.
router.post('/interviews', wrap(async (req, res) => {
  const { employee_id, client_ref } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id_required' });

  if (client_ref) {
    const existing = await db.one('select * from interviews where client_ref = $1', [client_ref]);
    if (existing) return res.json(existing);          // idempotent replay
  }

  const emp = await db.one(
    `select e.*, s.engagement_id from employees e join stores s on s.id = e.store_id where e.id = $1`,
    [employee_id]);
  if (!emp) return res.status(404).json({ error: 'employee_not_found' });
  if (!emp.template_key) {
    return res.status(400).json({ error: 'no_template_for_employee',
      detail: 'This person has no survey assigned. Management is interviewed separately today.' });
  }

  // Tapping Start twice, or a queued offline start arriving late, must not
  // create a second interview. An open draft for this person IS the interview.
  const openDraft = await db.one(
    `select * from interviews where employee_id = $1 and status = 'draft'
      order by started_at desc limit 1`, [employee_id]);
  // Already interviewed? "Review" must open that interview, not silently start
  // a second one. Only an explicit force_new re-interviews someone.
  const finished = await db.one(
    `select * from interviews where employee_id = $1 and status in ('complete','locked')
      order by completed_at desc nulls last limit 1`, [employee_id]);
  if (finished && req.body.force_new !== true) {
    // Tidy up blank drafts created by the old Review behaviour. Only drafts
    // with zero answers are removed, so nothing anyone typed is ever lost.
    const { rowCount } = await db.query(
      `delete from interviews i
        where i.employee_id = $1 and i.status = 'draft'
          and not exists (select 1 from answers a where a.interview_id = i.id)`,
      [employee_id]);
    if (rowCount) await audit(req, 'interview.cleanup_empty_drafts', 'employee', employee_id, { removed: rowCount });
    return res.json(finished);
  }

  if (openDraft && req.body.force_new !== true) {
    if (client_ref && !openDraft.client_ref) {
      await db.query('update interviews set client_ref = $1 where id = $2', [client_ref, openDraft.id]);
      openDraft.client_ref = client_ref;
    }
    return res.json(openDraft);
  }

  const tpl = await db.one(
    `select id, template_key, version from form_templates
      where template_key = $1 and status = 'published' order by version desc limit 1`,
    [emp.template_key]);
  if (!tpl) return res.status(400).json({ error: 'no_published_template', template_key: emp.template_key });

  const row = await db.one(
    `insert into interviews (employee_id, store_id, engagement_id, interviewer_id,
                             template_id, template_key, template_version, client_ref)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [emp.id, emp.store_id, emp.engagement_id, req.session.user.id,
     tpl.id, tpl.template_key, tpl.version, client_ref || null]);

  await db.query(
    `update employees set interview_status = 'in_progress', updated_at = now()
      where id = $1 and interview_status in ('pending','no_show','declined')`, [emp.id]);

  await audit(req, 'interview.start', 'interview', row.id, { employee_id });
  res.status(201).json(row);
}));

router.get('/interviews/:id', wrap(async (req, res) => {
  const iv = await db.one(
    `select i.*, e.first_name, e.last_name, e.position_title, s.name as store_name,
            eng.client_name, u.name as interviewer_name
       from interviews i
       join employees e on e.id = i.employee_id
       join stores s on s.id = i.store_id
       join engagements eng on eng.id = i.engagement_id
       left join users u on u.id = i.interviewer_id
      where i.id = $1`, [req.params.id]);
  if (!iv) return res.status(404).json({ error: 'not_found' });
  iv.answers = await db.many(
    'select question_key, value, other_text from answers where interview_id = $1', [req.params.id]);
  res.json(iv);
}));

// Batch answer upsert. The iPad posts whatever it has buffered; order and
// repetition don't matter because each (interview, question) is a primary key.
router.put('/interviews/:id/answers', wrap(async (req, res) => {
  const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
  const iv = await db.one('select * from interviews where id = $1', [req.params.id]);
  if (!iv) return res.status(404).json({ error: 'not_found' });
  if (iv.status === 'locked') return res.status(409).json({ error: 'interview_locked' });

  await db.tx(async (client) => {
    for (const a of answers) {
      if (!a || !a.question_key) continue;
      await client.query(
        `insert into answers (interview_id, question_key, value, other_text)
         values ($1,$2,$3,$4)
         on conflict (interview_id, question_key)
         do update set value = excluded.value, other_text = excluded.other_text, updated_at = now()`,
        [req.params.id, a.question_key,
         a.value === undefined ? null : JSON.stringify(a.value), a.other_text || null]);
    }
    await client.query('update interviews set updated_at = now() where id = $1', [req.params.id]);
  });

  res.json({ ok: true, saved: answers.length });
}));

// Complete. Validates required questions, rebuilds the nomination rows.
router.post('/interviews/:id/complete', wrap(async (req, res) => {
  const iv = await db.one('select * from interviews where id = $1', [req.params.id]);
  if (!iv) return res.status(404).json({ error: 'not_found' });
  if (iv.status === 'locked') return res.status(409).json({ error: 'interview_locked' });

  const tpl = await db.one('select * from form_templates where id = $1', [iv.template_id]);
  const answers = await db.many(
    'select question_key, value, other_text from answers where interview_id = $1', [req.params.id]);
  const byKey = new Map(answers.map((a) => [a.question_key, a]));

  const missing = [];
  for (const section of tpl.sections || []) {
    for (const q of section.questions || []) {
      if (!q.required) continue;
      if (q.show_if && !showIf(q.show_if, byKey)) continue;
      const a = byKey.get(q.key);
      const empty = !a || a.value === null || a.value === undefined || a.value === '' ||
                    (Array.isArray(a.value) && a.value.length === 0);
      if (empty) missing.push(q.key);
    }
  }
  if (missing.length && req.body.force !== true) {
    return res.status(422).json({ error: 'missing_required', missing });
  }

  await rebuildNominations(req.params.id);

  const row = await db.one(
    `update interviews set status = 'complete', completed_at = now(), updated_at = now()
      where id = $1 returning *`, [req.params.id]);
  await db.query(
    `update employees set interview_status = 'complete', updated_at = now() where id = $1`,
    [iv.employee_id]);

  await audit(req, 'interview.complete', 'interview', row.id,
    { forced: req.body.force === true, missing_count: missing.length });
  res.json({ ...row, forced_missing: req.body.force === true ? missing : [] });
}));

// Reopen a completed interview. Admin only, and never for a locked one.
router.post('/interviews/:id/reopen', requireRole('admin','lead'), wrap(async (req, res) => {
  const iv = await db.one('select * from interviews where id = $1', [req.params.id]);
  if (!iv) return res.status(404).json({ error: 'not_found' });
  if (iv.status === 'locked') return res.status(409).json({ error: 'interview_locked' });
  const row = await db.one(
    `update interviews set status = 'draft', completed_at = null, updated_at = now()
      where id = $1 returning *`, [req.params.id]);
  await db.query(`update employees set interview_status = 'in_progress' where id = $1`, [iv.employee_id]);
  await audit(req, 'interview.reopen', 'interview', row.id, { reason: req.body.reason || null });
  res.json(row);
}));

// Lock the engagement's interviews once analysis has been delivered.
router.post('/interviews/:id/lock', requireRole('admin','lead'), wrap(async (req, res) => {
  const row = await db.one(
    `update interviews set status = 'locked', locked_at = now(), updated_at = now()
      where id = $1 and status = 'complete' returning *`, [req.params.id]);
  if (!row) return res.status(409).json({ error: 'must_be_complete_first' });
  await audit(req, 'interview.lock', 'interview', row.id);
  res.json(row);
}));

router.get('/stores/:id/interviews', wrap(async (req, res) => {
  res.json(await db.many(
    `select i.id, i.status, i.template_key, i.started_at, i.completed_at,
            e.first_name, e.last_name, e.position_title, u.name as interviewer_name
       from interviews i
       join employees e on e.id = i.employee_id
       left join users u on u.id = i.interviewer_id
      where i.store_id = $1 order by i.updated_at desc`, [req.params.id]));
}));

// -------------------------------------------------------------- helpers

function showIf(cond, byKey) {
  const a = byKey.get(cond.key);
  const v = a ? a.value : undefined;
  switch (cond.op) {
    case 'eq':  return v === cond.value;
    case 'neq': return v !== cond.value;
    case 'lt':  return typeof v === 'number' && v < cond.value;
    case 'lte': return typeof v === 'number' && v <= cond.value;
    case 'gt':  return typeof v === 'number' && v > cond.value;
    case 'gte': return typeof v === 'number' && v >= cond.value;
    case 'in':  return Array.isArray(cond.value) && cond.value.includes(v);
    case 'answered': return v !== undefined && v !== null && v !== '';
    default: return true;
  }
}

// Nominations are derived, so rebuilding is a delete-and-reinsert. Keeps the
// graph consistent when an interview is reopened and an answer changes.
async function rebuildNominations(interviewId) {
  const iv = await db.one('select * from interviews where id = $1', [interviewId]);
  if (!iv) return;
  const answers = await db.many(
    'select question_key, value, other_text from answers where interview_id = $1', [interviewId]);
  const byKey = new Map(answers.map((a) => [a.question_key, a]));
  const catalog = await db.many(
    `select key, nomination, analysis from question_catalog where nomination is not null`);

  await db.tx(async (client) => {
    await client.query('delete from nominations where interview_id = $1', [interviewId]);
    for (const q of catalog) {
      const a = byKey.get(q.key);
      if (!a || a.value === null || a.value === undefined || a.value === '') continue;

      // value is either an employee uuid, or {freetext:"..."} for off-roster names
      let nomineeId = null, freetext = null;
      if (typeof a.value === 'string') {
        if (/^[0-9a-f-]{36}$/i.test(a.value)) nomineeId = a.value; else freetext = a.value;
      } else if (a.value && typeof a.value === 'object') {
        nomineeId = a.value.employee_id || null;
        freetext = a.value.freetext || null;
      }
      if (!nomineeId && !freetext) continue;

      // The "why" question paired to this nomination carries the reason.
      const reasonKey = `${q.key}_why`;
      const reason = byKey.get(reasonKey)?.value;

      await client.query(
        `insert into nominations (interview_id, engagement_id, store_id, question_key,
           nominator_employee_id, nominator_template_key, nominee_employee_id, nominee_freetext,
           target_role, direction, reason)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [interviewId, iv.engagement_id, iv.store_id, q.key,
         iv.employee_id, iv.template_key, nomineeId, freetext,
         q.nomination?.target || null, q.nomination?.direction || null,
         typeof reason === 'string' ? reason : null]);
    }
  });
}

module.exports = router;
module.exports._showIf = showIf;
module.exports._rebuildNominations = rebuildNominations;
