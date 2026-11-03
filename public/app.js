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
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const fmtMin = (m) => { m = Math.round(m || 0); const h = Math.floor(m / 60), r = m % 60; return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`; };
const fmtHrs = (m) => (m / 60).toFixed(1) + 'h';
const niceDate = (s) => new Date(s + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const rel = (s) => { if (!s) return 'never'; const d = Math.round((Date.parse(today()) - Date.parse(s)) / 86400000); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d}d ago`; };

let toastT;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = ''), 2600);
}

async function api(method, path, body) {
  const r = await fetch('/api' + path, {
    method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'timesheet' },
    body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin',
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
      if (f.type === 'checkbox') return html`<label class="row"><input type="checkbox" ${raw(common)} ${v ? raw('checked') : ''} style="width:22px;height:22px"> <span>${f.label}</span></label>`;
      return html`<input type="${f.type || 'text'}" ${raw(common)} value="${v}" ${f.step ? raw(`step="${f.step}"`) : ''} ${f.autocomplete ? raw(`autocomplete="${f.autocomplete}"`) : ''}>`;
    };
    mount(dlg, html`<form method="dialog"><h2>${title}</h2>
      ${fields.map((f) => html`<div class="field">${f.type === 'checkbox' ? '' : html`<label class="f" for="f_${f.name}">${f.label}</label>`}${input(f)}${f.help ? html`<div class="small muted">${f.help}</div>` : ''}</div>`)}
      <div class="err-text" id="dlgErr"></div>
      <div class="row sp"><button class="btn" type="button" id="dlgCancel">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${submit}</button></div></form>`);
    const form = $('form', dlg);
    const done = (v) => { dlg.close(); resolve(v); };
    $('#dlgCancel').onclick = () => done(null);
    dlg.onclose = () => resolve(null);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const out = {};
      for (const f of fields) { const el = form.elements[f.name]; out[f.name] = f.type === 'checkbox' ? el.checked : el.value; }
      done(out);
    };
    dlg.showModal();
  });
}
// run async action with error toast; returns true on success
async function attempt(fn, okMsg) { try { await fn(); if (okMsg) toast(okMsg); return true; } catch (e) { if (e.message !== 'signed out') toast(e.message, true); return false; } }

// ---------- state ----------
let me = null, catalog = { projects: [], task_types: [], levels: [] };
const isMgr = () => me && (me.role === 'admin' || me.role === 'leader');
const activeProjects = () => catalog.projects.filter((p) => p.active);
const activeTasks = () => catalog.task_types.filter((t) => t.active);
const byId = (arr, id) => arr.find((x) => x.id === Number(id));

// ---------- shell ----------
const NAV = [
  ['log', '＋', 'Log time', () => true], ['history', '☰', 'My entries', () => true], ['growth', '↗', 'My growth', () => true],
  ['dash', '▦', 'Dashboard', isMgr], ['prod', '⏱', 'Productivity', isMgr], ['team', '☻', 'Team', isMgr], ['setup', '⚙', 'Setup', () => me.role === 'admin'],
];
function shell(active, body) {
  mount($('#app'), html`<header class="top"><div class="brand"><img src="/icon.svg" alt=""> Team Timesheet</div>
    <div class="row small" style="flex-wrap:nowrap"><span class="muted hide-sm">${me.name}</span><button class="btn sm" data-act="pw">Password</button><button class="btn sm" data-act="logout">Sign out</button></div></header>
    <nav class="bar">${NAV.filter((n) => n[3]()).map(([k, i, l]) => html`<a href="#/${k}" class="${k === active ? 'on' : ''}"><span class="i">${i}</span>${l}</a>`)}</nav>
    <main class="wrap" id="view">${body}</main>`);
}

// ---------- login ----------
function renderLogin() {
  mount($('#app'), html`<form class="login card" id="loginForm"><h1>Team Timesheet</h1>
    <div class="field"><label class="f" for="u">Username</label><input id="u" type="text" autocomplete="username" autocapitalize="none" required></div>
    <div class="field"><label class="f" for="p">Password</label><input id="p" type="password" autocomplete="current-password" required></div>
    <div class="err-text" id="lerr"></div><button class="btn primary block" type="submit">Sign in</button></form>`);
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await post('/login', { username: $('#u').value, password: $('#p').value }); await boot(); }
    catch (er) { $('#lerr').textContent = er.message; }
  };
}

// ---------- LOG TIME ----------
const L = { date: today(), project_id: null, task_type_id: null, count: 1, minutes: null, desc: '', editId: null, sug: null, entries: [] };
const QUICK = [15, 30, 45, 60, 90, 120, 180, 240];

