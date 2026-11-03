import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { db, hashPassword, verifyPassword, seedIfEmpty, getSettings, setSettings, SETTING_DEFAULTS } from './db.js';
import { suggest } from './suggest.js';
import { overview, productivity, visibleUserIds, goalLiveValue, goalProgress, addDays, iso } from './analytics.js';
import { startScheduler, sendReminders, sendWeeklyReport, sendTest, localNow, reminderRecipients, weeklyReportData } from './notifications.js';
import { smtpConfigured } from './mailer.js';
import { importWorkbook } from './importer.js';

const PUBLIC = new URL('../public/', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = 30;
const EDIT_WINDOW_DAYS = 14;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const forbidden = (m = 'Not allowed') => new HttpError(403, m);
const notFound = (m = 'Not found') => new HttpError(404, m);

// ---------- tiny router ----------
const routes = [];
const route = (method, path, handler, auth = 'user', opts = {}) =>
  routes.push({ method, auth, handler, ...opts, re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });
const GET = (p, h, a) => route('GET', p, h, a), POST = (p, h, a, o) => route('POST', p, h, a, o),
  PUT = (p, h, a) => route('PUT', p, h, a), DEL = (p, h, a) => route('DELETE', p, h, a);

// ---------- helpers ----------
const num = (v, name, { min = -Infinity, max = Infinity, int = false, required = true } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`${name} is required`); return null; }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw bad(`${name} is invalid`);
  return n;
};
const str = (v, name, { max = 500, required = false } = {}) => {
  const s = (v ?? '').toString().trim();
  if (required && !s) throw bad(`${name} is required`);
  if (s.length > max) throw bad(`${name} is too long`);
  return s;
};
const flag = (v, dflt = 1) => (v === undefined ? dflt : v ? 1 : 0);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const dateParam = (s, name) => { if (!isDate(s)) throw bad(`${name} must be YYYY-MM-DD`); return s; };
const range = (q) => {
  const to = q.to ? dateParam(q.to, 'to') : iso(new Date());
  const from = q.from ? dateParam(q.from, 'from') : addDays(to, -29);
  return { from, to };
};
const emailOk = (e) => !e || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const publicUser = (u) => ({
  id: u.id, name: u.name, username: u.username, email: u.email, team: u.team, role: u.role, leader_id: u.leader_id,
  job_title: u.job_title, level_id: u.level_id, start_date: u.start_date, active: !!u.active,
});
const requireRole = (u, ...roles) => { if (!roles.includes(u.role)) throw forbidden(); };
const canViewUser = (viewer, targetId) => { if (!visibleUserIds(viewer).includes(targetId)) throw forbidden(); };
const getUser = (id) => { const u = db.prepare('SELECT * FROM users WHERE id=?').get(id); if (!u) throw notFound('User not found'); return u; };
const canManage = (viewer, target) => viewer.role === 'admin' || (viewer.role === 'leader' && target.leader_id === viewer.id);
const uniq = (fn) => { try { return fn(); } catch (e) { if (/UNIQUE/.test(e.message)) throw bad('That name already exists'); throw e; } };
const today = () => localNow(getSettings().timezone).date;

