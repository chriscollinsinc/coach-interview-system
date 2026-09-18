'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, audit } = require('../auth');
const { computeFacts } = require('../lib/analytics');
const { generateNarrative, PROMPT_VERSION } = require('../lib/llm');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireAuth);

// Live dashboard numbers. Always recomputed, never cached — cheap, and it
// means the coverage counter on the iPad is honest mid-fieldwork.
router.get('/stores/:id/facts', wrap(async (req, res) => {
  res.json(await computeFacts({ storeId: req.params.id }));
}));

router.get('/engagements/:id/facts', wrap(async (req, res) => {
  res.json(await computeFacts({ engagementId: req.params.id }));
}));

// Generate and persist a narrative. Every run is a new row so a finding quoted
// to a client months ago stays reproducible.
router.post('/stores/:id/analyze', requireRole('admin','lead','consultant'), wrap(async (req, res) => {
  const store = await db.one('select * from stores where id = $1', [req.params.id]);
  if (!store) return res.status(404).json({ error: 'store_not_found' });

  const facts = await computeFacts({ storeId: req.params.id });
  if (!facts.interview_count) return res.status(422).json({ error: 'no_completed_interviews' });

  let narrative = null, model = null, promptVersion = PROMPT_VERSION, status = 'facts_only', errText = null;
  try {
    const out = await generateNarrative(facts);
    narrative = out.narrative; model = out.model; promptVersion = out.prompt_version; status = 'complete';
  } catch (e) {
    errText = e.code === 'NO_API_KEY'
      ? 'ANTHROPIC_API_KEY not set — computed facts saved without a narrative.'
      : `Narrative generation failed: ${e.message}`;
    status = e.code === 'NO_API_KEY' ? 'facts_only' : 'error';
    console.error('[analyze]', errText);
  }

  const row = await db.one(
    `insert into analyses (scope, store_id, engagement_id, model, prompt_version,
                           computed_facts, narrative, input_interview_ids, status, error, generated_by)
     values ('store',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [store.id, store.engagement_id, model, promptVersion,
     JSON.stringify(facts), narrative ? JSON.stringify(narrative) : null,
     facts.input_interview_ids, status, errText, req.session.user.id]);

  await audit(req, 'analysis.generate', 'store', store.id,
    { status, interviews: facts.interview_count, model });
  res.status(201).json(row);
}));

router.get('/stores/:id/analyses', wrap(async (req, res) => {
  res.json(await db.many(
    `select a.id, a.status, a.model, a.prompt_version, a.generated_at, a.error,
            u.name as generated_by_name,
            coalesce(array_length(a.input_interview_ids,1),0) as interview_count
       from analyses a left join users u on u.id = a.generated_by
      where a.store_id = $1 order by a.generated_at desc`, [req.params.id]));
}));

router.get('/analyses/:id', wrap(async (req, res) => {
  const a = await db.one(
    `select a.*, u.name as generated_by_name from analyses a
       left join users u on u.id = a.generated_by where a.id = $1`, [req.params.id]);
  if (!a) return res.status(404).json({ error: 'not_found' });
  res.json(a);
}));

// Raw export. Internal use only — includes interviewer notes and attribution.
router.get('/stores/:id/export.csv', wrap(async (req, res) => {
  const rows = await db.many(
    `select e.first_name, e.last_name, e.position_title, i.template_key, i.status,
            i.completed_at, u.name as interviewer, a.question_key, a.value, a.other_text,
            q.prompt
       from interviews i
       join employees e on e.id = i.employee_id
       left join users u on u.id = i.interviewer_id
       left join answers a on a.interview_id = i.id
       left join question_catalog q on q.key = a.question_key
      where i.store_id = $1 and i.status in ('complete','locked')
      order by e.last_name, e.first_name, a.question_key`, [req.params.id]);

  const head = ['first_name','last_name','position_title','role_form','status','completed_at',
                'interviewer','question_key','question','answer','other_text'];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([r.first_name, r.last_name, r.position_title, r.template_key, r.status,
                r.completed_at ? new Date(r.completed_at).toISOString() : '', r.interviewer,
                r.question_key, r.prompt, r.value, r.other_text].map(esc).join(','));
  }
  await audit(req, 'export.csv', 'store', req.params.id, { rows: rows.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="interviews-${req.params.id}.csv"`);
  res.send(lines.join('\n'));
}));

module.exports = router;