async function loadSuggest() {
  try {
    L.sug = await get('/suggest' + qs({ project_id: L.project_id, task_type_id: L.task_type_id, text: L.desc, date: L.date }));
  } catch { L.sug = null; }
}
async function viewLog() {
  shell('log', html`<div class="empty">Loading…</div>`);
  const [, e] = await Promise.all([loadSuggest(), get('/entries' + qs({ date: L.date }))]);
  L.entries = e.entries;
  // learned default: preselect the most likely project when starting fresh
  if (!L.project_id && L.sug?.projects[0]?.confidence >= 0.35) L.project_id = L.sug.projects[0].id;
  drawLog();
}
function drawLog() {
  const sug = L.sug || { projects: [], task_types: [], combos: [], descriptions: [], hint: null };
  const conf = Object.fromEntries(sug.projects.map((p) => [p.id, p.confidence]));
  const tconf = Object.fromEntries(sug.task_types.map((p) => [p.id, p.confidence]));
  const projs = activeProjects();
  const top = sug.projects.map((p) => byId(projs, p.id)).filter(Boolean).slice(0, 4);
  if (L.project_id && !top.some((p) => p.id === L.project_id) && byId(projs, L.project_id)) top.unshift(byId(projs, L.project_id));
  const tasks = [...activeTasks()].sort((a, b) => (tconf[b.id] || 0) - (tconf[a.id] || 0));
  const unit = byId(catalog.task_types, L.task_type_id)?.unit_label || 'item';
  const total = L.entries.reduce((s, e) => s + e.minutes, 0), target = me.daily_target_min || 480;
  const hintMin = sug.hint ? sug.hint.minutes_per_unit * Math.max(1, L.count) : null;
  const dayLabel = L.date === today() ? 'Today' : niceDate(L.date);

  mount($('#view'), html`
    <div class="row sp" style="margin-bottom:10px">
      <button class="btn sm" data-act="dayPrev" aria-label="Previous day">‹</button>
      <div class="row"><strong>${dayLabel}</strong><input type="date" id="dateIn" value="${L.date}" max="${addDays(today(), 1)}" style="width:auto;min-height:36px"></div>
      <button class="btn sm" data-act="dayNext" aria-label="Next day" ${L.date >= today() ? raw('disabled') : ''}>›</button>
    </div>
    ${sug.combos.length && !L.editId ? html`<div class="card"><h3>⚡ Repeat something recent</h3><div class="chips">${sug.combos.map((c, i) => html`<button class="chip combo" data-act="combo" data-i="${i}"><b>${byId(catalog.projects, c.project_id)?.name}</b><br>${byId(catalog.task_types, c.task_type_id)?.name}${c.description ? ' · ' + c.description : ''}</button>`)}</div></div>` : ''}
    <div class="card">
      <h2>${L.editId ? 'Edit entry' : 'New entry'}</h2>
      <div class="field"><label class="f">Project ${top.length ? html`<span class="muted small">— suggested for you</span>` : ''}</label>
        <div class="chips">${top.map((p) => html`<button class="chip ${p.id === L.project_id ? 'on' : ''}" data-act="pickProject" data-id="${p.id}">${p.name}${conf[p.id] >= 0.1 ? html`<span class="pct">${Math.round(conf[p.id] * 100)}%</span>` : ''}</button>`)}</div>
        <select id="projSel" style="margin-top:8px"><option value="">${top.length ? 'Other project…' : 'Choose project…'}</option>${projs.filter((p) => !top.includes(p)).map((p) => html`<option value="${p.id}">${p.code ? p.code + ' · ' : ''}${p.name}</option>`)}</select></div>
      <div class="field"><label class="f">Task</label>
        <div class="chips">${tasks.map((t) => html`<button class="chip ${t.id === L.task_type_id ? 'on' : ''}" data-act="pickTask" data-id="${t.id}">${t.name}</button>`)}</div></div>
      <div class="field"><label class="f">How many ${unit}s?</label>
        <div class="stepper"><button data-act="dec" aria-label="Fewer">−</button><input type="number" inputmode="numeric" id="countIn" min="0" max="1000" value="${L.count}"><button data-act="inc" aria-label="More">+</button></div></div>
      <div class="field"><label class="f">Time spent</label>
        <div class="chips">${QUICK.map((m) => html`<button class="chip ${L.minutes === m ? 'on' : ''}" data-act="pickMin" data-m="${m}">${fmtMin(m)}</button>`)}</div>
        <div class="row" style="margin-top:8px"><input type="number" id="hrsIn" inputmode="decimal" step="0.25" min="0" placeholder="or hours, e.g. 2.5" value="${L.minutes ? +(L.minutes / 60).toFixed(2) : ''}" style="max-width:190px"><span class="muted small">${L.minutes ? fmtMin(L.minutes) : ''}</span></div>
        ${hintMin ? html`<div class="hint"><span>🧠 You usually take ~${fmtMin(sug.hint.minutes_per_unit)} per ${unit}${sug.hint.scope === 'task' ? ' (any project)' : ''} → <b>${fmtMin(hintMin)}</b></span><button class="btn sm" data-act="useHint" data-m="${hintMin}">Use</button></div>` : ''}</div>
      <div class="field"><label class="f" for="descIn">Description <span class="muted">(optional)</span></label>
        <input type="text" id="descIn" list="descList" maxlength="1000" placeholder="e.g. Level 3 slab, stair core B" value="${L.desc}" autocomplete="off"><datalist id="descList">${sug.descriptions.map((d) => html`<option value="${d}">`)}</datalist></div>
      <div class="row"><button class="btn primary" style="flex:1;min-height:52px;font-size:1.05rem" data-act="save">${L.editId ? 'Update entry' : 'Save entry'}</button>${L.editId ? html`<button class="btn" data-act="cancelEdit">Cancel</button>` : ''}</div>
    </div>
    <div class="card"><div class="row sp"><h2 style="margin:0">${dayLabel}'s entries</h2><strong>${fmtMin(total)} <span class="muted small">/ ${fmtMin(target)}</span></strong></div>
      <div class="progress ${total >= target ? 'over' : ''}" style="margin:8px 0"><i style="width:${Math.min(100, (total / target) * 100)}%"></i></div>
      ${L.entries.length ? L.entries.map(entryRow) : html`<div class="empty">Nothing logged yet for this day.</div>`}</div>`);
}
const entryRow = (e) => html`<div class="entry"><div class="t">${e.project} <span class="muted">·</span> ${e.task_type}${e.task_count ? html` <span class="tag">×${e.task_count}</span>` : ''}</div>
  <div class="right nowrap"><b>${fmtMin(e.minutes)}</b></div><div class="d">${e.description}</div>
  <div class="right nowrap"><button class="btn sm" data-act="edit" data-id="${e.id}">Edit</button> <button class="btn sm danger" data-act="delEntry" data-id="${e.id}">✕</button></div></div>`;

