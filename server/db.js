import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH || new URL('../data/timesheet.db', import.meta.url).pathname;
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS levels (
  id INTEGER PRIMARY KEY,
  rank INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','leader','member')),
  leader_id INTEGER REFERENCES users(id),
  job_title TEXT DEFAULT '',
  level_id INTEGER REFERENCES levels(id),
  start_date TEXT,
  daily_target_min INTEGER NOT NULL DEFAULT 480,
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
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS task_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  unit_label TEXT NOT NULL DEFAULT 'item',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  work_date TEXT NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  task_type_id INTEGER NOT NULL REFERENCES task_types(id),
  task_count INTEGER NOT NULL DEFAULT 1,
  minutes INTEGER NOT NULL,
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
  from_date TEXT NOT NULL,
  note TEXT DEFAULT ''
);
-- metric: 'manual' | 'avg_min' (lower is better, last 30d) | 'units_month' (higher is better, last 30d)
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  metric TEXT NOT NULL DEFAULT 'manual' CHECK (metric IN ('manual','avg_min','units_month')),
  task_type_id INTEGER REFERENCES task_types(id),
  start_value REAL,
  target_value REAL,
  current_value REAL,
  unit TEXT DEFAULT '',
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','dropped')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','feedback','milestone','review')),
  body TEXT NOT NULL,
  shared INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------- password helpers ----------
export function hashPassword(pw) {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${h.toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [s, h] = String(stored).split(':');
  if (!s || !h) return false;
  const calc = scryptSync(pw, Buffer.from(s, 'hex'), 64);
  const want = Buffer.from(h, 'hex');
  return calc.length === want.length && timingSafeEqual(calc, want);
}

// ---------- first-run seed ----------
export function seedIfEmpty() {
  const out = {};
  if (!db.prepare('SELECT 1 FROM levels LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO levels (rank,name,description) VALUES (?,?,?)');
    [
      ['Trainee', 'Learning the standards and tools under close guidance.'],
      ['Junior Drafter', 'Produces routine drawings with review; growing speed and accuracy.'],
      ['Drafter', 'Delivers drawings independently to standard.'],
      ['Senior Drafter', 'Handles complex packages, checks others\' work, mentors juniors.'],
      ['Team Leader', 'Plans and leads a team, owns quality and delivery.'],
    ].forEach(([n, d], i) => ins.run(i + 1, n, d));
  }
  if (!db.prepare('SELECT 1 FROM task_types LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO task_types (name,unit_label) VALUES (?,?)');
    [['Shop Drawing', 'drawing'], ['Revision', 'drawing'], ['Markup / Redline', 'sheet'],
     ['Coordination', 'item'], ['Review / QC', 'drawing'], ['Meeting', 'meeting'], ['Other', 'item']]
      .forEach(([n, u]) => ins.run(n, u));
  }
  if (!db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get()) {
    const pw = process.env.ADMIN_PASSWORD || randomBytes(6).toString('base64url');
    const top = db.prepare('SELECT id FROM levels ORDER BY rank DESC LIMIT 1').get();
    db.prepare("INSERT INTO users (name,username,pass_hash,role,job_title,level_id,start_date) VALUES (?,?,?,?,?,?,date('now'))")
      .run('Admin', 'admin', hashPassword(pw), 'admin', 'Manager', top?.id ?? null);
    out.adminPassword = process.env.ADMIN_PASSWORD ? null : pw;
    out.createdAdmin = true;
  }
  return out;
}
