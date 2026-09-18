'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, audit, verifyLogin } = require('../auth');
const positionMap = require('../lib/positionMap');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ------------------------------------------------------------------ auth

router.post('/auth/login', wrap(async (req, res) => {
  const user = await verifyLogin(req.body.email, req.body.password);
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });
  req.session.user = user;
  await audit(req, 'login', 'user', user.id);
  res.json({ user });
}));

router.post('/auth/logout', wrap(async (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
}));

router.get('/auth/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'not_authenticated' });
  res.json({ user: req.session.user });
});

router.use(requireAuth);

// User management lives in routes/users.js.

// ----------------------------------------------------------- engagements

router.get('/engagements', wrap(async (req, res) => {
  res.json(await db.many(
    `select e.*,
            (select count(*)::int from stores s where s.engagement_id = e.id) as store_count,
            (select count(*)::int from employees em
               join stores s on s.id = em.store_id where s.engagement_id = e.id) as roster_count,
            (select count(*)::int from interviews i
              where i.engagement_id = e.id and i.status in ('complete','locked')) as complete_count
       from engagements e
      where ($1::boolean is true or e.status <> 'archived')
      order by e.created_at desc`,
    [req.query.include_archived === 'true']
  ));
}));

router.post('/engagements', wrap(async (req, res) => {
  const { client_name, dealer_group, started_on, notes } = req.body;
  if (!client_name) return res.status(400).json({ error: 'client_name_required' });
  const row = await db.one(
    `insert into engagements (client_name,dealer_group,started_on,notes,created_by)
     values ($1,$2,$3,$4,$5) returning *`,
    [client_name.trim(), dealer_group || null, started_on || null, notes || null, req.session.user.id]
  );
  await audit(req, 'engagement.create', 'engagement', row.id, { client_name });
  res.status(201).json(row);
}));

router.get('/engagements/:id', wrap(async (req, res) => {
  const e = await db.one('select * from engagements where id = $1', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'not_found' });
  e.stores = await db.many(
    `select s.*,
            (select count(*)::int from employees em where em.store_id = s.id) as roster_count,
            (select count(*)::int from employees em
              where em.store_id = s.id and em.template_key is not null) as interviewable_count,
            (select count(*)::int from employees em
              where em.store_id = s.id and em.interview_status = 'complete') as complete_count
       from stores s where s.engagement_id = $1 order by s.name`,
    [req.params.id]
  );
  res.json(e);
}));

router.patch('/engagements/:id', wrap(async (req, res) => {
  const allowed = ['client_name', 'dealer_group', 'status', 'started_on', 'notes'];
  const sets = [], vals = [];
  for (const k of allowed) if (k in req.body) { vals.push(req.body[k]); sets.push(`${k} = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
  vals.push(req.params.id);
  const row = await db.one(
    `update engagements set ${sets.join(',')}, updated_at = now() where id = $${vals.length} returning *`, vals);
  await audit(req, 'engagement.update', 'engagement', req.params.id, req.body);
  res.json(row);
}));

// ---------------------------------------------------------------- stores

router.post('/engagements/:id/stores', wrap(async (req, res) => {
  const { name, franchise, city, state } = req.body;
  if (!name) return res.status(400).json({ error: 'name_required' });
  const row = await db.one(
    `insert into stores (engagement_id,name,franchise,city,state) values ($1,$2,$3,$4,$5) returning *`,
    [req.params.id, name.trim(), franchise || null, city || null, state || null]
  );
  await audit(req, 'store.create', 'store', row.id, { name });
  res.status(201).json(row);
}));

router.get('/stores/:id', wrap(async (req, res) => {
  const s = await db.one(
    `select s.*, e.client_name, e.status as engagement_status
       from stores s join engagements e on e.id = s.engagement_id where s.id = $1`,
    [req.params.id]);
  if (!s) return res.status(404).json({ error: 'not_found' });
  res.json(s);
}));

// -------------------------------------------------------- roster / people

router.get('/stores/:id/employees', wrap(async (req, res) => {
  res.json(await db.many(
    `select e.*, u.name as assigned_to_name,
            (select i.id from interviews i where i.employee_id = e.id
              order by case i.status when 'locked' then 0 when 'complete' then 1 else 2 end,
                       i.updated_at desc limit 1) as interview_id
       from employees e
       left join users u on u.id = e.assigned_to
      where e.store_id = $1
      order by e.template_key nulls last, e.last_name, e.first_name`,
    [req.params.id]));
}));

// Preview a paste-in roster: resolves each title to a template without saving,
// so a human can correct the mapping before anything is written.
router.post('/stores/:id/roster/preview', wrap(async (req, res) => {
  const rows = parseRoster(req.body.text || '');
  const out = [];
  for (const r of rows) {
    const m = await positionMap.resolve(r.position_title);
    out.push({ ...r, ...m });
  }
  res.json({ rows: out, count: out.length });
}));

router.post('/stores/:id/roster/import', wrap(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'no_rows' });
  const store = await db.one('select * from stores where id = $1', [req.params.id]);
  if (!store) return res.status(404).json({ error: 'store_not_found' });

  const created = await db.tx(async (client) => {
    const made = [];
    for (const r of rows) {
      if (!r.first_name || !r.last_name) continue;
      // Management (template_key null) is imported deliberately: they are named
      // in open answers, they count in the org picture, and they are already
      // here the day a management survey ships.
      const interviewStatus = r.template_key ? 'pending' : 'not_applicable';
      const { rows: ins } = await client.query(
        `insert into employees (store_id, first_name, last_name, position_title,
                                template_key, department, interview_status)
         values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [req.params.id, String(r.first_name).trim(), String(r.last_name).trim(),
         r.position_title || null, r.template_key || null, r.department || null, interviewStatus]
      );
      made.push(ins[0]);
      if (r.position_title && r.confirmed !== false) {
        await positionMap.learn(r.position_title, r.template_key, r.department);
      }
    }
    return made;
  });

  await audit(req, 'roster.import', 'store', req.params.id, { count: created.length });
  res.status(201).json({ created: created.length, employees: created });
}));