async function refreshLogParts() { await loadSuggest(); drawLog(); }
const logActions = {
  dayPrev: () => { L.date = addDays(L.date, -1); L.editId = null; viewLog(); },
  dayNext: () => { if (L.date < today()) { L.date = addDays(L.date, 1); L.editId = null; viewLog(); } },
  pickProject: (el) => { L.project_id = Number(el.dataset.id); refreshLogParts(); },
  pickTask: (el) => { L.task_type_id = Number(el.dataset.id); refreshLogParts(); },
  inc: () => { L.count = Math.min(1000, (Number(L.count) || 0) + 1); drawLog(); },
  dec: () => { L.count = Math.max(0, (Number(L.count) || 0) - 1); drawLog(); },
  pickMin: (el) => { L.minutes = Number(el.dataset.m); drawLog(); },
  useHint: (el) => { L.minutes = Number(el.dataset.m); drawLog(); },
  combo: (el) => { const c = L.sug.combos[Number(el.dataset.i)]; Object.assign(L, { project_id: c.project_id, task_type_id: c.task_type_id, desc: c.description, count: c.avgCount }); refreshLogParts(); },
  cancelEdit: () => { Object.assign(L, { editId: null, count: 1, minutes: null, desc: '' }); drawLog(); },
  edit: (el) => {
    const e = L.entries.find((x) => x.id === Number(el.dataset.id));
    Object.assign(L, { editId: e.id, project_id: e.project_id, task_type_id: e.task_type_id, count: e.task_count, minutes: e.minutes, desc: e.description });
    refreshLogParts().then(() => scrollTo({ top: 0, behavior: 'smooth' }));
  },
  delEntry: async (el) => {
    if (!confirm('Delete this entry?')) return;
    if (await attempt(() => del('/entries/' + el.dataset.id), 'Deleted')) { if (L.editId == el.dataset.id) L.editId = null; viewLog(); }
  },
  save: async () => {
    if (!L.project_id) return toast('Pick a project', true);
    if (!L.task_type_id) return toast('Pick a task', true);
    if (!L.minutes) return toast('Enter the time spent', true);
    const body = { work_date: L.date, project_id: L.project_id, task_type_id: L.task_type_id, task_count: Number(L.count) || 0, minutes: L.minutes, description: L.desc };
    const ok = await attempt(() => (L.editId ? put('/entries/' + L.editId, body) : post('/entries', body)), L.editId ? 'Updated ✓' : 'Saved ✓');
    if (ok) { Object.assign(L, { editId: null, count: 1, minutes: null, desc: '', task_type_id: null }); viewLog(); }
  },
};
// live inputs on the log form (no re-render so typing keeps focus)
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'countIn') L.count = t.value === '' ? '' : Number(t.value);
  else if (t.id === 'hrsIn') { L.minutes = Math.round(Number(t.value) * 60) || null; }
  else if (t.id === 'descIn') { L.desc = t.value; clearTimeout(L._t); L._t = setTimeout(async () => { await loadSuggest(); const dl = $('#descList'); if (dl) mount(dl, html`${(L.sug?.descriptions || []).map((d) => html`<option value="${d}">`)}`); }, 350); }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'projSel' && t.value) { L.project_id = Number(t.value); refreshLogParts(); }
  else if (t.id === 'dateIn' && t.value) { L.date = t.value; L.editId = null; viewLog(); }
  else if (t.id === 'hrsIn') drawLog();
});

// ---------- HISTORY ----------
async function viewHistory() {
  shell('history', html`<div class="empty">Loading…</div>`);
  const to = today(), from = addDays(to, -30);
  const { entries } = await get('/entries' + qs({ from, to }));
  const days = {};
  entries.forEach((e) => (days[e.work_date] ||= []).push(e));
  const total = entries.reduce((s, e) => s + e.minutes, 0);
  mount($('#view'), html`<h1>My entries</h1><div class="card"><div class="row sp"><span class="muted">Last 30 days</span><b>${fmtMin(total)} · ${entries.reduce((s, e) => s + e.task_count, 0)} tasks</b></div></div>
    ${Object.keys(days).length ? Object.keys(days).sort().reverse().map((d) => html`<div class="card"><div class="day-h" style="margin-top:0"><span>${niceDate(d)}</span><span>${fmtMin(days[d].reduce((s, e) => s + e.minutes, 0))}</span></div>
      ${days[d].map((e) => html`<div class="entry"><div class="t">${e.project} · ${e.task_type} <span class="tag">×${e.task_count}</span></div><div class="right"><b>${fmtMin(e.minutes)}</b></div><div class="d">${e.description}</div><div class="right"><a class="btn sm" href="#/log" data-act="goEdit" data-date="${d}" data-id="${e.id}">Edit</a></div></div>`)}</div>`)
      : html`<div class="card empty">No entries yet — head to “Log time”.</div>`}`);
}

