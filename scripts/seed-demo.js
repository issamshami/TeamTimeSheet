// Fills a database with fake people and ~10 weeks of timesheets (incl. quantities, so Speed has data).
// Usage: DB_PATH=data/demo.db ADMIN_PASSWORD=admin123 npm run seed:demo   (never run against real data)
import { db, hashPassword, seedIfEmpty } from '../server/db.js';
import { addDays, iso } from '../server/analytics.js';

seedIfEmpty();
if (db.prepare("SELECT COUNT(*) c FROM users WHERE role<>'admin'").get().c > 0) { console.log('Database already has users — aborting.'); process.exit(1); }
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const T = Object.fromEntries(db.prepare('SELECT id,name FROM task_types').all().map((t) => [t.name, t.id]));
const S = Object.fromEntries(db.prepare('SELECT id,name FROM scopes').all().map((s) => [s.name, s.id]));
const levels = db.prepare('SELECT id FROM levels ORDER BY rank').all();
const mk = (n, d, sc) => Number(db.prepare('INSERT INTO projects (name,default_scope_id) VALUES (?,?)').run(n, S[sc]).lastInsertRowid);
const projects = [mk('RDOH', 0, 'Stone'), mk('MOE', 0, 'Stone'), mk('Faena', 0, 'Fit Out'), mk('EVN Hotel', 0, 'Fit Out'), mk('OGR Amala', 0, 'Stone')];
const pw = hashPassword('demo123');
// speed = hours per sheet multiplier (lower = faster)
const people = [['Omar Demo', 'omar', 0.8, [0, 1]], ['Lina Demo', 'lina', 1.0, [2, 3]], ['Yusuf Demo', 'yusuf', 0.7, [0, 4]], ['Mona Demo', 'mona', 1.5, [1, 2]]];
const today = iso(new Date());
for (const [name, username, speed, focus] of people) {
  const uid = Number(db.prepare("INSERT INTO users (name,username,email,team,pass_hash,role,job_title,level_id,start_date) VALUES (?,?,?,?,?,'member','BIM Modeler',?,date('now','-80 day'))")
    .run(name, username, `${username}@example.test`, 'BIM', pw, levels[2].id).lastInsertRowid);
  for (let d = 70; d >= 0; d--) {
    const day = addDays(today, -d), dow = new Date(day + 'T12:00:00Z').getUTCDay();
    if (dow === 5 || dow === 6 || (d < 3 && rnd() < 0.5)) continue; // weekends; recent days sometimes still missing
    let left = 1, seq = 1;
    while (left > 0.01) {
      const days = Math.min(left, pick([0.25, 0.5, 0.5, 1]));
      const proj = rnd() < 0.85 ? projects[pick(focus)] : pick(projects);
      const item = pick(['Shop Drawings', 'Shop Drawings', 'Shop Drawings', 'Project Modeling', 'Project Modeling', 'Meetings & Coordination', 'BIM Support']);
      const scope = db.prepare('SELECT default_scope_id s FROM projects WHERE id=?').get(proj).s;
      const qty = item === 'Shop Drawings' ? Math.max(1, Math.round((days * 8) / (1.6 * speed * (1 + d / 300) * (0.8 + rnd() * 0.4)))) : null;
      db.prepare('INSERT INTO entries (user_id,work_date,task_seq,project_id,task_type_id,scope_id,days,quantity,description) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(uid, day, seq++, proj, T[item], scope, +days.toFixed(2), qty, pick(['Level 3 facade', 'South elevation sheets', 'Stair core B', 'Curtain wall details', 'Coordination model update']));
      left = +(left - days).toFixed(2);
    }
  }
  db.prepare("INSERT INTO goals (user_id,title,metric,task_type_id,start_value,target_value,unit,due_date,created_by) VALUES (?,?,?,?,?,?,?,date('now','+60 day'),1)")
    .run(uid, 'Cut hours per shop-drawing sheet', 'avg_hrs', T['Shop Drawings'], +(1.6 * speed * 1.2).toFixed(1), +(1.6 * speed * 0.9).toFixed(1), 'hrs/sheet');
}
console.log('Demo data created. Logins: admin, and omar / lina / yusuf / mona with password demo123');
