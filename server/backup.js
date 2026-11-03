// Nightly copy of the database next to it (…/backups/timesheet-YYYY-MM-DD.db), keeping the last 14 days.
import { mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { db, DB_PATH } from './db.js';

const KEEP = 14;
export function backupNow(date = new Date().toISOString().slice(0, 10)) {
  const dir = join(dirname(DB_PATH), 'backups'), file = join(dir, `timesheet-${date}.db`);
  mkdirSync(dir, { recursive: true });
  if (existsSync(file)) return null;
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = readdirSync(dir).filter((f) => /^timesheet-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -KEEP);
  old.forEach((f) => rmSync(join(dir, f), { force: true }));
  return file;
}
export function startBackups() {
  const run = () => { try { const f = backupNow(); if (f) console.log('[backup] saved', f); } catch (e) { console.error('[backup]', e.message); } };
  setTimeout(run, 20000); setInterval(run, 3600000);
}
