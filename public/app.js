'use strict';
/* CCI Staff Interviews — iPad-first PWA.
   Design constraint that shapes everything below: dealership wifi is unreliable
   and an interview is ~40 minutes of someone's candour. The device owns the
   draft. The server is a sync target, not a dependency. */

// ============================================================ IndexedDB

const DB_NAME = 'cci-interviews';
const DB_VER = 1;
let _db = null;

function idb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('drafts')) d.createObjectStore('drafts', { keyPath: 'client_ref' });
      if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache', { keyPath: 'key' });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, val) {
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readwrite');
    t.objectStore(store).put(val);
    t.oncomplete = () => res(true); t.onerror = () => rej(t.error);
  });
}
async function idbGet(store, key) {
  const d = await idb();
  return new Promise((res, rej) => {
    const r = d.transaction(store, 'readonly').objectStore(store).get(key);
    r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
  });
}
async function idbAll(store) {
  const d = await idb();
  return new Promise((res, rej) => {
    const r = d.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
  });
}
async function idbDel(store, key) {
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readwrite');
    t.objectStore(store).delete(key);
    t.oncomplete = () => res(true); t.onerror = () => rej(t.error);
  });
}

// ============================================================ API

const state = { user: null, online: navigator.onLine, syncing: false };

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin'
  });
  if (res.status === 401) { state.user = null; go('#/login'); throw new Error('not_authenticated'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) { const e = new Error(data.error || res.statusText); e.data = data; e.status = res.status; throw e; }
  return data;
}

// Cache GETs that the interview runner needs offline (templates, rosters).
async function apiCached(path) {
  try {
    const data = await api(path);
    await idbPut('cache', { key: path, data, at: Date.now() }).catch(() => {});
    return data;
  } catch (e) {
    const hit = await idbGet('cache', path).catch(() => null);
    if (hit) return hit.data;
    throw e;
  }
}

// ============================================================ outbox

async function queue(job) { await idbPut('outbox', job); }

async function flushOutbox() {
  if (state.syncing || !navigator.onLine) return;
  state.syncing = true;
  try {
    const jobs = (await idbAll('outbox')).sort((a, b) => a.id - b.id);
    for (const j of jobs) {
      try {
        await api(j.path, { method: j.method, body: j.body });
        await idbDel('outbox', j.id);
      } catch (e) {
        // 4xx means this job will never succeed — drop it rather than wedge the queue.
        if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
          console.warn('dropping unsendable job', j.path, e.message);
          await idbDel('outbox', j.id);
          continue;
        }
        break;   // network problem: stop, retry later, preserve order
      }
    }
  } finally {
    state.syncing = false;
    renderNet();
  }
}

async function outboxCount() { return (await idbAll('outbox')).length; }

// ============================================================ helpers

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(kid) : kid);
  }
  return n;
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const initials = (f, l) => ((f || '')[0] || '').toUpperCase() + ((l || '')[0] || '').toUpperCase();
// Survey keys are snake_case in the database; never show them to a consultant.
const SURVEY_LABEL = { technician: 'Technician', service_advisor: 'Service Advisor',
  parts: 'Parts', support_staff: 'Support Staff' };
