'use strict';
// Deterministic analysis. Everything here is arithmetic over the answers —
// no model involved. The LLM pass consumes this output rather than recomputing
// it, so the numbers quoted in a narrative are always the numbers in the data.
const db = require('../db');

const ROLE_LABEL = {
  technician: 'Technicians',
  service_advisor: 'Service Advisors',
  parts: 'Parts',
  support_staff: 'Support Staff'
};

// Any survey added later gets a readable label without touching this map.
const roleLabel = (key) => ROLE_LABEL[key] ||
  String(key || 'unknown').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r2 = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);

async function loadCatalog() {
  const rows = await db.many('select * from question_catalog');
  const map = new Map();
  for (const r of rows) map.set(r.key, r);
  return map;
}

/**
 * Build computed_facts for a store (or a whole engagement).
 * Only interviews with status complete/locked are counted — drafts are excluded
 * so a half-finished interview can't skew a number you show a client.
 */
async function computeFacts({ storeId, engagementId }) {
  const catalog = await loadCatalog();
  const scopeSql = storeId ? 'i.store_id = $1' : 'i.engagement_id = $1';
  const scopeId = storeId || engagementId;

  const interviews = await db.many(
    `select i.id, i.template_key, i.status, i.completed_at,
            e.id as employee_id, e.first_name, e.last_name, e.position_title
       from interviews i
       join employees e on e.id = i.employee_id
      where ${scopeSql} and i.status in ('complete','locked')
      order by i.completed_at nulls last`,
    [scopeId]
  );
  const interviewIds = interviews.map((i) => i.id);
  const byInterview = new Map(interviews.map((i) => [i.id, i]));

  // ---- roster coverage -----------------------------------------------------
  const rosterSql = storeId ? 'store_id = $1' : 'store_id in (select id from stores where engagement_id = $1)';
  const roster = await db.many(
    `select template_key, department, interview_status, roster_status, count(*)::int as n
       from employees where ${rosterSql}
      group by 1,2,3,4`,
    [scopeId]
  );

  const coverage = { total_on_roster: 0, interviewable: 0, complete: 0, by_template: {}, by_status: {}, no_form_assigned: 0 };
  for (const r of roster) {
    coverage.total_on_roster += r.n;
    coverage.by_status[r.interview_status] = (coverage.by_status[r.interview_status] || 0) + r.n;
    if (!r.template_key) { coverage.no_form_assigned += r.n; continue; }
    const t = (coverage.by_template[r.template_key] ||= { roster: 0, complete: 0 });
    t.roster += r.n;
    if (r.interview_status === 'complete') t.complete += r.n;
    coverage.interviewable += r.n;
    if (r.interview_status === 'complete') coverage.complete += r.n;
  }
  coverage.completion_rate = coverage.interviewable
    ? r2(coverage.complete / coverage.interviewable) : null;

  if (!interviewIds.length) {
    return { scope: storeId ? 'store' : 'engagement', generated_for: scopeId,
             coverage, interview_count: 0, dimensions: [], nominations: {},
             verbatims: [], input_interview_ids: [] };
  }

  // ---- answers -------------------------------------------------------------
  const answers = await db.many(
    `select a.interview_id, a.question_key, a.value, a.other_text
       from answers a where a.interview_id = any($1::uuid[])`,
    [interviewIds]
  );

  // dimension -> role -> collected values
  const dims = new Map();
  const verbatims = [];

  for (const a of answers) {
    const q = catalog.get(a.question_key);
    if (!q) continue;
    const an = q.analysis || {};
    if (an.internal_only) continue;             // interviewer notes never aggregate
    const iv = byInterview.get(a.interview_id);
    if (!iv) continue;
    const role = iv.template_key;
    const val = a.value;

    if (an.verbatim && typeof val === 'string' && val.trim()) {
      verbatims.push({
        interview_id: a.interview_id, question_key: a.question_key,
        dimension: an.dimension || null, role, role_label: roleLabel(role),
        prompt: q.prompt, text: val.trim()
      });
    }

    if (!an.dimension) continue;
    const d = dims.get(an.dimension) || { dimension: an.dimension, type: null, roles: new Map(), headline: false };
    if (an.headline) d.headline = true;

    const bucket = d.roles.get(role) ||
      { ratings: [], labels: new Map(), n_rating: 0, n_choice: 0, respondents: new Set() };

    if (q.type === 'rating' && typeof val === 'number') {
      d.type = 'rating';
      bucket.ratings.push(val);
      bucket.n_rating++;
    } else if (q.type === 'multi_select' && Array.isArray(val)) {
      d.type = d.type || 'choice';
      for (const v of val) {
        const label = labelFor(q, v, a.other_text);
        bucket.labels.set(label, (bucket.labels.get(label) || 0) + 1);
      }
      bucket.n_choice++;
    } else if ((q.type === 'single_select' || q.type === 'yes_no') && typeof val === 'string' && val) {
      d.type = d.type || 'choice';
      const label = labelFor(q, val, a.other_text);
      bucket.labels.set(label, (bucket.labels.get(label) || 0) + 1);
      bucket.n_choice++;
    } else {
      continue;
    }
    bucket.respondents.add(a.interview_id);
    d.roles.set(role, bucket);
    dims.set(an.dimension, d);
  }

  // ---- shape dimensions, compute cross-role gaps ---------------------------
  const dimensions = [];
  for (const d of dims.values()) {
    const roles = [];
    for (const [role, b] of d.roles.entries()) {
      roles.push({
        role, role_label: roleLabel(role),
        // n is the number of RATINGS behind the average, not the number of
        // answers touching this dimension — those differ when a dimension
        // carries both a rating question and a choice question.
        n: b.ratings.length,
        n_choice: b.n_choice,
        respondents: b.respondents.size,
        avg: b.ratings.length ? r2(mean(b.ratings)) : null,
        distribution: b.ratings.length ? tally(b.ratings) : null,
        choices: b.labels.size
          ? [...b.labels.entries()].sort((x, y) => y[1] - x[1]).map(([label, count]) => ({ label, count }))
          : null
      });
    }
    roles.sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));

    const rated = roles.filter((r) => r.avg !== null);
    let gap = null;
    if (rated.length >= 2) {
      const hi = rated[0], lo = rated[rated.length - 1];
      gap = {
        spread: r2(hi.avg - lo.avg),
        highest: { role: hi.role, role_label: hi.role_label, avg: hi.avg, n: hi.n },
        lowest:  { role: lo.role, role_label: lo.role_label, avg: lo.avg, n: lo.n }
      };
    }

    // For choice dimensions, disagreement = do the roles pick different top answers?
    let choice_divergence = null;
    const withChoices = roles.filter((r) => r.choices && r.choices.length);
    if (withChoices.length >= 2) {
      const tops = withChoices.map((r) => ({ role_label: r.role_label, top: r.choices[0].label }));
      choice_divergence = {
        agree: new Set(tops.map((t) => t.top)).size === 1,
        top_by_role: tops
      };
    }

    dimensions.push({
      dimension: d.dimension, type: d.type, headline: d.headline,
      role_count: roles.length, roles, gap, choice_divergence,
      // Weighted by rating count so a 1-respondent role can't swing the mean.
      overall_avg: rated.length ? r2(mean(rated.flatMap((r) => Array(r.n).fill(r.avg)))) : null
    });
  }
  // Biggest disagreements first — that's what the consultant wants to see.
  dimensions.sort((a, b) =>
    (b.headline - a.headline) || ((b.gap?.spread ?? -1) - (a.gap?.spread ?? -1)));

  // ---- nominations ---------------------------------------------------------
  const nomSql = storeId ? 'n.store_id = $1' : 'n.engagement_id = $1';
  const nomRows = await db.many(
    `select n.direction, n.target_role, n.nominator_template_key,
            n.nominee_employee_id, n.nominee_freetext, n.reason,
            e.first_name, e.last_name, e.position_title, e.template_key as nominee_template_key
       from nominations n
       left join employees e on e.id = n.nominee_employee_id
      where ${nomSql}`,
    [scopeId]
  );

  const nominations = {};
  for (const n of nomRows) {
    const target = n.target_role || 'unknown';
    const dir = n.direction || 'unknown';
    const name = n.nominee_employee_id
      ? `${n.first_name} ${n.last_name}`
      : (n.nominee_freetext || '(unnamed)');
    const group = (nominations[target] ||= { strongest: {}, needs_support: {} });
    const slot = (group[dir] ||= {});
    const rec = (slot[name] ||= {
      employee_id: n.nominee_employee_id, name, count: 0, by_role: {}, reasons: []
    });
    rec.count++;
    const rl = roleLabel(n.nominator_template_key);
    rec.by_role[rl] = (rec.by_role[rl] || 0) + 1;
    if (n.reason && n.reason.trim()) rec.reasons.push(n.reason.trim());
  }
  for (const target of Object.keys(nominations)) {
    for (const dir of Object.keys(nominations[target])) {
      nominations[target][dir] = Object.values(nominations[target][dir])
        .sort((a, b) => b.count - a.count);
    }
  }

  // Who was interviewed but never named by anyone — often as telling as the tallies.
  const namedIds = new Set(nomRows.map((n) => n.nominee_employee_id).filter(Boolean));
  const unnamed = interviews
    .filter((i) => ['technician', 'service_advisor'].includes(i.template_key))
    .filter((i) => !namedIds.has(i.employee_id))
    .map((i) => ({ employee_id: i.employee_id, name: `${i.first_name} ${i.last_name}`,
                   role: i.template_key, role_label: roleLabel(i.template_key) }));

  return {
    scope: storeId ? 'store' : 'engagement',
    generated_for: scopeId,
    coverage,
    interview_count: interviews.length,
    interviews_by_role: interviews.reduce((acc, i) => {
      acc[i.template_key] = (acc[i.template_key] || 0) + 1; return acc;
    }, {}),
    dimensions,
    nominations,
    never_nominated: unnamed,
    verbatims,
    input_interview_ids: interviewIds
  };
}

function labelFor(q, value, otherText) {
  if (value === '__other__') return otherText ? `Other: ${otherText}` : 'Other';
  const opts = q.options || [];
  const hit = opts.find((o) => o.value === value);
  if (hit) return hit.label;
  if (q.type === 'yes_no') return value === 'yes' ? 'Yes' : value === 'no' ? 'No' : String(value);
  return String(value);
}

function tally(nums) {
  const out = {};
  for (const n of nums) out[n] = (out[n] || 0) + 1;
  return out;
}

module.exports = { computeFacts, ROLE_LABEL, roleLabel };
