// ---------- tiny helpers ----------
const $ = (s, el = document) => el.querySelector(s);
class Raw { constructor(s) { this.s = s; } }
const raw = (s) => new Raw(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const val = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : esc(v));
const html = (st, ...v) => new Raw(st.reduce((o, s, i) => o + s + (i < v.length ? val(v[i]) : ''), ''));
const mount = (el, r) => { el.innerHTML = r instanceof Raw ? r.s : r; };

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localToday = () => ymd(new Date());
const today = () => catalog.settings?.today || localToday();
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const fmtD = (d) => (+Number(d || 0).toFixed(2)).toString();       // days: 0.5
const hrs = (d) => +(Number(d || 0) * (catalog.settings?.hours_per_day || 8)).toFixed(1);
const fmtH = (h) => { h = Number(h) || 0; return h < 1 ? `${Math.round(h * 60)}m` : `${+h.toFixed(1)}h`; };
const niceDate = (s) => new Date(s + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const shortDate = (s) => new Date(s + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const rel = (s) => { if (!s) return 'never'; const d = Math.round((Date.parse(today()) - Date.parse(s)) / 86400000); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d}d ago`; };
const isWorkday = (s) => (catalog.settings?.workdays || '0,1,2,3,4').split(',').map(Number).includes(new Date(s + 'T12:00:00').getDay());

let toastT;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = ''), 3200);
}
async function api(method, path, body, opts = {}) {
  const r = await fetch('/api' + path, {
    method, headers: { 'Content-Type': opts.type || 'application/json', 'X-Requested-With': 'timesheet' },
    body: body === undefined ? undefined : opts.type ? body : JSON.stringify(body), credentials: 'same-origin',
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login') { me = null; renderLogin(); throw new Error('signed out'); }
  if (!r.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
const get = (p) => api('GET', p), post = (p, b = {}) => api('POST', p, b), put = (p, b = {}) => api('PUT', p, b), del = (p) => api('DELETE', p);
const qs = (o) => '?' + new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''))).toString();

// ---------- generic form dialog ----------
function formDialog({ title, fields, values = {}, submit = 'Save', danger }) {
  return new Promise((resolve) => {
    const dlg = $('#dlg');
    const input = (f) => {
      const v = values[f.name] ?? f.default ?? '';
      const common = `name="${esc(f.name)}" id="f_${esc(f.name)}" ${f.required ? 'required' : ''}`;
      if (f.type === 'select') return html`<select ${raw(common)}>${f.options.map((o) => html`<option value="${o.value}" ${String(o.value) === String(v) ? raw('selected') : ''}>${o.label}</option>`)}</select>`;
      if (f.type === 'textarea') return html`<textarea ${raw(common)}>${v}</textarea>`;
      if (f.type === 'checks') return f.options.length ? html`<div class="chips">${f.options.map((o) => { const on = (v || []).map(String).includes(String(o.value)); return html`<label class="chip ${on ? 'on' : ''}" style="cursor:pointer"><input type="checkbox" name="${f.name}" value="${o.value}" ${on ? raw('checked') : ''} style="display:none" onchange="this.parentNode.classList.toggle('on',this.checked)">${o.label}</label>`; })}</div>` : html`<div class="small muted">${f.empty || 'Nothing to choose yet.'}</div>`;
      if (f.type === 'checkbox') return html`<label class="row"><input type="checkbox" ${raw(common)} ${v ? raw('checked') : ''} style="width:22px;height:22px"> <span>${f.label}</span></label>`;
      return html`<input type="${f.type || 'text'}" ${raw(common)} value="${v}" ${f.step ? raw(`step="${f.step}"`) : ''} ${f.autocomplete ? raw(`autocomplete="${f.autocomplete}"`) : ''}>`;
    };
    mount(dlg, html`<form method="dialog"><h2>${title}</h2>
      ${fields.map((f) => html`<div class="field">${f.type === 'checkbox' ? '' : html`<label class="f" for="f_${f.name}">${f.label}</label>`}${input(f)}${f.help ? html`<div class="small muted">${f.help}</div>` : ''}</div>`)}
      <div class="err-text" id="dlgErr"></div>
      <div class="row sp"><button class="btn" type="button" id="dlgCancel">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${submit}</button></div></form>`);
    const form = $('form', dlg);
    const done = (v) => { dlg.onclose = null; dlg.close(); resolve(v); };
    $('#dlgCancel').onclick = () => done(null);
    dlg.onclose = () => resolve(null);
    form.onsubmit = (e) => {
      e.preventDefault();
      const out = {};
      for (const f of fields) { if (f.type === 'checks') { out[f.name] = [...form.querySelectorAll(`input[name="${f.name}"]:checked`)].map((i) => Number(i.value)); continue; } const el = form.elements[f.name]; out[f.name] = f.type === 'checkbox' ? el.checked : el.value; }
      done(out);
    };
    dlg.showModal();
  });
}
function ask(message, { ok = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#dlg');
    mount(dlg, html`<form method="dialog"><p style="margin:0 0 16px;font-size:1.02rem">${message}</p><div class="row sp"><button class="btn" type="button" id="askNo">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" type="submit" id="askYes">${ok}</button></div></form>`);
    const done = (v) => { dlg.onclose = null; dlg.close(); resolve(v); };
    $('#askNo').onclick = () => done(false);
    $('form', dlg).onsubmit = (e) => { e.preventDefault(); done(true); };
    dlg.onclose = () => resolve(false);
    dlg.showModal(); $('#askYes').focus();
  });
}
function infoDialog(title, bodyHtml) {
  const dlg = $('#dlg');
  mount(dlg, html`<form method="dialog"><h2>${title}</h2>${bodyHtml}<div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn primary" type="submit">Close</button></div></form>`);
  dlg.onclose = null; dlg.showModal();
}
async function attempt(fn, okMsg) { try { const r = await fn(); if (okMsg) toast(okMsg); return r ?? true; } catch (e) { if (e.message !== 'signed out') toast(e.message, true); return false; } }

// ---------- theme ----------
const THEME_KEY = 'ts-theme';
const svg = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  auto: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'),
  light: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  dark: svg('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>'),
  out: svg('<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/>'),
};
const THEMES = { auto: [ICONS.auto, 'Theme: follows your device'], light: [ICONS.light, 'Theme: light'], dark: [ICONS.dark, 'Theme: dark'] };
const getTheme = () => { try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; } };
function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#7a0b1d' : '#c8102e');
  document.querySelectorAll('.theme-btn').forEach((b) => { b.innerHTML = THEMES[t][0]; b.title = THEMES[t][1]; b.setAttribute('aria-label', THEMES[t][1]); });
}
function cycleTheme() {
  const order = ['auto', 'light', 'dark'], next = order[(order.indexOf(getTheme()) + 1) % 3];
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  applyTheme(next); toast(THEMES[next][1]);
}
const themeBtn = () => html`<button class="btn sm theme-btn" data-act="theme" type="button" title="${THEMES[getTheme()][1]}" aria-label="${THEMES[getTheme()][1]}">${raw(THEMES[getTheme()][0])}</button>`;
if (getTheme() !== 'auto') applyTheme(getTheme());

// ---------- state ----------
let me = null, catalog = { projects: [], task_types: [], scopes: [], levels: [], settings: {} };
const ICON = window.DEMO?.icon || '/icon.svg';
const demoStrip = () => (window.DEMO ? html`<div class="demo-strip">Preview with made-up sample data, saved only in this browser. <button type="button" data-act="demoReset">Reset sample data</button></div>` : '');
const isMgr = () => me && (me.role === 'admin' || me.role === 'leader');
const isAdmin = () => me?.role === 'admin';
const activeProjects = () => catalog.projects.filter((p) => p.active && !p.is_leave);
const workTasks = () => catalog.task_types.filter((t) => t.active && !t.is_leave);
const activeScopes = () => catalog.scopes.filter((s) => s.active);
const byId = (arr, id) => arr.find((x) => x.id === Number(id));
// projects whose data this viewer can analyse (leaders: the ones assigned to them)
const scopedProjects = () => catalog.projects.filter((p) => !p.is_leave && (!catalog.my_project_ids || catalog.my_project_ids.includes(p.id)));

// ---------- shell ----------
const NAV = [
  ['log', '＋', 'Log time', () => true], ['history', '☰', 'My entries', () => true], ['growth', '↗', 'My growth', () => true],
  ['dash', '▦', 'Dashboard', isMgr], ['prod', '⏱', 'Speed', isMgr], ['team', '☻', 'Team', isMgr], ['projects', '◧', () => (isAdmin() && catalog.pending_proposals ? `Projects (${catalog.pending_proposals})` : 'Projects'), isMgr], ['export', '⤓', 'Export', isMgr], ['emails', '✉', 'Emails', isAdmin], ['setup', '⚙', 'Setup', isAdmin],
];
function shell(active, body) {
  mount($('#app'), html`${demoStrip()}<div class="topband"><header class="top"><div class="brand"><img src="${ICON}" alt=""> Team Timesheet</div>
    <div class="row small" style="flex-wrap:nowrap"><span class="who hide-sm">${me.name}</span>${themeBtn()}<button class="btn sm icon-btn" data-act="pw" title="Change password" aria-label="Change password">${raw(ICONS.key)}<span class="hide-sm">Password</span></button><button class="btn sm icon-btn" data-act="logout" title="Sign out" aria-label="Sign out">${raw(ICONS.out)}<span class="hide-sm">Sign out</span></button></div></header></div>
    <nav class="bar">${NAV.filter((n) => n[3]()).map(([k, i, l]) => html`<a href="#${k}" class="${k === active ? 'on' : ''}"><span class="i">${i}</span>${typeof l === 'function' ? l() : l}</a>`)}</nav>
    <main class="wrap" id="view">${body}</main>`);
}