const surveyLabel = (k) => SURVEY_LABEL[k] ||
  String(k || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
// "Service Advisor · Service Advisor" reads like a bug. Only name the survey
// when it differs from the dealer's own job title.
function subtitleFor(p) {
  const title = (p.position_title || '').trim();
  const survey = surveyLabel(p.template_key);
  if (!title) return survey || '';
  if (!survey) return title;
  return title.toLowerCase() === survey.toLowerCase() ? title : `${title} · ${survey}`;
}
const esc = (s) => String(s ?? '');
const go = (hash) => { location.hash = hash; };

function setTitle(t, back) {
  $('#title').textContent = t;
  const bm = $('#brandmark');
  if (bm) bm.hidden = !state.user;   // signed-out screens use the hero instead
  const b = $('#backBtn');
  b.hidden = !back;
  b.onclick = () => (typeof back === 'string' ? go(back) : history.back());
  $('#logoutBtn').hidden = !state.user;
}

function renderNet() {
  const pill = $('#net');
  outboxCount().then((n) => {
    if (!navigator.onLine) { pill.className = 'netpill offline'; pill.textContent = n ? `offline · ${n} queued` : 'offline'; }
    else if (n) { pill.className = 'netpill offline'; pill.textContent = `syncing ${n}`; }
    else { pill.className = 'netpill online'; pill.textContent = 'online'; }
  }).catch(() => {});
}

function view(...nodes) {
  const app = $('#app');
  app.innerHTML = '';
  app.className = '';
  for (const n of nodes.flat()) if (n) app.appendChild(n);
}

function banner(kind, text) { return el('div', { class: 'banner ' + kind }, text); }

// ============================================================ router

const routes = [
  [/^#\/login$/,                         () => screenLogin()],
  [/^#\/setup$/,                         () => screenSetup()],
  [/^#\/team$/,                          () => screenTeam()],
  [/^#\/account$/,                       () => screenAccount()],
  [/^#\/$/,                              () => screenEngagements()],
  [/^#\/engagements$/,                   () => screenEngagements()],
  [/^#\/engagement\/([\w-]+)$/,          (m) => screenEngagement(m[1])],
  [/^#\/store\/([\w-]+)$/,               (m) => screenStore(m[1])],
  [/^#\/store\/([\w-]+)\/import$/,       (m) => screenImport(m[1])],
  [/^#\/store\/([\w-]+)\/dashboard$/,    (m) => screenDashboard(m[1])],
  [/^#\/interview\/([\w-]+)$/,           (m) => screenInterview(m[1])],
  [/^#\/analysis\/([\w-]+)$/,            (m) => screenAnalysis(m[1])]
];

async function route() {
  const h = location.hash || '#/';
  if (!state.user && h !== '#/login' && h !== '#/setup') {
    try { const me = await api('/auth/me'); state.user = me.user; }
    catch (_) { return screenLogin(); }
  }
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (m) { try { return await fn(m); } catch (e) { return view(banner('err', e.message)); } }
  }
  go('#/');
}

// ============================================================ screens

function brandHero(sub) {
  return el('div', { class: 'brandhero' },
    el('img', { src: '/icons/cci-logo.png', alt: 'Chris Collins Inc.' }),
    el('div', { class: 'sub' }, sub));
}

async function screenLogin() {
  setTitle('Sign in', false);
  // A brand-new deployment has no users yet; let the first admin be created
  // here rather than from a Render shell.
  try {
    const st = await api('/setup/status');
    if (st.needs_setup) return screenSetup();
  } catch (_) { /* offline or API down — fall through to the normal form */ }
  const email = el('input', { type: 'email', autocomplete: 'username', placeholder: 'you@chriscollinsinc.com' });
  const pw = el('input', { type: 'password', autocomplete: 'current-password' });
  const err = el('div');
  const form = el('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault(); err.innerHTML = '';
      try {
        const r = await api('/auth/login', { method: 'POST', body: { email: email.value, password: pw.value } });
        state.user = r.user; go('#/');
      } catch (_) { err.appendChild(banner('err', 'Email or password not recognised.')); }
    } },
    el('label', { class: 'field' }, el('span', { class: 'label' }, 'Email'), email),
    el('label', { class: 'field' }, el('span', { class: 'label' }, 'Password'), pw),
    err,
    el('button', { class: 'btn primary', type: 'submit' }, 'Sign in'));
  view(brandHero('Staff Interview System'), form);
}

// ------------------------------------------------------------ first-run setup

async function screenSetup() {
  setTitle('Set up this app', false);
  let st;
  try { st = await api('/setup/status'); }
  catch (e) { return view(banner('err', 'Cannot reach the server.')); }
  if (!st.needs_setup) {
    return view(banner('info', 'This app is already set up.'),
      el('button', { class: 'btn primary', onclick: () => go('#/login') }, 'Go to sign in'));
  }

  const name = el('input', { type: 'text', autocomplete: 'name', placeholder: 'Your name' });
  const email = el('input', { type: 'email', autocomplete: 'username' });
  const pw = el('input', { type: 'password', autocomplete: 'new-password' });
  const pw2 = el('input', { type: 'password', autocomplete: 'new-password' });
  const err = el('div');

  view(brandHero('Staff Interview System'),
    el('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault(); err.innerHTML = '';
      if (pw.value !== pw2.value) { err.appendChild(banner('err', 'Passwords do not match.')); return; }
      try {
        const r = await api('/setup/bootstrap', { method: 'POST',
          body: { name: name.value, email: email.value, password: pw.value } });
        state.user = r.user; go('#/');
      } catch (ex) {
        err.appendChild(banner('err', ex.data?.message || 'Could not create the account.'));
      }
    } },
    el('h3', {}, 'Create the first admin'),
    el('p', { class: 'muted small' },
      'This is a new installation with no users yet. This account will be an admin and can add everyone else.'),
    el('label', { class: 'field' }, el('span', { class: 'label' }, 'Name'), name),
    el('label', { class: 'field' }, el('span', { class: 'label' }, 'Email'), email),
    el('label', { class: 'field' }, el('span', { class: 'label' }, 'Password',
      el('span', { class: 'help' }, 'At least 10 characters.')), pw),
    el('label', { class: 'field' }, el('span', { class: 'label' }, 'Confirm password'), pw2),
    err,
    el('button', { class: 'btn primary', type: 'submit' }, 'Create admin account')));
}

// ------------------------------------------------------------ team / users

const ROLE_HELP = {
  consultant: 'Runs interviews, sees rosters and analysis.',
  lead: 'Everything a consultant can do, plus reopening completed interviews and locking them.',
  admin: 'Everything, plus managing logins and publishing new surveys.'
};

async function screenTeam() {
  if (state.user?.role !== 'admin') {
    setTitle('Team', '#/');
    return view(banner('warn', 'Only admins can manage logins.'));
  }
  setTitle('Team', '#/');
  const users = await api('/users');

  const roleSelect = (u) => {
    const sel = el('select', { onchange: async (e) => {
      const role = e.target.value;
      try { await api('/users/' + u.id, { method: 'PATCH', body: { role } }); route(); }
      catch (ex) { alert(ex.data?.message || ex.message); route(); }
    } });
    for (const r of ['consultant', 'lead', 'admin']) {
      sel.appendChild(el('option', { value: r, selected: u.role === r },
        r[0].toUpperCase() + r.slice(1)));
    }
    return sel;
  };

  const row = (u) => el('div', { class: 'person' },
    el('div', { class: 'avatar' }, initials(...u.name.split(' '))),
    el('div', { class: 'grow' },
      el('div', {}, u.name, u.id === state.user.id ? el('span', { class: 'muted small' }, '  (you)') : null),
      el('div', { class: 'muted small' },
        [u.email, u.interview_count ? `${u.interview_count} interviews` : null].filter(Boolean).join(' · '))),
    u.active ? roleSelect(u) : el('span', { class: 'tag skip' }, 'disabled'),
    el('button', { class: 'btn ghost', onclick: () => userMenu(u) }, '⋯'));

  const active = users.filter((u) => u.active);
  const inactive = users.filter((u) => !u.active);

  view(
    el('div', { class: 'row between' }, el('h2', {}, 'Logins'),
      el('button', { class: 'btn primary', onclick: newUser }, '+ Add person')),
    el('div', { class: 'card', style: 'padding:0' }, active.map(row)),
    inactive.length ? el('h2', {}, 'Disabled') : null,
    inactive.length ? el('div', { class: 'card', style: 'padding:0' }, inactive.map(row)) : null,
    el('div', { class: 'card' },
      el('h3', {}, 'Roles'),
      Object.entries(ROLE_HELP).map(([r, d]) => el('div', { class: 'small', style: 'margin-bottom:6px' },
        el('strong', {}, r[0].toUpperCase() + r.slice(1) + ': '), d))));
}

function userForm({ title, submitLabel, onSubmit, withRole = true }) {
  const dlg = el('dialog');
  const name = el('input', { type: 'text', autocomplete: 'off' });
  const email = el('input', { type: 'email', autocomplete: 'off' });
  const pw = el('input', { type: 'password', autocomplete: 'new-password' });
  const role = el('select', {},
    el('option', { value: 'consultant' }, 'Consultant'),
    el('option', { value: 'lead' }, 'Lead'),
    el('option', { value: 'admin' }, 'Admin'));
  const err = el('div');

  const gen = el('button', { class: 'btn ghost small', type: 'button', onclick: () => {
    // Generated so an admin never has to invent one for a colleague.
    const words = 'anchor,beacon,cedar,dynamo,ember,fathom,granite,harbor,ingot,juniper,kestrel,lantern,marlin,nimbus,onyx,pivot,quarry,ridge,summit,tundra'.split(',');
    const pick = () => words[Math.floor(Math.random() * words.length)];
    pw.value = `${pick()}-${pick()}-${Math.floor(100 + Math.random() * 900)}`;
    pw.type = 'text';
  } }, 'Generate');

  dlg.appendChild(el('div', { class: 'dlg' },
    el('h3', {}, title),
    el('label', { class: 'field' }, el('span', { class: 'label' }, 'Name'), name),
    el('label', { class: 'field' }, el('span', { class: 'label' }, 'Email'), email),
    withRole ? el('label', { class: 'field' }, el('span', { class: 'label' }, 'Role'), role) : null,
    el('label', { class: 'field' },
      el('span', { class: 'label' }, 'Password', el('span', { class: 'help' }, 'At least 10 characters.')),
      el('div', { class: 'row' }, el('span', { class: 'grow' }, pw), gen)),
    err,
    el('div', { class: 'btnrow' },
      el('button', { class: 'btn primary', onclick: async () => {
        err.innerHTML = '';
        try {
          await onSubmit({ name: name.value, email: email.value, password: pw.value, role: role.value });
          dlg.close(); route();
        } catch (ex) { err.appendChild(banner('err', ex.data?.message || ex.data?.error || ex.message)); }
      } }, submitLabel),
      el('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'))));

  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  name.focus();
}

function newUser() {
  userForm({
    title: 'Add a login', submitLabel: 'Create login',
    onSubmit: (body) => api('/users', { method: 'POST', body })
  });
}

async function userMenu(u) {
  const choice = prompt(
    `${u.name}\n\n1 Reset password\n2 ${u.active ? 'Disable' : 'Re-enable'} this login\n\nEnter number:`);
  if (choice === '1') {
    const pw = prompt('New password (at least 10 characters)');
    if (!pw) return;
    try { await api(`/users/${u.id}/password`, { method: 'POST', body: { password: pw } });
      alert('Password updated. Give it to them directly — it is not emailed.'); }
    catch (e) { alert(e.data?.message || e.message); }
  } else if (choice === '2') {
    try { await api('/users/' + u.id, { method: 'PATCH', body: { active: !u.active } }); route(); }
    catch (e) { alert(e.data?.message || e.message); }
  }
}

async function screenAccount() {
  setTitle('My account', '#/');
  const cur = el('input', { type: 'password', autocomplete: 'current-password' });
  const pw = el('input', { type: 'password', autocomplete: 'new-password' });
  const pw2 = el('input', { type: 'password', autocomplete: 'new-password' });
  const msg = el('div');

  view(el('div', { class: 'card' },
    el('h3', {}, state.user.name),
    el('div', { class: 'muted small', style: 'margin-bottom:14px' }, `${state.user.email} · ${state.user.role}`),
    el('label', { class: 'field' }, el('span', { class: 'label' }, 'Current password'), cur),
    el('label', { class: 'field' }, el('span', { class: 'label' }, 'New password'), pw),
    el('label', { class: 'field' }, el('span', { class: 'label' }, 'Confirm new password'), pw2),
    msg,
    el('button', { class: 'btn primary', onclick: async () => {
      msg.innerHTML = '';
      if (pw.value !== pw2.value) { msg.appendChild(banner('err', 'Passwords do not match.')); return; }
      try {
        await api('/me/password', { method: 'POST',
          body: { current_password: cur.value, password: pw.value } });
        msg.appendChild(banner('info', 'Password changed.'));
        cur.value = pw.value = pw2.value = '';
      } catch (e) {
        msg.appendChild(banner('err', e.data?.message ||
          (e.status === 401 ? 'Current password is not correct.' : e.message)));
      }
    } }, 'Change password')));
}

async function screenEngagements() {
  setTitle('Engagements', false);
  const list = await api('/engagements');
  const nodes = list.map((e) => el('div', { class: 'card tap', onclick: () => go('#/engagement/' + e.id) },
    el('div', { class: 'row between' },
      el('div', { class: 'grow' },
        el('h3', {}, e.client_name),
        el('div', { class: 'muted small' },
          [e.dealer_group, `${e.store_count} store${e.store_count === 1 ? '' : 's'}`,
           `${e.complete_count}/${e.roster_count} interviewed`].filter(Boolean).join(' · '))),
      el('span', { class: 'tag ' + (e.status === 'complete' ? 'complete' : e.status === 'fieldwork' ? 'working' : '') }, e.status))));

  view(
    el('div', { class: 'row between' }, el('h2', {}, 'Engagements'),
      el('div', { class: 'btnrow' },
        state.user?.role === 'admin'
          ? el('button', { class: 'btn', onclick: () => go('#/team') }, 'Team') : null,
        el('button', { class: 'btn ghost', onclick: () => go('#/account') }, 'Account'),
        el('button', { class: 'btn primary', onclick: newEngagement }, '+ New'))),
    nodes.length ? nodes : el('p', { class: 'muted' }, 'No engagements yet.'));
}

async function newEngagement() {
  const name = prompt('Client name (dealership or group)');
  if (!name) return;
  const e = await api('/engagements', { method: 'POST', body: { client_name: name } });
  go('#/engagement/' + e.id);
}

async function screenEngagement(id) {
  const e = await api('/engagements/' + id);
  setTitle(e.client_name, '#/');
  const stores = e.stores.map((s) => el('div', { class: 'card tap', onclick: () => go('#/store/' + s.id) },
    el('div', { class: 'row between' },
      el('div', { class: 'grow' }, el('h3', {}, s.name),
        el('div', { class: 'muted small' },
          `${s.complete_count}/${s.interviewable_count} interviewed · ${s.roster_count} on roster`)),
      el('div', { class: 'progress', style: 'width:80px' },
        el('i', { style: `width:${s.interviewable_count ? Math.round(100 * s.complete_count / s.interviewable_count) : 0}%` })))));

  view(
    el('div', { class: 'row between' }, el('h2', {}, 'Stores'),
      el('button', { class: 'btn primary', onclick: async () => {
        const n = prompt('Store name'); if (!n) return;
        await api(`/engagements/${id}/stores`, { method: 'POST', body: { name: n } });
        route();
      } }, '+ Store')),
    stores.length ? stores : el('p', { class: 'muted' }, 'No stores yet. Add one to load its roster.'));
}

async function screenStore(id) {
  const [store, people] = await Promise.all([
    apiCached('/stores/' + id), apiCached(`/stores/${id}/employees`)]);
  setTitle(store.name, '#/engagement/' + store.engagement_id);

  const interviewable = people.filter((p) => p.template_key);
  const done = interviewable.filter((p) => p.interview_status === 'complete');
  const noForm = people.filter((p) => !p.template_key);

  const tagFor = (p) => {
    const s = p.interview_status;
    if (s === 'complete') return el('span', { class: 'tag complete' }, 'done');
    if (s === 'in_progress') return el('span', { class: 'tag working' }, 'in progress');
    if (['no_show', 'declined', 'no_longer_employed'].includes(s))
      return el('span', { class: 'tag skip' }, s.replace(/_/g, ' '));
    if (s === 'not_applicable') return el('span', { class: 'tag na' }, 'no survey');
    return el('span', { class: 'tag' }, 'pending');
  };

  const personRow = (p) => el('div', { class: 'person' },
    el('div', { class: 'avatar' }, initials(p.first_name, p.last_name)),
    el('div', { class: 'grow' },
      el('div', {}, `${p.first_name} ${p.last_name}`),
      el('div', { class: 'muted small' }, subtitleFor(p))),
    tagFor(p),
    p.template_key
      ? el('button', { class: 'btn',
          // An existing interview is opened by id. Only a genuinely new one
          // goes through startInterview, which creates the record.
          onclick: () => (p.interview_id ? go('#/interview/' + p.interview_id) : startInterview(p)) },
          p.interview_status === 'complete' ? 'Review' : p.interview_status === 'in_progress' ? 'Resume' : 'Start')
      : el('button', { class: 'btn ghost', onclick: () => leadershipNote(p) }, 'Note'),
    el('button', { class: 'btn ghost', onclick: () => personMenu(p, id) }, '⋯'));

  view(
    el('div', { class: 'tiles' },
      el('div', { class: 'tile' }, el('div', { class: 'v mono' }, `${done.length}/${interviewable.length}`),
        el('div', { class: 'k' }, 'interviewed')),
      el('div', { class: 'tile' }, el('div', { class: 'v mono' }, String(people.length)),
        el('div', { class: 'k' }, 'on roster')),
      el('div', { class: 'tile' }, el('div', { class: 'v mono' }, String(noForm.length)),
        el('div', { class: 'k' }, 'no survey yet'))),

    el('div', { class: 'btnrow', style: 'margin:14px 0' },
      el('button', { class: 'btn', onclick: () => go(`#/store/${id}/import`) }, 'Import roster'),
      el('button', { class: 'btn', onclick: () => addPerson(id) }, '+ Add person'),
      el('button', { class: 'btn primary', onclick: () => go(`#/store/${id}/dashboard`) }, 'Analysis')),

    interviewable.length ? el('h2', {}, 'Roster') : null,
    interviewable.length ? el('div', { class: 'card', style: 'padding:0' }, interviewable.map(personRow)) : null,

    noForm.length ? el('h2', {}, 'No survey assigned') : null,
    noForm.length ? banner('info',
      'Management is interviewed one-on-one by the lead consultant today. They stay on the roster so they can be named in answers, counted in the org picture, and picked up automatically when a management survey is added.') : null,
    noForm.length ? el('div', { class: 'card', style: 'padding:0' }, noForm.map(personRow)) : null);
}

async function startInterview(p, forceNew = false) {
  const client_ref = uid();
  try {
    const iv = await api('/interviews', { method: 'POST',
      body: { employee_id: p.id, client_ref, force_new: forceNew || undefined } });
    go('#/interview/' + iv.id);
  } catch (e) {
    if (!navigator.onLine) {
      alert('You are offline. Start this interview once before going into the shop — after that it works offline.');
    } else alert(e.data?.detail || e.message);
  }
}

async function addPerson(storeId) {
  const name = prompt('Name (First Last)'); if (!name) return;
  const pos = prompt('Position / title') || '';
  const parts = name.trim().split(/\s+/);
  const prev = await api(`/stores/${storeId}/roster/preview`,
    { method: 'POST', body: { text: `${parts[0]}\t${parts.slice(1).join(' ')}\t${pos}` } });
  const r = prev.rows[0] || {};
  await api(`/stores/${storeId}/employees`, { method: 'POST', body: {
    first_name: parts[0], last_name: parts.slice(1).join(' '), position_title: pos,
    template_key: r.template_key, department: r.department } });
  route();
}

async function personMenu(p, storeId) {
  const choice = prompt(
    `${p.first_name} ${p.last_name}\n\nSet status:\n1 pending\n2 no show\n3 declined\n4 no longer employed\n5 change survey type\n\nEnter number:`);
  const map = { '1': 'pending', '2': 'no_show', '3': 'declined', '4': 'no_longer_employed' };
  if (map[choice]) {
    await api('/employees/' + p.id, { method: 'PATCH', body: { interview_status: map[choice] } });
    return route();
  }
  if (choice === '5') {
    const t = prompt('Survey: technician / service_advisor / parts / support_staff / none', p.template_key || 'none');
    if (!t) return;
    const key = t === 'none' ? null : t.trim();
    await api('/employees/' + p.id, { method: 'PATCH', body: {
      template_key: key, interview_status: key ? 'pending' : 'not_applicable' } });
    route();
  }
}

async function leadershipNote(p) {
  const body = prompt(`Note from the one-on-one with ${p.first_name} ${p.last_name}`);
  if (!body || !body.trim()) return;
  await api(`/employees/${p.id}/leadership-notes`, { method: 'POST', body: { body } });
  alert('Saved.');
}

// ------------------------------------------------------------ roster import

async function screenImport(storeId) {
  const store = await api('/stores/' + storeId);
  setTitle('Import roster — ' + store.name, '#/store/' + storeId);

  const ta = el('textarea', { rows: 10, placeholder:
    'Paste from a spreadsheet or email. One person per line:\n\nJohn\tSmith\tService Advisor\nMaria\tGarcia\tLube Tech\nDan Wu, Parts Counter' });
  const out = el('div');

  const preview = async () => {
    const r = await api(`/stores/${storeId}/roster/preview`, { method: 'POST', body: { text: ta.value } });
    out.innerHTML = '';
    if (!r.rows.length) { out.appendChild(banner('warn', 'Nothing parsed. Check the separators.')); return; }

    const sel = (row, i) => {
      const s = el('select', { onchange: (e) => { row.template_key = e.target.value || null; } });
      for (const [v, label] of [['', '— no survey (management) —'], ['technician', 'Technician'],
        ['service_advisor', 'Service Advisor'], ['parts', 'Parts'], ['support_staff', 'Support Staff']]) {
        s.appendChild(el('option', { value: v, selected: (row.template_key || '') === v }, label));
      }
      return s;
    };

    const tbl = el('table', { class: 'grid' },
      el('tr', {}, el('th', {}, 'First'), el('th', {}, 'Last'), el('th', {}, 'Title as given'),
        el('th', {}, 'Survey'), el('th', {}, 'Match')));
    r.rows.forEach((row, i) => tbl.appendChild(el('tr', {},
      el('td', {}, row.first_name), el('td', {}, row.last_name),
      el('td', { class: 'muted' }, row.position_title || '—'),
      el('td', {}, sel(row, i)),
      el('td', { class: 'small muted' }, row.confidence === 'none' ? 'unrecognised' : row.confidence))));

    const unknown = r.rows.filter((x) => x.confidence === 'none' && x.position_title).length;
    out.appendChild(el('div', { class: 'card' },
      unknown ? banner('warn', `${unknown} title${unknown === 1 ? '' : 's'} not recognised — set the survey manually. The app remembers your choice for next time.`) : null,
      tbl,
      el('div', { class: 'btnrow', style: 'margin-top:14px' },
        el('button', { class: 'btn primary', onclick: async () => {
          await api(`/stores/${storeId}/roster/import`, { method: 'POST', body: { rows: r.rows } });
          go('#/store/' + storeId);
        } }, `Import ${r.rows.length} people`))));
  };

  view(
    el('div', { class: 'card' },
      el('label', { class: 'field' },
        el('span', { class: 'label' }, 'Roster',
          el('span', { class: 'help' }, 'First name, last name, position. Tabs, commas or pipes all work.')),
        ta),
      el('button', { class: 'btn', onclick: preview }, 'Preview mapping')),
    out);
}

// ------------------------------------------------------------ interview runner

async function screenInterview(interviewId) {
  const iv = await apiCached('/interviews/' + interviewId);
  const tpl = await apiCached('/templates/' + iv.template_key + '/current');
  const catalog = new Map(tpl.catalog.map((q) => [q.key, q]));

  // Local draft wins over server state: the device is the source of truth.
  const draftKey = 'iv:' + interviewId;
  const local = await idbGet('drafts', draftKey);
  const answers = new Map();
  for (const a of iv.answers || []) answers.set(a.question_key, { value: a.value, other_text: a.other_text });
  if (local && local.answers) for (const [k, v] of Object.entries(local.answers)) answers.set(k, v);

  setTitle(`${iv.first_name} ${iv.last_name}`, '#/store/' + iv.store_id);

  let sectionIdx = 0;
  let dirty = new Set();
  const saveState = el('span', { class: 'savestate' }, 'All changes saved');

  const persistLocal = async () => {
    await idbPut('drafts', { client_ref: draftKey, interview_id: interviewId,
      answers: Object.fromEntries(answers), at: Date.now() }).catch(() => {});
  };

  let saveTimer = null;
  const scheduleSave = () => {
    persistLocal();
    saveState.textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(pushAnswers, 1200);
  };

  async function pushAnswers() {
    if (!dirty.size) { saveState.textContent = 'All changes saved'; return; }
    const payload = [...dirty].map((k) => ({ question_key: k, ...answers.get(k) }));
    const job = { path: `/interviews/${interviewId}/answers`, method: 'PUT', body: { answers: payload } };
    dirty = new Set();
    try {
      if (!navigator.onLine) throw new Error('offline');
      await api(job.path, { method: job.method, body: job.body });
      saveState.textContent = 'All changes saved';
    } catch (_) {
      await queue(job);
      saveState.textContent = 'Saved on this iPad — will sync when back online';
    }
    renderNet();
  }

  const setAnswer = (key, value, other) => {
    answers.set(key, { value, other_text: other ?? answers.get(key)?.other_text ?? null });
    dirty.add(key);
    scheduleSave();
  };

  // ---- question rendering ----
  function renderQuestion(q) {
    const def = catalog.get(q.key);
    if (!def) return null;
    if (q.show_if && !evalShowIf(q.show_if)) return null;

    const cur = answers.get(q.key) || {};
    const prompt = q.prompt_override || def.prompt;
    const head = el('span', { class: 'label' }, prompt + (q.required ? ' *' : ''),
      def.help_text ? el('span', { class: 'help' }, def.help_text) : null);
    const wrap = el('label', { class: 'field' }, head);

    const repaint = () => { const parent = wrap.parentNode; if (parent) renderSection(); };

    switch (def.type) {
      case 'short_text': {
        wrap.appendChild(el('input', { type: 'text', value: esc(cur.value),
          oninput: (e) => setAnswer(q.key, e.target.value) }));
        break;
      }
      case 'number': {
        wrap.appendChild(el('input', { type: 'number', inputmode: 'decimal', value: cur.value ?? '',
          oninput: (e) => setAnswer(q.key, e.target.value === '' ? null : Number(e.target.value)) }));
        break;
      }
      case 'long_text': {
        wrap.appendChild(el('textarea', { oninput: (e) => setAnswer(q.key, e.target.value) }, esc(cur.value)));
        break;
      }
      case 'rating': {
        const min = def.scale?.min ?? 1, max = def.scale?.max ?? 3, labels = def.scale?.labels || {};
        const box = el('div', { class: 'ratings' });
        for (let n = min; n <= max; n++) {
          const on = cur.value === n;
          box.appendChild(el('div', { class: 'choice' + (on ? ' sel' : ''),
            onclick: () => { setAnswer(q.key, n); repaint(); } },
            el('span', { class: 'n' }, String(n)),
            el('span', { class: 'lbl' }, labels[String(n)] || '')));
        }
        wrap.appendChild(box);
        break;
      }
      case 'yes_no': {
        const box = el('div', { class: 'ratings' });
        for (const [v, label] of [['yes', 'Yes'], ['no', 'No']]) {
          box.appendChild(el('div', { class: 'choice' + (cur.value === v ? ' sel' : ''),
            onclick: () => { setAnswer(q.key, v); repaint(); } }, el('span', { class: 'lbl' }, label)));
        }
        wrap.appendChild(box);
        break;
      }
      case 'single_select': {
        const box = el('div', { class: 'choices' });
        const opts = [...(def.options || [])];
        if (def.allow_other) opts.push({ value: '__other__', label: 'Other' });
        for (const o of opts) {
          box.appendChild(el('div', { class: 'choice' + (cur.value === o.value ? ' sel' : ''),
            onclick: () => { setAnswer(q.key, o.value); repaint(); } },
            el('input', { type: 'radio', checked: cur.value === o.value, tabindex: '-1' }),
            el('span', {}, o.label)));
        }
        if (cur.value === '__other__') {
          box.appendChild(el('input', { type: 'text', placeholder: 'Please specify',
            value: esc(cur.other_text),
            oninput: (e) => setAnswer(q.key, '__other__', e.target.value) }));
        }
        wrap.appendChild(box);
        break;
      }
      case 'multi_select': {
        const sel = new Set(Array.isArray(cur.value) ? cur.value : []);
        const box = el('div', { class: 'choices' });
        const opts = [...(def.options || [])];
        if (def.allow_other) opts.push({ value: '__other__', label: 'Other' });
        for (const o of opts) {
          box.appendChild(el('div', { class: 'choice' + (sel.has(o.value) ? ' sel' : ''),
            onclick: () => {
              sel.has(o.value) ? sel.delete(o.value) : sel.add(o.value);
              setAnswer(q.key, [...sel]); repaint();
            } },
            el('input', { type: 'checkbox', checked: sel.has(o.value), tabindex: '-1' }),
            el('span', {}, o.label)));
        }
        if (sel.has('__other__')) {
          box.appendChild(el('input', { type: 'text', placeholder: 'Please specify',
            value: esc(cur.other_text),
            oninput: (e) => setAnswer(q.key, [...sel], e.target.value) }));
        }
        wrap.appendChild(box);
        break;
      }
      case 'employee_ref': {
        const sel = el('select', { onchange: (e) => {
          const v = e.target.value;
          if (v === '__off__') {
            const name = prompt('Name (not on the roster)');
            setAnswer(q.key, name ? { freetext: name } : null);
          } else setAnswer(q.key, v || null);
          repaint();
        } });
        const currentId = typeof cur.value === 'string' ? cur.value : cur.value?.employee_id;
        const freetext = cur.value && typeof cur.value === 'object' ? cur.value.freetext : null;
        sel.appendChild(el('option', { value: '' }, freetext ? `${freetext} (off roster)` : '— select —'));
        const pool = pickable.filter((p) => !def.ref_filter?.template_key ||
                                            p.template_key === def.ref_filter.template_key);
        for (const p of pool) {
          sel.appendChild(el('option', { value: p.id, selected: currentId === p.id },
            `${p.first_name} ${p.last_name}${p.position_title ? ' — ' + p.position_title : ''}`));
        }
        sel.appendChild(el('option', { value: '__off__' }, 'Someone not on the roster…'));
        wrap.appendChild(sel);
        if (!pool.length) {
          wrap.appendChild(el('div', { class: 'small muted', style: 'margin-top:6px' },
            'No one on this roster holds that role yet.'));
        }
        break;
      }
      default:
        wrap.appendChild(el('div', { class: 'muted small' }, `Unsupported type: ${def.type}`));
    }
    return wrap;
  }

  function evalShowIf(cond) {
    const v = answers.get(cond.key)?.value;
    switch (cond.op) {
      case 'eq': return v === cond.value;
      case 'neq': return v !== cond.value;
      case 'lt': return typeof v === 'number' && v < cond.value;
      case 'lte': return typeof v === 'number' && v <= cond.value;
      case 'gt': return typeof v === 'number' && v > cond.value;
      case 'gte': return typeof v === 'number' && v >= cond.value;
      case 'in': return Array.isArray(cond.value) && cond.value.includes(v);
      case 'answered': return v !== undefined && v !== null && v !== '';
      default: return true;
    }
  }

  function sectionComplete(s) {
    return (s.questions || []).every((q) => {
      if (!q.required) return true;
      if (q.show_if && !evalShowIf(q.show_if)) return true;
      const v = answers.get(q.key)?.value;
      return !(v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length));
    });
  }

  let pickable = [];
  try { pickable = await apiCached(`/stores/${iv.store_id}/pickable`); } catch (_) { pickable = []; }

  function renderSection() {
    const sections = tpl.sections;
    const s = sections[sectionIdx];
    const answered = sections.flatMap((x) => x.questions).filter((q) => {
      const v = answers.get(q.key)?.value;
      return !(v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length));
    }).length;
    const total = sections.flatMap((x) => x.questions).length;

    const tabs = el('div', { class: 'sectiontabs' }, sections.map((sec, i) =>
      el('button', { class: (i === sectionIdx ? 'on ' : '') + (sectionComplete(sec) ? 'done' : ''),
        onclick: () => { sectionIdx = i; renderSection(); window.scrollTo(0, 0); } }, sec.title)));

    const body = el('div', { class: 'card' },
      s.internal_only ? banner('info', 'Internal only — never included in a client-facing export.') : null,
      (s.questions || []).map(renderQuestion).filter(Boolean));

    const isLast = sectionIdx === sections.length - 1;
    const bar = el('div', { class: 'savebar' },
      saveState,
      sectionIdx > 0 ? el('button', { class: 'btn', onclick: () => { sectionIdx--; renderSection(); window.scrollTo(0, 0); } }, 'Back') : null,
      !isLast ? el('button', { class: 'btn primary', onclick: () => { sectionIdx++; renderSection(); window.scrollTo(0, 0); } }, 'Next')
              : el('button', { class: 'btn primary', onclick: finish }, 'Complete interview'));

    view(
      el('div', { class: 'row between', style: 'margin-bottom:8px' },
        el('div', { class: 'muted small' },
          `${iv.position_title || iv.template_key} · ${iv.store_name}`),
        el('div', { class: 'muted small mono' }, `${answered}/${total}`)),
      el('div', { class: 'progress' }, el('i', { style: `width:${total ? Math.round(100 * answered / total) : 0}%` })),
      tabs, body, bar);
  }

  async function finish() {
    await pushAnswers();
    try {
      await api(`/interviews/${interviewId}/complete`, { method: 'POST', body: {} });
      await idbDel('drafts', draftKey).catch(() => {});
      go('#/store/' + iv.store_id);
    } catch (e) {
      if (e.status === 422) {
        const names = (e.data.missing || []).map((k) => catalog.get(k)?.prompt || k);
        if (confirm(`Still unanswered:\n\n• ${names.join('\n• ')}\n\nComplete anyway?`)) {
          await api(`/interviews/${interviewId}/complete`, { method: 'POST', body: { force: true } });
          await idbDel('drafts', draftKey).catch(() => {});
          go('#/store/' + iv.store_id);
        }
      } else if (!navigator.onLine) {
        await queue({ path: `/interviews/${interviewId}/complete`, method: 'POST', body: { force: true } });
        alert('Saved on this iPad. It will be marked complete as soon as you are back online.');
        go('#/store/' + iv.store_id);
      } else alert(e.message);
    }
  }

  // ---- read-only review of a finished interview ----
  function formatAnswer(def, a) {
    if (!a || a.value === null || a.value === undefined || a.value === '' ||
        (Array.isArray(a.value) && !a.value.length)) return null;
    const v = a.value;
    const label = (val) => {
      if (val === '__other__') return a.other_text ? `Other — ${a.other_text}` : 'Other';
      const hit = (def.options || []).find((o) => o.value === val);
      return hit ? hit.label : String(val);
    };
    switch (def.type) {
      case 'rating': {
        const name = def.scale?.labels?.[String(v)];
        return name ? `${v} — ${name}` : String(v);
      }
      case 'yes_no': return v === 'yes' ? 'Yes' : v === 'no' ? 'No' : String(v);
      case 'single_select': return label(v);
      case 'multi_select': return v.map(label).join(', ');
      case 'employee_ref': {
        const id = typeof v === 'string' ? v : v.employee_id;
        const free = v && typeof v === 'object' ? v.freetext : null;
        if (free) return `${free} (not on roster)`;
        const p = pickable.find((x) => x.id === id);
        return p ? `${p.first_name} ${p.last_name}` : '(unknown)';
      }
      default: return String(v);
    }
  }

  function renderReview() {
    const locked = iv.status === 'locked';
    const canReopen = ['admin', 'lead'].includes(state.user?.role) && !locked;

    const blocks = tpl.sections.map((sec) => {
      const rows = (sec.questions || []).map((q) => {
        const def = catalog.get(q.key);
        if (!def) return null;
        if (q.show_if && !evalShowIf(q.show_if)) return null;
        const text = formatAnswer(def, answers.get(q.key));
        return el('div', { style: 'padding:10px 0;border-bottom:1px solid var(--border)' },
          el('div', { class: 'small muted' }, q.prompt_override || def.prompt),
          el('div', { style: 'margin-top:2px;white-space:pre-wrap' },
            text ?? el('span', { class: 'muted' }, '— not answered —')));
      }).filter(Boolean);
      if (!rows.length) return null;
      return el('div', { class: 'card' },
        el('h3', {}, sec.title),
        sec.internal_only ? banner('info', 'Internal only — excluded from any client-facing export.') : null,
        rows);
    }).filter(Boolean);

    view(
      el('div', { class: 'card' },
        el('div', { class: 'row between' },
          el('div', { class: 'grow' },
            el('h3', {}, `${iv.first_name} ${iv.last_name}`),
            el('div', { class: 'muted small' },
              [iv.position_title, iv.store_name,
               iv.completed_at ? 'completed ' + new Date(iv.completed_at).toLocaleString() : null,
               iv.interviewer_name ? 'by ' + iv.interviewer_name : null].filter(Boolean).join(' · '))),
          el('span', { class: 'tag ' + (locked ? 'na' : 'complete') }, locked ? 'locked' : 'complete')),
        el('div', { class: 'btnrow', style: 'margin-top:12px' },
          canReopen ? el('button', { class: 'btn', onclick: async () => {
            if (!confirm('Reopen this interview for editing? It will be excluded from analysis until completed again.')) return;
            await api(`/interviews/${interviewId}/reopen`, { method: 'POST', body: {} });
            route();
          } }, 'Reopen for editing') : null,
          state.user?.role === 'admin' ? el('button', { class: 'btn ghost', onclick: async () => {
            if (!confirm(`Start a SECOND interview for ${iv.first_name} ${iv.last_name}? Use this only for a genuine re-interview — the existing one is kept.`)) return;
            await startInterview({ id: iv.employee_id }, true);
          } }, 'New interview for this person') : null),
        locked ? el('div', { class: 'small muted', style: 'margin-top:8px' },
          'This interview is locked and cannot be edited.') : null),
      blocks);
  }

  if (iv.status === 'complete' || iv.status === 'locked') renderReview();
  else renderSection();
}

// ------------------------------------------------------------ dashboard

async function screenDashboard(storeId) {
  const [store, facts, analyses] = await Promise.all([
    api('/stores/' + storeId), api(`/stores/${storeId}/facts`), api(`/stores/${storeId}/analyses`)]);
  setTitle('Analysis — ' + store.name, '#/store/' + storeId);
  document.querySelector('main').className = 'wide';

  const c = facts.coverage;
  const tiles = el('div', { class: 'tiles' },
    el('div', { class: 'tile' }, el('div', { class: 'v mono' }, String(facts.interview_count)),
      el('div', { class: 'k' }, 'interviews')),
    el('div', { class: 'tile' }, el('div', { class: 'v mono' },
      c.completion_rate === null ? '—' : Math.round(c.completion_rate * 100) + '%'),
      el('div', { class: 'k' }, 'coverage')),
    el('div', { class: 'tile' }, el('div', { class: 'v mono' }, String(c.total_on_roster)),
      el('div', { class: 'k' }, 'on roster')),
    el('div', { class: 'tile' }, el('div', { class: 'v mono' },
      String(facts.dimensions.filter((d) => d.gap && d.gap.spread > 0).length)),
      el('div', { class: 'k' }, 'split opinions')));

  // Cross-role gaps — the reason this app exists.
  const gapCards = facts.dimensions
    .filter((d) => d.type === 'rating' && d.role_count > 1)
    .map((d) => el('div', { class: 'card' },
      el('div', { class: 'row between' },
        el('h3', {}, prettyDim(d.dimension)),
        d.gap ? el('span', { class: 'sev ' + (d.gap.spread >= 1 ? 'high' : d.gap.spread >= 0.5 ? 'medium' : 'low') },
          `${d.gap.spread.toFixed(2)} spread`) : null),
      d.roles.filter((r) => r.avg !== null).map((r) => el('div', { class: 'gapbar' },
        el('span', { class: 'name' }, r.role_label),
        el('span', { class: 'track' }, el('i', { style: `width:${((r.avg - 1) / 2 * 100).toFixed(1)}%` })),
        el('span', { class: 'val' }, r.avg === null ? '—' : r.avg.toFixed(2)),
        el('span', { class: 'small muted' }, `n=${r.n}`))),
      d.gap && d.gap.spread >= 0.5
        ? el('div', { class: 'small muted', style: 'margin-top:8px' },
            `${d.gap.highest.role_label} rate this ${d.gap.spread.toFixed(2)} higher than ${d.gap.lowest.role_label}.`)
        : null));

  // Choice dimensions where departments name different causes.
  const divergent = facts.dimensions
    .filter((d) => d.choice_divergence && !d.choice_divergence.agree)
    .map((d) => el('div', { class: 'card' },
      el('h3', {}, prettyDim(d.dimension)),
      el('div', { class: 'small muted', style: 'margin-bottom:8px' }, 'Departments name different answers.'),
      el('table', { class: 'grid' },
        d.roles.filter((r) => r.choices).map((r) => el('tr', {},
          el('td', {}, r.role_label),
          el('td', {}, r.choices.map((ch) => `${ch.label} (${ch.count})`).join(', ')))))));

  // Nominations
  const nomBlocks = [];
  for (const [target, dirs] of Object.entries(facts.nominations || {})) {
    for (const [dir, list] of Object.entries(dirs)) {
      if (!list.length) continue;
      nomBlocks.push(el('div', { class: 'card' },
        el('h3', {}, `${target === 'advisor' ? 'Service Advisors' : 'Technicians'} — ${dir === 'strongest' ? 'named strongest' : 'named as needing support'}`),
        el('table', { class: 'grid' },
          el('tr', {}, el('th', {}, 'Name'), el('th', { class: 'num' }, 'Votes'), el('th', {}, 'Named by')),
          list.map((n) => el('tr', {},
            el('td', {}, n.name),
            el('td', { class: 'num' }, String(n.count)),
            el('td', { class: 'small muted' },
              Object.entries(n.by_role).map(([r, c]) => `${r} ${c}`).join(', ')))))));
    }
  }
  if (facts.never_nominated?.length) {
    nomBlocks.push(el('div', { class: 'card' },
      el('h3', {}, 'Interviewed but never named by anyone'),
      el('div', { class: 'small muted' }, facts.never_nominated.map((n) => n.name).join(', '))));
  }

  const runBtn = el('button', { class: 'btn primary', onclick: async () => {
    runBtn.disabled = true; runBtn.textContent = 'Analyzing…';
    try { const a = await api(`/stores/${storeId}/analyze`, { method: 'POST' }); go('#/analysis/' + a.id); }
    catch (e) { alert(e.data?.error || e.message); runBtn.disabled = false; runBtn.textContent = 'Run LLM analysis'; }
  } }, 'Run LLM analysis');

  view(
    tiles,
    el('div', { class: 'btnrow', style: 'margin:14px 0' }, runBtn,
      el('a', { class: 'btn', href: `/api/stores/${storeId}/export.csv` }, 'Export CSV')),

    analyses.length ? el('h2', {}, 'Saved analyses') : null,
    analyses.length ? el('div', { class: 'card', style: 'padding:0' }, analyses.map((a) =>
      el('div', { class: 'person', onclick: () => go('#/analysis/' + a.id), style: 'cursor:pointer' },
        el('div', { class: 'grow' },
          el('div', {}, new Date(a.generated_at).toLocaleString()),
          el('div', { class: 'muted small' },
            `${a.interview_count} interviews · ${a.model || 'facts only'} · ${a.prompt_version || ''}`)),
        el('span', { class: 'tag ' + (a.status === 'complete' ? 'complete' : 'skip') }, a.status)))) : null,

    facts.interview_count === 0 ? banner('warn', 'No completed interviews yet.') : null,
    gapCards.length ? el('h2', {}, 'Cross-role rating gaps') : null, gapCards,
    divergent.length ? el('h2', {}, 'Where departments disagree on causes') : null, divergent,
    nomBlocks.length ? el('h2', {}, 'Nominations') : null, nomBlocks);
}

// Dimension keys are internal; a naive title-case turns sm_accountability into
// "Sm Accountability". These are the names a consultant should actually read.
const DIM_LABEL = {
  parts_service_relationship: 'Parts \u2194 Service Relationship',
  advisor_tech_relationship:  'Advisors \u2194 Technicians',
  advisor_communication:      'Communication with Service Advisors',
  advisor_relationship:       'Relationship with Service Advisors',
  tech_communication:         'Communication with Technicians',
  service_sales_relationship: 'Service \u2194 Sales Relationship',
  sm_accountability:          'Service Manager \u2014 Accountability',
  sm_leadership:              'Service Manager \u2014 Leadership',
  pm_leadership:              'Parts Manager \u2014 Leadership',
  leadership_clarity:         'Clarity of Expectations',
  parts_delivery:             'Parts Delivered to the Stall',
  parts_delay_cause:          'Cause of Parts Delays',
  parts_process_discipline:   'Parts Process Discipline',
  productivity_blocker:       'What Slows People Down',
  change_priority:            'If You Owned the Dealership',
  communication_gap:          'Biggest Communication Gap',
  department_cohesion:        'How the Department Works Together',
  inspection_discipline:      'Inspection Discipline',
  dispatch_quality:           'Dispatch Process',
  job_description_exists:     'Has a Written Job Description',
  self_productivity:          'Self-Rated Productivity',
  advisor_standing:           'Service Advisor Standing',
  tech_standing:              'Technician Standing',
  service_menu:               'Service Menu',
  pay_structure:              'Pay Structure',
  flagged_hours:              'Flagged Hours',
  retention_signal:           'Retention Signal',
  mentorship:                 'Mentorship',
  tenure:                     'Time with Company'
};
function prettyDim(d) {
  return DIM_LABEL[d] || String(d).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function screenAnalysis(id) {
  const a = await api('/analyses/' + id);
  setTitle('Analysis', '#/store/' + a.store_id + '/dashboard');
  document.querySelector('main').className = 'wide';
  const n = a.narrative;

  if (!n) {
    return view(banner(a.status === 'error' ? 'err' : 'warn',
      a.error || 'No narrative was generated. The computed facts are still saved.'),
      el('pre', { class: 'card small', style: 'overflow:auto' },
        JSON.stringify(a.computed_facts?.dimensions?.slice(0, 5) || {}, null, 2)));
  }
  if (n.parse_error) return view(banner('err', 'The model returned unparseable output.'),
    el('pre', { class: 'card small', style: 'overflow:auto' }, n.raw));

  const list = (title, items, render) => items?.length
    ? [el('h2', {}, title), ...items.map(render)] : [];

  view(
    el('div', { class: 'card' }, el('h3', {}, 'Executive summary'), el('p', {}, n.executive_summary || '—'),
      el('div', { class: 'small muted' },
        `${a.model || ''} · ${a.prompt_version || ''} · ${new Date(a.generated_at).toLocaleString()}`)),

    list('Perception gaps', n.perception_gaps, (g) => el('div', { class: 'card' },
      el('div', { class: 'row between' }, el('h3', {}, g.title),
        el('span', { class: 'sev ' + (g.severity || 'low') }, g.severity || '')),
      el('p', {}, g.detail),
      g.evidence ? el('p', { class: 'small muted' }, g.evidence) : null,
      el('div', { class: 'small muted' }, `${(g.interview_ids || []).length} interviews cited`))),

    list('Themes', n.themes, (t) => el('div', { class: 'card' },
      el('h3', {}, t.title), el('p', {}, t.detail),
      el('div', { class: 'small muted' }, (t.roles_affected || []).join(', ')))),

    list('People signals', n.people_signals, (p) => el('div', { class: 'card' },
      el('h3', {}, p.name), el('div', { class: 'small muted' }, p.signal), el('p', {}, p.detail))),

    list('Recommended focus', n.recommended_focus, (r) => el('div', { class: 'card' },
      el('h3', {}, `${r.priority || ''}. ${r.title}`), el('p', {}, r.rationale),
      r.first_move ? el('p', { class: 'small' }, el('strong', {}, 'First move: '), r.first_move) : null)),

    n.data_gaps?.length ? el('div', { class: 'card' }, el('h3', {}, 'Data gaps'),
      el('ul', {}, n.data_gaps.map((g) => el('li', {}, g)))) : null);
}

// ============================================================ boot

window.addEventListener('hashchange', route);
window.addEventListener('online', () => { renderNet(); flushOutbox(); });
window.addEventListener('offline', renderNet);
document.addEventListener('visibilitychange', () => { if (!document.hidden) flushOutbox(); });
$('#logoutBtn').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  state.user = null; go('#/login');
});

// Theme. Dark is the default; the choice is a per-viewer convenience so it
// lives in localStorage, wrapped because that throws in some privacy modes.
(function initTheme() {
  const btn = document.getElementById('themeBtn');
  if (!btn) return;
  const meta = document.querySelector('meta[name=theme-color]');
  const apply = (theme) => {
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#F2F2F2' : '#0D0D0D');
    btn.title = theme === 'light' ? 'Switch to dark' : 'Switch to light';
  };
  let current = 'dark';
  try { if (localStorage.getItem('cci.theme') === 'light') current = 'light'; } catch (e) {}
  apply(current);
  btn.addEventListener('click', () => {
    current = current === 'light' ? 'dark' : 'light';
    apply(current);
    try { localStorage.setItem('cci.theme', current); } catch (e) {}
  });
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('sw:', e.message));
}

setInterval(flushOutbox, 30000);
renderNet();
flushOutbox();
route();
