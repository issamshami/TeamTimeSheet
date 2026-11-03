// One-time (or repeatable) import from the team's Excel workbook:
//   sheet "Picklist"        -> task items, projects, scopes ("Department"), team members + emails
//   sheet "Task Management" -> historical timesheet lines (Date, Team Member, Task Number, Task Item,
//                              Task Description, Project, Number of Days, Month, Project Scope)
// Safe to re-run: identical lines are skipped. Use dry:true to preview (everything is rolled back).
import { readSheet } from 'read-excel-file/node';
import { randomBytes } from 'node:crypto';
import { db, hashPassword } from './db.js';

const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const key = (v) => clean(v).toLowerCase();
const ALIAS = { 'meeting and coordination': 'Meetings & Coordination', 'meetings and coordination': 'Meetings & Coordination' };

function toIsoDate(v) {
  if (v instanceof Date && !Number.isNaN(+v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10); // Excel serial
  const t = clean(v); if (!t) return null;
  const d = new Date(t.replace(/^[A-Za-z]+,\s*/, '') + ' 12:00 UTC');
  return Number.isNaN(+d) ? null : d.toISOString().slice(0, 10);
}
const findHeader = (rows, ...names) => rows.findIndex((r) => names.every((n) => r.some((c) => key(c) === n.toLowerCase())));
const col = (header, name) => header.findIndex((c) => key(c) === name.toLowerCase());
const pw = () => Array.from(randomBytes(8), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

export async function importWorkbook(file, { dry = false } = {}) {
  const [pick, tm] = await Promise.all([readSheet(file, 'Picklist'), readSheet(file, 'Task Management')]);
  const sum = { dry, members: { created: [], updated: [], without_email: [] }, projects_created: [], task_items_created: [], scopes_created: [],
    entries: { imported: 0, duplicates: 0, skipped: {}, first_date: null, last_date: null }, credentials: [] };

  // ----- picklist -----
  const ph = findHeader(pick, 'Task Item', 'Team Members');
  if (ph < 0) throw new Error('Sheet "Picklist" must have "Task Item" and "Team Members" columns');
  const H = pick[ph], ci = { item: col(H, 'Task Item'), member: col(H, 'Team Members'), team: col(H, 'Team'), email: col(H, 'Email'), project: col(H, 'Project List'), dept: col(H, 'Department') };
  const block = pick.slice(ph + 1, ph + 80); // the lists sit right under the header; ignore the stray block far below
  const pl = (i) => (i < 0 ? [] : block.map((r) => clean(r[i])).filter(Boolean));
  const members = block.map((r) => ({ name: clean(r[ci.member]), team: clean(r[ci.team]), email: clean(r[ci.email]).toLowerCase() })).filter((m) => m.name);

  db.exec('BEGIN');
  try {
    const getScope = (name) => {
      name = clean(name) || 'None';
      let r = db.prepare('SELECT id FROM scopes WHERE name=?').get(name);
      if (!r) { r = { id: Number(db.prepare('INSERT INTO scopes (name) VALUES (?)').run(name).lastInsertRowid) }; sum.scopes_created.push(name); }
      return r.id;
    };
    const getItem = (raw) => {
      const name = ALIAS[key(raw)] || clean(raw); if (!name) return null;
      let r = db.prepare('SELECT id FROM task_types WHERE name=?').get(name);
      if (!r) {
        const leave = /day off|leave|holiday|vacation/i.test(name) ? 1 : 0, qty = /drawing|rfi|library/i.test(name) ? 1 : 0;
        r = { id: Number(db.prepare('INSERT INTO task_types (name,unit_label,track_qty,is_leave) VALUES (?,?,?,?)').run(name, qty ? 'sheet' : 'item', qty, leave).lastInsertRowid) };
        sum.task_items_created.push(name);
      }
      return r.id;
    };
    const getProject = (raw) => {
      const name = clean(raw); if (!name) return null;
      let r = db.prepare('SELECT id FROM projects WHERE name=?').get(name);
      if (!r) {
        r = { id: Number(db.prepare('INSERT INTO projects (name,is_leave) VALUES (?,?)').run(name, /^day off$/i.test(name) ? 1 : 0).lastInsertRowid) };
        sum.projects_created.push(name);
      }
      return r.id;
    };
    pl(ci.item).forEach(getItem); pl(ci.project).forEach(getProject); pl(ci.dept).forEach(getScope);

    // ----- members -----
    const byName = new Map(db.prepare('SELECT id,name FROM users').all().map((u) => [key(u.name), u.id]));
    const usernames = new Set(db.prepare('SELECT username FROM users').all().map((u) => u.username.toLowerCase()));
    const mkUsername = (name, email) => {
      let base = email ? email.split('@')[0] : (() => { const p = clean(name).toLowerCase().split(' '); return p.length > 1 ? `${p[0]}.${p[p.length - 1][0]}` : p[0]; })();
      base = base.replace(/[^a-z0-9._-]/g, ''); let u = base, i = 2;
      while (usernames.has(u)) u = base + i++;
      usernames.add(u); return u;
    };
    const ensureMember = (m) => {
      const id = byName.get(key(m.name));
      if (id) {
        const u = db.prepare('SELECT email,team FROM users WHERE id=?').get(id);
        if ((m.email && !u.email) || (m.team && !u.team)) { db.prepare('UPDATE users SET email=COALESCE(NULLIF(email,\'\'),?), team=COALESCE(NULLIF(team,\'\'),?) WHERE id=?').run(m.email || '', m.team || '', id); sum.members.updated.push(m.name); }
        return id;
      }
      const username = mkUsername(m.name, m.email), password = pw();
      const nid = Number(db.prepare("INSERT INTO users (name,username,email,team,pass_hash,role,start_date) VALUES (?,?,?,?,?,'member',NULL)").run(m.name, username, m.email || '', m.team || '', hashPassword(password)).lastInsertRowid);
      byName.set(key(m.name), nid); sum.members.created.push(m.name);
      sum.credentials.push({ name: m.name, username, email: m.email || '', password });
      return nid;
    };
    members.forEach(ensureMember);
    sum.members.without_email = members.filter((m) => !m.email).map((m) => m.name);

    // ----- history -----
    const th = findHeader(tm, 'Date', 'Team Member', 'Task Item', 'Project');
    if (th < 0) throw new Error('Sheet "Task Management" must have Date, Team Member, Task Item, Project columns');
    const T = tm[th], c = { date: col(T, 'Date'), member: col(T, 'Team Member'), item: col(T, 'Task Item'), desc: col(T, 'Task Description'), project: col(T, 'Project'), days: col(T, 'Number of Days'), scope: col(T, 'Project Scope') };
    const skip = (why) => { sum.entries.skipped[why] = (sum.entries.skipped[why] || 0) + 1; };
    const scopeVotes = new Map(), seq = new Map(), firstStart = new Map(), fresh = new Set();
    const exists = db.prepare('SELECT 1 FROM entries WHERE user_id=? AND work_date=? AND task_type_id=? AND project_id=? AND days=? AND description=?');
    const ins = db.prepare('INSERT INTO entries (user_id,work_date,task_seq,project_id,task_type_id,scope_id,days,description) VALUES (?,?,?,?,?,?,?,?)');
    const maxSeq = db.prepare('SELECT COALESCE(MAX(task_seq),0) n FROM entries WHERE user_id=? AND work_date=?');
    for (const r of tm.slice(th + 1)) {
      const name = clean(r[c.member]); if (!name && !clean(r[c.item]) && !clean(r[c.project])) continue; // blank line
      const date = toIsoDate(r[c.date]), days = parseFloat(r[c.days]);
      if (!date) { skip('no/invalid date'); continue; }
      if (!name) { skip('no team member'); continue; }
      const item = getItem(r[c.item]); if (!item) { skip('no task item'); continue; }
      const proj = getProject(r[c.project]); if (!proj) { skip('no project'); continue; }
      if (!(days > 0)) { skip('zero/blank days'); continue; }
      const uid = byName.get(key(name)) ?? ensureMember({ name, team: '', email: '' });
      const scope = getScope(r[c.scope]), desc = clean(r[c.desc]);
      const sig = [uid, date, item, proj, days, desc].join('|');
      if (!fresh.has(sig) && exists.get(uid, date, item, proj, days, desc)) { sum.entries.duplicates++; continue; } // already in the database (re-import)
      fresh.add(sig);
      const k = `${uid}|${date}`; if (!seq.has(k)) seq.set(k, maxSeq.get(uid, date).n);
      seq.set(k, seq.get(k) + 1);
      ins.run(uid, date, seq.get(k), proj, item, scope, days, desc);
      sum.entries.imported++;
      sum.entries.first_date = !sum.entries.first_date || date < sum.entries.first_date ? date : sum.entries.first_date;
      sum.entries.last_date = !sum.entries.last_date || date > sum.entries.last_date ? date : sum.entries.last_date;
      const v = scopeVotes.get(proj) || new Map(); v.set(scope, (v.get(scope) || 0) + 1); scopeVotes.set(proj, v);
      if (!firstStart.has(uid) || date < firstStart.get(uid)) firstStart.set(uid, date);
    }
    // project default scope = most used scope; member start date = first logged day (so old months don't count as "missing")
    for (const [proj, v] of scopeVotes) db.prepare('UPDATE projects SET default_scope_id=? WHERE id=? AND default_scope_id IS NULL').run([...v.entries()].sort((a, b) => b[1] - a[1])[0][0], proj);
    for (const [uid, d] of firstStart) db.prepare('UPDATE users SET start_date=? WHERE id=? AND (start_date IS NULL OR start_date>?)').run(d, uid, d);
    db.exec("UPDATE users SET start_date=date('now') WHERE start_date IS NULL AND role<>'admin'"); // no history yet: count from today
    db.exec(dry ? 'ROLLBACK' : 'COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return sum;
}