// ---------- login ----------
function renderLogin() {
  mount($('#app'), html`${demoStrip()}<div class="login-wrap"><form class="login card" id="loginForm"><div class="theme-row">${themeBtn()}</div><h1><img src="${ICON}" alt=""> Team Timesheet</h1>
    <div class="field"><label class="f" for="u">Username or work email</label><input id="u" type="text" autocomplete="username" autocapitalize="none" required></div>
    <div class="field"><label class="f" for="p">Password</label><input id="p" type="password" autocomplete="current-password" required></div>
    <div class="err-text" id="lerr"></div><button class="btn primary block" type="submit">Sign in</button>
    ${window.DEMO ? html`<div class="demo-logins"><div class="small muted">Preview with sample data — sign in as:</div>${window.DEMO.logins.map((l) => html`<button class="btn" type="button" data-act="demoLogin" data-u="${l.u}" data-p="${l.p}">${l.label}</button>`)}</div>` : ''}</form></div>`);
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await post('/login', { username: $('#u').value, password: $('#p').value }); await boot(); }
    catch (er) { $('#lerr').textContent = er.message; }
  };
}

// ---------- LOG TIME ----------
const L = { date: null, project_id: null, task_type_id: null, scope_id: null, scopeManual: false, days: null, qty: '', desc: '', editId: null, sug: null, entries: [] };
const DAY_CHIPS = [1, 0.75, 0.5, 0.25, 0.2, 0.1];
const dayTotal = (exceptId) => L.entries.filter((e) => e.id !== exceptId).reduce((s, e) => s + e.days, 0);

async function loadSuggest() {
  try {
    L.sug = await get('/suggest' + qs({ project_id: L.project_id, task_type_id: L.task_type_id, text: L.desc, date: L.date }));
    if (L.project_id && !L.scopeManual && L.sug.scope_id) L.scope_id = L.sug.scope_id;
  } catch { L.sug = null; }
}
async function viewLog() {
  L.date ||= today();
  shell('log', html`<div class="empty">Loading…</div>`);
  const [, e] = await Promise.all([loadSuggest(), get('/entries' + qs({ date: L.date }))]);
  L.entries = e.entries;
  if (!L.project_id && L.sug?.projects[0]?.confidence >= 0.35) { L.project_id = L.sug.projects[0].id; await loadSuggest(); }
  drawLog();
}
function drawLog() {
  const sug = L.sug || { projects: [], task_types: [], combos: [], descriptions: [], hint: null };
  const conf = Object.fromEntries(sug.projects.map((p) => [p.id, p.confidence]));
  const tconf = Object.fromEntries(sug.task_types.map((p) => [p.id, p.confidence]));
  const projs = activeProjects();
  const top = sug.projects.map((p) => byId(projs, p.id)).filter(Boolean).slice(0, 4);
  if (L.project_id && !top.some((p) => p.id === L.project_id) && byId(projs, L.project_id)) top.unshift(byId(projs, L.project_id));
  const tasks = [...workTasks()].sort((a, b) => (tconf[b.id] || 0) - (tconf[a.id] || 0));
  const task = byId(catalog.task_types, L.task_type_id);
  const used = dayTotal(L.editId), remaining = Math.max(0, +(1 - used).toFixed(2)), total = +dayTotal().toFixed(2);
  const complete = total >= 0.99, over = total > 1.01;
  const dayLabel = L.date === today() ? 'Today' : niceDate(L.date);
  const chips = [...new Set([...(remaining > 0 && remaining < 1 ? [remaining] : []), ...DAY_CHIPS])];

  mount($('#view'), html`
    <div class="row sp" style="margin-bottom:10px">
      <button class="btn sm" data-act="dayPrev" aria-label="Previous day">‹</button>
      <div class="row"><strong>${dayLabel}</strong><input type="date" id="dateIn" value="${L.date}" max="${addDays(today(), 1)}" style="width:auto;min-height:36px"></div>
      <button class="btn sm" data-act="dayNext" aria-label="Next day" ${L.date >= today() ? raw('disabled') : ''}>›</button>
    </div>
    <div class="card" style="padding:12px 16px"><div class="row sp"><b>${complete ? (over ? '⚠ More than 1 day logged' : '✓ Day complete') : `${fmtD(total)} of 1 day logged`}</b>
      <span class="muted small">${complete ? '' : `${fmtD(remaining)} left (${fmtH(hrs(remaining))})`}</span></div>
      <div class="progress ${complete ? (over ? 'warn' : 'over') : ''}" style="margin-top:8px"><i style="width:${Math.min(100, total * 100)}%"></i></div>
      ${!L.entries.length ? html`<div class="row" style="margin-top:10px"><button class="btn sm" data-act="dayOff">🌴 Mark whole day off</button><span class="small muted">weekend, leave, holiday</span></div>` : ''}</div>
    ${sug.combos.length && !L.editId ? html`<div class="card"><h3>⚡ Repeat something recent</h3><div class="chips">${sug.combos.map((c, i) => html`<button class="chip combo" data-act="combo" data-i="${i}"><b>${byId(catalog.projects, c.project_id)?.name}</b> · ${fmtD(c.days)}d<br>${byId(catalog.task_types, c.task_type_id)?.name}${c.description ? ' — ' + c.description : ''}</button>`)}</div></div>` : ''}
    <div class="card">
      <h2>${L.editId ? 'Edit entry' : 'New entry'}</h2>
      <div class="field"><label class="f">Project ${top.length ? html`<span class="muted small">— suggested for you</span>` : ''}</label>
        <div class="chips">${top.map((p) => html`<button class="chip ${p.id === L.project_id ? 'on' : ''}" data-act="pickProject" data-id="${p.id}">${p.name}${conf[p.id] >= 0.1 ? html`<span class="pct">${Math.round(conf[p.id] * 100)}%</span>` : ''}</button>`)}</div>
        <select id="projSel" style="margin-top:8px"><option value="">${top.length ? 'Other project…' : 'Choose project…'}</option>${projs.filter((p) => !top.includes(p)).map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></div>
      <div class="field"><label class="f">Task item</label>
        <div class="chips">${tasks.map((t) => html`<button class="chip ${t.id === L.task_type_id ? 'on' : ''}" data-act="pickTask" data-id="${t.id}">${t.name}</button>`)}</div></div>
      <div class="field"><label class="f">Scope <span class="muted small">${L.scopeManual ? '' : '— filled from the project'}</span></label>
        <div class="chips">${activeScopes().map((s) => html`<button class="chip ${s.id === L.scope_id ? 'on' : ''}" data-act="pickScope" data-id="${s.id}">${s.name}</button>`)}</div></div>
      <div class="field"><label class="f">Time spent <span class="muted small">(days)</span></label>
        <div class="chips">${chips.map((d) => html`<button class="chip ${L.days === d ? 'on' : ''}" data-act="pickDays" data-d="${d}">${d === remaining && d < 1 ? 'Rest of day · ' : ''}${fmtD(d)}<span class="pct">${fmtH(hrs(d))}</span></button>`)}</div>
        <div class="row" style="margin-top:8px"><input type="number" id="daysIn" inputmode="decimal" step="0.05" min="0.05" max="1" placeholder="or type, e.g. 0.3" value="${L.days ?? ''}" style="max-width:170px"><span class="muted small">${L.days ? `= ${fmtH(hrs(L.days))}` : ''}</span></div>
        ${sug.hint && !L.days ? html`<div class="hint"><span>🧠 You usually log <b>${fmtD(sug.hint.days)}</b> day on this</span><button class="btn sm" data-act="pickDays" data-d="${sug.hint.days}">Use</button></div>` : ''}</div>
      ${task?.track_qty ? html`<div class="field"><label class="f">How many ${task.unit_label}s? <span class="muted small">(optional — lets the app learn your speed)</span></label>
        <div class="stepper"><button data-act="dec" aria-label="Fewer">−</button><input type="number" inputmode="numeric" id="qtyIn" min="0" max="1000" value="${L.qty}" placeholder="–"><button data-act="inc" aria-label="More">+</button></div></div>` : ''}
      <div class="field"><label class="f" for="descIn">Task description <span class="muted">(optional)</span></label>
        <input type="text" id="descIn" list="descList" maxlength="1000" placeholder="e.g. South elevation stone sheets" value="${L.desc}" autocomplete="off"><datalist id="descList">${sug.descriptions.map((d) => html`<option value="${d}">`)}</datalist></div>
      <div class="row"><button class="btn primary" style="flex:1;min-height:52px;font-size:1.05rem" data-act="save">${L.editId ? 'Update entry' : 'Save entry'}</button>${L.editId ? html`<button class="btn" data-act="cancelEdit">Cancel</button>` : ''}</div>
    </div>
    <div class="card"><h2>${dayLabel}'s entries</h2>
      ${L.entries.length ? L.entries.map(entryRow) : html`<div class="empty">Nothing logged yet for this day.</div>`}</div>`);
}
const entryRow = (e) => html`<div class="entry"><div class="t"><span class="tag">Task ${e.task_seq}</span> ${e.project} <span class="muted">·</span> ${e.task_type}${e.scope && e.scope !== 'None' ? html` <span class="muted small">(${e.scope})</span>` : ''}</div>
  <div class="right nowrap"><b>${fmtD(e.days)}</b> <span class="muted small">day${e.quantity ? ` · ${e.quantity} ${e.unit}${e.quantity > 1 ? 's' : ''}` : ''}</span></div><div class="d">${e.description}</div>
  <div class="right nowrap"><button class="btn sm" data-act="edit" data-id="${e.id}">Edit</button> <button class="btn sm danger" data-act="delEntry" data-id="${e.id}">✕</button></div></div>`;

