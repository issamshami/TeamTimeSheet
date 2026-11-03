import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { db, hashPassword, verifyPassword, seedIfEmpty } from './db.js';
import { suggest } from './suggest.js';
import { overview, productivity, visibleUserIds, goalLiveValue, goalProgress, addDays, iso } from './analytics.js';

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
const route = (method, path, handler, auth = 'user') =>
  routes.push({ method, auth, handler, re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });
const GET = (p, h, a) => route('GET', p, h, a), POST = (p, h, a) => route('POST', p, h, a),
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
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const dateParam = (s, name) => { if (!isDate(s)) throw bad(`${name} must be YYYY-MM-DD`); return s; };
const range = (q) => {
  const to = q.to ? dateParam(q.to, 'to') : iso(new Date());
  const from = q.from ? dateParam(q.from, 'from') : addDays(to, -29);
  return { from, to };
};
const publicUser = (u) => ({
  id: u.id, name: u.name, username: u.username, role: u.role, leader_id: u.leader_id,
  job_title: u.job_title, level_id: u.level_id, start_date: u.start_date, daily_target_min: u.daily_target_min, active: !!u.active,
});
const requireRole = (u, ...roles) => { if (!roles.includes(u.role)) throw forbidden(); };
function canViewUser(viewer, targetId) {
  if (!visibleUserIds(viewer).includes(targetId)) throw forbidden();
}
const getUser = (id) => { const u = db.prepare('SELECT * FROM users WHERE id=?').get(id); if (!u) throw notFound('User not found'); return u; };
const canManage = (viewer, target) => viewer.role === 'admin' || (viewer.role === 'leader' && target.leader_id === viewer.id);