router.post('/stores/:id/employees', wrap(async (req, res) => {
  const { first_name, last_name, position_title, template_key, department } = req.body;
  if (!first_name || !last_name) return res.status(400).json({ error: 'name_required' });
  const row = await db.one(
    `insert into employees (store_id, first_name, last_name, position_title, template_key,
                            department, roster_status, interview_status)
     values ($1,$2,$3,$4,$5,$6,'added_onsite',$7) returning *`,
    [req.params.id, first_name.trim(), last_name.trim(), position_title || null,
     template_key || null, department || null, template_key ? 'pending' : 'not_applicable']
  );
  await audit(req, 'employee.add_onsite', 'employee', row.id);
  res.status(201).json(row);
}));

router.patch('/employees/:id', wrap(async (req, res) => {
  const allowed = ['first_name','last_name','position_title','template_key','department',
                   'interview_status','assigned_to'];
  const sets = [], vals = [];
  for (const k of allowed) if (k in req.body) { vals.push(req.body[k]); sets.push(`${k} = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
  vals.push(req.params.id);
  const row = await db.one(
    `update employees set ${sets.join(',')}, updated_at = now() where id = $${vals.length} returning *`, vals);
  await audit(req, 'employee.update', 'employee', req.params.id, req.body);
  res.json(row);
}));

// Roster for nomination pickers. Includes everyone matching the filter whether
// or not they've been interviewed — you can be named by a peer before your turn.
router.get('/stores/:id/pickable', wrap(async (req, res) => {
  const { template_key, department } = req.query;
  const rows = await db.many(
    `select id, first_name, last_name, position_title, template_key, department
       from employees
      where store_id = $1
        and interview_status <> 'no_longer_employed'
        and ($2::text is null or template_key = $2)
        and ($3::text is null or department = $3)
      order by last_name, first_name`,
    [req.params.id, template_key || null, department || null]);
  res.json(rows);
}));

// ------------------------------------------------------- leadership notes

router.get('/stores/:id/leadership-notes', wrap(async (req, res) => {
  res.json(await db.many(
    `select ln.*, e.first_name, e.last_name, e.position_title, u.name as author_name
       from leadership_notes ln
       join employees e on e.id = ln.employee_id
       left join users u on u.id = ln.author_id
      where ln.store_id = $1 order by ln.occurred_on desc, ln.created_at desc`,
    [req.params.id]));
}));

router.post('/employees/:id/leadership-notes', wrap(async (req, res) => {
  const emp = await db.one(
    `select e.*, s.engagement_id from employees e join stores s on s.id = e.store_id
      where e.id = $1`, [req.params.id]);
  if (!emp) return res.status(404).json({ error: 'employee_not_found' });
  const row = await db.one(
    `insert into leadership_notes (employee_id, store_id, engagement_id, author_id, occurred_on, body)
     values ($1,$2,$3,$4,coalesce($5::date, current_date),$6) returning *`,
    [emp.id, emp.store_id, emp.engagement_id, req.session.user.id,
     req.body.occurred_on || null, String(req.body.body || '').trim()]
  );
  await audit(req, 'leadership_note.create', 'employee', emp.id);
  res.status(201).json(row);
}));

// ------------------------------------------------------------- templates

router.get('/templates', wrap(async (req, res) => {
  res.json(await db.many(
    `select id, template_key, version, title, description, status, applies_to, published_at
       from form_templates
      where ($1::text is null or status = $1)
      order by template_key, version desc`,
    [req.query.status || null]));
}));

router.get('/templates/:key/current', wrap(async (req, res) => {
  const t = await db.one(
    `select * from form_templates where template_key = $1 and status = 'published'
      order by version desc limit 1`, [req.params.key]);
  if (!t) return res.status(404).json({ error: 'no_published_version' });
  t.catalog = await db.many(
    `select * from question_catalog where key = any($1::text[])`,
    [t.sections.flatMap((s) => s.questions.map((q) => q.key))]);
  res.json(t);
}));

router.get('/catalog', wrap(async (req, res) => {
  res.json(await db.many('select * from question_catalog order by key'));
}));

// Create a new survey, or a new version of an existing one. Publishing
// validates that every referenced key exists, which is what stops a new
// survey from quietly falling out of the cross-role analysis.
router.post('/templates', requireRole('admin'), wrap(async (req, res) => {
  const { template_key, title, description, applies_to, sections, status } = req.body;
  if (!template_key || !title || !Array.isArray(sections)) {
    return res.status(400).json({ error: 'template_key_title_sections_required' });
  }
  const keys = sections.flatMap((s) => (s.questions || []).map((q) => q.key));
  const known = await db.many('select key from question_catalog where key = any($1::text[])', [keys]);
  const knownSet = new Set(known.map((k) => k.key));
  const missing = [...new Set(keys.filter((k) => !knownSet.has(k)))];
  if (missing.length && status === 'published') {
    return res.status(400).json({ error: 'unknown_question_keys', missing });
  }
  const next = await db.one(
    'select coalesce(max(version),0)+1 as v from form_templates where template_key = $1', [template_key]);
  const row = await db.one(
    `insert into form_templates (template_key, version, title, description, applies_to, sections,
                                 status, published_at)
     values ($1,$2,$3,$4,$5,$6,$7, case when $7 = 'published' then now() else null end) returning *`,
    [template_key, next.v, title, description || null,
     JSON.stringify(applies_to || {}), JSON.stringify(sections), status || 'draft']
  );
  await audit(req, 'template.create', 'form_template', row.id, { template_key, version: next.v, status });
  res.status(201).json({ ...row, warnings: missing.length ? { unknown_question_keys: missing } : null });
}));

router.post('/catalog', requireRole('admin'), wrap(async (req, res) => {
  const q = req.body;
  if (!q.key || !q.prompt || !q.type) return res.status(400).json({ error: 'key_prompt_type_required' });
  // Near-duplicate guard: key drift is how the cross-role analysis silently breaks.
  const similar = await db.many(
    `select key, prompt from question_catalog
      where similarity(lower(prompt), lower($1)) > 0.55
      order by similarity(lower(prompt), lower($1)) desc limit 5`, [q.prompt]
  ).catch(() => []);   // pg_trgm absent -> guard degrades to no-op, never blocks
  const row = await db.one(
    `insert into question_catalog (key,prompt,type,options,allow_other,scale,ref_filter,
                                   nomination,analysis,help_text)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [q.key, q.prompt, q.type, q.options ? JSON.stringify(q.options) : null, !!q.allow_other,
     q.scale ? JSON.stringify(q.scale) : null, q.ref_filter ? JSON.stringify(q.ref_filter) : null,
     q.nomination ? JSON.stringify(q.nomination) : null,
     q.analysis ? JSON.stringify(q.analysis) : null, q.help_text || null]
  );
  await audit(req, 'catalog.create', null, null, { key: q.key });
  res.status(201).json({ ...row, possible_duplicates: similar });
}));

// -------------------------------------------------------------- helpers

function parseRoster(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const [idx, line] of lines.entries()) {
    const parts = line.split(/\t|,|\s{2,}|\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
    if (!parts.length) continue;
    const lower = parts.map((p) => p.toLowerCase());
    if (idx === 0 && lower.some((p) => ['first','first name','firstname'].includes(p))) continue;
    let first, last, position;
    if (parts.length >= 3) { [first, last, position] = parts; }
    else if (parts.length === 2) {
      if (parts[0].includes(' ')) { const s = parts[0].split(/\s+/); first = s[0]; last = s.slice(1).join(' '); position = parts[1]; }
      else { first = parts[0]; last = parts[1]; }
    } else {
      const s = parts[0].split(/\s+/); first = s[0]; last = s.slice(1).join(' ');
    }
    if (!first) continue;
    out.push({ first_name: first, last_name: last || '', position_title: position || '' });
  }
  return out;
}

module.exports = router;
module.exports._parseRoster = parseRoster;
