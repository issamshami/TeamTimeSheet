import { db } from './db.js';

export const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => iso(new Date(Date.parse(s) + n * 86400000));

/** Users the viewer may see analytics for. admin: everyone; leader: self + team; member: self. */
export function visibleUserIds(viewer) {
  if (viewer.role === 'admin') return db.prepare('SELECT id FROM users WHERE active=1').all().map((r) => r.id);
  if (viewer.role === 'leader')
    return db.prepare('SELECT id FROM users WHERE active=1 AND (id=? OR leader_id=?)').all(viewer.id, viewer.id).map((r) => r.id);
  return [viewer.id];
}
const inList = (ids) => ids.map(() => '?').join(',') || 'NULL';

export function overview(viewer, from, to) {
  const ids = visibleUserIds(viewer), L = inList(ids);
  const P = [...ids, from, to];
  const totals = db.prepare(
    `SELECT COALESCE(SUM(minutes),0) minutes, COALESCE(SUM(task_count),0) tasks, COUNT(*) entries, COUNT(DISTINCT user_id) people
     FROM entries WHERE user_id IN (${L}) AND work_date BETWEEN ? AND ?`).get(...P);
  const by_project = db.prepare(
    `SELECT p.id, p.name, p.code, SUM(e.minutes) minutes, SUM(e.task_count) tasks, COUNT(DISTINCT e.user_id) people
     FROM entries e JOIN projects p ON p.id=e.project_id
     WHERE e.user_id IN (${L}) AND e.work_date BETWEEN ? AND ? GROUP BY p.id ORDER BY minutes DESC`).all(...P);
  const by_person = db.prepare(
    `SELECT u.id, u.name, SUM(e.minutes) minutes, SUM(e.task_count) tasks
     FROM entries e JOIN users u ON u.id=e.user_id
     WHERE e.user_id IN (${L}) AND e.work_date BETWEEN ? AND ? GROUP BY u.id ORDER BY minutes DESC`).all(...P);
  const by_task = db.prepare(
    `SELECT t.id, t.name, SUM(e.minutes) minutes, SUM(e.task_count) tasks
     FROM entries e JOIN task_types t ON t.id=e.task_type_id
     WHERE e.user_id IN (${L}) AND e.work_date BETWEEN ? AND ? GROUP BY t.id ORDER BY minutes DESC`).all(...P);
  const by_day = db.prepare(
    `SELECT work_date date, SUM(minutes) minutes, SUM(task_count) tasks FROM entries
     WHERE user_id IN (${L}) AND work_date BETWEEN ? AND ? GROUP BY work_date ORDER BY work_date`).all(...P);
  // who is behind on logging: last entry date + minutes in range
  const people = db.prepare(
    `SELECT u.id, u.name, u.job_title, u.daily_target_min,
       (SELECT MAX(work_date) FROM entries WHERE user_id=u.id) last_entry,
       COALESCE((SELECT SUM(minutes) FROM entries WHERE user_id=u.id AND work_date BETWEEN ? AND ?),0) minutes
     FROM users u WHERE u.id IN (${L}) AND u.role<>'admin' ORDER BY u.name`).all(from, to, ...ids);
  return { totals, by_project, by_person, by_task, by_day, people };
}

/** Productivity = average minutes per unit, per task type, split by person and by project. */
export function productivity(viewer, from, to, { taskTypeId, projectId, userId } = {}) {
  let ids = visibleUserIds(viewer);
  if (userId) ids = ids.filter((i) => i === userId);
  const L = inList(ids);
  const filt = [`e.user_id IN (${L})`, 'e.work_date BETWEEN ? AND ?', 'e.task_count>0'];
  const P = [...ids, from, to];
  if (taskTypeId) { filt.push('e.task_type_id=?'); P.push(taskTypeId); }
  if (projectId) { filt.push('e.project_id=?'); P.push(projectId); }
  const where = filt.join(' AND ');
  const row = (extraSelect, join, group) => db.prepare(
    `SELECT ${extraSelect}, SUM(e.minutes) minutes, SUM(e.task_count) tasks, COUNT(*) entries,
            ROUND(1.0*SUM(e.minutes)/SUM(e.task_count),1) min_per_unit
     FROM entries e ${join} WHERE ${where} GROUP BY ${group}`).all(...P);
  const by_person_task = row('u.id user_id, u.name user, t.id task_type_id, t.name task_type, t.unit_label unit',
    'JOIN users u ON u.id=e.user_id JOIN task_types t ON t.id=e.task_type_id', 'u.id, t.id');
  const by_project_task = row('p.id project_id, p.name project, t.id task_type_id, t.name task_type, t.unit_label unit',
    'JOIN projects p ON p.id=e.project_id JOIN task_types t ON t.id=e.task_type_id', 'p.id, t.id');
  const team = row('t.id task_type_id, t.name task_type, t.unit_label unit', 'JOIN task_types t ON t.id=e.task_type_id', 't.id');
  const teamMap = Object.fromEntries(team.map((t) => [t.task_type_id, t.min_per_unit]));
  for (const r of by_person_task) {
    r.team_min_per_unit = teamMap[r.task_type_id];
    r.vs_team_pct = r.team_min_per_unit ? Math.round(((r.min_per_unit - r.team_min_per_unit) / r.team_min_per_unit) * 100) : 0;
  }
  // weekly trend for the selection
  const trend = db.prepare(
    `SELECT strftime('%Y-%W', e.work_date) wk, MIN(e.work_date) week_start,
            SUM(e.minutes) minutes, SUM(e.task_count) tasks, ROUND(1.0*SUM(e.minutes)/SUM(e.task_count),1) min_per_unit
     FROM entries e WHERE ${where} GROUP BY wk ORDER BY wk`).all(...P);
  return { team, by_person_task, by_project_task, trend };
}

/** Live value of a goal's metric for a user (last 30 days). */
export function goalLiveValue(g, today = iso(new Date())) {
  if (g.metric === 'manual') return g.current_value;
  const from = addDays(today, -30);
  const q = g.task_type_id ? ' AND task_type_id=?' : '';
  const args = g.task_type_id ? [g.user_id, from, today, g.task_type_id] : [g.user_id, from, today];
  const r = db.prepare(
    `SELECT SUM(minutes) m, SUM(task_count) c FROM entries WHERE user_id=? AND work_date BETWEEN ? AND ? AND task_count>0${q}`).get(...args);
  if (!r?.c) return null;
  return g.metric === 'avg_min' ? +(r.m / r.c).toFixed(1) : r.c;
}

/** 0..100 progress between start and target (handles lower-is-better). */
export function goalProgress(g, live) {
  if (g.status === 'achieved') return 100;
  if (live == null || g.target_value == null) return 0;
  const start = g.start_value ?? (g.metric === 'units_month' ? 0 : live);
  if (start === g.target_value) return live === g.target_value ? 100 : 0;
  const p = (live - start) / (g.target_value - start);
  return Math.max(0, Math.min(100, Math.round(p * 100)));
}
