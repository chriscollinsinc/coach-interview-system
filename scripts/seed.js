'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../src/db');

const SEEDS = path.join(__dirname, '..', 'db', 'seeds');

(async () => {
  // ---- question catalog (upsert: safe to re-run after editing the seed) ----
  const cat = JSON.parse(fs.readFileSync(path.join(SEEDS, 'question_catalog.json'), 'utf8'));
  for (const q of cat.questions) {
    await db.query(
      `insert into question_catalog (key,prompt,type,options,allow_other,scale,ref_filter,
                                     nomination,analysis,help_text)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (key) do update set
         prompt=excluded.prompt, type=excluded.type, options=excluded.options,
         allow_other=excluded.allow_other, scale=excluded.scale, ref_filter=excluded.ref_filter,
         nomination=excluded.nomination, analysis=excluded.analysis,
         help_text=excluded.help_text, updated_at=now()`,
      [q.key, q.prompt, q.type,
       q.options ? JSON.stringify(q.options) : null, !!q.allow_other,
       q.scale ? JSON.stringify(q.scale) : null,
       q.ref_filter ? JSON.stringify(q.ref_filter) : null,
       q.nomination ? JSON.stringify(q.nomination) : null,
       q.analysis ? JSON.stringify(q.analysis) : null,
       q.help_text || null]);
  }
  console.log(`  catalog: ${cat.questions.length} questions`);

  // ---- templates (versioned; only inserted if that version is absent) ----
  const tdir = path.join(SEEDS, 'templates');
  for (const f of fs.readdirSync(tdir).filter((x) => x.endsWith('.json'))) {
    const t = JSON.parse(fs.readFileSync(path.join(tdir, f), 'utf8'));
    const keys = t.sections.flatMap((s) => s.questions.map((q) => q.key));
    const known = await db.many('select key from question_catalog where key = any($1::text[])', [keys]);
    const missing = keys.filter((k) => !known.some((r) => r.key === k));
    if (missing.length) throw new Error(`${f} references unknown keys: ${missing.join(', ')}`);

    const exists = await db.one(
      'select id from form_templates where template_key=$1 and version=$2', [t.template_key, t.version]);
    if (exists) { console.log(`  = ${t.template_key} v${t.version} (exists)`); continue; }
    await db.query(
      `insert into form_templates (template_key,version,title,description,status,applies_to,sections,published_at)
       values ($1,$2,$3,$4,$5,$6,$7, case when $5='published' then now() else null end)`,
      [t.template_key, t.version, t.title, t.description || null, t.status || 'draft',
       JSON.stringify(t.applies_to || {}), JSON.stringify(t.sections)]);
    console.log(`  + ${t.template_key} v${t.version} (${keys.length} questions, ${t.status})`);
  }

  // ---- position aliases from each template's applies_to ----
  let aliasCount = 0;
  for (const f of fs.readdirSync(tdir).filter((x) => x.endsWith('.json'))) {
    const t = JSON.parse(fs.readFileSync(path.join(tdir, f), 'utf8'));
    for (const p of (t.applies_to?.positions || [])) {
      await db.query(
        `insert into position_aliases (alias, template_key, department) values ($1,$2,$3)
         on conflict (alias) do nothing`,
        [p.toLowerCase().trim(), t.template_key, t.applies_to.department || null]);
      aliasCount++;
    }
  }
  // Management titles map to no survey on purpose — they're still rostered.
  for (const p of ['service manager','parts manager','fixed ops director',
                   'fixed operations director','general manager','dealer principal',
                   'service director','owner']) {
    await db.query(
      `insert into position_aliases (alias, template_key, department) values ($1,null,'management')
       on conflict (alias) do nothing`, [p]);
    aliasCount++;
  }
  console.log(`  position aliases: ${aliasCount} seeded`);

  // ---- bootstrap admin ----
  const { rows } = await db.query('select count(*)::int as n from users');
  if (rows[0].n === 0) {
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
    const pw = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (email && pw) {
      await db.query(
        `insert into users (email,name,password_hash,role) values ($1,$2,$3,'admin')`,
        [email, process.env.BOOTSTRAP_ADMIN_NAME || 'Admin', await bcrypt.hash(pw, 12)]);
      console.log(`  + admin user ${email}`);
    } else {
      console.log('  ! no users yet — run: npm run create-user -- <email> <name> <password> admin');
    }
  }

  console.log('seed complete');
  await db.pool.end();
})().catch((e) => { console.error('seed failed:', e.message); process.exit(1); });
