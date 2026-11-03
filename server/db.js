import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH || new URL('../data/timesheet.db', import.meta.url).pathname;
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS levels (
  id INTEGER PRIMARY KEY, rank INTEGER NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS scopes (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL DEFAULT '',
  team TEXT NOT NULL DEFAULT '',
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','leader','member')),
  leader_id INTEGER REFERENCES users(id),
  job_title TEXT DEFAULT '',
  level_id INTEGER REFERENCES levels(id),
  start_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  code TEXT DEFAULT '',
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  default_scope_id INTEGER REFERENCES scopes(id),
  is_leave INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
-- Task Item picklist. track_qty = ask "how many?" (drawings, RFIs...) so speed per unit can be learned.
CREATE TABLE IF NOT EXISTS task_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  unit_label TEXT NOT NULL DEFAULT 'item',
  track_qty INTEGER NOT NULL DEFAULT 0,
  is_leave INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
-- One row = one line of the old Excel sheet. days = fraction of a working day (a full day sums to 1).
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  work_date TEXT NOT NULL,
  task_seq INTEGER NOT NULL DEFAULT 1,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  task_type_id INTEGER NOT NULL REFERENCES task_types(id),
  scope_id INTEGER REFERENCES scopes(id),
  days REAL NOT NULL,
  quantity INTEGER,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entries_user_date ON entries(user_id, work_date);
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(work_date);
CREATE INDEX IF NOT EXISTS idx_entries_proj ON entries(project_id);

CREATE TABLE IF NOT EXISTS level_history (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level_id INTEGER NOT NULL REFERENCES levels(id),
  from_date TEXT NOT NULL, note TEXT DEFAULT ''
);
-- metric: 'manual' | 'avg_hrs' (hours per unit, lower is better, last 30d) | 'units_month' (higher is better, last 30d)
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT DEFAULT '',
  metric TEXT NOT NULL DEFAULT 'manual' CHECK (metric IN ('manual','avg_hrs','units_month')),
  task_type_id INTEGER REFERENCES task_types(id),
  start_value REAL, target_value REAL, current_value REAL,
  unit TEXT DEFAULT '', due_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','dropped')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','feedback','milestone','review')),
  body TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- every email the app tries to send (also the audit trail when SMTP is not configured yet)
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL, to_addr TEXT NOT NULL, subject TEXT NOT NULL, html TEXT NOT NULL,
  status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- team leaders propose new projects; only the admin turns a proposal into a real project
CREATE TABLE IF NOT EXISTS project_proposals (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  scope_id INTEGER REFERENCES scopes(id),
  note TEXT NOT NULL DEFAULT '',
  proposed_by INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  reason TEXT NOT NULL DEFAULT '',
  project_id INTEGER REFERENCES projects(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS job_runs (job TEXT NOT NULL, run_date TEXT NOT NULL, ran_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (job, run_date));
`);

// ---------- settings ----------
export const SETTING_DEFAULTS = {
  timezone: 'Asia/Riyadh',
  workdays: '0,1,2,3,4',          // 0=Sun … 6=Sat  → Sunday to Thursday
  hours_per_day: '8',
  reminders_enabled: '1',
  reminder_time: '15:30',
  reminder_only_incomplete: '1',  // only remind people whose day is not yet complete
  weekly_report_enabled: '1',
  weekly_report_day: '4',         // Thursday
  weekly_report_time: '16:30',
  admin_email: '',
  app_url: '',
};
export function getSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const r of db.prepare('SELECT key,value FROM settings').all()) out[r.key] = r.value;
  return out;
}
export function setSettings(obj) {
  const st = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(obj)) if (k in SETTING_DEFAULTS) st.run(k, String(v));
}

// ---------- password helpers ----------
export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [s, h] = String(stored).split(':');
  if (!s || !h) return false;
  const calc = scryptSync(pw, Buffer.from(s, 'hex'), 64), want = Buffer.from(h, 'hex');
  return calc.length === want.length && timingSafeEqual(calc, want);
}

// ---------- first-run seed ----------
export function seedIfEmpty() {
  const out = {};
  if (!db.prepare('SELECT 1 FROM levels LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO levels (rank,name,description) VALUES (?,?,?)');
    [['Trainee', 'Learning the standards and tools under close guidance.'],
     ['Junior BIM Modeler', 'Produces routine models and drawings with review.'],
     ['BIM Modeler', 'Delivers models and shop drawings independently to standard.'],
     ['Senior BIM Modeler', 'Handles complex packages, checks others\' work, mentors juniors.'],
     ['BIM Coordinator', 'Coordinates disciplines and projects, owns quality and delivery.']]
      .forEach(([n, d], i) => ins.run(i + 1, n, d));
  }
  if (!db.prepare('SELECT 1 FROM scopes LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO scopes (name) VALUES (?)');
    ['Stone', 'Fit Out', 'Landscape', 'None'].forEach((s) => ins.run(s));
  }
  if (!db.prepare('SELECT 1 FROM task_types LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO task_types (name,unit_label,track_qty,is_leave) VALUES (?,?,?,?)');
    [['Project Modeling', 'model', 0, 0], ['Shop Drawings', 'sheet', 1, 0], ['Fabrication Drawings', 'drawing', 1, 0],
     ['Project Review', 'item', 0, 0], ['Library Modeling', 'family', 1, 0], ['BIM Support', 'item', 0, 0], ['Take Off', 'item', 0, 0],
     ['RFI', 'RFI', 1, 0], ['ACC Management', 'item', 0, 0], ['Meetings & Coordination', 'meeting', 0, 0],
     ['General Overhead', 'item', 0, 0], ['Training', 'session', 0, 0], ['Day Off', 'day', 0, 1]].forEach((r) => ins.run(...r));
  }
  if (!db.prepare('SELECT 1 FROM projects LIMIT 1').get()) {
    const none = db.prepare("SELECT id FROM scopes WHERE name='None'").get()?.id;
    db.prepare('INSERT INTO projects (name,default_scope_id,is_leave) VALUES (?,?,1)').run('Day Off', none);
    db.prepare('INSERT INTO projects (name,default_scope_id,is_leave) VALUES (?,?,0)').run('General', none);
  }
  if (!db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get()) {
    const pw = process.env.ADMIN_PASSWORD || randomBytes(6).toString('base64url');
    const top = db.prepare('SELECT id FROM levels ORDER BY rank DESC LIMIT 1').get();
    db.prepare("INSERT INTO users (name,username,email,pass_hash,role,job_title,level_id,start_date) VALUES (?,?,?,?,?,?,?,date('now'))")
      .run('Admin', 'admin', process.env.ADMIN_EMAIL || '', hashPassword(pw), 'admin', 'BIM Manager', top?.id ?? null);
    out.adminPassword = process.env.ADMIN_PASSWORD ? null : pw;
    out.createdAdmin = true;
  }
  if (process.env.ADMIN_EMAIL && !getSettings().admin_email) setSettings({ admin_email: process.env.ADMIN_EMAIL });
  if (process.env.APP_URL && !getSettings().app_url) setSettings({ app_url: process.env.APP_URL });
  return out;
}
