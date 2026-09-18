'use strict';
/* User management tests, including the bootstrap path on an empty database. */
require('dotenv').config();
const BASE = process.env.SMOKE_BASE || `http://localhost:${process.env.PORT || 3000}`;
let pass = 0, fail = 0;

function ok(c, label, extra) {
  if (c) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' — ' + JSON.stringify(extra) : ''}`); }
}

function session() {
  let cookie = '';
  return async function call(path, opts = {}) {
    const res = await fetch(BASE + '/api' + path, {
      method: opts.method || 'GET',
      headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), cookie },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) { const e = new Error(JSON.stringify(data)); e.status = res.status; e.data = data; throw e; }
    return data;
  };
}

const RUN = Date.now().toString(36);
const addr = (who) => `${who}+${RUN}@chriscollinsinc.com`;
const DANA = addr('dana'), SAM = addr('sam'), ADMIN2 = addr('admin2');

(async () => {
  console.log(`user management smoke -> ${BASE}  (run ${RUN})\n`);
  const admin = session();

  // ---- bootstrap ----
  console.log('first-run bootstrap');
  const st = await admin('/setup/status');
  if (st.needs_setup) {
    const b = await admin('/setup/bootstrap', { method: 'POST', body: {
      name: 'Mike', email: 'mike@chriscollinsinc.com', password: 'anchor-ridge-417' } });
    ok(b.user.role === 'admin', 'bootstrap creates an admin and signs them in');
  } else {
    ok(true, 'database already has users (bootstrap path skipped)');
    await admin('/auth/login', { method: 'POST', body: {
      email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD } });
  }

  let blocked = false;
  try { await admin('/setup/bootstrap', { method: 'POST', body: {
    name: 'Attacker', email: addr('evil'), password: 'anchor-ridge-999' } }); }
  catch (e) { blocked = e.status === 409; }
  ok(blocked, 'bootstrap refuses to run once any user exists');

  // ---- password policy ----
  console.log('\npassword policy');
  for (const [pw, why] of [['short', 'too short'], ['1234567890123', 'all digits'],
                           ['mypassword123', 'predictable']]) {
    let rejected = false;
    try { await admin('/users', { method: 'POST', body: {
      name: 'X', email: addr('x'+Math.random().toString(36).slice(2)), password: pw } }); }
    catch (e) { rejected = e.status === 400 && e.data.error === 'weak_password'; }
    ok(rejected, `rejects a ${why} password`);
  }

  // ---- create logins ----
  console.log('\ncreating logins');
  const consultant = await admin('/users', { method: 'POST', body: {
    name: 'Dana Reyes', email: DANA, password: 'cedar-harbor-208', role: 'consultant' } });
  ok(consultant.role === 'consultant', 'consultant login created');

  const lead = await admin('/users', { method: 'POST', body: {
    name: 'Sam Doyle', email: SAM, password: 'lantern-pivot-733', role: 'lead' } });
  ok(lead.role === 'lead', 'lead login created');

  const admin2 = await admin('/users', { method: 'POST', body: {
    name: 'Second Admin', email: ADMIN2, password: 'summit-tundra-591', role: 'admin' } });
  ok(admin2.role === 'admin', 'second admin created');

  let dup = false;
  try { await admin('/users', { method: 'POST', body: {
    name: 'Dupe', email: DANA.toUpperCase(), password: 'granite-marlin-330' } }); }
  catch (e) { dup = e.status === 409 && e.data.error === 'email_taken'; }
  ok(dup, 'duplicate email rejected case-insensitively');

  let badRole = false;
  try { await admin('/users', { method: 'POST', body: {
    name: 'Nope', email: addr('nope'), password: 'kestrel-onyx-144', role: 'superuser' } }); }
  catch (e) { badRole = e.status === 400 && e.data.error === 'bad_role'; }
  ok(badRole, 'unknown role rejected');

  // ---- the new consultant can actually sign in and work ----
  console.log('\nnew login works');
  const danaS = session();
  const who = await danaS('/auth/login', { method: 'POST', body: {
    email: DANA, password: 'cedar-harbor-208' } });
  ok(who.user.name === 'Dana Reyes', 'new consultant can sign in');
  const engs = await danaS('/engagements');
  ok(Array.isArray(engs), 'consultant can read engagements');

  let forbidden = false;
  try { await danaS('/users'); } catch (e) { forbidden = e.status === 403; }
  ok(forbidden, 'consultant cannot list logins');

  forbidden = false;
  try { await danaS('/users', { method: 'POST', body: {
    name: 'Self Promoted', email: addr('sp'), password: 'nimbus-quarry-802', role: 'admin' } }); }
  catch (e) { forbidden = e.status === 403; }
  ok(forbidden, 'consultant cannot create logins');

  // lead can reopen, consultant cannot — role boundary that actually matters
  forbidden = false;
  try { await danaS('/interviews/00000000-0000-0000-0000-000000000000/reopen', { method: 'POST', body: {} }); }
  catch (e) { forbidden = e.status === 403; }
  ok(forbidden, 'consultant cannot reopen a completed interview');

  const samS = session();
  await samS('/auth/login', { method: 'POST', body: {
    email: SAM, password: 'lantern-pivot-733' } });
  let notFound = false;
  try { await samS('/interviews/00000000-0000-0000-0000-000000000000/reopen', { method: 'POST', body: {} }); }
  catch (e) { notFound = e.status === 404; }
  ok(notFound, 'lead passes the role check on reopen (404 on a fake id, not 403)');

  // ---- last-admin protection ----
  console.log('\nlast-admin protection');
  await admin('/users/' + admin2.id, { method: 'PATCH', body: { role: 'consultant' } });
  const me = await admin('/auth/me');
  let lastAdmin = false;
  try { await admin('/users/' + me.user.id, { method: 'PATCH', body: { role: 'consultant' } }); }
  catch (e) { lastAdmin = e.status === 409 && e.data.error === 'last_admin'; }
  ok(lastAdmin, 'the only remaining admin cannot demote themselves');

  lastAdmin = false;
  try { await admin('/users/' + me.user.id, { method: 'PATCH', body: { active: false } }); }
  catch (e) { lastAdmin = ['last_admin', 'cannot_deactivate_self'].includes(e.data.error); }
  ok(lastAdmin, 'the only remaining admin cannot switch themselves off');

  // with a second admin restored, demotion is allowed again
  await admin('/users/' + admin2.id, { method: 'PATCH', body: { role: 'admin' } });
  const demoted = await admin('/users/' + admin2.id, { method: 'PATCH', body: { role: 'lead' } });
  ok(demoted.role === 'lead', 'demotion allowed while another admin remains');

  // ---- disable / re-enable ----
  console.log('\ndisable and re-enable');
  await admin('/users/' + consultant.id, { method: 'PATCH', body: { active: false } });
  let denied = false;
  try { await session()('/auth/login', { method: 'POST', body: {
    email: DANA, password: 'cedar-harbor-208' } }); }
  catch (e) { denied = e.status === 401; }
  ok(denied, 'disabled login cannot sign in');

  await admin('/users/' + consultant.id, { method: 'PATCH', body: { active: true } });
  const back = await session()('/auth/login', { method: 'POST', body: {
    email: DANA, password: 'cedar-harbor-208' } });
  ok(back.user.id === consultant.id, 're-enabled login works again');

  // ---- password reset by admin, and self-service change ----
  console.log('\npasswords');
  await admin(`/users/${consultant.id}/password`, { method: 'POST', body: { password: 'juniper-beacon-615' } });
  const reset = await session()('/auth/login', { method: 'POST', body: {
    email: DANA, password: 'juniper-beacon-615' } });
  ok(reset.user.id === consultant.id, 'admin password reset takes effect');

  const dana2 = session();
  await dana2('/auth/login', { method: 'POST', body: {
    email: DANA, password: 'juniper-beacon-615' } });
  let wrongCur = false;
  try { await dana2('/me/password', { method: 'POST', body: {
    current_password: 'not-it-at-all', password: 'ember-fathom-901' } }); }
  catch (e) { wrongCur = e.status === 401; }
  ok(wrongCur, 'self-service change requires the correct current password');

  await dana2('/me/password', { method: 'POST', body: {
    current_password: 'juniper-beacon-615', password: 'ember-fathom-901' } });
  const changed = await session()('/auth/login', { method: 'POST', body: {
    email: DANA, password: 'ember-fathom-901' } });
  ok(changed.user.id === consultant.id, 'self-service password change takes effect');

  // ---- audit trail ----
  console.log('\naudit');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  const { rows } = await pool.query(
    `select action, count(*)::int n from audit_log
      where action like 'user.%' or action like 'setup.%' group by 1 order by 1`);
  await pool.end();
  const actions = rows.map((r) => r.action);
  ok(actions.includes('user.create'), 'user creation audited');
  ok(actions.includes('user.password_reset'), 'password reset audited');
  ok(actions.includes('user.update'), 'role and status changes audited');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nSMOKE ERROR:', e.message); process.exit(1); });
