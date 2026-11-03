// Loads the team's own workbook data (passed in at build time, never committed) into the preview database.
import { db, hashPassword, setSettings } from '../server/db.js';
import { localNow } from '../server/notifications.js';

const ALIAS = { 'meeting and coordination': 'Meetings & Coordination', 'meetings and coordination': 'Meetings & Coordination' };
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

export function seedReal(data, { password = 'demo' } = {}) {
  if (db.prepare("SELECT COUNT(*) c FROM users WHERE role<>'admin'").get().c > 0) return null;
  const pw = hashPassword(password), today = localNow('Asia/Riyadh').date;
  if (data.admin_email) { // the admin signs in with this email; weekly reports and alerts go here
    db.prepare("UPDATE users SET email=? WHERE username='admin'").run(String(data.admin_email).toLowerCase());
    setSettings({ admin_email: String(data.admin_email).toLowerCase() });
  }
  db.exec('BEGIN');
  const scopeId = (n) => { n = clean(n) || 'None'; let r = db.prepare('SELECT id FROM scopes WHERE name=?').get(n); if (!r) r = { id: Number(db.prepare('INSERT INTO scopes (name) VALUES (?)').run(n).lastInsertRowid) }; return r.id; };
  const itemId = (raw) => {
    const n = ALIAS[clean(raw).toLowerCase()] || clean(raw); if (!n) return null;
    let r = db.prepare('SELECT id FROM task_types WHERE name=?').get(n);
    if (!r) r = { id: Number(db.prepare('INSERT INTO task_types (name,unit_label,track_qty,is_leave) VALUES (?,?,?,?)').run(n, 'item', 0, /day off|leave/i.test(n) ? 1 : 0).lastInsertRowid) };
    return r.id;
  };
  const projId = (raw) => {
    const n = clean(raw); if (!n) return null;
    let r = db.prepare('SELECT id FROM projects WHERE name=?').get(n);
    if (!r) r = { id: Number(db.prepare('INSERT INTO projects (name,is_leave) VALUES (?,?)').run(n, /^day off$/i.test(n) ? 1 : 0).lastInsertRowid) };
    return r.id;
  };
  data.scopes.forEach(scopeId); data.items.forEach(itemId); data.projects.forEach(projId);

  const users = new Map(), taken = new Set(['admin']);
  const uname = (name, email) => {
    let base = email ? email.split('@')[0] : (() => { const p = name.toLowerCase().split(' '); return p.length > 1 ? `${p[0]}.${p.at(-1)[0]}` : p[0]; })();
    base = base.toLowerCase().replace(/[^a-z0-9._-]/g, ''); let u = base, i = 2; while (taken.has(u)) u = base + i++; taken.add(u); return u;
  };
  const addUser = (m) => {
    const role = data.leaders.includes(m.name) ? 'leader' : 'member';
    const id = Number(db.prepare('INSERT INTO users (name,username,email,team,pass_hash,role,job_title,start_date) VALUES (?,?,?,?,?,?,?,NULL)')
      .run(m.name, uname(m.name, m.email), m.email || '', m.team || 'BIM', pw, role, role === 'leader' ? 'Team Leader' : 'BIM Modeler').lastInsertRowid);
    users.set(m.name.toLowerCase(), id); return id;
  };
  data.members.forEach(addUser);

  const ins = db.prepare('INSERT INTO entries (user_id,work_date,task_seq,project_id,task_type_id,scope_id,days,description) VALUES (?,?,?,?,?,?,?,?)');
  const seq = new Map(), votes = new Map(), first = new Map(); let n = 0, skipped = 0;
  for (const e of data.entries) {
    const days = parseFloat(e.days), item = itemId(e.item), proj = projId(e.project), name = clean(e.member);
    if (!name || !item || !proj || !(days > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) { skipped++; continue; }
    const uid = users.get(name.toLowerCase()) ?? addUser({ name, email: '', team: 'BIM' });
    const k = `${uid}|${e.date}`; seq.set(k, (seq.get(k) || 0) + 1);
    const sc = scopeId(e.scope);
    ins.run(uid, e.date, seq.get(k), proj, item, sc, days, clean(e.desc)); n++;
    const v = votes.get(proj) || new Map(); v.set(sc, (v.get(sc) || 0) + 1); votes.set(proj, v);
    if (!first.has(uid) || e.date < first.get(uid)) first.set(uid, e.date);
  }
  // the scope most used in the history decides each project's scope
  for (const [p, v] of votes) db.prepare('UPDATE projects SET default_scope_id=? WHERE id=?').run([...v.entries()].sort((a, b) => b[1] - a[1])[0][0], p);
  for (const [u, d] of first) db.prepare('UPDATE users SET start_date=? WHERE id=?').run(d, u);
  db.prepare("UPDATE users SET start_date=? WHERE start_date IS NULL AND role<>'admin'").run(today);
  db.prepare("UPDATE projects SET default_scope_id=(SELECT id FROM scopes WHERE name='None') WHERE is_leave=1 AND default_scope_id IS NULL").run();
  db.exec('COMMIT');
  return { lines: n, skipped };
}