// ---------- auth ----------
const attempts = new Map();
POST('/api/login', ({ body, res, ip }) => {
  const username = str(body.username, 'username', { required: true }), key = ip + '|' + username.toLowerCase();
  const a = attempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 600000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) throw new HttpError(429, 'Too many attempts, try again in a few minutes');
  const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
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

// ---------- catalog ----------
GET('/api/catalog', () => ({
  projects: db.prepare('SELECT id,code,name,active FROM projects ORDER BY active DESC, name').all(),
  task_types: db.prepare('SELECT id,name,unit_label,active FROM task_types ORDER BY active DESC, name').all(),
  levels: db.prepare('SELECT id,rank,name,description FROM levels ORDER BY rank').all(),
}));
const upsertCatalog = (table, cols) => ({ user, body, params }) => {
  requireRole(user, 'admin');
  const vals = cols.map(([c, o]) => str(body[c], c, o));
  const active = body.active === undefined ? 1 : body.active ? 1 : 0;
  try {
    if (params.id) {
      db.prepare(`UPDATE ${table} SET ${cols.map(([c]) => c + '=?').join(',')}, active=? WHERE id=?`).run(...vals, active, params.id);
      return { id: Number(params.id) };
    }
    const r = db.prepare(`INSERT INTO ${table} (${cols.map(([c]) => c).join(',')}, active) VALUES (${cols.map(() => '?').join(',')},1)`).run(...vals);
    return { id: Number(r.lastInsertRowid) };
  } catch (e) { if (/UNIQUE/.test(e.message)) throw bad('That name already exists'); throw e; }
};
const projCols = [['name', { required: true, max: 120 }], ['code', { max: 30 }]];
const taskCols = [['name', { required: true, max: 80 }], ['unit_label', { max: 30 }]];
POST('/api/projects', upsertCatalog('projects', projCols)); PUT('/api/projects/:id', upsertCatalog('projects', projCols));
POST('/api/task_types', upsertCatalog('task_types', taskCols)); PUT('/api/task_types/:id', upsertCatalog('task_types', taskCols));
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
const ENTRY_SELECT = `SELECT e.*, p.name project, p.code project_code, t.name task_type, t.unit_label unit, u.name user
  FROM entries e JOIN projects p ON p.id=e.project_id JOIN task_types t ON t.id=e.task_type_id JOIN users u ON u.id=e.user_id`;
GET('/api/entries', ({ user, query }) => {
  const { from, to } = range({ from: query.from || query.date, to: query.to || query.date });
  const uid = query.user_id ? Number(query.user_id) : user.id;
  canViewUser(user, uid);
  return { entries: db.prepare(`${ENTRY_SELECT} WHERE e.user_id=? AND e.work_date BETWEEN ? AND ? ORDER BY e.work_date DESC, e.id DESC`).all(uid, from, to) };
});
function entryFields(body, user) {
  const work_date = dateParam(str(body.work_date, 'date', { required: true }), 'date');
  if (work_date > addDays(iso(new Date()), 1)) throw bad('Date cannot be in the future');
  const project_id = num(body.project_id, 'project', { int: true }), task_type_id = num(body.task_type_id, 'task', { int: true });
  if (!db.prepare('SELECT 1 FROM projects WHERE id=? AND active=1').get(project_id)) throw bad('Unknown project');
  if (!db.prepare('SELECT 1 FROM task_types WHERE id=? AND active=1').get(task_type_id)) throw bad('Unknown task');
  return {
    work_date, project_id, task_type_id,
    task_count: num(body.task_count ?? 1, 'task count', { int: true, min: 0, max: 1000 }),
    minutes: num(body.minutes, 'time', { int: true, min: 1, max: 1440 }),
    description: str(body.description, 'description', { max: 1000 }),
  };
}
POST('/api/entries', ({ user, body }) => {
  const f = entryFields(body, user);
  const uid = body.user_id && user.role === 'admin' ? Number(body.user_id) : user.id;
  const r = db.prepare('INSERT INTO entries (user_id,work_date,project_id,task_type_id,task_count,minutes,description) VALUES (?,?,?,?,?,?,?)')
    .run(uid, f.work_date, f.project_id, f.task_type_id, f.task_count, f.minutes, f.description);
  return { id: Number(r.lastInsertRowid) };
});
function ownEntry(user, id) {
  const e = db.prepare('SELECT * FROM entries WHERE id=?').get(id);
  if (!e) throw notFound();
  if (user.role !== 'admin') {
    if (e.user_id !== user.id) throw forbidden();
    if (e.work_date < addDays(iso(new Date()), -EDIT_WINDOW_DAYS)) throw forbidden(`Entries older than ${EDIT_WINDOW_DAYS} days are locked — ask your manager`);
  }
  return e;
}
PUT('/api/entries/:id', ({ user, body, params }) => {
  ownEntry(user, params.id);
  const f = entryFields(body, user);
  db.prepare("UPDATE entries SET work_date=?,project_id=?,task_type_id=?,task_count=?,minutes=?,description=?,updated_at=datetime('now') WHERE id=?")
    .run(f.work_date, f.project_id, f.task_type_id, f.task_count, f.minutes, f.description, params.id);
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
  const to = iso(new Date()), from = addDays(to, -29);
  const rows = db.prepare(
    `SELECT u.*, l.name level,
       (SELECT MAX(work_date) FROM entries WHERE user_id=u.id) last_entry,
       COALESCE((SELECT SUM(minutes) FROM entries WHERE user_id=u.id AND work_date BETWEEN ? AND ?),0) minutes_30d
     FROM users u LEFT JOIN levels l ON l.id=u.level_id WHERE u.id IN (${ids.map(() => '?').join(',') || 'NULL'}) ORDER BY u.active DESC, u.name`).all(from, to, ...ids);
  return { users: rows.map((r) => ({ ...publicUser(r), level: r.level, last_entry: r.last_entry, minutes_30d: r.minutes_30d })) };
});
GET('/api/leaders', ({ user }) => { requireRole(user, 'admin'); return { leaders: db.prepare("SELECT id,name FROM users WHERE role IN ('leader','admin') AND active=1 ORDER BY name").all() }; });
POST('/api/users', ({ user, body }) => {
  requireRole(user, 'admin');
  const username = str(body.username, 'username', { required: true, max: 50 });
  const password = str(body.password, 'password', { required: true, max: 200 });
  if (password.length < 6) throw bad('Password must be at least 6 characters');
  const role = ['admin', 'leader', 'member'].includes(body.role) ? body.role : 'member';
  try {
    const r = db.prepare('INSERT INTO users (name,username,pass_hash,role,leader_id,job_title,level_id,start_date,daily_target_min) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(str(body.name, 'name', { required: true, max: 100 }), username, hashPassword(password), role,
        body.leader_id ? Number(body.leader_id) : null, str(body.job_title, 'job title', { max: 100 }),
        body.level_id ? Number(body.level_id) : null, body.start_date || iso(new Date()), num(body.daily_target_min ?? 480, 'daily target', { int: true, min: 0, max: 1440 }));
    const id = Number(r.lastInsertRowid);
    if (body.level_id) db.prepare('INSERT INTO level_history (user_id,level_id,from_date) VALUES (?,?,?)').run(id, Number(body.level_id), body.start_date || iso(new Date()));
    return { id };
  } catch (e) { if (/UNIQUE/.test(e.message)) throw bad('Username already taken'); throw e; }
});
PUT('/api/users/:id', ({ user, body, params }) => {
  requireRole(user, 'admin');
  const t = getUser(params.id);
  const role = ['admin', 'leader', 'member'].includes(body.role) ? body.role : t.role;
  if (t.id === user.id && (role !== 'admin' || body.active === false)) throw bad("You can't demote or deactivate yourself");
  db.prepare('UPDATE users SET name=?,role=?,leader_id=?,job_title=?,daily_target_min=?,start_date=?,active=? WHERE id=?')
    .run(str(body.name ?? t.name, 'name', { required: true, max: 100 }), role, body.leader_id ? Number(body.leader_id) : null,
      str(body.job_title ?? t.job_title, 'job title', { max: 100 }), num(body.daily_target_min ?? t.daily_target_min, 'daily target', { int: true, min: 0, max: 1440 }),
      body.start_date || t.start_date, body.active === undefined ? t.active : body.active ? 1 : 0, t.id);
  if (body.password) {
    if (String(body.password).length < 6) throw bad('Password must be at least 6 characters');
    db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(String(body.password)), t.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(t.id);
  }
  return { ok: true };
});

// ---------- dashboard ----------
GET('/api/dash/overview', ({ user, query }) => {
  requireRole(user, 'admin', 'leader');
  const { from, to } = range(query);
  return { from, to, ...overview(user, from, to) };
});
GET('/api/dash/productivity', ({ user, query }) => {
  requireRole(user, 'admin', 'leader');
  const { from, to } = range(query);
  return { from, to, ...productivity(user, from, to, {
    taskTypeId: query.task_type_id ? Number(query.task_type_id) : null,
    projectId: query.project_id ? Number(query.project_id) : null,
    userId: query.user_id ? Number(query.user_id) : null,
  }) };
});

// ---------- career / growth ----------
function growth(viewer, uid) {
  canViewUser(viewer, uid);
  const u = getUser(uid);
  const manager = canManage(viewer, u) || viewer.role === 'admin';
  const level = u.level_id ? db.prepare('SELECT * FROM levels WHERE id=?').get(u.level_id) : null;
  const levels = db.prepare('SELECT * FROM levels ORDER BY rank').all();
  const history = db.prepare('SELECT h.*, l.name level FROM level_history h JOIN levels l ON l.id=h.level_id WHERE h.user_id=? ORDER BY h.from_date DESC, h.id DESC').all(uid);
  const goals = db.prepare('SELECT g.*, t.name task_type FROM goals g LEFT JOIN task_types t ON t.id=g.task_type_id WHERE g.user_id=? ORDER BY (g.status=\'active\') DESC, g.due_date').all(uid)
    .map((g) => { const live = goalLiveValue(g); return { ...g, live_value: live, progress: goalProgress(g, live) }; });
  const notes = db.prepare(`SELECT n.*, a.name author FROM notes n JOIN users a ON a.id=n.author_id WHERE n.user_id=? ${manager ? '' : 'AND n.shared=1'} ORDER BY n.created_at DESC, n.id DESC`).all(uid);
  const to = iso(new Date());
  const skills = productivity(viewer, addDays(to, -29), to, { userId: uid }).by_person_task;
  const prev = productivity(viewer, addDays(to, -59), addDays(to, -30), { userId: uid }).by_person_task;
  const prevMap = Object.fromEntries(prev.map((r) => [r.task_type_id, r.min_per_unit]));
  for (const s of skills) s.prev_min_per_unit = prevMap[s.task_type_id] ?? null;
  const totals = db.prepare('SELECT COALESCE(SUM(minutes),0) minutes, COALESCE(SUM(task_count),0) tasks, COUNT(DISTINCT work_date) days FROM entries WHERE user_id=?').get(uid);
  return { user: publicUser(u), level, levels, history, goals, notes, skills, totals, can_manage: manager };
}
GET('/api/users/:id/growth', ({ user, params }) => growth(user, Number(params.id)));

function requireManager(viewer, uid) { const t = getUser(uid); if (!canManage(viewer, t)) throw forbidden(); return t; }
const goalFields = (b) => {
  const metric = ['manual', 'avg_min', 'units_month'].includes(b.metric) ? b.metric : 'manual';
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
  const isMgr = canManage(user, getUser(g.user_id));
  if (!isMgr) {
    // a member may only update progress on their own manual goals
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
  const from = body.from_date ? dateParam(body.from_date, 'date') : iso(new Date());
  db.prepare('UPDATE users SET level_id=? WHERE id=?').run(lvl.id, t.id);
  db.prepare('INSERT INTO level_history (user_id,level_id,from_date,note) VALUES (?,?,?,?)').run(t.id, lvl.id, from, str(body.note, 'note', { max: 500 }));
  if (body.share !== false) db.prepare('INSERT INTO notes (user_id,author_id,kind,body,shared) VALUES (?,?,?,?,1)')
    .run(t.id, user.id, 'milestone', `Moved to ${lvl.name}${body.note ? ' — ' + str(body.note, 'note', { max: 500 }) : ''}`);
  return { ok: true };
});

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function parseCookies(h = '') { return Object.fromEntries(h.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')])); }
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 1e6) throw new HttpError(413, 'Too large'); chunks.push(c); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw bad('Invalid JSON'); }
}

async function handleApi(req, res, url) {
  const route_ = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
  if (!route_) throw notFound('Unknown endpoint');
  const token = parseCookies(req.headers.cookie).sid;
  let user = null;
  if (token) {
    user = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.active=1').get(token, Date.now()) || null;
  }
  if (route_.auth === 'user' && !user) throw new HttpError(401, 'Please sign in');
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'timesheet') throw forbidden('Bad request origin');
  const params = route_.re.exec(url.pathname).groups || {};
  const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
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
  if (seeded.createdAdmin) {
    console.log(`\n  First run — admin account created:\n    username: admin\n    password: ${seeded.adminPassword ?? '(from ADMIN_PASSWORD)'}\n  Change it after signing in.\n`);
  }
});