// ---------- auth ----------
const attempts = new Map();
POST('/api/login', ({ body, res, ip }) => {
  const username = str(body.username, 'username', { required: true }), key = ip + '|' + username.toLowerCase();
  const a = attempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 600000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) throw new HttpError(429, 'Too many attempts, try again in a few minutes');
  // allow signing in with the username or the work email
  const u = db.prepare('SELECT * FROM users WHERE (username=? OR (email<>\'\' AND email=?)) AND active=1').get(username, username);
  if (!u || !verifyPassword(String(body.password ?? ''), u.pass_hash)) {
    a.n++; attempts.set(key, a); throw new HttpError(401, 'Wrong username or password');
  }
  attempts.delete(key);
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(token, u.id, Date.now() + SESSION_DAYS * 86400000);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`);
  return { user: publicUser(u) };
}, 'none');
POST('/api/logout', ({ res, token }) => {
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  return { ok: true };
}, 'optional');
GET('/api/me', ({ user }) => ({ user: publicUser(user) }));
POST('/api/me/password', ({ user, body }) => {
  const u = getUser(user.id);
  if (!verifyPassword(String(body.current ?? ''), u.pass_hash)) throw bad('Current password is wrong');
  const np = str(body.next, 'new password', { required: true, max: 200 });
  if (np.length < 6) throw bad('New password must be at least 6 characters');
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(np), u.id);
  return { ok: true };
});

// ---------- catalog (the picklists) ----------
GET('/api/catalog', () => {
  const s = getSettings();
  return {
    projects: db.prepare('SELECT id,code,name,default_scope_id,is_leave,active FROM projects ORDER BY active DESC, name').all(),
    task_types: db.prepare('SELECT id,name,unit_label,track_qty,is_leave,active FROM task_types ORDER BY active DESC, name').all(),
    scopes: db.prepare('SELECT id,name,active FROM scopes ORDER BY active DESC, name').all(),
    levels: db.prepare('SELECT id,rank,name,description FROM levels ORDER BY rank').all(),
    settings: { hours_per_day: Number(s.hours_per_day), workdays: s.workdays, timezone: s.timezone, today: today() },
  };
});
const projectScope = (body) => {
  const id = body.default_scope_id ? Number(body.default_scope_id) : null;
  if (!id && !flag(body.is_leave, 0)) throw bad('Choose the project scope');
  if (id && !db.prepare('SELECT 1 FROM scopes WHERE id=?').get(id)) throw bad('Unknown scope');
  return id;
};
POST('/api/projects', ({ user, body }) => { requireRole(user, 'admin');
  return { id: uniq(() => Number(db.prepare('INSERT INTO projects (name,code,default_scope_id,is_leave) VALUES (?,?,?,?)').run(str(body.name, 'name', { required: true, max: 120 }), str(body.code, 'code', { max: 30 }), projectScope(body), flag(body.is_leave, 0)).lastInsertRowid)) }; });
PUT('/api/projects/:id', ({ user, body, params }) => { requireRole(user, 'admin');
  uniq(() => db.prepare('UPDATE projects SET name=?,code=?,default_scope_id=?,is_leave=?,active=? WHERE id=?').run(str(body.name, 'name', { required: true, max: 120 }), str(body.code, 'code', { max: 30 }), projectScope(body), flag(body.is_leave, 0), flag(body.active), params.id)); return { ok: true }; });
POST('/api/task_types', ({ user, body }) => { requireRole(user, 'admin');
  return { id: uniq(() => Number(db.prepare('INSERT INTO task_types (name,unit_label,track_qty,is_leave) VALUES (?,?,?,?)').run(str(body.name, 'name', { required: true, max: 80 }), str(body.unit_label, 'unit', { max: 30 }) || 'item', flag(body.track_qty, 0), flag(body.is_leave, 0)).lastInsertRowid)) }; });
PUT('/api/task_types/:id', ({ user, body, params }) => { requireRole(user, 'admin');
  uniq(() => db.prepare('UPDATE task_types SET name=?,unit_label=?,track_qty=?,is_leave=?,active=? WHERE id=?').run(str(body.name, 'name', { required: true, max: 80 }), str(body.unit_label, 'unit', { max: 30 }) || 'item', flag(body.track_qty, 0), flag(body.is_leave, 0), flag(body.active), params.id)); return { ok: true }; });
POST('/api/scopes', ({ user, body }) => { requireRole(user, 'admin');
  return { id: uniq(() => Number(db.prepare('INSERT INTO scopes (name) VALUES (?)').run(str(body.name, 'name', { required: true, max: 60 })).lastInsertRowid)) }; });
PUT('/api/scopes/:id', ({ user, body, params }) => { requireRole(user, 'admin');
  uniq(() => db.prepare('UPDATE scopes SET name=?,active=? WHERE id=?').run(str(body.name, 'name', { required: true, max: 60 }), flag(body.active), params.id)); return { ok: true }; });
POST('/api/levels', ({ user, body }) => {
  requireRole(user, 'admin');
  const r = db.prepare('INSERT INTO levels (rank,name,description) VALUES (?,?,?)')
    .run(num(body.rank, 'rank', { int: true, min: 1 }), str(body.name, 'name', { required: true, max: 80 }), str(body.description, 'description', { max: 1000 }));
  return { id: Number(r.lastInsertRowid) };
});
PUT('/api/levels/:id', ({ user, body, params }) => {
  requireRole(user, 'admin');
  db.prepare('UPDATE levels SET rank=?,name=?,description=? WHERE id=?')
    .run(num(body.rank, 'rank', { int: true, min: 1 }), str(body.name, 'name', { required: true, max: 80 }), str(body.description, 'description', { max: 1000 }), params.id);
  return { ok: true };
});

// ---------- entries ----------
const ENTRY_SELECT = `SELECT e.*, p.name project, p.is_leave, t.name task_type, t.unit_label unit, s.name scope, u.name user
  FROM entries e JOIN projects p ON p.id=e.project_id JOIN task_types t ON t.id=e.task_type_id JOIN users u ON u.id=e.user_id
  LEFT JOIN scopes s ON s.id=e.scope_id`;
GET('/api/entries', ({ user, query }) => {
  const { from, to } = range({ from: query.from || query.date, to: query.to || query.date });
  const uid = query.user_id ? Number(query.user_id) : user.id;
  canViewUser(user, uid);
  return { entries: db.prepare(`${ENTRY_SELECT} WHERE e.user_id=? AND e.work_date BETWEEN ? AND ? ORDER BY e.work_date DESC, e.task_seq, e.id`).all(uid, from, to) };
});
function entryFields(body) {
  const work_date = dateParam(str(body.work_date, 'date', { required: true }), 'date');
  if (work_date > addDays(today(), 1)) throw bad('Date cannot be in the future');
  const project_id = num(body.project_id, 'project', { int: true }), task_type_id = num(body.task_type_id, 'task item', { int: true });
  const proj = db.prepare('SELECT * FROM projects WHERE id=? AND active=1').get(project_id);
  const task = db.prepare('SELECT * FROM task_types WHERE id=? AND active=1').get(task_type_id);
  if (!proj) throw bad('Unknown project');
  if (!task) throw bad('Unknown task item');
  const days = Math.round(num(body.days, 'days', { min: 0.01, max: 1 }) * 100) / 100;
  const scope_id = body.scope_id ? Number(body.scope_id) : proj.default_scope_id;
  const qty = task.track_qty ? num(body.quantity, 'quantity', { int: true, min: 0, max: 1000, required: false }) : null;
  return { work_date, project_id, task_type_id, scope_id, days, quantity: qty || null, description: str(body.description, 'description', { max: 1000 }) };
}
POST('/api/entries', ({ user, body }) => {
  const f = entryFields(body);
  const uid = body.user_id && user.role === 'admin' ? Number(body.user_id) : user.id;
  const seq = db.prepare('SELECT COALESCE(MAX(task_seq),0)+1 n FROM entries WHERE user_id=? AND work_date=?').get(uid, f.work_date).n;
  const r = db.prepare('INSERT INTO entries (user_id,work_date,task_seq,project_id,task_type_id,scope_id,days,quantity,description) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(uid, f.work_date, seq, f.project_id, f.task_type_id, f.scope_id, f.days, f.quantity, f.description);
  const total = db.prepare('SELECT ROUND(SUM(days),2) d FROM entries WHERE user_id=? AND work_date=?').get(uid, f.work_date).d;
  return { id: Number(r.lastInsertRowid), day_total: total };
});
function ownEntry(user, id) {
  const e = db.prepare('SELECT * FROM entries WHERE id=?').get(id);
  if (!e) throw notFound();
  if (user.role !== 'admin') {
    if (e.user_id !== user.id) throw forbidden();
    if (e.work_date < addDays(today(), -EDIT_WINDOW_DAYS)) throw forbidden(`Entries older than ${EDIT_WINDOW_DAYS} days are locked — ask your manager`);
  }
  return e;
}
PUT('/api/entries/:id', ({ user, body, params }) => {
  const old = ownEntry(user, params.id), f = entryFields(body);
  const seq = f.work_date === old.work_date ? old.task_seq : db.prepare('SELECT COALESCE(MAX(task_seq),0)+1 n FROM entries WHERE user_id=? AND work_date=?').get(old.user_id, f.work_date).n;
  db.prepare("UPDATE entries SET work_date=?,task_seq=?,project_id=?,task_type_id=?,scope_id=?,days=?,quantity=?,description=?,updated_at=datetime('now') WHERE id=?")
    .run(f.work_date, seq, f.project_id, f.task_type_id, f.scope_id, f.days, f.quantity, f.description, params.id);
  return { ok: true };
});
DEL('/api/entries/:id', ({ user, params }) => { ownEntry(user, params.id); db.prepare('DELETE FROM entries WHERE id=?').run(params.id); return { ok: true }; });

GET('/api/suggest', ({ user, query }) => suggest(user.id, {
  projectId: query.project_id ? Number(query.project_id) : null,
  taskTypeId: query.task_type_id ? Number(query.task_type_id) : null,
  text: query.text || '', date: query.date && isDate(query.date) ? query.date : undefined,
}));

// ---------- users / team ----------
GET('/api/users', ({ user }) => {
  const ids = visibleUserIds(user);
  const to = today(), from = addDays(to, -29);
  const rows = db.prepare(
    `SELECT u.*, l.name level,
       (SELECT MAX(work_date) FROM entries WHERE user_id=u.id) last_entry,
       COALESCE((SELECT ROUND(SUM(e.days),2) FROM entries e JOIN projects p ON p.id=e.project_id WHERE e.user_id=u.id AND p.is_leave=0 AND e.work_date BETWEEN ? AND ?),0) days_30d
     FROM users u LEFT JOIN levels l ON l.id=u.level_id WHERE u.id IN (${ids.map(() => '?').join(',') || 'NULL'}) ORDER BY u.active DESC, u.name`).all(from, to, ...ids);
  return { users: rows.map((r) => ({ ...publicUser(r), level: r.level, last_entry: r.last_entry, days_30d: r.days_30d })) };
});
GET('/api/leaders', ({ user }) => { requireRole(user, 'admin'); return { leaders: db.prepare("SELECT id,name FROM users WHERE role IN ('leader','admin') AND active=1 ORDER BY name").all() }; });
POST('/api/users', ({ user, body }) => {
  requireRole(user, 'admin');
  const username = str(body.username, 'username', { required: true, max: 50 });
  const password = str(body.password, 'password', { required: true, max: 200 });
  if (password.length < 6) throw bad('Password must be at least 6 characters');
  const email = str(body.email, 'email', { max: 150 }).toLowerCase();
  if (!emailOk(email)) throw bad('Email looks invalid');
  const role = ['admin', 'leader', 'member'].includes(body.role) ? body.role : 'member';
  try {
    const r = db.prepare('INSERT INTO users (name,username,email,team,pass_hash,role,leader_id,job_title,level_id,start_date) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(str(body.name, 'name', { required: true, max: 100 }), username, email, str(body.team, 'team', { max: 50 }), hashPassword(password), role,
        body.leader_id ? Number(body.leader_id) : null, str(body.job_title, 'job title', { max: 100 }), body.level_id ? Number(body.level_id) : null, body.start_date || today());
    const id = Number(r.lastInsertRowid);
    if (body.level_id) db.prepare('INSERT INTO level_history (user_id,level_id,from_date) VALUES (?,?,?)').run(id, Number(body.level_id), body.start_date || today());
    return { id };
  } catch (e) { if (/UNIQUE/.test(e.message)) throw bad('Username already taken'); throw e; }
});
PUT('/api/users/:id', ({ user, body, params }) => {
  requireRole(user, 'admin');
  const t = getUser(params.id);
  const role = ['admin', 'leader', 'member'].includes(body.role) ? body.role : t.role;
  if (t.id === user.id && (role !== 'admin' || body.active === false)) throw bad("You can't demote or deactivate yourself");
  const email = str(body.email ?? t.email, 'email', { max: 150 }).toLowerCase();
  if (!emailOk(email)) throw bad('Email looks invalid');
  db.prepare('UPDATE users SET name=?,email=?,team=?,role=?,leader_id=?,job_title=?,start_date=?,active=? WHERE id=?')
    .run(str(body.name ?? t.name, 'name', { required: true, max: 100 }), email, str(body.team ?? t.team, 'team', { max: 50 }), role, body.leader_id ? Number(body.leader_id) : null,
      str(body.job_title ?? t.job_title, 'job title', { max: 100 }), body.start_date || t.start_date, body.active === undefined ? t.active : body.active ? 1 : 0, t.id);
  if (body.password) {
    if (String(body.password).length < 6) throw bad('Password must be at least 6 characters');
    db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(String(body.password)), t.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(t.id);
  }
  return { ok: true };
});

// ---------- dashboard ----------
GET('/api/dash/overview', ({ user, query }) => { requireRole(user, 'admin', 'leader'); const { from, to } = range(query); return { from, to, ...overview(user, from, to) }; });
GET('/api/dash/productivity', ({ user, query }) => {
  requireRole(user, 'admin', 'leader');
  const { from, to } = range(query);
  return { from, to, ...productivity(user, from, to, {
    taskTypeId: query.task_type_id ? Number(query.task_type_id) : null,
    projectId: query.project_id ? Number(query.project_id) : null,
    userId: query.user_id ? Number(query.user_id) : null,
  }) };
});

// ---------- admin: notifications, settings, import ----------
const OUTBOX_LIST = 'SELECT id,kind,to_addr,subject,status,error,created_at FROM outbox ORDER BY id DESC LIMIT 60';
GET('/api/admin/settings', ({ user }) => {
  requireRole(user, 'admin');
  const s = getSettings(), now = localNow(s.timezone);
  return { settings: s, smtp: smtpConfigured(), now, outbox: db.prepare(OUTBOX_LIST).all(),
    jobs: db.prepare('SELECT job,run_date,ran_at FROM job_runs ORDER BY ran_at DESC LIMIT 8').all() };
});
PUT('/api/admin/settings', ({ user, body }) => {
  requireRole(user, 'admin');
  const t = (v, n) => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw bad(`${n} must be HH:MM`); return v; };
  const next = { ...getSettings() };
  for (const k of Object.keys(SETTING_DEFAULTS)) if (body[k] !== undefined) next[k] = typeof body[k] === 'boolean' ? (body[k] ? '1' : '0') : String(body[k]).trim();
  t(next.reminder_time, 'Reminder time'); t(next.weekly_report_time, 'Report time');
  if (!/^[0-6](,[0-6])*$/.test(next.workdays)) throw bad('Workdays must be digits 0–6 (0 = Sunday)');
  if (!emailOk(next.admin_email)) throw bad('Admin email looks invalid');
  try { new Intl.DateTimeFormat('en', { timeZone: next.timezone }); } catch { throw bad('Unknown timezone'); }
  if (!(Number(next.hours_per_day) > 0 && Number(next.hours_per_day) <= 24)) throw bad('Hours per day is invalid');
  setSettings(next);
  return { ok: true };
});
POST('/api/admin/notify', async ({ user, body }) => {
  requireRole(user, 'admin');
  const s = getSettings(), now = localNow(s.timezone), dry = !!body.dry;
  if (body.action === 'reminder') return sendReminders(now.date, { dry });
  if (body.action === 'weekly') return sendWeeklyReport(now.date, { dry });
  if (body.action === 'test') {
    const to = str(body.to, 'email', { max: 150 }) || s.admin_email || user.email;
    if (!to || !emailOk(to)) throw bad('Enter an email address to send the test to');
    return { to, ...(await sendTest(to)), smtp: smtpConfigured() };
  }
  throw bad('Unknown action');
});
GET('/api/admin/outbox/:id', ({ user, params }) => { requireRole(user, 'admin'); const r = db.prepare('SELECT * FROM outbox WHERE id=?').get(params.id); if (!r) throw notFound(); return r; });
POST('/api/admin/import', async ({ user, body, query }) => {
  requireRole(user, 'admin');
  if (!Buffer.isBuffer(body) || body.length < 100) throw bad('Upload the .xlsx file');
  try { return await importWorkbook(body, { dry: query.dry === '1' }); }
  catch (e) { throw bad('Could not import: ' + e.message); }
}, 'user', { raw: true });

// ---------- career / growth ----------
function growth(viewer, uid) {
  canViewUser(viewer, uid);
  const u = getUser(uid);
  const manager = canManage(viewer, u);
  const level = u.level_id ? db.prepare('SELECT * FROM levels WHERE id=?').get(u.level_id) : null;
  const levels = db.prepare('SELECT * FROM levels ORDER BY rank').all();
  const history = db.prepare('SELECT h.*, l.name level FROM level_history h JOIN levels l ON l.id=h.level_id WHERE h.user_id=? ORDER BY h.from_date DESC, h.id DESC').all(uid);
  const goals = db.prepare('SELECT g.*, t.name task_type FROM goals g LEFT JOIN task_types t ON t.id=g.task_type_id WHERE g.user_id=? ORDER BY (g.status=\'active\') DESC, g.due_date').all(uid)
    .map((g) => { const live = goalLiveValue(g); return { ...g, live_value: live, progress: goalProgress(g, live) }; });
  const notes = db.prepare(`SELECT n.*, a.name author FROM notes n JOIN users a ON a.id=n.author_id WHERE n.user_id=? ${manager ? '' : 'AND n.shared=1'} ORDER BY n.created_at DESC, n.id DESC`).all(uid);
  const to = today(), p1 = [uid, addDays(to, -29), to], p0 = [uid, addDays(to, -59), addDays(to, -30)];
  const effort = (p) => db.prepare(`SELECT t.id task_type_id, t.name task_type, ROUND(SUM(e.days),2) days FROM entries e JOIN task_types t ON t.id=e.task_type_id
    WHERE e.user_id=? AND e.work_date BETWEEN ? AND ? AND t.is_leave=0 GROUP BY t.id ORDER BY days DESC`).all(...p);
  const prev = Object.fromEntries(effort(p0).map((r) => [r.task_type_id, r.days]));
  const speed = Object.fromEntries(productivity(viewer, p1[1], to, { userId: uid }).by_person_task.map((r) => [r.task_type_id, r]));
  const skills = effort(p1).map((r) => ({ ...r, prev_days: prev[r.task_type_id] ?? null, units: speed[r.task_type_id]?.units ?? null, unit: speed[r.task_type_id]?.unit ?? null,
    hrs_per_unit: speed[r.task_type_id]?.hrs_per_unit ?? null, team_hrs_per_unit: speed[r.task_type_id]?.team_hrs_per_unit ?? null }));
  const totals = db.prepare(`SELECT COALESCE(ROUND(SUM(CASE WHEN p.is_leave=0 THEN e.days END),1),0) days, COALESCE(SUM(e.quantity),0) units, COUNT(DISTINCT e.work_date) active_days
    FROM entries e JOIN projects p ON p.id=e.project_id WHERE e.user_id=?`).get(uid);
  return { user: publicUser(u), level, levels, history, goals, notes, skills, totals, can_manage: manager };
}
GET('/api/users/:id/growth', ({ user, params }) => growth(user, Number(params.id)));

function requireManager(viewer, uid) { const t = getUser(uid); if (!canManage(viewer, t)) throw forbidden(); return t; }
const goalFields = (b) => {
  const metric = ['manual', 'avg_hrs', 'units_month'].includes(b.metric) ? b.metric : 'manual';
  return {
    title: str(b.title, 'title', { required: true, max: 200 }), description: str(b.description, 'description', { max: 1000 }), metric,
    task_type_id: metric === 'manual' || !b.task_type_id ? null : Number(b.task_type_id),
    start_value: num(b.start_value, 'start', { required: false }), target_value: num(b.target_value, 'target', { required: false }),
    unit: str(b.unit, 'unit', { max: 30 }), due_date: b.due_date ? dateParam(b.due_date, 'due date') : null,
  };
};
POST('/api/users/:id/goals', ({ user, params, body }) => {
  requireManager(user, Number(params.id));
  const g = goalFields(body);
  if (g.metric !== 'manual' && g.start_value == null) g.start_value = goalLiveValue({ ...g, user_id: Number(params.id) });
  const r = db.prepare('INSERT INTO goals (user_id,title,description,metric,task_type_id,start_value,target_value,current_value,unit,due_date,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(Number(params.id), g.title, g.description, g.metric, g.task_type_id, g.start_value, g.target_value, g.start_value, g.unit, g.due_date, user.id);
  return { id: Number(r.lastInsertRowid) };
});
PUT('/api/goals/:id', ({ user, params, body }) => {
  const g = db.prepare('SELECT * FROM goals WHERE id=?').get(params.id);
  if (!g) throw notFound();
  if (!canManage(user, getUser(g.user_id))) {
    if (g.user_id !== user.id || g.metric !== 'manual') throw forbidden();
    db.prepare('UPDATE goals SET current_value=? WHERE id=?').run(num(body.current_value, 'value'), g.id);
    return { ok: true };
  }
  const f = goalFields({ ...g, ...body });
  const status = ['active', 'achieved', 'dropped'].includes(body.status) ? body.status : g.status;
  db.prepare('UPDATE goals SET title=?,description=?,metric=?,task_type_id=?,start_value=?,target_value=?,current_value=?,unit=?,due_date=?,status=? WHERE id=?')
    .run(f.title, f.description, f.metric, f.task_type_id, f.start_value, f.target_value, body.current_value ?? g.current_value, f.unit, f.due_date, status, g.id);
  return { ok: true };
});
DEL('/api/goals/:id', ({ user, params }) => {
  const g = db.prepare('SELECT * FROM goals WHERE id=?').get(params.id);
  if (!g) throw notFound();
  requireManager(user, g.user_id);
  db.prepare('DELETE FROM goals WHERE id=?').run(g.id);
  return { ok: true };
});
POST('/api/users/:id/notes', ({ user, params, body }) => {
  requireManager(user, Number(params.id));
  const kind = ['note', 'feedback', 'milestone', 'review'].includes(body.kind) ? body.kind : 'note';
  const r = db.prepare('INSERT INTO notes (user_id,author_id,kind,body,shared) VALUES (?,?,?,?,?)')
    .run(Number(params.id), user.id, kind, str(body.body, 'note', { required: true, max: 4000 }), body.shared ? 1 : 0);
  return { id: Number(r.lastInsertRowid) };
});
DEL('/api/notes/:id', ({ user, params }) => {
  const n = db.prepare('SELECT * FROM notes WHERE id=?').get(params.id);
  if (!n) throw notFound();
  requireManager(user, n.user_id);
  db.prepare('DELETE FROM notes WHERE id=?').run(n.id);
  return { ok: true };
});
POST('/api/users/:id/level', ({ user, params, body }) => {
  requireRole(user, 'admin');
  const t = getUser(params.id);
  const lvl = db.prepare('SELECT * FROM levels WHERE id=?').get(num(body.level_id, 'level', { int: true }));
  if (!lvl) throw bad('Unknown level');
  const from = body.from_date ? dateParam(body.from_date, 'date') : today();
  db.prepare('UPDATE users SET level_id=? WHERE id=?').run(lvl.id, t.id);
  db.prepare('INSERT INTO level_history (user_id,level_id,from_date,note) VALUES (?,?,?,?)').run(t.id, lvl.id, from, str(body.note, 'note', { max: 500 }));
  if (body.share !== false) db.prepare('INSERT INTO notes (user_id,author_id,kind,body,shared) VALUES (?,?,?,?,1)')
    .run(t.id, user.id, 'milestone', `Moved to ${lvl.name}${body.note ? ' — ' + str(body.note, 'note', { max: 500 }) : ''}`);
  return { ok: true };
});

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function parseCookies(h = '') { return Object.fromEntries(h.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')])); }
async function readBody(req, { raw = false } = {}) {
  const chunks = []; let size = 0; const max = raw ? 30e6 : 1e6;
  for await (const c of req) { size += c.length; if (size > max) throw new HttpError(413, 'Too large'); chunks.push(c); }
  if (raw) return Buffer.concat(chunks);
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw bad('Invalid JSON'); }
}

async function handleApi(req, res, url) {
  const route_ = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
  if (!route_) throw notFound('Unknown endpoint');
  const token = parseCookies(req.headers.cookie).sid;
  let user = null;
  if (token) user = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.active=1').get(token, Date.now()) || null;
  if (route_.auth === 'user' && !user) throw new HttpError(401, 'Please sign in');
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'timesheet') throw forbidden('Bad request origin');
  const params = route_.re.exec(url.pathname).groups || {};
  const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req, route_) : {};
  const out = await route_.handler({ req, res, user, token, params, body, query: Object.fromEntries(url.searchParams), ip: req.socket.remoteAddress });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(out ?? { ok: true }));
}

async function handleStatic(req, res, url) {
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (p === '/' || !extname(p)) p = '/index.html';
  try {
    const data = await readFile(join(PUBLIC, p));
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream', 'Cache-Control': p === '/index.html' ? 'no-cache' : 'public, max-age=300' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await handleStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: status === 500 ? 'Server error' : e.message }));
  }
});

const seeded = seedIfEmpty();
db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
server.listen(PORT, () => {
  console.log(`Team Timesheet running on http://localhost:${PORT}`);
  console.log(`Email: ${smtpConfigured() ? 'SMTP configured — reminders will really be sent' : 'SMTP not configured — emails are only recorded (see Setup → Notifications)'}`);
  if (seeded.createdAdmin) console.log(`\n  First run — admin account created:\n    username: admin\n    password: ${seeded.adminPassword ?? '(from ADMIN_PASSWORD)'}\n  Change it after signing in.\n`);
  startScheduler();
});
