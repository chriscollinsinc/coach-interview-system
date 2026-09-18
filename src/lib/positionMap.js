'use strict';
// Dealers hand you job titles in their own language. This resolves them to one
// of the survey templates. Unknown titles are NOT an error — they come back as
// null so the import screen can ask, and management legitimately maps to null.
const db = require('../db');

const norm = (s) => String(s || '').toLowerCase().trim().replace(/[._/]+/g, ' ').replace(/\s+/g, ' ');

const MANAGEMENT = [
  'service manager','sm','service director','fixed ops director','fixed operations director',
  'parts manager','pm','general manager','gm','dealer principal','owner','shop foreman manager',
  'assistant parts manager','service operations manager'
];

// Substring hints, checked after exact alias lookup. Order matters: more
// specific patterns first, since "assistant service manager" contains "service".
const HINTS = [
  [/\b(dealer principal|general manager|\bgm\b|owner)\b/,           null,              'management'],
  [/\b(fixed ops|fixed operations)\b/,                              null,              'management'],
  [/\bservice (manager|director)\b/,                                null,              'management'],
  [/\bparts manager\b/,                                             null,              'management'],
  [/\b(asm|assistant service manager|service advisor|advisor|service consultant|service writer|writer)\b/,
                                                                    'service_advisor', 'service'],
  [/\b(tech|technician|mechanic|foreman)\b/,                        'technician',      'service'],
  [/\bparts\b|\bcounterperson\b|\bwarehouse\b|\bwholesale\b/,        'parts',           'parts'],
  [/\b(porter|valet|cashier|bdc|warranty|greeter|dispatcher|shuttle|admin|office|coordinator)\b/,
                                                                    'support_staff',   'support'],
  [/\b(sales|salesperson|finance|f&i)\b/,                           null,              'sales']
];

async function resolve(positionTitle) {
  const n = norm(positionTitle);
  if (!n) return { template_key: null, department: null, confidence: 'none' };

  const alias = await db.one('select template_key, department from position_aliases where alias = $1', [n]);
  if (alias) {
    await db.query('update position_aliases set hits = hits + 1 where alias = $1', [n]);
    return { template_key: alias.template_key, department: alias.department, confidence: 'alias' };
  }

  if (MANAGEMENT.includes(n)) {
    return { template_key: null, department: 'management', confidence: 'exact' };
  }

  for (const [re, template_key, department] of HINTS) {
    if (re.test(n)) return { template_key, department, confidence: 'hint' };
  }
  return { template_key: null, department: null, confidence: 'none' };
}

// Called when a human confirms or corrects a mapping on the import screen.
async function learn(positionTitle, template_key, department) {
  const n = norm(positionTitle);
  if (!n) return;
  await db.query(
    `insert into position_aliases (alias, template_key, department, hits)
     values ($1,$2,$3,1)
     on conflict (alias) do update set template_key = excluded.template_key,
       department = excluded.department, hits = position_aliases.hits + 1`,
    [n, template_key || null, department || null]
  );
}

module.exports = { resolve, learn, norm };