async function refreshLogParts() { await loadSuggest(); drawLog(); }
const resetForm = () => Object.assign(L, { editId: null, days: null, qty: '', desc: '', task_type_id: null });
const logActions = {
  dayPrev: () => { L.date = addDays(L.date, -1); resetForm(); viewLog(); },
  dayNext: () => { if (L.date < today()) { L.date = addDays(L.date, 1); resetForm(); viewLog(); } },
  pickProject: (el) => { L.project_id = Number(el.dataset.id); L.scopeManual = false; refreshLogParts(); },
  pickTask: (el) => { L.task_type_id = Number(el.dataset.id); if (!byId(catalog.task_types, L.task_type_id).track_qty) L.qty = ''; refreshLogParts(); },
  pickScope: (el) => { L.scope_id = Number(el.dataset.id); L.scopeManual = true; drawLog(); },
  pickDays: (el) => { L.days = Number(el.dataset.d); drawLog(); },
  inc: () => { L.qty = Math.min(1000, (Number(L.qty) || 0) + 1); drawLog(); },
  dec: () => { L.qty = Math.max(0, (Number(L.qty) || 0) - 1) || ''; drawLog(); },
  combo: (el) => { const c = L.sug.combos[Number(el.dataset.i)]; Object.assign(L, { project_id: c.project_id, task_type_id: c.task_type_id, scope_id: c.scope_id, scopeManual: true, desc: c.description, days: Math.min(c.days, Math.max(0.05, +(1 - dayTotal()).toFixed(2))) }); refreshLogParts(); },
  cancelEdit: () => { resetForm(); drawLog(); },
  edit: (el) => {
    const e = L.entries.find((x) => x.id === Number(el.dataset.id));
    Object.assign(L, { editId: e.id, project_id: e.project_id, task_type_id: e.task_type_id, scope_id: e.scope_id, scopeManual: true, days: e.days, qty: e.quantity ?? '', desc: e.description });
    refreshLogParts().then(() => scrollTo({ top: 0, behavior: 'smooth' }));
  },
  delEntry: async (el) => {
    if (!(await ask('Delete this entry?', { ok: 'Delete', danger: true }))) return;
    if (await attempt(() => del('/entries/' + el.dataset.id), 'Deleted')) { if (L.editId == el.dataset.id) resetForm(); viewLog(); }
  },
  dayOff: async () => {
    const p = catalog.projects.find((x) => x.is_leave && x.active), t = catalog.task_types.find((x) => x.is_leave && x.active);
    if (!p || !t) return toast('No "Day Off" project/task set up — ask the admin', true);
    if (await attempt(() => post('/entries', { work_date: L.date, project_id: p.id, task_type_id: t.id, days: 1, description: 'Day off' }), 'Marked as day off')) viewLog();
  },
  save: async () => {
    if (!L.project_id) return toast('Pick a project', true);
    if (!L.task_type_id) return toast('Pick a task item', true);
    if (!L.days) return toast('Choose the time spent', true);
    const body = { work_date: L.date, project_id: L.project_id, task_type_id: L.task_type_id, scope_id: L.scope_id, days: L.days, quantity: L.qty === '' ? null : Number(L.qty), description: L.desc };
    const was = L.editId;
    const r = await attempt(() => (was ? put('/entries/' + was, body) : post('/entries', body)));
    if (!r) return;
    resetForm(); await viewLog();
    const tot = +dayTotal().toFixed(2);
    toast(tot >= 0.99 ? 'Saved ✓ — day complete 🎉' : `Saved ✓ — ${fmtD(1 - tot)} day left`);
  },
};
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'qtyIn') L.qty = t.value === '' ? '' : Number(t.value);
  else if (t.id === 'daysIn') L.days = Number(t.value) > 0 ? Math.min(1, Number(t.value)) : null;
  else if (t.id === 'descIn') { L.desc = t.value; clearTimeout(L._t); L._t = setTimeout(async () => { await loadSuggest(); const dl = $('#descList'); if (dl) mount(dl, html`${(L.sug?.descriptions || []).map((d) => html`<option value="${d}">`)}`); }, 350); }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'projSel' && t.value) { L.project_id = Number(t.value); L.scopeManual = false; refreshLogParts(); }
  else if (t.id === 'dateIn' && t.value) { L.date = t.value; resetForm(); viewLog(); }
  else if (t.id === 'daysIn') drawLog();
});

// ---------- HISTORY ----------
async function viewHistory() {
  shell('history', html`<div class="empty">Loading…</div>`);
  const to = today(), from = addDays(to, -30);
  const { entries } = await get('/entries' + qs({ from, to }));
  const days = {};
  entries.forEach((e) => (days[e.work_date] ||= []).push(e));
  const work = entries.filter((e) => !e.is_leave).reduce((s, e) => s + e.days, 0);
  mount($('#view'), html`<h1>My entries</h1><div class="card"><div class="row sp"><span class="muted">Last 30 days</span><b>${fmtD(work)} working days · ${Object.keys(days).length} days with entries</b></div></div>
    ${Object.keys(days).length ? Object.keys(days).sort().reverse().map((d) => { const t = +days[d].reduce((s, e) => s + e.days, 0).toFixed(2);
      return html`<div class="card"><div class="day-h" style="margin-top:0"><span>${niceDate(d)}</span><span><span class="tag ${t >= 0.99 ? 'good' : 'warn'}">${fmtD(t)} / 1</span></span></div>
      ${days[d].map((e) => html`<div class="entry"><div class="t"><span class="tag">Task ${e.task_seq}</span> ${e.project} · ${e.task_type}${e.scope && e.scope !== 'None' ? html` <span class="muted small">(${e.scope})</span>` : ''}</div><div class="right"><b>${fmtD(e.days)}</b></div><div class="d">${e.description}</div><div class="right"><a class="btn sm" href="#log" data-act="goEdit" data-date="${d}" data-id="${e.id}">Edit</a></div></div>`)}</div>`; })
      : html`<div class="card empty">No entries yet — head to “Log time”.</div>`}`);
}

// ---------- GROWTH ----------
async function viewGrowth(id) {
  shell('growth', html`<div class="empty">Loading…</div>`);
  const uid = Number(id) || me.id;
  const g = await get(`/users/${uid}/growth`);
  const curRank = g.level ? g.levels.find((l) => l.id === g.level.id)?.rank : 0;
  const mgr = g.can_manage, admin = isAdmin();
  const goalCard = (x) => {
    const live = x.metric === 'manual' ? x.current_value : x.live_value, pct = x.progress;
    return html`<div class="card" style="margin-bottom:10px;box-shadow:none"><div class="row sp"><b>${x.title}</b><span class="tag ${x.status === 'achieved' ? 'good' : x.status === 'dropped' ? 'bad' : ''}">${x.status}</span></div>
      <div class="small muted">${x.metric === 'avg_hrs' ? `Avg hours per unit${x.task_type ? ' — ' + x.task_type : ''} (30d, lower is better)` : x.metric === 'units_month' ? `Units per 30 days${x.task_type ? ' — ' + x.task_type : ''}` : 'Manual'}${x.due_date ? ' · due ' + x.due_date : ''}</div>
      <div class="progress ${pct >= 100 ? 'over' : ''}" style="margin:8px 0"><i style="width:${pct}%"></i></div>
      <div class="row sp small"><span>${x.start_value ?? '–'} → <b>${live ?? '–'}</b> → target ${x.target_value ?? '–'} ${x.unit}</span><span>${pct}%</span></div>
      ${x.description ? html`<div class="small" style="margin-top:6px">${x.description}</div>` : ''}
      <div class="row" style="margin-top:8px">
        ${x.metric === 'manual' && (mgr || g.user.id === me.id) ? html`<button class="btn sm" data-act="goalProgress" data-id="${x.id}" data-cur="${x.current_value ?? ''}">Update progress</button>` : ''}
        ${mgr ? html`<button class="btn sm" data-act="goalEdit" data-uid="${uid}" data-id="${x.id}">Edit</button><button class="btn sm danger" data-act="goalDel" data-id="${x.id}">Delete</button>` : ''}</div></div>`;
  };
  window._growth = g;
  mount($('#view'), html`
    <div class="row sp"><div><h1 style="margin-bottom:2px">${g.user.name}</h1><div class="muted">${g.user.job_title || ''}${g.level ? ' · ' + g.level.name : ''}</div></div>
      ${uid !== me.id ? html`<a class="btn sm" href="#team">← Team</a>` : ''}</div>
    <div class="grid g4" style="margin:14px 0"><div class="kpi"><b>${fmtD(g.totals.days)}</b><span>working days logged</span></div><div class="kpi"><b>${g.totals.units}</b><span>units counted (drawings etc.)</span></div><div class="kpi"><b>${g.totals.active_days}</b><span>days with entries</span></div></div>
    <div class="card"><div class="row sp"><h2>Career path</h2>${admin ? html`<button class="btn sm" data-act="setLevel" data-uid="${uid}">Change level</button>` : ''}</div>
      <div class="ladder">${g.levels.map((l) => html`<div class="step ${l.id === g.level?.id ? 'cur' : l.rank < curRank ? 'done' : ''}"><div>${l.rank < curRank ? '✓ ' : ''}${l.name}</div><div class="small">${l.description}</div></div>`)}</div>
      ${g.history.length ? html`<div class="small muted" style="margin-top:10px">${g.history.map((h) => `${h.from_date}: ${h.level}${h.note ? ' (' + h.note + ')' : ''}`).join('  ·  ')}</div>` : ''}</div>
    <div class="card"><div class="row sp"><h2>Goals & targets</h2>${mgr ? html`<button class="btn sm primary" data-act="goalAdd" data-uid="${uid}">+ Goal</button>` : ''}</div>
      ${g.goals.length ? g.goals.map(goalCard) : html`<div class="empty">No goals yet.</div>`}</div>
    <div class="card"><h2>Where the time goes <span class="muted small">(last 30 days vs previous 30)</span></h2>
      ${g.skills.length ? html`<div class="tscroll"><table><tr><th>Task item</th><th class="right">Days</th><th class="right">Before</th><th class="right">Speed</th></tr>
      ${g.skills.map((s) => html`<tr><td>${s.task_type}</td><td class="right"><b>${fmtD(s.days)}</b></td><td class="right muted">${s.prev_days == null ? '–' : fmtD(s.prev_days)}</td>
        <td class="right">${s.hrs_per_unit ? html`${fmtH(s.hrs_per_unit)}/${s.unit} <span class="muted small">(team ${fmtH(s.team_hrs_per_unit)})</span>` : html`<span class="muted small">–</span>`}</td></tr>`)}</table></div>` : html`<div class="empty">Not enough data yet.</div>`}</div>
    <div class="card"><div class="row sp"><h2>Feedback & milestones</h2>${mgr ? html`<button class="btn sm primary" data-act="noteAdd" data-uid="${uid}">+ Add</button>` : ''}</div>
      ${g.notes.length ? g.notes.map((n) => html`<div class="note ${n.shared ? '' : 'priv'}"><div class="small muted">${n.created_at.slice(0, 10)} · ${n.author} · <span class="tag">${n.kind}</span> ${mgr ? (n.shared ? html`<span class="tag good">shared</span>` : html`<span class="tag warn">private</span>`) : ''}
        ${mgr ? html` <a href="#" data-act="noteDel" data-id="${n.id}" class="small">delete</a>` : ''}</div><div>${n.body}</div></div>`) : html`<div class="empty">Nothing here yet.</div>`}</div>`);
}

