// Fictional sample data for demos and the browser preview (never run against real data).
import { db, hashPassword, setSettings } from './db.js';
import { addDays } from './analytics.js';
import { localNow, sendReminders, sendWeeklyReport } from './notifications.js';

export async function seedDemo({ password = 'demo' } = {}) {
  if (db.prepare("SELECT COUNT(*) c FROM users WHERE role<>'admin'").get().c > 0) return false;
  let seed = 20261103; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const today = localNow('Asia/Riyadh').date;
  const T = Object.fromEntries(db.prepare('SELECT id,name FROM task_types').all().map((t) => [t.name, t.id]));
  const S = Object.fromEntries(db.prepare('SELECT id,name FROM scopes').all().map((s) => [s.name, s.id]));
  const L = db.prepare('SELECT id FROM levels ORDER BY rank').all().map((l) => l.id);
  const pw = hashPassword(password);
  setSettings({ admin_email: 'admin@example.com' });
  db.prepare("UPDATE users SET name='Admin', email='admin@example.com' WHERE username='admin'").run();

  const proj = (name, scope) => Number(db.prepare('INSERT INTO projects (name,default_scope_id) VALUES (?,?)').run(name, S[scope]).lastInsertRowid);
  const P = { tower: proj('Tower A – Podium', 'Stone'), airport: proj('Airport T2 Facade', 'Stone'), mall: proj('Riverside Mall', 'Fit Out'),
    hospital: proj('Hospital Wing C', 'Fit Out'), villas: proj('Villa Compound 14', 'Landscape') };
  const general = db.prepare("SELECT id FROM projects WHERE name='General'").get().id;
  const dayOffP = db.prepare('SELECT id FROM projects WHERE is_leave=1').get().id;

  const user = (name, username, role, level, title, leader = null, startAgo = 400) => {
    const id = Number(db.prepare("INSERT INTO users (name,username,email,team,pass_hash,role,leader_id,job_title,level_id,start_date) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(name, username, `${username}@example.com`, 'BIM', pw, role, leader, title, L[level], addDays(today, -startAgo)).lastInsertRowid);
    db.prepare('INSERT INTO level_history (user_id,level_id,from_date,note) VALUES (?,?,?,?)').run(id, L[level], addDays(today, -startAgo), 'Joined');
    return id;
  };
  const rania = user('Rania Haddad', 'rania', 'leader', 4, 'BIM Coordinator');
  const tariq = user('Tariq Nasser', 'tariq', 'leader', 3, 'Senior BIM Modeler');
  // name, username, level, speed (hours/sheet multiplier: lower = faster), favourite projects, leader, quirks
  const team = [
    ['Omar Saleh', 'omar', 2, 0.85, [P.tower, P.airport], rania, {}],
    ['Lina Aziz', 'lina', 1, 1.15, [P.tower, P.villas], rania, { partial: true }],
    ['Yusuf Karim', 'yusuf', 3, 0.7, [P.airport, P.hospital], rania, {}],
    ['Mona Fares', 'mona', 0, 1.5, [P.mall, P.hospital], tariq, { missing: true }],
    ['Sami Darwish', 'sami', 2, 1.0, [P.mall, P.villas], tariq, {}],
    ['Huda Mansour', 'huda', 1, 1.25, [P.hospital, P.mall], tariq, { newJoiner: true }],
  ];
  for (const [pid, uid] of [[P.tower, rania], [P.airport, rania], [P.mall, tariq], [P.hospital, tariq]]) db.prepare('INSERT INTO project_leaders (project_id,user_id) VALUES (?,?)').run(pid, uid);

  const ins = db.prepare('INSERT INTO entries (user_id,work_date,task_seq,project_id,task_type_id,scope_id,days,quantity,description) VALUES (?,?,?,?,?,?,?,?,?)');
  const scopeOf = (pid) => db.prepare('SELECT default_scope_id s FROM projects WHERE id=?').get(pid).s;
  const DESC = { 'Shop Drawings': ['South elevation stone sheets', 'Level 3 slab edge details', 'Stair core B sections', 'Curtain wall anchor layout', 'Ceiling RCP sheets'],
    'Project Modeling': ['Facade stone modeling', 'Joint alignment check', 'Podium cladding model', 'MEP clash fixes in model'],
    'Meetings & Coordination': ['Weekly coordination meeting', 'Client model review', 'Site team clash session'],
    'BIM Support': ['ACC folder setup', 'Linked models cleanup'], 'Project Review': ['QC review of issued sheets'], 'RFI': ['RFI on anchor spacing'], 'Training': ['Dynamo basics session'] };
  const workers = [[rania, [P.tower, P.airport], 0.9, {}], [tariq, [P.mall, P.hospital], 1.0, {}], ...team.map(([, , , sp, fav, , q], i) => [null, fav, sp, q, i])];
  // create team members first
  const ids = team.map(([name, username, lvl, , , leader, q]) => user(name, username, 'member', lvl, 'BIM Modeler', leader, q.newJoiner ? 24 : 400));
  workers.forEach((w, i) => { if (w[0] === null) w[0] = ids[w[4]]; });

  for (const [uid, fav, speed, q] of workers) {
    for (let d = 72; d >= 0; d--) {
      const day = addDays(today, -d), dow = new Date(day + 'T12:00:00Z').getUTCDay();
      if (q.newJoiner && d > 23) continue;
      if (dow === 5 || dow === 6) continue;                        // Fri/Sat weekend
      if (d === 0 && rnd() < 0.6) continue;                         // today: many still to fill
      if (q.missing && [1, 2, 6, 9].includes(d)) continue;          // a few forgotten days
      if (rnd() < 0.04) { ins.run(uid, day, 1, dayOffP, T['Day Off'], S.None, 1, null, 'Annual leave'); continue; }
      let left = q.partial && [1, 3].includes(d) ? 0.5 : 1, seq = 1;
      while (left > 0.01) {
        const item = pick(['Shop Drawings', 'Shop Drawings', 'Shop Drawings', 'Project Modeling', 'Project Modeling', 'Meetings & Coordination', 'BIM Support', 'Project Review', 'RFI', 'Training']);
        const days = Math.min(left, item === 'Meetings & Coordination' ? 0.25 : pick([0.25, 0.5, 0.5, 0.75, 1]));
        const pid = item === 'Training' ? general : rnd() < 0.85 ? pick(fav) : pick(Object.values(P));
        const learn = 1 + (d / 72) * 0.25; // everyone gets a bit faster over time
        const qty = item === 'Shop Drawings' ? Math.max(1, Math.round((days * 8) / (1.6 * speed * learn * (0.8 + rnd() * 0.4)))) : item === 'RFI' ? 1 + Math.floor(rnd() * 2) : null;
        ins.run(uid, day, seq++, pid, T[item], scopeOf(pid), +days.toFixed(2), qty, pick(DESC[item]));
        left = +(left - days).toFixed(2);
      }
    }
  }
  // career data
  const goal = db.prepare("INSERT INTO goals (user_id,title,description,metric,task_type_id,start_value,target_value,current_value,unit,due_date,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,1)");
  ids.forEach((uid, i) => {
    const sp = team[i][3];
    goal.run(uid, 'Faster shop-drawing sheets', 'Reuse sheet templates and view templates.', 'avg_hrs', T['Shop Drawings'], +(1.6 * sp * 1.25).toFixed(1), +(1.6 * sp * 0.9).toFixed(1), null, 'hrs/sheet', addDays(today, 60));
    goal.run(uid, 'Revit Professional certification', '', 'manual', null, 0, 100, [35, 60, 80, 10, 50, 0][i], '%', addDays(today, 90));
  });
  const note = db.prepare("INSERT INTO notes (user_id,author_id,kind,body,shared,created_at) VALUES (?,?,?,?,?,datetime('now',?))");
  note.run(ids[0], 1, 'feedback', 'Very clean sheet sets on Tower A. Next step: lead the coordination meetings for the podium.', 1, '-12 day');
  note.run(ids[0], 1, 'note', 'Ready for Senior BIM Modeler in Q1 if he keeps this pace.', 0, '-3 day');
  note.run(ids[3], tariq, 'feedback', 'Please log time daily. Several days were missing this month.', 1, '-5 day');
  note.run(ids[2], 1, 'milestone', 'Moved to Senior BIM Modeler', 1, '-60 day');
  db.prepare("INSERT INTO project_proposals (name,scope_id,note,proposed_by,created_at) VALUES ('Expo Pavilion Landscape',?,?,?,datetime('now','-1 day'))").run(S.Landscape, 'Tender stage, landscape BIM for 3 plazas', tariq);
  db.prepare("INSERT INTO project_proposals (name,scope_id,note,proposed_by,status,decided_by,decided_at,reason,project_id,created_at) VALUES ('Airport T2 Facade',?,?,?, 'approved',1,datetime('now','-40 day'),'Go ahead',?,datetime('now','-41 day'))").run(S.Stone, 'Stone facade package', rania, P.airport);
  // a few emails in the log so the Emails tab shows what goes out
  await sendReminders(addDays(today, -1));
  await sendWeeklyReport(today);
  return true;
}