// ---------- GROWTH ----------
async function viewGrowth(id) {
  shell('growth', html`<div class="empty">Loading…</div>`);
  const uid = Number(id) || me.id;
  const g = await get(`/users/${uid}/growth`);
  const catTasks = activeTasks();
  const curRank = g.level ? g.levels.find((l) => l.id === g.level.id)?.rank : 0;
  const mgr = g.can_manage, admin = me.role === 'admin';
  const goalCard = (x) => {
    const live = x.metric === 'manual' ? x.current_value : x.live_value;
    const pct = x.progress;
    return html`<div class="card" style="margin-bottom:10px;box-shadow:none"><div class="row sp"><b>${x.title}</b><span class="tag ${x.status === 'achieved' ? 'good' : x.status === 'dropped' ? 'bad' : ''}">${x.status}</span></div>
      <div class="small muted">${x.metric === 'avg_min' ? `Avg time per ${x.task_type || 'unit'} (30d, lower is better)` : x.metric === 'units_month' ? `Units/month${x.task_type ? ' — ' + x.task_type : ''}` : 'Manual'}${x.due_date ? ' · due ' + x.due_date : ''}</div>
      <div class="progress ${pct >= 100 ? 'over' : ''}" style="margin:8px 0"><i style="width:${pct}%"></i></div>
      <div class="row sp small"><span>${x.start_value ?? '–'} → <b>${live ?? '–'}</b> → target ${x.target_value ?? '–'} ${x.unit}</span><span>${pct}%</span></div>
      ${x.description ? html`<div class="small" style="margin-top:6px">${x.description}</div>` : ''}
      <div class="row" style="margin-top:8px">
        ${(mgr || (g.user.id === me.id && x.metric === 'manual')) && x.metric === 'manual' ? html`<button class="btn sm" data-act="goalProgress" data-id="${x.id}" data-cur="${x.current_value ?? ''}">Update progress</button>` : ''}
        ${mgr ? html`<button class="btn sm" data-act="goalEdit" data-uid="${uid}" data-id="${x.id}">Edit</button><button class="btn sm danger" data-act="goalDel" data-id="${x.id}">Delete</button>` : ''}</div></div>`;
  };
  window._growth = g;
  mount($('#view'), html`
    <div class="row sp"><div><h1 style="margin-bottom:2px">${g.user.name}</h1><div class="muted">${g.user.job_title || ''}${g.level ? ' · ' + g.level.name : ''}</div></div>
      ${uid !== me.id ? html`<a class="btn sm" href="#/team">← Team</a>` : ''}</div>
    <div class="grid g4" style="margin:14px 0"><div class="kpi"><b>${fmtHrs(g.totals.minutes)}</b><span>total logged</span></div><div class="kpi"><b>${g.totals.tasks}</b><span>tasks completed</span></div><div class="kpi"><b>${g.totals.days}</b><span>days logged</span></div></div>
    <div class="card"><div class="row sp"><h2>Career path</h2>${admin ? html`<button class="btn sm" data-act="setLevel" data-uid="${uid}">Change level</button>` : ''}</div>
      <div class="ladder">${g.levels.map((l) => html`<div class="step ${l.id === g.level?.id ? 'cur' : l.rank < curRank ? 'done' : ''}"><div>${l.rank < curRank ? '✓ ' : ''}${l.name}</div><div class="small">${l.description}</div></div>`)}</div>
      ${g.history.length ? html`<div class="small muted" style="margin-top:10px">${g.history.map((h) => `${h.from_date}: ${h.level}${h.note ? ' (' + h.note + ')' : ''}`).join('  ·  ')}</div>` : ''}</div>
    <div class="card"><div class="row sp"><h2>Goals & targets</h2>${mgr ? html`<button class="btn sm primary" data-act="goalAdd" data-uid="${uid}">+ Goal</button>` : ''}</div>
      ${g.goals.length ? g.goals.map(goalCard) : html`<div class="empty">No goals yet.</div>`}</div>
    <div class="card"><h2>Speed by task <span class="muted small">(last 30 days vs previous 30)</span></h2>
      ${g.skills.length ? html`<div class="tscroll"><table><tr><th>Task</th><th class="right">Done</th><th class="right">Avg / unit</th><th class="right">Trend</th><th class="right">Team</th></tr>
      ${g.skills.map((s) => { const tr = s.prev_min_per_unit ? Math.round(((s.min_per_unit - s.prev_min_per_unit) / s.prev_min_per_unit) * 100) : null;
        return html`<tr><td>${s.task_type}</td><td class="right">${s.tasks}</td><td class="right"><b>${fmtMin(s.min_per_unit)}</b></td>
          <td class="right">${tr === null ? '–' : html`<span class="tag ${tr < -2 ? 'good' : tr > 2 ? 'warn' : ''}">${tr > 0 ? '▲' : tr < 0 ? '▼' : '='} ${Math.abs(tr)}%</span>`}</td><td class="right muted">${fmtMin(s.team_min_per_unit)}</td></tr>`; })}</table></div>
      <div class="small muted">▼ green = faster than before.</div>` : html`<div class="empty">Not enough data yet.</div>`}</div>
    <div class="card"><div class="row sp"><h2>Feedback & milestones</h2>${mgr ? html`<button class="btn sm primary" data-act="noteAdd" data-uid="${uid}">+ Add</button>` : ''}</div>
      ${g.notes.length ? g.notes.map((n) => html`<div class="note ${n.shared ? '' : 'priv'}"><div class="small muted">${n.created_at.slice(0, 10)} · ${n.author} · <span class="tag">${n.kind}</span> ${mgr ? (n.shared ? html`<span class="tag good">shared</span>` : html`<span class="tag warn">private</span>`) : ''}
        ${mgr ? html` <a href="#" data-act="noteDel" data-id="${n.id}" class="small">delete</a>` : ''}</div><div>${n.body}</div></div>`) : html`<div class="empty">Nothing here yet.</div>`}</div>`);
}