// ---------- DASHBOARD ----------
const D = { days: 30, project: null };
const rangeSel = (act, cur) => html`<select data-change="${act}" style="width:auto">${[[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [180, 'Last 6 months']].map(([d, l]) => html`<option value="${d}" ${cur === d ? raw('selected') : ''}>${l}</option>`)}</select>`;
const bars = (rows, { label, value, text, cls = () => '' }) => {
  const max = Math.max(...rows.map(value), 0.0001);
  return html`<div class="bars">${rows.map((r) => html`<div class="bar"><span class="lbl" title="${label(r)}">${label(r)}</span><div class="track"><div class="fill ${cls(r)}" style="width:${(value(r) / max) * 100}%"></div></div><b class="nowrap">${text(r)}</b></div>`)}</div>`;
};
function dayChart(byDay, from, to) {
  const map = Object.fromEntries(byDay.map((d) => [d.date, d.days]));
  const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const max = Math.max(...days.map((d) => map[d] || 0), 1), W = 600, H = 120, bw = W / days.length;
  return html`<svg viewBox="0 0 ${W} ${H + 16}" width="100%" role="img" aria-label="Days logged per day">${days.map((d, i) => { const h = ((map[d] || 0) / max) * H; return html`<rect x="${i * bw + 1}" y="${H - h}" width="${Math.max(1, bw - 2)}" height="${h}" rx="2" fill="var(--brand)" opacity="${map[d] ? 1 : 0.15}"><title>${d}: ${fmtD(map[d] || 0)} days</title></rect>`; })}
    <text x="0" y="${H + 12}">${from}</text><text x="${W}" y="${H + 12}" text-anchor="end">${to}</text></svg>`;
}
async function viewDash() {
  shell('dash', html`<div class="empty">Loading…</div>`);
  const to = today(), from = addDays(to, -(D.days - 1));
  const mine = scopedProjects();
  if (catalog.my_project_ids && !mine.length) return mount($('#view'), html`<h1>Dashboard</h1><div class="card empty"><b>No projects assigned to you yet.</b><br>When the admin assigns you as team leader of a project, its team performance appears here.</div>`);
  if (D.project && !mine.some((p) => p.id === D.project)) D.project = null;
  const o = await get('/dash/overview' + qs({ from, to, project_id: D.project }));
  const t = o.totals, behind = o.people.filter((p) => p.missing.length || p.partial.length).sort((a, b) => b.missing.length - a.missing.length);
  const tasks = o.by_task.slice(0, 8), people = o.by_person;
  const mx = Object.fromEntries(o.matrix.map((r) => [`${r.user_id}|${r.task_type_id}`, r.days]));
  const mmax = Math.max(...o.matrix.map((r) => r.days), 0.0001);
  const projSel = html`<select data-change="dashProject" style="width:auto;max-width:100%"><option value="">${catalog.my_project_ids ? 'All my projects' : 'All projects'}</option>${mine.map((p) => html`<option value="${p.id}" ${D.project === p.id ? raw('selected') : ''}>${p.name}</option>`)}</select>`;
  mount($('#view'), html`<div class="row sp"><h1>Dashboard${D.project ? html` <span class="muted" style="font-weight:500">· ${byId(catalog.projects, D.project)?.name}</span>` : ''}</h1><div class="row">${projSel}${rangeSel('dashRange', D.days)}</div></div>
    ${catalog.my_project_ids ? html`<p class="small muted" style="margin-top:-6px">Showing everyone's work on the projects you lead: ${mine.map((p) => p.name).join(', ')}.</p>` : ''}
    <div class="grid g4"><div class="kpi"><b>${fmtD(t.days)}</b><span>working days logged</span></div><div class="kpi"><b>${fmtD(t.leave_days)}</b><span>days off / leave</span></div>
      <div class="kpi"><b>${t.people}</b><span>people logging</span></div><div class="kpi"><b>${behind.length}</b><span>need follow-up</span></div></div>
    ${behind.length ? html`<div class="card" style="margin-top:14px;border-color:var(--warn)"><h2>⚠ Needs follow-up <span class="muted small">(workdays with nothing logged or less than 1 day)</span></h2>
      <div class="tscroll"><table><tr><th>Person</th><th class="right">Complete</th><th>Missing days</th><th>Partial days</th></tr>
      ${behind.map((p) => html`<tr><td><a href="#growth-${p.id}"><b>${p.name}</b></a>${p.email ? '' : html` <span class="tag warn">no email</span>`}</td><td class="right">${p.complete}/${p.expected}</td>
        <td>${p.missing.length ? html`<b>${p.missing.length}</b> <span class="small muted">— latest ${p.missing.slice(-3).map(shortDate).join(', ')}</span>` : '–'}</td>
        <td>${p.partial.length ? html`<b>${p.partial.length}</b> <span class="small muted">— latest ${p.partial.slice(-2).map((x) => `${shortDate(x.date)} (${fmtD(x.days)})`).join(', ')}</span>` : '–'}</td></tr>`)}</table></div></div>`
      : html`<div class="card" style="margin-top:14px"><b>✓ Everyone is up to date in this period.</b></div>`}
    <div class="card"><h2>Days logged per day (whole team)</h2>${dayChart(o.by_day, o.from, o.to)}</div>
    <div class="grid g2">
      <div class="card"><h2>Days by project</h2>${o.by_project.length ? bars(o.by_project, { label: (r) => r.name, value: (r) => r.days, text: (r) => fmtD(r.days) }) : html`<div class="empty">No data</div>`}</div>
      <div class="card"><h2>Days by person</h2>${people.length ? bars(people, { label: (r) => r.name, value: (r) => r.days, text: (r) => fmtD(r.days) }) : html`<div class="empty">No data</div>`}</div>
      <div class="card"><h2>Days by task item</h2>${o.by_task.length ? bars(o.by_task, { label: (r) => r.name, value: (r) => r.days, text: (r) => fmtD(r.days) }) : ''}</div>
      <div class="card"><h2>Days by scope</h2>${o.by_scope.length ? bars(o.by_scope, { label: (r) => r.name, value: (r) => r.days, text: (r) => fmtD(r.days) }) : ''}</div>
    </div>
    <div class="card"><h2>Who spends time on what <span class="muted small">(days)</span></h2><div class="tscroll"><table><tr><th>Person</th>${tasks.map((x) => html`<th class="right">${x.name}</th>`)}</tr>
      ${people.map((p) => html`<tr><td>${p.name}</td>${tasks.map((x) => { const v = mx[`${p.id}|${x.id}`] || 0; return html`<td class="right" style="background:color-mix(in srgb, var(--brand) ${Math.round((v / mmax) * 45)}%, transparent)">${v ? fmtD(v) : ''}</td>`; })}</tr>`)}</table></div></div>`);
}

// ---------- SPEED (productivity) ----------
const P = { days: 180, task: null, project: null, user: null };
async function viewProd() {
  shell('prod', html`<div class="empty">Loading…</div>`);
  const to = today(), from = addDays(to, -(P.days - 1));
  const tracked = catalog.task_types.filter((t) => t.track_qty && t.active);
  if (!P.task || !byId(tracked, P.task)) P.task = tracked.find((t) => /shop/i.test(t.name))?.id || tracked[0]?.id;
  const [data, ppl] = await Promise.all([get('/dash/productivity' + qs({ from, to, task_type_id: P.task, project_id: P.project, user_id: P.user })), get('/dash/people' + qs({ from, to }))]);
  const tt = byId(catalog.task_types, P.task), unit = tt?.unit_label || 'unit', teamRow = data.team[0];
  const persons = [...data.by_person_task].sort((a, b) => a.hrs_per_unit - b.hrs_per_unit), projs = [...data.by_project_task].sort((a, b) => a.hrs_per_unit - b.hrs_per_unit);
  const tr = data.trend, tmax = Math.max(...tr.map((x) => x.hrs_per_unit), 0.0001), W = 600, H = 100, PADX = 8;
  const X = (i) => (tr.length > 1 ? PADX + (i / (tr.length - 1)) * (W - 2 * PADX) : W / 2), Y = (v) => H - (v / tmax) * (H - 8) - 4;
  const sel = (id, opts, cur) => html`<select data-change="${id}" style="width:auto;max-width:100%">${opts.map(([v, l]) => html`<option value="${v}" ${String(cur ?? '') === String(v) ? raw('selected') : ''}>${l}</option>`)}</select>`;
  mount($('#view'), html`<h1>Speed per unit</h1>
    <p class="muted small">Hours to produce one drawing / RFI / family, learned from lines where people enter “how many”. Hours = days × ${data.hours_per_day}.</p>
    <div class="row" style="margin-bottom:14px">${sel('prodTask', tracked.map((t) => [t.id, t.name]), P.task)}${sel('prodProject', [['', catalog.my_project_ids ? 'All my projects' : 'All projects'], ...scopedProjects().map((p) => [p.id, p.name])], P.project)}
      ${sel('prodUser', [['', 'Everyone'], ...ppl.people.map((u) => [u.id, u.name])], P.user)}${sel('prodRange', [[90, 'Last 90 days'], [180, 'Last 6 months'], [365, 'Last year']], P.days)}</div>
    ${teamRow ? html`<div class="grid g4"><div class="kpi"><b>${fmtH(teamRow.hrs_per_unit)}</b><span>avg per ${unit}</span></div><div class="kpi"><b>${(1 / teamRow.hrs_per_unit).toFixed(2)}</b><span>${unit}s per hour</span></div>
      <div class="kpi"><b>${teamRow.units}</b><span>${unit}s counted</span></div><div class="kpi"><b>${teamRow.entries}</b><span>entries with a count</span></div></div>
    <div class="card" style="margin-top:14px"><h2>Weekly trend — hours per ${unit}</h2>
      <svg viewBox="0 0 ${W} ${H + 16}" width="100%"><polyline fill="none" stroke="var(--brand)" stroke-width="3" points="${tr.map((x, i) => `${X(i)},${Y(x.hrs_per_unit)}`).join(' ')}"/>${tr.map((x, i) => html`<circle cx="${X(i)}" cy="${Y(x.hrs_per_unit)}" r="4" fill="var(--brand)"><title>${x.week_start}: ${fmtH(x.hrs_per_unit)} per ${unit}</title></circle>`)}
      <text x="0" y="${H + 13}">${tr[0]?.week_start || ''}</text><text x="${W}" y="${H + 13}" text-anchor="end">${tr.at(-1)?.week_start || ''}</text></svg></div>
    <div class="grid g2"><div class="card"><h2>By person <span class="muted small">(faster first)</span></h2>
      ${bars(persons, { label: (r) => r.user, value: (r) => r.hrs_per_unit, text: (r) => `${fmtH(r.hrs_per_unit)} ${r.vs_team_pct ? `(${r.vs_team_pct > 0 ? '+' : ''}${r.vs_team_pct}%)` : ''}`, cls: (r) => (r.vs_team_pct <= -5 ? 'good' : r.vs_team_pct >= 15 ? 'warn' : '') })}
      <div class="small muted" style="margin-top:8px">% vs team average. Green ≥5% faster, amber ≥15% slower.</div></div>
    <div class="card"><h2>By project</h2>${bars(projs, { label: (r) => r.project, value: (r) => r.hrs_per_unit, text: (r) => `${fmtH(r.hrs_per_unit)} · ${r.units}` })}</div></div>`
      : html`<div class="card empty"><b>No “${tt?.name || 'task'}” lines with a count yet.</b><br>Your Excel history has no quantities, so speed starts building from the moment the team enters “how many ${unit}s” on the timesheet. Use the Dashboard for effort so far.</div>`}`);
}

// ---------- TEAM ----------
async function viewTeam() {
  shell('team', html`<div class="empty">Loading…</div>`);
  const { users } = await get('/users');
  const admin = isAdmin();
  mount($('#view'), html`<div class="row sp"><h1>Team</h1>${admin ? html`<button class="btn primary" data-act="userAdd">+ Add person</button>` : ''}</div>
    <div class="card"><div class="tscroll"><table><tr><th>Name</th><th>Access</th><th>Level</th><th>Start date</th><th>Last entry</th><th class="right">Days (30d)</th><th></th></tr>
    ${users.map((u) => html`<tr style="${u.active ? '' : 'opacity:.5'}"><td><a href="#growth-${u.id}"><b>${u.name}</b></a><div class="small muted">${u.email || html`<span class="tag warn">no email</span>`}${u.team ? ' · ' + u.team : ''}</div></td><td><span class="tag">${u.role}</span></td><td>${u.level || '–'}</td>
      <td class="nowrap small">${u.start_date || '–'}</td><td>${u.role === 'admin' ? '' : rel(u.last_entry)}</td><td class="right">${fmtD(u.days_30d)}</td><td class="right nowrap"><a class="btn sm" href="#growth-${u.id}">Growth</a> ${admin ? html`<button class="btn sm" data-act="userEdit" data-id="${u.id}">Edit</button>` : ''}</td></tr>`)}</table></div></div>`);
  window._users = users;
}


// ---------- PROJECTS (leaders propose, admin approves) ----------
async function viewProjects() {
  shell('projects', html`<div class="empty">Loading…</div>`);
  await loadCatalog(); shell('projects', html`<div class="empty">Loading…</div>`);
  const { proposals } = await get('/proposals');
  window._proposals = proposals;
  const admin = isAdmin(), pending = proposals.filter((p) => p.status === 'pending'), decided = proposals.filter((p) => p.status !== 'pending');
  const scopeName = (id) => byId(catalog.scopes, id)?.name || '–';
  const stTag = (p) => html`<span class="tag ${p.status === 'approved' ? 'good' : p.status === 'rejected' ? 'bad' : 'warn'}">${p.status === 'pending' ? 'waiting for approval' : p.status}</span>`;
  const row = (p, actions) => html`<div class="entry"><div class="t">${p.name} <span class="muted small">· ${p.scope || '–'}</span></div><div class="right">${stTag(p)}</div>
    <div class="d">${admin ? `Proposed by ${p.proposed_by_name} · ` : ''}${p.created_at.slice(0, 10)}${p.note ? ' — ' + p.note : ''}${p.reason ? ` · ${p.status === 'rejected' ? 'Reason' : 'Note'}: ${p.reason}` : ''}${p.decided_by_name ? ` · decided by ${p.decided_by_name}` : ''}</div>
    <div class="right nowrap">${actions || ''}</div></div>`;
  mount($('#view'), html`<h1>Projects</h1>
    ${admin ? html`<div class="card" style="${pending.length ? 'border-color:var(--warn)' : ''}"><div class="row sp"><h2>Waiting for your approval</h2><button class="btn sm primary" data-act="projAddHere">+ New project</button></div>
        ${pending.length ? pending.map((p) => row(p, html`<button class="btn sm primary" data-act="propApprove" data-id="${p.id}">Approve</button> <button class="btn sm danger" data-act="propReject" data-id="${p.id}">Reject</button>`)) : html`<div class="empty">No proposals waiting.</div>`}</div>`
      : html`<form class="card" id="propForm"><h2>Propose a new project</h2><p class="muted small">The admin reviews it; once approved it appears on everyone's timesheet with this scope.</p>
        <div class="grid g2"><div><label class="f" for="pn">Project name</label><input id="pn" name="name" type="text" maxlength="120" required></div>
        <div><label class="f" for="ps">Scope</label><select id="ps" name="scope_id" required><option value="">— choose scope —</option>${catalog.scopes.filter((x) => x.active).map((x) => html`<option value="${x.id}">${x.name}</option>`)}</select></div></div>
        <div style="margin-top:10px"><label class="f" for="pnote">Note for the admin <span class="muted">(optional)</span></label><input id="pnote" name="note" type="text" maxlength="1000" placeholder="client, package, expected start…"></div>
        <div class="row" style="margin-top:12px"><button class="btn primary" type="submit">Send proposal</button></div></form>
        <div class="card"><h2>My proposals</h2>${proposals.length ? proposals.map((p) => row(p)) : html`<div class="empty">You haven't proposed any project yet.</div>`}</div>`}
    ${admin && decided.length ? html`<div class="card"><h2>Decided</h2>${decided.slice(0, 30).map((p) => row(p))}</div>` : ''}
    ${catalog.my_project_ids ? html`<div class="card"><h2>Projects I lead</h2>${scopedProjects().length ? html`<div class="chips">${scopedProjects().map((p) => html`<a class="chip" href="#dash-${p.id}">▦ ${p.name}</a>`)}</div><p class="small muted" style="margin-top:8px">Tap a project to open its team dashboard.</p>` : html`<div class="empty">No projects assigned to you yet — the admin assigns team leaders to projects.</div>`}</div>` : ''}
    <div class="card"><h2>Active projects</h2><div class="tscroll"><table><tr><th>Project</th><th>Scope</th><th>Team leader</th>${admin ? html`<th></th>` : ''}</tr>${catalog.projects.filter((p) => p.active && !p.is_leave).map((p) => html`<tr><td>${p.name}</td><td>${scopeName(p.default_scope_id)}</td><td>${p.leaders?.join(', ') || html`<span class="muted">–</span>`}</td>${admin ? html`<td class="right"><button class="btn sm" data-act="projEditHere" data-id="${p.id}">Edit</button></td>` : ''}</tr>`)}</table></div></div>`);
  const f = $('#propForm');
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    const body = { name: f.elements.name.value, scope_id: f.elements.scope_id.value, note: f.elements.note.value };
    if (await attempt(() => post('/proposals', body), 'Proposal sent to the admin')) viewProjects();
  };
}

// ---------- EXPORT ----------
const EX_KEY = 'ts-export-v1';
const exLoad = () => { try { return JSON.parse(localStorage.getItem(EX_KEY)) || {}; } catch { return {}; } };
const exSave = (v) => { try { localStorage.setItem(EX_KEY, JSON.stringify(v)); } catch {} };
function presetRange(k) {
  const t = today(), d = new Date(t + 'T12:00:00'), wd = d.getDay(), y = d.getFullYear(), m = d.getMonth();
  const f = (x) => ymd(x);
  if (k === 'week') return [addDays(t, -wd), t];
  if (k === 'lastweek') return [addDays(t, -wd - 7), addDays(t, -wd - 1)];
  if (k === 'month') return [f(new Date(y, m, 1)), t];
  if (k === 'lastmonth') return [f(new Date(y, m - 1, 1)), f(new Date(y, m, 0))];
  if (k === 'year') return [f(new Date(y, 0, 1)), t];
  return [addDays(t, -29), t];
}
async function viewExport() {
  shell('export', html`<div class="empty">Loading…</div>`);
  const [opt, { people: users }] = await Promise.all([get('/export/options'), get('/dash/people' + qs({ from: addDays(today(), -365), to: today() }))]);
  const saved = exLoad(), [df, dt] = presetRange('month');
  const st = { from: df, to: dt, format: saved.format || 'xlsx', columns: saved.columns || opt.columns.filter((c) => c.def).map((c) => c.key),
    sheets: saved.sheets || opt.sheets.filter((c) => c.def).map((c) => c.key), users: [], projects: [] };
  const people = users;
  const projs = scopedProjects();
  const chk = (group, key, label, on, disabled) => html`<label class="chip ${on ? 'on' : ''}" style="cursor:pointer;${disabled ? 'opacity:.45;pointer-events:none' : ''}"><input type="checkbox" data-g="${group}" value="${key}" ${on ? raw('checked') : ''} style="display:none">${label}</label>`;
  const draw = () => {
    const csv = st.format === 'csv';
    mount($('#view'), html`<h1>Export</h1>
      <div class="card"><h2>Period</h2>
        <div class="chips" style="margin-bottom:10px">${[['week', 'This week'], ['lastweek', 'Last week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['30', 'Last 30 days'], ['year', 'This year']].map(([k, l]) => html`<button class="chip" data-act="exPreset" data-k="${k}">${l}</button>`)}</div>
        <div class="grid g2"><div><label class="f" for="exFrom">From</label><input type="date" id="exFrom" value="${st.from}"></div><div><label class="f" for="exTo">To</label><input type="date" id="exTo" value="${st.to}"></div></div></div>
      <div class="card"><h2>Format</h2><div class="chips">${chk('format', 'xlsx', 'Excel (.xlsx) — several sheets', !csv)}${chk('format', 'csv', 'CSV — timesheet lines only', csv)}</div></div>
      <div class="card"><div class="row sp"><h2>What to include</h2></div>
        <div class="chips">${opt.sheets.map((x) => chk('sheets', x.key, x.label, csv ? x.key === 'lines' : st.sheets.includes(x.key), csv))}</div>
        ${csv ? html`<p class="small muted">CSV holds one table, so it contains the timesheet lines only.</p>` : ''}</div>
      <div class="card"><div class="row sp"><h2>Columns of the timesheet lines</h2><button class="btn sm ghost" data-act="exColsDefault">Same as the old Excel</button></div>
        <div class="chips">${opt.columns.map((c) => chk('columns', c.key, c.label, st.columns.includes(c.key)))}</div></div>
      <div class="grid g2">
        <div class="card"><div class="row sp"><h2>People</h2><span class="small muted">${st.users.length ? `${st.users.length} selected` : 'everyone'}</span></div>
          <div class="chips">${people.map((u) => chk('users', u.id, u.name, st.users.includes(u.id)))}</div></div>
        <div class="card"><div class="row sp"><h2>Projects</h2><span class="small muted">${st.projects.length ? `${st.projects.length} selected` : 'all projects'}</span></div>
          <div class="chips">${projs.map((p) => chk('projects', p.id, p.name, st.projects.includes(p.id)))}</div></div></div>
      <div class="card stickybar"><div class="row sp"><span class="small muted">${niceDate(st.from)} → ${niceDate(st.to)} · ${csv ? 'CSV' : 'Excel'}</span>
        <button class="btn primary" data-act="exGo" style="min-width:180px">⤓ Download</button></div></div>`);
  };
  window._ex = { st, draw, opt };
  draw();
}
document.addEventListener('change', (e) => {
  const x = window._ex; if (!x || !$('#exFrom')) return;
  const t = e.target, st = x.st;
  if (t.id === 'exFrom') st.from = t.value; else if (t.id === 'exTo') st.to = t.value;
  else if (t.dataset.g) {
    const g = t.dataset.g, v = g === 'users' || g === 'projects' ? Number(t.value) : t.value;
    if (g === 'format') st.format = v;
    else st[g] = t.checked ? [...new Set([...st[g], v])] : st[g].filter((k) => k !== v);
    exSave({ format: st.format, columns: st.columns, sheets: st.sheets });
    x.draw();
  }
});

// ---------- EMAILS ----------
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
async function viewEmails() {
  shell('emails', html`<div class="empty">Loading…</div>`);
  const a = await get('/admin/settings'), s = a.settings, wds = s.workdays.split(',').map(Number);
  window._outbox = a.outbox;
  const st = (x) => (x === 'sent' ? 'good' : x === 'failed' ? 'bad' : 'warn');
  mount($('#view'), html`<h1>Emails & reminders</h1>
    ${a.smtp ? html`<div class="card" style="border-color:var(--good)"><b>✓ Email delivery is connected.</b> Local time now: ${a.now.date} ${a.now.hhmm} (${s.timezone}).</div>`
      : html`<div class="card" style="border-color:var(--warn)"><b>⚠ Email delivery is not connected yet.</b><div class="small">Everything below works and is recorded in the log, but nothing is actually sent until the server has SMTP settings (see README → “Email setup”). Local time now: ${a.now.date} ${a.now.hhmm} (${s.timezone}).</div></div>`}
    <form class="card" id="setForm"><h2>Schedule</h2>
      <div class="field"><label class="row"><input type="checkbox" name="reminders_enabled" ${s.reminders_enabled === '1' ? raw('checked') : ''} style="width:22px;height:22px"><b>Daily reminder to the team</b></label>
        <div class="row" style="margin-top:8px"><span>at</span><input type="time" name="reminder_time" value="${s.reminder_time}" style="width:auto"><span>on</span>
          ${WD.map((n, i) => html`<label class="chip ${wds.includes(i) ? 'on' : ''}" style="cursor:pointer"><input type="checkbox" name="wd${i}" ${wds.includes(i) ? raw('checked') : ''} style="display:none" onchange="this.parentNode.classList.toggle('on',this.checked)">${n}</label>`)}</div>
        <label class="row" style="margin-top:8px"><input type="checkbox" name="reminder_only_incomplete" ${s.reminder_only_incomplete === '1' ? raw('checked') : ''} style="width:22px;height:22px"><span>Only remind people who haven't completed today (less than 1 day logged)</span></label></div>
      <div class="field"><label class="row"><input type="checkbox" name="weekly_report_enabled" ${s.weekly_report_enabled === '1' ? raw('checked') : ''} style="width:22px;height:22px"><b>Weekly “who hasn't filled” report to me</b></label>
        <div class="row" style="margin-top:8px"><span>every</span><select name="weekly_report_day" style="width:auto">${WD.map((n, i) => html`<option value="${i}" ${Number(s.weekly_report_day) === i ? raw('selected') : ''}>${n}</option>`)}</select><span>at</span><input type="time" name="weekly_report_time" value="${s.weekly_report_time}" style="width:auto"></div>
        <div style="margin-top:8px"><label class="f">Send the report to</label><input type="email" name="admin_email" value="${s.admin_email}" placeholder="your work email"></div></div>
      <div class="grid g2"><div><label class="f">Timezone</label><input type="text" name="timezone" value="${s.timezone}"></div><div><label class="f">Working hours per day</label><input type="number" name="hours_per_day" min="1" max="24" step="0.5" value="${s.hours_per_day}"></div></div>
      <div><label class="f" style="margin-top:12px">Link to the app in emails</label><input type="text" name="app_url" value="${s.app_url}" placeholder="https://timesheet.yourcompany.com"></div>
      <div class="row" style="margin-top:14px"><button class="btn primary" type="submit">Save schedule</button></div></form>
    <div class="card"><h2>Try it</h2><div class="row">
      <button class="btn" data-act="notify" data-a="reminder" data-dry="1">Preview today's reminder</button><button class="btn" data-act="notify" data-a="reminder">Send reminder now</button>
      <button class="btn" data-act="notify" data-a="weekly" data-dry="1">Preview weekly report</button><button class="btn" data-act="notify" data-a="weekly">Send weekly report now</button>
      <button class="btn" data-act="notify" data-a="test">Send test email</button></div></div>
    <div class="card"><h2>Email log <span class="muted small">(latest 60)</span></h2>
      ${a.outbox.length ? html`<div class="tscroll"><table><tr><th>When (UTC)</th><th>Type</th><th>To</th><th>Subject</th><th>Status</th></tr>${a.outbox.map((m) => html`<tr><td class="nowrap small">${m.created_at}</td><td>${m.kind}</td><td>${m.to_addr}</td>
        <td><a href="#" data-act="viewMail" data-id="${m.id}">${m.subject}</a></td><td><span class="tag ${st(m.status)}" title="${m.error || ''}">${m.status.replace('_', ' ')}</span></td></tr>`)}</table></div>` : html`<div class="empty">Nothing yet.</div>`}</div>`);
  $('#setForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements, body = { timezone: f.timezone.value, hours_per_day: f.hours_per_day.value, reminder_time: f.reminder_time.value, weekly_report_time: f.weekly_report_time.value, weekly_report_day: f.weekly_report_day.value,
      admin_email: f.admin_email.value, app_url: f.app_url.value, reminders_enabled: f.reminders_enabled.checked, weekly_report_enabled: f.weekly_report_enabled.checked, reminder_only_incomplete: f.reminder_only_incomplete.checked,
      workdays: WD.map((_, i) => i).filter((i) => f['wd' + i].checked).join(',') };
    if (!body.workdays) return toast('Pick at least one workday', true);
    if (await attempt(() => put('/admin/settings', body), 'Schedule saved')) { await loadCatalog(); viewEmails(); }
  };
}

// ---------- SETUP ----------
async function viewSetup() {
  shell('setup', html`<div class="empty">Loading…</div>`);
  await loadCatalog();
  const list = (title, items, addAct, editAct, sub) => html`<div class="card"><div class="row sp"><h2>${title}</h2><button class="btn sm primary" data-act="${addAct}">+ Add</button></div>
    ${items.length ? items.map((i) => html`<div class="row sp" style="padding:8px 0;border-bottom:1px solid var(--line);${i.active === 0 ? 'opacity:.5' : ''}"><div>${i.name}<div class="small muted">${sub(i)}</div></div><button class="btn sm" data-act="${editAct}" data-id="${i.id}">Edit</button></div>`) : html`<div class="empty">None yet</div>`}</div>`;
  mount($('#view'), html`<h1>Setup</h1>
    <p class="muted">These lists feed the quick-pick buttons on the timesheet. Archive instead of deleting so history is kept.</p>
    ${list('Projects', catalog.projects, 'projAdd', 'projEdit', (p) => `scope: ${byId(catalog.scopes, p.default_scope_id)?.name || '–'}${p.leaders?.length ? ' · leader: ' + p.leaders.join(', ') : p.is_leave ? '' : ' · no leader'}${p.is_leave ? ' · leave' : ''}${p.active ? '' : ' · archived'}`)}
    ${list('Task items', catalog.task_types, 'taskAdd', 'taskEdit', (t) => `${t.track_qty ? `asks “how many ${t.unit_label}s?”` : 'time only'}${t.is_leave ? ' · leave' : ''}${t.active ? '' : ' · archived'}`)}
    ${list('Scopes', catalog.scopes, 'scopeAdd', 'scopeEdit', (s) => (s.active ? '' : 'archived'))}
    ${list('Career levels', catalog.levels.map((l) => ({ ...l, active: 1 })), 'lvlAdd', 'lvlEdit', (l) => `#${l.rank} · ${l.description}`)}`);
}

// ---------- actions (delegated) ----------
const fld = (n, l, o = {}) => ({ name: n, label: l, ...o });
const actions = {
  ...logActions,
  theme: () => cycleTheme(),
  demoLogin: async (el) => { $('#u').value = el.dataset.u; $('#p').value = el.dataset.p; $('#loginForm').requestSubmit(); },
  demoReset: async () => { if (await ask('Reset all sample data to the starting state?', { ok: 'Reset', danger: true })) window.DEMO.reset(); },
  logout: async () => { await post('/logout'); me = null; renderLogin(); },
  pw: async () => {
    const v = await formDialog({ title: 'Change password', submit: 'Change', fields: [fld('current', 'Current password', { type: 'password', required: true, autocomplete: 'current-password' }), fld('next', 'New password (6+ characters)', { type: 'password', required: true, autocomplete: 'new-password' })] });
    if (v) attempt(() => post('/me/password', v), 'Password changed');
  },
  goEdit: (el) => { L.date = el.dataset.date; L._openEdit = Number(el.dataset.id); },
  goalAdd: (el) => goalForm(Number(el.dataset.uid)),
  goalEdit: (el) => goalForm(Number(el.dataset.uid), window._growth.goals.find((g) => g.id === Number(el.dataset.id))),
  goalDel: async (el) => { if (await ask('Delete this goal?', { ok: 'Delete', danger: true }) && await attempt(() => del('/goals/' + el.dataset.id), 'Deleted')) route(); },
  goalProgress: async (el) => {
    const v = await formDialog({ title: 'Update progress', fields: [fld('current_value', 'Current value', { type: 'number', step: 'any', required: true })], values: { current_value: el.dataset.cur } });
    if (v && await attempt(() => put('/goals/' + el.dataset.id, { current_value: Number(v.current_value) }), 'Updated')) route();
  },
  noteAdd: async (el) => {
    const v = await formDialog({ title: 'Add feedback / milestone', fields: [
      fld('kind', 'Type', { type: 'select', options: ['feedback', 'milestone', 'review', 'note'].map((k) => ({ value: k, label: k })) }),
      fld('body', 'Note', { type: 'textarea', required: true }), fld('shared', 'Share with the employee', { type: 'checkbox', default: true })] });
    if (v && await attempt(() => post(`/users/${el.dataset.uid}/notes`, v), 'Added')) route();
  },
  noteDel: async (el, ev) => { ev.preventDefault(); if (await ask('Delete this note?', { ok: 'Delete', danger: true }) && await attempt(() => del('/notes/' + el.dataset.id))) route(); },
  setLevel: async (el) => {
    const g = window._growth;
    const v = await formDialog({ title: 'Change level / promote', fields: [
      fld('level_id', 'New level', { type: 'select', options: g.levels.map((l) => ({ value: l.id, label: l.name })), default: g.level?.id }),
      fld('from_date', 'Effective from', { type: 'date', default: today() }), fld('note', 'Reason / note'),
      fld('share', 'Share a milestone with the employee', { type: 'checkbox', default: true })] });
    if (v && await attempt(() => post(`/users/${el.dataset.uid}/level`, v), 'Level updated')) route();
  },
  propApprove: async (el) => {
    const p = window._proposals.find((x) => x.id === Number(el.dataset.id));
    const v = await formDialog({ title: 'Approve project', submit: 'Approve & create', fields: [fld('name', 'Project name', { required: true }), fld('scope_id', 'Scope', { type: 'select', options: scopeOpts('— choose scope —') }), fld('assign_leader', `Make ${p.proposed_by_name} the team leader of this project`, { type: 'checkbox' }), fld('reason', 'Message to the leader (optional)')], values: { name: p.name, scope_id: p.scope_id, assign_leader: true } });
    if (v && await attempt(() => post(`/proposals/${p.id}/approve`, v), `“${v.name}” created`)) viewProjects();
  },
  propReject: async (el) => {
    const v = await formDialog({ title: 'Reject proposal', submit: 'Reject', danger: true, fields: [fld('reason', 'Reason (sent to the leader)', { type: 'textarea' })] });
    if (v && await attempt(() => post(`/proposals/${el.dataset.id}/reject`, v), 'Rejected')) viewProjects();
  },
  projAddHere: () => projectForm(null, viewProjects),
  projEditHere: (el) => projectForm(byId(catalog.projects, el.dataset.id), viewProjects),
  exPreset: (el) => { const x = window._ex; [x.st.from, x.st.to] = presetRange(el.dataset.k); x.draw(); },
  exColsDefault: () => { const x = window._ex; x.st.columns = x.opt.columns.filter((c) => c.def).map((c) => c.key); exSave({ format: x.st.format, columns: x.st.columns, sheets: x.st.sheets }); x.draw(); },
  exGo: async (el) => {
    const st = window._ex.st;
    if (!st.from || !st.to || st.from > st.to) return toast('Check the dates', true);
    if (!st.columns.length && (st.format === 'csv' || st.sheets.includes('lines'))) return toast('Pick at least one column', true);
    if (window.DEMO) return infoDialog('Export', html`<p>Downloads are switched off in this preview. In the real app this button downloads <b>${st.format === 'csv' ? 'a CSV file' : 'an Excel file'}</b> for ${niceDate(st.from)} → ${niceDate(st.to)} with: ${st.format === 'csv' ? 'timesheet lines' : window._ex.opt.sheets.filter((x) => st.sheets.includes(x.key)).map((x) => x.label.toLowerCase()).join(', ')}.</p>`);
    el.disabled = true; el.textContent = 'Preparing…';
    try {
      const r = await fetch('/api/export' + qs({ from: st.from, to: st.to, format: st.format, columns: st.columns.join(','), sheets: st.sheets.join(','), users: st.users.join(','), projects: st.projects.join(',') }), { credentials: 'same-origin' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Export failed');
      const name = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'timesheet-export';
      const url = URL.createObjectURL(await r.blob());
      Object.assign(document.createElement('a'), { href: url, download: name }).click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast(`Downloaded ${name} — ${r.headers.get('X-Row-Count')} timesheet lines`);
    } catch (e) { toast(e.message, true); } finally { el.disabled = false; el.textContent = '⤓ Download'; }
  },
  userAdd: () => userForm(), userEdit: (el) => userForm(window._users.find((u) => u.id === Number(el.dataset.id))),
  projAdd: () => projectForm(), projEdit: (el) => projectForm(byId(catalog.projects, el.dataset.id)),
  taskAdd: () => taskForm(), taskEdit: (el) => taskForm(byId(catalog.task_types, el.dataset.id)),
  scopeAdd: () => simpleForm('scopes', 'Scope'), scopeEdit: (el) => simpleForm('scopes', 'Scope', byId(catalog.scopes, el.dataset.id)),
  lvlAdd: () => levelForm(), lvlEdit: (el) => levelForm(byId(catalog.levels, el.dataset.id)),
  // emails
  notify: async (el) => {
    const a = el.dataset.a, dry = !!el.dataset.dry; let body = { action: a, dry };
    if (a === 'test') { const v = await formDialog({ title: 'Send a test email', submit: 'Send', fields: [fld('to', 'Send to', { type: 'email', required: true, default: (await get('/admin/settings')).settings.admin_email })] }); if (!v) return; body.to = v.to; }
    else if (!dry && !(await ask(a === 'reminder' ? 'Send the reminder email now to everyone who has not completed today?' : 'Send the weekly report to you now?', { ok: 'Send' }))) return;
    const r = await attempt(() => post('/admin/notify', body)); if (!r) return;
    if (a === 'reminder') infoDialog(dry ? 'Reminder preview' : 'Reminder sent', html`<p class="small">${dry ? 'These people would get the email now:' : `${r.sent} sent${r.failed ? `, ${r.failed} failed` : ''}${r.smtp === false || (!r.dry && r.sent === 0 && r.recipients.length) ? ' (email delivery not connected — recorded in the log only)' : ''}.`}</p>
      <ul class="small">${r.recipients.map((x) => html`<li>${x.name} <span class="muted">— ${x.email}, logged ${fmtD(x.logged)}/1</span></li>`)}</ul>
      ${r.recipients.length ? '' : html`<p class="muted small">Nobody to remind — everyone has completed ${r.date}.</p>`}
      ${r.no_email.length ? html`<p class="small" style="color:var(--warn)">No email on file: ${r.no_email.join(', ')}</p>` : ''}${r.already_done ? html`<p class="small muted">${r.already_done} already complete — skipped.</p>` : ''}`);
    else if (a === 'weekly') infoDialog(dry ? 'Weekly report preview' : 'Weekly report', html`<p class="small">Week ${r.from} → ${r.to}. ${dry ? 'Would be sent to' : `Status: <b>${r.status}</b> — sent to`} <b>${r.sent_to || 'no address set (set it above)'}</b></p>
      ${r.behind.length ? html`<ul class="small">${r.behind.map((p) => html`<li><b>${p.name}</b> — ${p.complete}/${p.expected} complete; missing ${p.missing.length} day(s)${p.partial.length ? `, ${p.partial.length} partial` : ''}</li>`)}</ul>` : html`<p>Everyone is complete 🎉</p>`}`);
    else toast(r.status === 'sent' ? `Test email sent to ${r.to}` : `Recorded (not delivered — SMTP not configured): ${r.to}`);
    if (!dry) viewEmails();
  },
  viewMail: async (el, ev) => { ev.preventDefault(); const m = await get('/admin/outbox/' + el.dataset.id);
    infoDialog(m.subject, html`<div class="small muted">To: ${m.to_addr} · ${m.status}${m.error ? ' — ' + m.error : ''}</div><iframe sandbox style="width:100%;height:340px;border:1px solid var(--line);border-radius:10px;margin-top:8px;background:#fff" srcdoc="${m.html}"></iframe>`); },
};
const scopeOpts = (none = '—') => [{ value: '', label: none }, ...catalog.scopes.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))];
async function projectForm(p, after = viewSetup) {
  const leaders = (await get('/leaders')).leaders.filter((l) => l.role === 'leader');
  const v = await formDialog({ title: p ? 'Edit project' : 'New project', fields: [fld('name', 'Project name', { required: true }), fld('code', 'Code (optional)'),
    fld('default_scope_id', 'Scope', { type: 'select', options: scopeOpts('— choose scope —'), help: 'Filled in automatically for everyone who logs time on this project.' }),
    fld('leader_ids', 'Team leader(s) monitoring this project', { type: 'checks', options: leaders.map((l) => ({ value: l.id, label: l.name })), empty: 'No team leaders yet — set Access = Team leader on the Team page.', help: 'They see this project on their Dashboard, Speed and Export.' }), fld('is_leave', 'This is a leave / day-off item', { type: 'checkbox' }), ...(p ? [fld('active', 'Active (shown on timesheet)', { type: 'checkbox' })] : [])],
    values: p ? { ...p, default_scope_id: p.default_scope_id ?? '', active: !!p.active, is_leave: !!p.is_leave } : { leader_ids: [] } });
  if (v && await attempt(() => (p ? put('/projects/' + p.id, v) : post('/projects', v)), 'Saved')) after();
}
async function taskForm(t) {
  const v = await formDialog({ title: t ? 'Edit task item' : 'New task item', fields: [fld('name', 'Task item name', { required: true }),
    fld('track_qty', 'Ask “how many?” (drawings, RFIs…) so speed can be learned', { type: 'checkbox' }), fld('unit_label', 'What is counted? (singular, e.g. sheet)'),
    fld('is_leave', 'This is a leave / day-off item', { type: 'checkbox' }), ...(t ? [fld('active', 'Active (shown on timesheet)', { type: 'checkbox' })] : [])],
    values: t ? { ...t, track_qty: !!t.track_qty, is_leave: !!t.is_leave, active: !!t.active } : { unit_label: 'sheet' } });
  if (v && await attempt(() => (t ? put('/task_types/' + t.id, v) : post('/task_types', v)), 'Saved')) viewSetup();
}
async function simpleForm(kind, label, ex) {
  const v = await formDialog({ title: ex ? `Edit ${label.toLowerCase()}` : `New ${label.toLowerCase()}`, fields: [fld('name', `${label} name`, { required: true }), ...(ex ? [fld('active', 'Active', { type: 'checkbox' })] : [])], values: ex ? { ...ex, active: !!ex.active } : {} });
  if (v && await attempt(() => (ex ? put(`/${kind}/${ex.id}`, v) : post(`/${kind}`, v)), 'Saved')) viewSetup();
}
async function levelForm(ex) {
  const v = await formDialog({ title: ex ? 'Edit level' : 'New level', fields: [fld('name', 'Name', { required: true }), fld('rank', 'Order (1 = lowest)', { type: 'number', required: true, default: catalog.levels.length + 1 }), fld('description', 'What this level means', { type: 'textarea' })], values: ex || {} });
  if (v && await attempt(() => (ex ? put('/levels/' + ex.id, v) : post('/levels', v)), 'Saved')) viewSetup();
}
async function userForm(u) {
  const { leaders } = await get('/leaders');
  const fields = [fld('name', 'Full name', { required: true }), ...(u ? [] : [fld('username', 'Username', { required: true, autocomplete: 'off' })]),
    fld('email', 'Work email (for reminders)', { type: 'email' }),
    fld('password', u ? 'Reset password (leave empty to keep)' : 'Initial password (6+)', { type: 'password', required: !u, autocomplete: 'new-password' }),
    fld('job_title', 'Job title'), fld('team', 'Team / department'),
    fld('start_date', 'Start date', { type: 'date', help: 'Days before this date are never counted as missing — no reminders, no follow-up flags.' }),
    fld('role', 'Access', { type: 'select', options: [{ value: 'member', label: 'Team member' }, { value: 'leader', label: 'Team leader (sees own team)' }, { value: 'admin', label: 'Admin (sees everything)' }] }),
    fld('leader_id', 'Reports to', { type: 'select', options: [{ value: '', label: '— none —' }, ...leaders.filter((l) => l.id !== u?.id).map((l) => ({ value: l.id, label: l.name }))] })];
  if (!u) fields.push(fld('level_id', 'Starting level', { type: 'select', options: [{ value: '', label: '—' }, ...catalog.levels.map((l) => ({ value: l.id, label: l.name }))] }));
  if (u) fields.push(fld('active', 'Active (can sign in, gets reminders)', { type: 'checkbox' }));
  const v = await formDialog({ title: u ? 'Edit person' : 'Add person', fields, values: u ? { ...u, leader_id: u.leader_id ?? '' } : { role: 'member', team: 'BIM', start_date: today() } });
  if (!v) return;
  if (await attempt(() => (u ? put('/users/' + u.id, v) : post('/users', v)), 'Saved')) viewTeam();
}
async function goalForm(uid, g) {
  const tracked = catalog.task_types.filter((t) => t.active && !t.is_leave);
  const v = await formDialog({ title: g ? 'Edit goal' : 'New goal', fields: [
    fld('title', 'Goal', { required: true }),
    fld('metric', 'How is it measured?', { type: 'select', options: [{ value: 'manual', label: 'Manual (you update progress)' }, { value: 'avg_hrs', label: 'Auto: hours per unit (lower = better)' }, { value: 'units_month', label: 'Auto: units completed per 30 days' }] }),
    fld('task_type_id', 'For which task item (auto goals)', { type: 'select', options: [{ value: '', label: 'All tasks' }, ...tracked.map((t) => ({ value: t.id, label: t.name }))] }),
    fld('start_value', 'Starting value', { type: 'number', step: 'any', help: 'Auto goals: leave empty to use the current measured value.' }),
    fld('target_value', 'Target value', { type: 'number', step: 'any', required: true }), fld('unit', 'Unit (e.g. hrs, %, sheets)'),
    fld('due_date', 'Due date', { type: 'date' }), fld('description', 'Notes', { type: 'textarea' }),
    ...(g ? [fld('status', 'Status', { type: 'select', options: ['active', 'achieved', 'dropped'].map((s) => ({ value: s, label: s })) })] : [])],
    values: g ? { ...g, task_type_id: g.task_type_id ?? '' } : { metric: 'manual' } });
  if (!v) return;
  if (await attempt(() => (g ? put('/goals/' + g.id, v) : post(`/users/${uid}/goals`, v)), 'Saved')) route();
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (fn) { if (el.tagName === 'A' && el.dataset.act !== 'goEdit') e.preventDefault(); fn(el, e); }
});
document.addEventListener('change', (e) => {
  const a = e.target.dataset?.change; if (!a) return;
  const v = e.target.value;
  if (a === 'dashRange') { D.days = Number(v); viewDash(); }
  else if (a === 'dashProject') { D.project = v ? Number(v) : null; viewDash(); }
  else if (a === 'prodRange') { P.days = Number(v); viewProd(); }
  else if (a === 'prodTask') { P.task = Number(v); viewProd(); }
  else if (a === 'prodProject') { P.project = v ? Number(v) : null; viewProd(); }
  else if (a === 'prodUser') { P.user = v ? Number(v) : null; viewProd(); }
});

// ---------- routing ----------
async function loadCatalog() { catalog = await get('/catalog'); }
async function route() {
  if (!me) return renderLogin();
  const h = location.hash.replace(/^#\/?/, '');
  const [page = 'log', arg] = h.includes('/') ? h.split('/') : (h.match(/^([a-z]+)(?:-(\d+))?$/) || [, h || 'log']).slice(1);
  const guard = { dash: isMgr, prod: isMgr, team: isMgr, projects: isMgr, export: isMgr, setup: isAdmin, emails: isAdmin };
  if (guard[page] && !guard[page]()) { location.hash = '#log'; return; }
  try {
    if (page === 'log') await viewLog();
    else if (page === 'history') await viewHistory();
    else if (page === 'growth') await viewGrowth(arg);
    else if (page === 'dash') { if (arg) D.project = Number(arg) || null; await viewDash(); }
    else if (page === 'prod') await viewProd();
    else if (page === 'team') await viewTeam();
    else if (page === 'emails') await viewEmails();
    else if (page === 'setup') await viewSetup();
    else if (page === 'projects') await viewProjects();
    else if (page === 'export') await viewExport();
    else location.hash = '#log';
    if (page === 'log' && L._openEdit) { const id = L._openEdit; L._openEdit = null; const el = document.createElement('i'); el.dataset.id = id; actions.edit(el); }
    if (page !== 'log') scrollTo(0, 0);
  } catch (e) { if (e.message !== 'signed out') mount($('#view') || $('#app'), html`<div class="card empty">${e.message}</div>`); }
}
window.addEventListener('hashchange', route);

async function boot() {
  try { ({ user: me } = await get('/me')); await loadCatalog(); } catch { me = null; }
  if (!me) return renderLogin();
  if (!location.hash) location.hash = '#log';
  route();
}
boot();
