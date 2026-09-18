'use strict';
/* End-to-end smoke test against a running server. Seeds a realistic store with
   a deliberate perception gap (Parts think the Parts/Service relationship is
   fine, Technicians do not) and asserts the analytics actually surface it. */
require('dotenv').config();

const BASE = process.env.SMOKE_BASE || `http://localhost:${process.env.PORT || 3000}`;
let cookie = '';
let pass = 0, fail = 0;

function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' — ' + JSON.stringify(extra) : ''}`); }
}

async function call(path, opts = {}) {
  const res = await fetch(BASE + '/api' + path, {
    method: opts.method || 'GET',
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual'
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) { const e = new Error(JSON.stringify(data)); e.status = res.status; e.data = data; throw e; }
  return data;
}

const ROSTER = `First\tLast\tPosition
Ray\tMendoza\tService Manager
Tom\tKelly\tParts Manager
Dana\tWhitfield\tService Advisor
Greg\tOkafor\tASM
Lisa\tTran\tService Consultant
Marcus\tBell\tMaster Technician
Sofia\tRuiz\tLube Tech
Andre\tPetrov\tA Tech
Wes\tDunlap\tTechnician
Nina\tCaruso\tParts Counterperson
Hector\tSalas\tParts Driver
Jo\tBranson\tWarranty Admin
Kim\tAdeyemi\tPorter`;

(async () => {
  console.log(`smoke test -> ${BASE}\n`);

  // ---- auth ----
  console.log('auth');
  await call('/auth/login', { method: 'POST', body: {
    email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD } });
  const me = await call('/auth/me');
  ok(me.user.role === 'admin', 'login as admin');
  try { await fetch(BASE + '/api/engagements').then((r) => ok(r.status === 401, 'unauthenticated request is rejected')); }
  catch (_) {}

  // ---- engagement + store ----
  console.log('\nengagement');
  const eng = await call('/engagements', { method: 'POST', body: {
    client_name: 'Valley Auto Group', dealer_group: 'Valley Auto', started_on: '2026-09-21' } });
  const store = await call(`/engagements/${eng.id}/stores`, { method: 'POST', body: {
    name: 'Valley Chevrolet', franchise: 'Chevrolet', city: 'Van Nuys', state: 'CA' } });
  ok(!!store.id, 'store created');

  // ---- roster import + position mapping ----
  console.log('\nroster');
  const prev = await call(`/stores/${store.id}/roster/preview`, { method: 'POST', body: { text: ROSTER } });
  ok(prev.rows.length === 13, 'parsed 13 roster rows', { got: prev.rows.length });

  const byName = (f) => prev.rows.find((r) => r.first_name === f);
  ok(byName('Ray').template_key === null && byName('Ray').department === 'management',
     'Service Manager maps to no survey, department=management');
  ok(byName('Tom').template_key === null, 'Parts Manager maps to no survey');
  ok(byName('Greg').template_key === 'service_advisor', 'ASM resolves to Service Advisor');
  ok(byName('Lisa').template_key === 'service_advisor', 'Service Consultant resolves to Service Advisor');
  ok(byName('Sofia').template_key === 'technician', 'Lube Tech resolves to Technician');
  ok(byName('Andre').template_key === 'technician', 'A Tech resolves to Technician');
  ok(byName('Nina').template_key === 'parts', 'Parts Counterperson resolves to Parts');
  ok(byName('Hector').template_key === 'parts', 'Parts Driver resolves to Parts');
  ok(byName('Jo').template_key === 'support_staff', 'Warranty Admin resolves to Support Staff');
  ok(byName('Kim').template_key === 'support_staff', 'Porter resolves to Support Staff');

  const imported = await call(`/stores/${store.id}/roster/import`, { method: 'POST', body: { rows: prev.rows } });
  ok(imported.created === 13, 'all 13 imported including management', { got: imported.created });

  const people = await call(`/stores/${store.id}/employees`);
  const mgmt = people.filter((p) => !p.template_key);
  ok(mgmt.length === 2 && mgmt.every((m) => m.interview_status === 'not_applicable'),
     'management on roster with status not_applicable');

  const find = (f) => people.find((p) => p.first_name === f);
  const techs = people.filter((p) => p.template_key === 'technician');
  const advisors = people.filter((p) => p.template_key === 'service_advisor');

  // ---- nomination picker scoping ----
  const pickAdvisors = await call(`/stores/${store.id}/pickable?template_key=service_advisor`);
  ok(pickAdvisors.length === 3, 'advisor picker is scoped to the 3 advisors', { got: pickAdvisors.length });

  // ---- interviews ----
  console.log('\ninterviews');
  async function interview(person, answers) {
    const iv = await call('/interviews', { method: 'POST', body: {
      employee_id: person.id, client_ref: 'smoke-' + person.id } });
    await call(`/interviews/${iv.id}/answers`, { method: 'PUT', body: {
      answers: Object.entries(answers).map(([question_key, value]) => ({ question_key, value })) } });
    return iv;
  }

  // Technicians: relationship with Parts is BAD (1s and 2s), blame availability
  const techAnswers = (strongAdvisor, weakAdvisor, rel, delay) => ({
    tenure_company: '4 years', self_productivity: 2, biggest_slowdown: 'parts',
    pay_structure: 'flat_rate', avg_flagged_hours: 38, dispatch_rating: 2,
    parts_delivered_to_stall: 'no', parts_delay_cause: delay,
    advisor_info_quality: 'sometimes', comm_with_advisors: 2,
    rel_parts_service: rel, sm_accountability_style: 'supportive',
    if_you_owned_it: 'parts',
    nominate_strongest_advisor: strongAdvisor, nominate_strongest_advisor_why: 'Writes a clear ticket and answers the phone.',
    nominate_support_advisor: weakAdvisor, nominate_support_advisor_why: 'Notes are thin, I end up calling the customer myself.',
    sm_approachable: 'Yes, he will come out to the stall if you ask.'
  });

  const ivMarcus = await interview(find('Marcus'), techAnswers(find('Dana').id, find('Greg').id, 1, 'availability'));
  const ivSofia  = await interview(find('Sofia'),  techAnswers(find('Dana').id, find('Greg').id, 1, 'wait_time'));
  const ivAndre  = await interview(find('Andre'),  techAnswers(find('Lisa').id, find('Greg').id, 2, 'availability'));
  const ivWes    = await interview(find('Wes'),    techAnswers(find('Dana').id, find('Greg').id, 1, 'availability'));

  // Parts: think the same relationship is fine (3s), blame communication
  const partsAnswers = (rel) => ({
    tenure_company: '7 years', primary_role_parts: 'counter', has_job_description: 'yes',
    pay_structure: 'hourly', parts_requisition_used: 'sometimes', parts_prepulled: 'yes',
    parts_delivered_to_stall: 'yes', parts_delay_cause: 'communication',
    rel_parts_service: rel, comm_with_advisors: 3, comm_with_techs: 3,
    pm_leadership_style: 'easygoing', if_you_owned_it: 'communication',
    nominate_strongest_tech: find('Marcus').id, nominate_strongest_tech_why: 'Orders the right part the first time.',
    nominate_support_tech: find('Sofia').id, nominate_support_tech_why: 'Still learning the catalog numbers.',
    advisors_slow_me_down: 'They send techs over without a requisition and then stand at the counter.'
  });
  const ivNina   = await interview(find('Nina'),   partsAnswers(3));
  const ivHector = await interview(find('Hector'), partsAnswers(3));

  // Advisors
  const advAnswers = {
    tenure_company: '2 years', has_job_description: 'no', uses_service_menu: 'yes',
    service_menu_current: 'no', inspection_every_ro: 'yes', inspection_process: 'digital',
    inspection_notify_timing: 'during_visit',
    rel_parts_service: 2, rel_service_sales: 2, rel_advisors_techs: 2,
    sm_accountability_style: 'supportive', if_you_owned_it: 'process',
    nominate_strongest_tech: find('Marcus').id, nominate_strongest_tech_why: 'Fast and clean diagnostics.',
    nominate_support_tech: find('Wes').id, nominate_support_tech_why: 'Comebacks on electrical.',
    sm_strengths: 'Knows the numbers cold.', sm_opportunities: 'Rarely walks the drive.'
  };
  const ivDana = await interview(find('Dana'), advAnswers);
  const ivGreg = await interview(find('Greg'), { ...advAnswers, rel_parts_service: 2 });
  const ivLisa = await interview(find('Lisa'), { ...advAnswers, rel_parts_service: 3 });

  // Support
  const supAnswers = {
    tenure_company: '1 year', primary_role_support: 'porter', has_job_description: 'no',
    checkin_authority: 'advisor', primary_interaction: ['advisors', 'customers'],
    rel_with_advisors: 2, comm_with_techs: 2, rel_parts_service: 2,
    biggest_comm_gap: 'advisors', sm_accountability_style: 'no_accountability', leadership_clarity: 'sometimes',
    biggest_improvement_opportunity: 'communication',
    nominate_strongest_advisor: find('Dana').id, nominate_strongest_advisor_why: 'She tells me what is coming.',
    nominate_support_advisor: find('Greg').id, nominate_support_advisor_why: 'Never says where the car needs to go.',
    career_outlook_1yr: 'I would like to get into the tech apprentice program.'
  };
  const ivJo  = await interview(find('Jo'),  { ...supAnswers, primary_role_support: 'warranty' });
  const ivKim = await interview(find('Kim'), supAnswers);

  // ---- required-field validation ----
  console.log('\nvalidation');
  const replay = await call('/interviews', { method: 'POST', body: {
    employee_id: find('Wes').id, client_ref: 'smoke-' + find('Wes').id } });
  ok(replay.id === ivWes.id, 'replayed client_ref returns the same interview (idempotent sync)');

  // Different client_ref, same person, interview still open: must NOT duplicate.
  const doubleTap = await call('/interviews', { method: 'POST', body: {
    employee_id: find('Wes').id, client_ref: 'smoke-double-' + find('Wes').id } });
  ok(doubleTap.id === ivWes.id, 'tapping Start twice reuses the open draft instead of duplicating',
     { got: doubleTap.id, expected: ivWes.id });

  const all = [ivMarcus, ivSofia, ivAndre, ivWes, ivNina, ivHector, ivDana, ivGreg, ivLisa, ivJo, ivKim];
  let completed = 0;
  for (const iv of all) {
    try { await call(`/interviews/${iv.id}/complete`, { method: 'POST', body: {} }); completed++; }
    catch (e) {
      if (e.status === 422) {
        await call(`/interviews/${iv.id}/complete`, { method: 'POST', body: { force: true } });
        completed++;
      } else throw e;
    }
  }
  ok(completed === 11, 'all 11 interviews completed', { completed });

  // a genuinely empty interview must be rejected without force
  const emptyEmp = await call(`/stores/${store.id}/employees`, { method: 'POST', body: {
    first_name: 'Test', last_name: 'Empty', position_title: 'Technician',
    template_key: 'technician', department: 'service' } });
  const emptyIv = await call('/interviews', { method: 'POST', body: { employee_id: emptyEmp.id } });
  let rejected = false;
  try { await call(`/interviews/${emptyIv.id}/complete`, { method: 'POST', body: {} }); }
  catch (e) { rejected = e.status === 422 && Array.isArray(e.data.missing) && e.data.missing.length > 0; }
  ok(rejected, 'empty interview blocked by required-field validation');

  // ---- Review must not create a second interview (regression) ----
  console.log('\nreview a completed interview');
  const beforeRows = await call(`/stores/${store.id}/interviews`);
  const reviewed = await call('/interviews', { method: 'POST', body: {
    employee_id: find('Marcus').id, client_ref: 'smoke-review-' + find('Marcus').id } });
  ok(reviewed.id === ivMarcus.id,
     'opening a completed interview returns the SAME interview, not a new blank one',
     { got: reviewed.id, expected: ivMarcus.id });
  ok(reviewed.status === 'complete', 'it comes back still marked complete');
  const afterRows = await call(`/stores/${store.id}/interviews`);
  ok(afterRows.length === beforeRows.length,
     'no extra interview row was created', { before: beforeRows.length, after: afterRows.length });

  // strays from the old behaviour are swept up, but only if truly empty
  const strayCheck = await call(`/stores/${store.id}/interviews`);
  ok(!strayCheck.some((r) => r.status === 'draft' && r.first_name === 'Marcus'),
     'blank drafts left by the old Review behaviour are cleaned up');

  const marcusRoster = (await call(`/stores/${store.id}/employees`))
    .find((p) => p.first_name === 'Marcus');
  ok(marcusRoster.interview_id === ivMarcus.id,
     'roster hands the UI the completed interview id so Review opens it directly');
  ok(marcusRoster.interview_status === 'complete', 'employee stays complete after a review');

  const detail = await call('/interviews/' + ivMarcus.id);
  ok(detail.answers.length > 10, 'review payload actually contains the answers',
     { answers: detail.answers.length });

  // an explicit re-interview is still possible, but only on purpose
  const reInterview = await call('/interviews', { method: 'POST', body: {
    employee_id: find('Marcus').id, force_new: true } });
  ok(reInterview.id !== ivMarcus.id && reInterview.status === 'draft',
     'force_new still allows a deliberate re-interview');
  await call(`/interviews/${reInterview.id}/complete`, { method: 'POST', body: { force: true } })
    .catch(() => {});
  // put things back so the analytics assertions below are unaffected
  await call(`/interviews/${reInterview.id}/reopen`, { method: 'POST', body: { reason: 'smoke cleanup' } })
    .catch(() => {});

  // ---- the analytics that justify the whole build ----
  console.log('\nanalytics');
  const facts = await call(`/stores/${store.id}/facts`);
  ok(facts.interview_count === 11, 'facts count only completed interviews', { got: facts.interview_count });
  ok(facts.coverage.no_form_assigned === 2, 'management excluded from coverage denominator');

  const psr = facts.dimensions.find((d) => d.dimension === 'parts_service_relationship');
  ok(!!psr, 'parts_service_relationship dimension exists');
  ok(psr.role_count === 4, 'all four roles pooled into one dimension', { got: psr.role_count });
  ok(psr.gap && psr.gap.highest.role === 'parts' && psr.gap.lowest.role === 'technician',
     'gap correctly identifies Parts highest / Technicians lowest',
     psr.gap && { hi: psr.gap.highest.role, lo: psr.gap.lowest.role });
  ok(psr.gap.spread >= 1.5, 'gap spread reflects the seeded disagreement', { spread: psr.gap?.spread });

  const pdc = facts.dimensions.find((d) => d.dimension === 'parts_delay_cause');
  ok(pdc && pdc.choice_divergence && pdc.choice_divergence.agree === false,
     'Parts and Techs flagged as naming different delay causes',
     pdc && pdc.choice_divergence);

  const pdel = facts.dimensions.find((d) => d.dimension === 'parts_delivery');
  ok(pdel && !pdel.choice_divergence.agree, 'parts delivery mirror question shows disagreement');

  const strongTechs = facts.nominations?.technician?.strongest || [];
  ok(strongTechs[0] && strongTechs[0].name === 'Marcus Bell' && strongTechs[0].count === 5,
     'Marcus Bell tops strongest-technician tally with 5 nominations',
     strongTechs[0] && { name: strongTechs[0].name, count: strongTechs[0].count });
  ok(Object.keys(strongTechs[0].by_role).length === 2,
     'nominations attributed across both nominating departments');

  const weakAdvisors = facts.nominations?.advisor?.needs_support || [];
  ok(weakAdvisors[0] && weakAdvisors[0].name === 'Greg Okafor',
     'Greg Okafor is the most-named advisor needing support',
     weakAdvisors[0] && { name: weakAdvisors[0].name, count: weakAdvisors[0].count });
  ok(weakAdvisors[0].reasons.length > 0, 'nomination reasons carried through');

  ok(Array.isArray(facts.never_nominated), 'never-nominated list present');
  ok(facts.verbatims.length > 0, 'verbatims collected for the narrative pass');
  ok(!facts.verbatims.some((v) => v.question_key === 'interviewer_notes'),
     'interviewer notes excluded from aggregation');

  // ---- reopen rebuilds nominations ----
  console.log('\nreopen');
  await call(`/interviews/${ivNina.id}/reopen`, { method: 'POST', body: { reason: 'smoke' } });
  await call(`/interviews/${ivNina.id}/answers`, { method: 'PUT', body: {
    answers: [{ question_key: 'nominate_strongest_tech', value: find('Andre').id }] } });
  await call(`/interviews/${ivNina.id}/complete`, { method: 'POST', body: { force: true } });
  const facts2 = await call(`/stores/${store.id}/facts`);
  const st2 = facts2.nominations.technician.strongest;
  ok(st2.find((n) => n.name === 'Marcus Bell').count === 4,
     'reopening an interview rebuilds the nomination graph',
     { count: st2.find((n) => n.name === 'Marcus Bell')?.count });

  // ---- leadership note on management ----
  console.log('\nleadership notes');
  await call(`/employees/${find('Ray').id}/leadership-notes`, { method: 'POST', body: {
    body: 'Says the shop is short two techs and he cannot get approval to hire.' } });
  const notes = await call(`/stores/${store.id}/leadership-notes`);
  ok(notes.length === 1 && notes[0].first_name === 'Ray', 'leadership note attached to the Service Manager');

  // ---- template versioning guard ----
  console.log('\ntemplate authoring');
  let blocked = false;
  try {
    await call('/templates', { method: 'POST', body: {
      template_key: 'service_manager', title: 'Service Manager Interview', status: 'published',
      sections: [{ title: 'X', questions: [{ key: 'rel_parts_service' }, { key: 'made_up_key' }] }] } });
  } catch (e) { blocked = e.status === 400 && e.data.error === 'unknown_question_keys'; }
  ok(blocked, 'publishing a survey with an unknown question key is blocked');

  const smTpl = await call('/templates', { method: 'POST', body: {
    template_key: 'service_manager', title: 'Service Manager Interview', status: 'published',
    applies_to: { positions: ['service manager'], department: 'management' },
    sections: [{ title: 'Relationships', questions: [
      { key: 'rel_parts_service', required: true },
      { key: 'sm_accountability_style' }] }] } });
  // Version is whatever comes next for this key -- republishing is supposed to
  // create a new version rather than mutate the old one, so don't pin it to 1.
  ok(smTpl.version >= 1 && smTpl.status === 'published',
     'new survey published without a code change', { version: smTpl.version });
  const smVersions = (await call('/templates')).filter((t) => t.template_key === 'service_manager');
  ok(smVersions.length === smTpl.version,
     'each publish adds a version rather than overwriting the previous one',
     { versions: smVersions.length, latest: smTpl.version });

  // The payoff: the new survey's answers pool into the EXISTING dimension.
  await call('/employees/' + find('Ray').id, { method: 'PATCH', body: {
    template_key: 'service_manager', interview_status: 'pending' } });
  const ivRay = await call('/interviews', { method: 'POST', body: { employee_id: find('Ray').id } });
  await call(`/interviews/${ivRay.id}/answers`, { method: 'PUT', body: {
    answers: [{ question_key: 'rel_parts_service', value: 3 },
              { question_key: 'sm_accountability_style', value: 'supportive' }] } });
  await call(`/interviews/${ivRay.id}/complete`, { method: 'POST', body: {} });
  const facts3 = await call(`/stores/${store.id}/facts`);
  const psr3 = facts3.dimensions.find((d) => d.dimension === 'parts_service_relationship');
  ok(psr3.role_count === 5, 'new survey drops into the existing cross-role dimension automatically',
     { role_count: psr3.role_count });
  ok(psr3.roles.some((r) => r.role === 'service_manager'), 'Service Manager appears in the gap chart');

  // ---- export ----
  console.log('\nexport');
  const csvRes = await fetch(`${BASE}/api/stores/${store.id}/export.csv`, { headers: { cookie } });
  const csv = await csvRes.text();
  ok(csv.split('\n').length > 50, 'CSV export produced rows', { lines: csv.split('\n').length });
  ok(csv.startsWith('first_name,last_name,'), 'CSV header correct');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nSMOKE ERROR:', e.message); process.exit(1); });