// ---------- DASHBOARD ----------
const D = { days: 30 };
const rangeSel = (act) => html`<select data-change="${act}" style="width:auto">${[[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [180, 'Last 6 months']].map(([d, l]) => html`<option value="${d}" ${D.days === d ? raw('selected') : ''}>${l}</option>`)}</select>`;
const bars = (rows, { label, value, text, cls = () => '' }) => {
  const max = Math.max(...rows.map(value), 1);
  return html`<div class="bars">${rows.map((r) => html`<div class="bar"><span class="lbl" title="${label(r)}">${label(r)}</span><div class="track"><div class="fill ${cls(r)}" style="width:${(value(r) / max) * 100}%"></div></div><b class="nowrap">${text(r)}</b></div>`)}</div>`;
};
function dayChart(byDay, from, to) {
  const map = Object.fromEntries(byDay.map((d) => [d.date, d.minutes]));
  const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const max = Math.max(...days.map((d) => map[d] || 0), 1), W = 600, H = 120, bw = W / days.length;
  return html`<svg viewBox="0 0 ${W} ${H + 16}" width="100%" role="img" aria-label="Hours per day">${days.map((d, i) => { const h = ((map[d] || 0) / max) * H; return html`<rect x="${i * bw + 1}" y="${H - h}" width="${Math.max(1, bw - 2)}" height="${h}" rx="2" fill="var(--brand)" opacity="${map[d] ? 1 : 0.15}"><title>${d}: ${fmtMin(map[d] || 0)}</title></rect>`; })}
    <text x="0" y="${H + 12}">${from}</text><text x="${W}" y="${H + 12}" text-anchor="end">${to}</text></svg>`;
}
async function viewDash() {
  shell('dash', html`<div class="empty">Loading…</div>`);
  const to = today(), from = addDays(to, -(D.days - 1));
  const o = await get('/dash/overview' + qs({ from, to }));
  const t = o.totals;
  mount($('#view'), html`<div class="row sp"><h1>Dashboard</h1>${rangeSel('dashRange')}</div>
    <div class="grid g4"><div class="kpi"><b>${fmtHrs(t.minutes)}</b><span>hours logged</span></div><div class="kpi"><b>${t.tasks}</b><span>tasks completed</span></div>
      <div class="kpi"><b>${t.people}</b><span>active people</span></div><div class="kpi"><b>${t.tasks ? fmtMin(t.minutes / t.tasks) : '–'}</b><span>avg time / task</span></div></div>
    <div class="card" style="margin-top:14px"><h2>Hours per day</h2>${dayChart(o.by_day, o.from, o.to)}</div>
    <div class="grid g2">
      <div class="card"><h2>Time by project</h2>${o.by_project.length ? bars(o.by_project, { label: (r) => r.name, value: (r) => r.minutes, text: (r) => `${fmtHrs(r.minutes)} · ${r.tasks}` }) : html`<div class="empty">No data</div>`}</div>
      <div class="card"><h2>Time by person</h2>${o.by_person.length ? bars(o.by_person, { label: (r) => r.name, value: (r) => r.minutes, text: (r) => `${fmtHrs(r.minutes)} · ${r.tasks}` }) : html`<div class="empty">No data</div>`}</div>
    </div>
    <div class="card"><h2>Time by task</h2>${o.by_task.length ? bars(o.by_task, { label: (r) => r.name, value: (r) => r.minutes, text: (r) => `${fmtHrs(r.minutes)} · ${r.tasks}` }) : ''}</div>
    <div class="card"><h2>Timesheet status</h2><div class="tscroll"><table><tr><th>Person</th><th>Last entry</th><th class="right">Hours in period</th></tr>
      ${o.people.map((p) => { const d = p.last_entry ? Math.round((Date.parse(today()) - Date.parse(p.last_entry)) / 86400000) : 99; return html`<tr><td><a href="#/growth/${p.id}">${p.name}</a></td><td><span class="tag ${d <= 1 ? 'good' : d <= 3 ? 'warn' : 'bad'}">${rel(p.last_entry)}</span></td><td class="right">${fmtHrs(p.minutes)}</td></tr>`; })}</table></div></div>`);
}

