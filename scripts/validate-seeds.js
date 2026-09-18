'use strict';
// Runs without a database. Catches the failure mode that matters most: a
// template referencing a question key that doesn't exist, which would silently
// drop that question from the cross-role analysis.
const fs = require('fs');
const path = require('path');

const SEEDS = path.join(__dirname, '..', 'db', 'seeds');
const cat = JSON.parse(fs.readFileSync(path.join(SEEDS, 'question_catalog.json'), 'utf8'));
const keys = new Set(cat.questions.map((q) => q.key));
let errors = 0, warnings = 0;

const dupes = cat.questions.map((q) => q.key).filter((k, i, a) => a.indexOf(k) !== i);
if (dupes.length) { console.error('duplicate catalog keys:', dupes); errors++; }

for (const q of cat.questions) {
  const t = q.type;
  if (['single_select', 'multi_select'].includes(t) && !(q.options || []).length) {
    console.error(`${q.key}: ${t} with no options`); errors++;
  }
  if (t === 'rating' && !q.scale) { console.error(`${q.key}: rating with no scale`); errors++; }
  if (t === 'employee_ref' && !q.nomination) {
    console.warn(`${q.key}: employee_ref without nomination metadata — won't appear in tallies`); warnings++;
  }
  if (q.analysis?.reason_for && !keys.has(q.analysis.reason_for)) {
    console.error(`${q.key}: reason_for points at unknown key ${q.analysis.reason_for}`); errors++;
  }
}

const dimRoles = new Map();
const tdir = path.join(SEEDS, 'templates');
for (const f of fs.readdirSync(tdir).filter((x) => x.endsWith('.json'))) {
  const t = JSON.parse(fs.readFileSync(path.join(tdir, f), 'utf8'));
  const seen = new Set();
  for (const s of t.sections) {
    for (const q of s.questions) {
      if (!keys.has(q.key)) { console.error(`${f}: unknown key "${q.key}"`); errors++; continue; }
      if (seen.has(q.key)) { console.error(`${f}: duplicate key "${q.key}" in one template`); errors++; }
      seen.add(q.key);
      if (q.show_if && !keys.has(q.show_if.key)) {
        console.error(`${f}: show_if references unknown key "${q.show_if.key}"`); errors++;
      }
      const dim = cat.questions.find((c) => c.key === q.key)?.analysis?.dimension;
      if (dim) {
        if (!dimRoles.has(dim)) dimRoles.set(dim, new Set());
        dimRoles.get(dim).add(t.template_key);
      }
    }
  }
}

const shared = [...dimRoles.entries()].filter(([, r]) => r.size > 1)
  .sort((a, b) => b[1].size - a[1].size);
console.log(`\ncatalog: ${cat.questions.length} questions`);
console.log(`cross-role dimensions (${shared.length}):`);
for (const [dim, roles] of shared) {
  console.log(`  ${String(roles.size)} roles  ${dim.padEnd(32)} ${[...roles].join(', ')}`);
}
console.log(`\n${errors} errors, ${warnings} warnings`);
process.exit(errors ? 1 : 0);
