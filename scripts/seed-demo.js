// Fills a database with fake people, projects and ~10 weeks of timesheets.
// Usage: DB_PATH=data/demo.db npm run seed:demo   (never run against real data)
import { db, hashPassword, seedIfEmpty } from '../server/db.js';
import { addDays, iso } from '../server/analytics.js';

seedIfEmpty();
if (db.prepare("SELECT COUNT(*) c FROM users WHERE role<>'admin'").get().c > 0) { console.log('Database already has users — aborting.'); process.exit(1); }

let seed = 42; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const levels = db.prepare('SELECT id,rank FROM levels ORDER BY rank').all();
const tasks = db.prepare('SELECT id,name FROM task_types').all();
const T = Object.fromEntries(tasks.map((t) => [t.name, t.id]));
const pw = hashPassword('demo123');

const projects = ['Tower A – Podium', 'Tower B – Façade', 'Riverside Mall', 'Airport Terminal 2', 'Hospital Wing C', 'Villa Compound 14'];
const pid = projects.map((n, i) => Number(db.prepare('INSERT INTO projects (code,name) VALUES (?,?)').run('P' + (100 + i), n).lastInsertRowid));

const leader = Number(db.prepare("INSERT INTO users (name,username,pass_hash,role,job_title,level_id,start_date) VALUES ('Sara Haddad','sara',?,'leader','Team Leader',?,date('now','-900 day'))").run(pw, levels[4].id).lastInsertRowid);
// speed = multiplier on minutes per unit (lower = faster); focus = favourite projects
const people = [
  ['Omar Khalil', 'omar', 2, 0.85, [0, 1]], ['Lina Farah', 'lina', 1, 1.1, [2, 3]], ['Yusuf Nasser', 'yusuf', 3, 0.75, [3, 4]],
  ['Mona Saleh', 'mona', 0, 1.5, [0, 5]], ['Karim Aziz', 'karim', 2, 1.0, [1, 2, 4]],
];
const base = { 'Shop Drawing': 90, 'Revision': 35, 'Markup / Redline': 20, 'Coordination': 40, 'Review / QC': 25 };
const today = iso(new Date());
for (const [name, username, lvl, speed, focus] of people) {
  const uid = Number(db.prepare("INSERT INTO users (name,username,pass_hash,role,leader_id,job_title,level_id,start_date) VALUES (?,?,?,?,?,?,?,date('now','-400 day'))")
    .run(name, username, pw, 'member', leader, 'Drafter', levels[lvl].id).lastInsertRowid);
  db.prepare("INSERT INTO level_history (user_id,level_id,from_date,note) VALUES (?,?,date('now','-400 day'),'Joined')").run(uid, levels[lvl].id);
  for (let d = 70; d >= 0; d--) {
    const day = addDays(today, -d), dow = new Date(day).getUTCDay();
    if (dow === 5 || dow === 6) continue; // Fri/Sat weekend
    if (rnd() < 0.06) continue;
    let left = 450 + Math.floor(rnd() * 60);
    // people get faster over time (learning curve)
    const learn = 1 + (d / 70) * 0.25;
    while (left > 30) {
      const project = rnd() < 0.8 ? pid[pick(focus)] : pick(pid);
      const tname = pick(['Shop Drawing', 'Shop Drawing', 'Shop Drawing', 'Revision', 'Revision', 'Markup / Redline', 'Coordination', 'Review / QC', 'Meeting']);
      if (tname === 'Meeting') { const m = pick([30, 45, 60]); db.prepare('INSERT INTO entries (user_id,work_date,project_id,task_type_id,task_count,minutes,description) VALUES (?,?,?,?,?,?,?)').run(uid, day, project, T[tname], 1, m, 'Weekly coordination meeting'); left -= m; continue; }
      const per = base[tname] * speed * learn * (0.8 + rnd() * 0.4);
      const count = 1 + Math.floor(rnd() * 4);
      const minutes = Math.min(left, Math.max(15, Math.round(per * count / 5) * 5));
      const desc = pick(['Level ' + (1 + Math.floor(rnd() * 12)) + ' slab', 'Stair core ' + pick(['A', 'B', 'C']), 'Beam layout grid ' + pick(['1-4', '5-8', 'C-F']), 'Curtain wall details', 'Rebar schedule', 'Column schedule']);
      db.prepare('INSERT INTO entries (user_id,work_date,project_id,task_type_id,task_count,minutes,description) VALUES (?,?,?,?,?,?,?)').run(uid, day, project, T[tname], count, minutes, desc);
      left -= minutes;
    }
  }
  db.prepare("INSERT INTO goals (user_id,title,metric,task_type_id,start_value,target_value,unit,due_date,created_by) VALUES (?,?,?,?,?,?,?,date('now','+60 day'),1)")
    .run(uid, 'Cut average shop-drawing time', 'avg_min', T['Shop Drawing'], Math.round(base['Shop Drawing'] * speed * 1.2), Math.round(base['Shop Drawing'] * speed * 0.9), 'min/drawing');
  db.prepare("INSERT INTO goals (user_id,title,metric,start_value,target_value,current_value,unit,due_date,created_by) VALUES (?,?,?,?,?,?,?,date('now','+90 day'),1)")
    .run(uid, 'Complete Revit certification', 'manual', 0, 100, 35, '%');
  db.prepare("INSERT INTO notes (user_id,author_id,kind,body,shared) VALUES (?,1,'feedback','Strong progress on accuracy this month. Next focus: speed on repetitive drawings.',1)").run(uid);
}
console.log('Demo data created. Logins: admin (see first-run password), sara / omar / lina / … with password demo123');