// ---------- PRODUCTIVITY ----------
const P = { days: 90, task: null, project: null, user: null };
async function viewProd() {
  shell('prod', html`<div class="empty">Loading…</div>`);
  const to = today(), from = addDays(to, -(P.days - 1));
  if (!P.task) P.task = activeTasks().find((t) => /shop/i.test(t.name))?.id || activeTasks()[0]?.id;
  const [data, users] = await Promise.all([get('/dash/productivity' + qs({ from, to, task_type_id: P.task, project_id: P.project, user_id: P.user })), get('/users')]);
  const tt = byId(catalog.task_types, P.task), unit = tt?.unit_label || 'unit';
  const teamRow = data.team[0];
  const persons = [...data.by_person_task].sort((a, b) => a.min_per_unit - b.min_per_unit);
  const projs = [...data.by_project_task].sort((a, b) => a.min_per_unit - b.min_per_unit);
  const tr = data.trend, tmax = Math.max(...tr.map((x) => x.min_per_unit), 1), W = 600, H = 100;
  const pts = tr.map((x, i) => `${tr.length > 1 ? PADX + (i / (tr.length - 1)) * (W - 2 * PADX) : W / 2},${H - (x.min_per_unit / tmax) * (H - 8) - 4}`).join(' ');
  const sel = (id, opts, cur) => html`<select data-change="${id}" style="width:auto;max-width:100%">${opts.map(([v, l]) => html`<option value="${v}" ${String(cur ?? '') === String(v) ? raw('selected') : ''}>${l}</option>`)}</select>`;
  mount($('#view'), html`<h1>Productivity</h1>
    <div class="row" style="margin-bottom:14px">${sel('prodTask', activeTasks().map((t) => [t.id, t.name]), P.task)}${sel('prodProject', [['', 'All projects'], ...catalog.projects.map((p) => [p.id, p.name])], P.project)}
      ${sel('prodUser', [['', 'Everyone'], ...users.users.filter((u) => u.role !== 'admin').map((u) => [u.id, u.name])], P.user)}
      ${sel('prodRange', [[30, 'Last 30 days'], [90, 'Last 90 days'], [180, 'Last 6 months'], [365, 'Last year']], P.days)}</div>
    ${teamRow ? html`<div class="grid g4"><div class="kpi"><b>${fmtMin(teamRow.min_per_unit)}</b><span>avg per ${unit}</span></div><div class="kpi"><b>${(60 / teamRow.min_per_unit).toFixed(2)}</b><span>${unit}s per hour</span></div>
      <div class="kpi"><b>${teamRow.tasks}</b><span>${unit}s completed</span></div><div class="kpi"><b>${teamRow.entries}</b><span>entries</span></div></div>
    <div class="card" style="margin-top:14px"><h2>Weekly trend — avg time per ${unit}</h2>
      <svg viewBox="0 0 ${W} ${H + 16}" width="100%"><polyline fill="none" stroke="var(--brand)" stroke-width="3" points="${pts}"/>${tr.map((x, i) => html`<circle cx="${tr.length > 1 ? PADX + (i / (tr.length - 1)) * (W - 2 * PADX) : W / 2}" cy="${H - (x.min_per_unit / tmax) * (H - 8) - 4}" r="4" fill="var(--brand)"><title>${x.week_start}: ${fmtMin(x.min_per_unit)} per ${unit}</title></circle>`)}
      <text x="0" y="${H + 13}">${tr[0]?.week_start || ''}</text><text x="${W}" y="${H + 13}" text-anchor="end">${tr.at(-1)?.week_start || ''}</text></svg></div>
    <div class="grid g2"><div class="card"><h2>By person <span class="muted small">(faster first)</span></h2>
      ${bars(persons, { label: (r) => r.user, value: (r) => r.min_per_unit, text: (r) => `${fmtMin(r.min_per_unit)} ${r.vs_team_pct ? `(${r.vs_team_pct > 0 ? '+' : ''}${r.vs_team_pct}%)` : ''}`, cls: (r) => (r.vs_team_pct <= -5 ? 'good' : r.vs_team_pct >= 15 ? 'warn' : '') })}
      <div class="small muted" style="margin-top:8px">% vs team average. Green = ≥5% faster, amber = ≥15% slower.</div></div>
    <div class="card"><h2>By project <span class="muted small">(avg per ${unit})</span></h2>${bars(projs, { label: (r) => r.project, value: (r) => r.min_per_unit, text: (r) => `${fmtMin(r.min_per_unit)} · ${r.tasks}` })}</div></div>`
      : html`<div class="card empty">No “${tt?.name}” entries with a task count in this period.</div>`}`);
}

// ---------- TEAM ----------
async function viewTeam() {
  shell('team', html`<div class="empty">Loading…</div>`);
  const { users } = await get('/users');
  const admin = me.role === 'admin';
  mount($('#view'), html`<div class="row sp"><h1>Team</h1>${admin ? html`<button class="btn primary" data-act="userAdd">+ Add person</button>` : ''}</div>
    <div class="card"><div class="tscroll"><table><tr><th>Name</th><th>Role</th><th>Level</th><th>Last entry</th><th class="right">30d hours</th><th></th></tr>
    ${users.map((u) => html`<tr style="${u.active ? '' : 'opacity:.5'}"><td><a href="#/growth/${u.id}"><b>${u.name}</b></a><div class="small muted">${u.job_title}</div></td><td><span class="tag">${u.role}</span></td><td>${u.level || '–'}</td>
      <td>${u.role === 'admin' ? '' : rel(u.last_entry)}</td><td class="right">${fmtHrs(u.minutes_30d)}</td><td class="right nowrap"><a class="btn sm" href="#/growth/${u.id}">Growth</a> ${admin ? html`<button class="btn sm" data-act="userEdit" data-id="${u.id}">Edit</button>` : ''}</td></tr>`)}</table></div></div>`);
  window._users = users;
}

// ---------- SETUP ----------
async function viewSetup() {
  shell('setup', html`<div class="empty">Loading…</div>`);
  await loadCatalog();
  const list = (title, items, addAct, editAct, sub) => html`<div class="card"><div class="row sp"><h2>${title}</h2><button class="btn sm primary" data-act="${addAct}">+ Add</button></div>
    ${items.length ? items.map((i) => html`<div class="row sp" style="padding:8px 0;border-bottom:1px solid var(--line);${i.active === 0 ? 'opacity:.5' : ''}"><div>${i.name}<div class="small muted">${sub(i)}</div></div><button class="btn sm" data-act="${editAct}" data-id="${i.id}">Edit</button></div>`) : html`<div class="empty">None yet</div>`}</div>`;
  mount($('#view'), html`<h1>Setup</h1><p class="muted">These lists feed the quick-pick buttons on the timesheet. Archive instead of deleting so history is kept.</p>
    ${list('Projects', catalog.projects, 'projAdd', 'projEdit', (p) => (p.code || '') + (p.active ? '' : ' · archived'))}
    ${list('Task types', catalog.task_types, 'taskAdd', 'taskEdit', (t) => `counted in: ${t.unit_label}s` + (t.active ? '' : ' · archived'))}
    ${list('Career levels', catalog.levels.map((l) => ({ ...l, active: 1 })), 'lvlAdd', 'lvlEdit', (l) => `#${l.rank} · ${l.description}`)}`);
}

// ---------- actions (delegated) ----------
const catField = (n, l, o = {}) => ({ name: n, label: l, ...o });
const actions = {
  ...logActions,
  logout: async () => { await post('/logout'); me = null; renderLogin(); },
  pw: async () => {
    const v = await formDialog({ title: 'Change password', submit: 'Change', fields: [catField('current', 'Current password', { type: 'password', required: true, autocomplete: 'current-password' }), catField('next', 'New password (6+ characters)', { type: 'password', required: true, autocomplete: 'new-password' })] });
    if (v) attempt(() => post('/me/password', v), 'Password changed');
  },
  goEdit: (el) => { Object.assign(L, { date: el.dataset.date }); L._openEdit = Number(el.dataset.id); },
  // goals
  goalAdd: (el) => goalForm(Number(el.dataset.uid)),
  goalEdit: (el) => goalForm(Number(el.dataset.uid), window._growth.goals.find((g) => g.id === Number(el.dataset.id))),
  goalDel: async (el) => { if (confirm('Delete this goal?') && await attempt(() => del('/goals/' + el.dataset.id), 'Deleted')) route(); },
  goalProgress: async (el) => {
    const v = await formDialog({ title: 'Update progress', fields: [catField('current_value', 'Current value', { type: 'number', step: 'any', required: true })], values: { current_value: el.dataset.cur } });
    if (v && await attempt(() => put('/goals/' + el.dataset.id, { current_value: Number(v.current_value) }), 'Updated')) route();
  },
  noteAdd: async (el) => {
    const v = await formDialog({ title: 'Add feedback / milestone', fields: [
      catField('kind', 'Type', { type: 'select', options: ['feedback', 'milestone', 'review', 'note'].map((k) => ({ value: k, label: k })) }),
      catField('body', 'Note', { type: 'textarea', required: true }), catField('shared', 'Share with the employee', { type: 'checkbox', default: true })] });
    if (v && await attempt(() => post(`/users/${el.dataset.uid}/notes`, v), 'Added')) route();
  },
  noteDel: async (el, ev) => { ev.preventDefault(); if (confirm('Delete note?') && await attempt(() => del('/notes/' + el.dataset.id))) route(); },
  setLevel: async (el) => {
    const g = window._growth;
    const v = await formDialog({ title: 'Change level / promote', fields: [
      catField('level_id', 'New level', { type: 'select', options: g.levels.map((l) => ({ value: l.id, label: l.name })), default: g.level?.id }),
      catField('from_date', 'Effective from', { type: 'date', default: today() }), catField('note', 'Reason / note'),
      catField('share', 'Share a milestone with the employee', { type: 'checkbox', default: true })] });
    if (v && await attempt(() => post(`/users/${el.dataset.uid}/level`, v), 'Level updated')) route();
  },
  // users
  userAdd: () => userForm(),
  userEdit: (el) => userForm(window._users.find((u) => u.id === Number(el.dataset.id))),
  // setup
  projAdd: () => catalogForm('projects', 'Project', [catField('name', 'Project name', { required: true }), catField('code', 'Code (optional)')]),
  projEdit: (el) => catalogForm('projects', 'Project', [catField('name', 'Project name', { required: true }), catField('code', 'Code (optional)'), catField('active', 'Active (shown on timesheet)', { type: 'checkbox' })], byId(catalog.projects, el.dataset.id)),
  taskAdd: () => catalogForm('task_types', 'Task', [catField('name', 'Task name', { required: true }), catField('unit_label', 'What is counted? (e.g. drawing, sheet)', { default: 'drawing' })]),
  taskEdit: (el) => catalogForm('task_types', 'Task', [catField('name', 'Task name', { required: true }), catField('unit_label', 'What is counted?'), catField('active', 'Active (shown on timesheet)', { type: 'checkbox' })], byId(catalog.task_types, el.dataset.id)),
  lvlAdd: () => levelForm(), lvlEdit: (el) => levelForm(byId(catalog.levels, el.dataset.id)),
};
async function catalogForm(kind, label, fields, existing) {
  const v = await formDialog({ title: existing ? `Edit ${label.toLowerCase()}` : `New ${label.toLowerCase()}`, fields, values: existing ? { ...existing, active: !!existing.active } : {} });
  if (!v) return;
  if (await attempt(() => (existing ? put(`/${kind}/${existing.id}`, v) : post(`/${kind}`, v)), 'Saved')) viewSetup();
}
async function levelForm(existing) {
  const v = await formDialog({ title: existing ? 'Edit level' : 'New level', fields: [catField('name', 'Name', { required: true }), catField('rank', 'Order (1 = lowest)', { type: 'number', required: true, default: catalog.levels.length + 1 }), catField('description', 'What this level means', { type: 'textarea' })], values: existing || {} });
  if (v && await attempt(() => (existing ? put('/levels/' + existing.id, v) : post('/levels', v)), 'Saved')) viewSetup();
}
async function userForm(u) {
  const { leaders } = await get('/leaders');
  const fields = [catField('name', 'Full name', { required: true }), ...(u ? [] : [catField('username', 'Username', { required: true, autocomplete: 'off' })]),
    catField(u ? 'password' : 'password', u ? 'Reset password (leave empty to keep)' : 'Initial password (6+)', { type: 'password', required: !u, autocomplete: 'new-password' }),
    catField('job_title', 'Job title'), catField('role', 'Access', { type: 'select', options: [{ value: 'member', label: 'Team member' }, { value: 'leader', label: 'Team leader (sees own team)' }, { value: 'admin', label: 'Admin (sees everything)' }] }),
    catField('leader_id', 'Reports to', { type: 'select', options: [{ value: '', label: '— none —' }, ...leaders.filter((l) => l.id !== u?.id).map((l) => ({ value: l.id, label: l.name }))] }),
    catField('daily_target_min', 'Daily target (minutes)', { type: 'number', default: 480 })];
  if (!u) fields.push(catField('level_id', 'Starting level', { type: 'select', options: [{ value: '', label: '—' }, ...catalog.levels.map((l) => ({ value: l.id, label: l.name }))] }));
  if (u) fields.push(catField('active', 'Active (can sign in)', { type: 'checkbox' }));
  const v = await formDialog({ title: u ? 'Edit person' : 'Add person', fields, values: u ? { ...u, leader_id: u.leader_id ?? '' } : { role: 'member' } });
  if (!v) return;
  if (await attempt(() => (u ? put('/users/' + u.id, v) : post('/users', v)), 'Saved')) viewTeam();
}
async function goalForm(uid, g) {
  const v = await formDialog({ title: g ? 'Edit goal' : 'New goal', fields: [
    catField('title', 'Goal', { required: true }),
    catField('metric', 'How is it measured?', { type: 'select', options: [{ value: 'manual', label: 'Manual (you update progress)' }, { value: 'avg_min', label: 'Auto: avg minutes per unit (lower = better)' }, { value: 'units_month', label: 'Auto: units completed per 30 days' }] }),
    catField('task_type_id', 'For which task (auto goals)', { type: 'select', options: [{ value: '', label: 'All tasks' }, ...activeTasks().map((t) => ({ value: t.id, label: t.name }))] }),
    catField('start_value', 'Starting value', { type: 'number', step: 'any', help: 'Auto goals: leave empty to use the current measured value.' }),
    catField('target_value', 'Target value', { type: 'number', step: 'any', required: true }), catField('unit', 'Unit (e.g. min, %, drawings)'),
    catField('due_date', 'Due date', { type: 'date' }), catField('description', 'Notes', { type: 'textarea' }),
    ...(g ? [catField('status', 'Status', { type: 'select', options: ['active', 'achieved', 'dropped'].map((s) => ({ value: s, label: s })) })] : [])],
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
  else if (a === 'prodRange') { P.days = Number(v); viewProd(); }
  else if (a === 'prodTask') { P.task = Number(v); viewProd(); }
  else if (a === 'prodProject') { P.project = v ? Number(v) : null; viewProd(); }
  else if (a === 'prodUser') { P.user = v ? Number(v) : null; viewProd(); }
});

// ---------- routing ----------
async function loadCatalog() { catalog = await get('/catalog'); }
async function route() {
  if (!me) return renderLogin();
  const [, page = 'log', arg] = location.hash.split('/');
  const guard = { dash: isMgr, prod: isMgr, team: isMgr, setup: () => me.role === 'admin' };
  if (guard[page] && !guard[page]()) { location.hash = '#/log'; return; }
  try {
    if (page === 'log') await viewLog();
    else if (page === 'history') await viewHistory();
    else if (page === 'growth') await viewGrowth(arg);
    else if (page === 'dash') await viewDash();
    else if (page === 'prod') await viewProd();
    else if (page === 'team') await viewTeam();
    else if (page === 'setup') await viewSetup();
    else location.hash = '#/log';
    if (page === 'log' && L._openEdit) { const id = L._openEdit; L._openEdit = null; const el = document.createElement('i'); el.dataset.id = id; actions.edit(el); }
    if (page !== 'log') scrollTo(0, 0);
  } catch (e) { if (e.message !== 'signed out') { mount($('#view') || $('#app'), html`<div class="card empty">${e.message}</div>`); } }
}
window.addEventListener('hashchange', route);

async function boot() {
  try { ({ user: me } = await get('/me')); await loadCatalog(); } catch { me = null; }
  if (!me) return renderLogin();
  if (!location.hash) location.hash = '#/log';
  route();
}
boot();
