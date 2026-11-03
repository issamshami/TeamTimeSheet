import { db, getSettings } from './db.js';

export const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => iso(new Date(Date.parse(s) + n * 86400000));
const hpd = () => Number(getSettings().hours_per_day) || 8;
export const round = (n, d = 2) => (n == null ? n : +Number(n).toFixed(d));

/** Users the viewer may see analytics for. admin: everyone; leader: self + team; member: self. */
export function visibleUserIds(viewer) {
  if (viewer.role === 'admin') return db.prepare('SELECT id FROM users WHERE active=1').all().map((r) => r.id);
  if (viewer.role === 'leader')
    return db.prepare('SELECT id FROM users WHERE active=1 AND (id=? OR leader_id=?)').all(viewer.id, viewer.id).map((r) => r.id);
  return [viewer.id];
}
const inList = (ids) => ids.map(() => '?').join(',') || 'NULL';

export const leaderProjectIds = (uid) => db.prepare('SELECT project_id FROM project_leaders WHERE user_id=?').all(uid).map((r) => r.project_id);
/**
 * Which timesheet lines a viewer may analyse. admin: all; leader: every line on the projects assigned to them
 * (whoever logged it); member: their own lines. Career data (goals, notes) is NOT governed by this — see visibleUserIds.
 */
export function entryScope(viewer, a = 'e') {
  if (viewer.role === 'admin') return { sql: '1=1', params: [] };
  // leader: their own lines + every line on the projects they lead
  if (viewer.role === 'leader') { const p = leaderProjectIds(viewer.id); return { sql: `(${a}.project_id IN (${inList(p)}) OR ${a}.user_id=?)`, params: [...p, viewer.id] }; }
  return { sql: `${a}.user_id=?`, params: [viewer.id] };
}
/** People a viewer follows up on: admin → everyone; leader → direct reports + anyone who logged on their projects in the period. */
export function peopleInScope(viewer, from, to, projectId) {
  if (viewer.role === 'admin' && !projectId) return visibleUserIds(viewer);
  if (viewer.role === 'member') return [viewer.id];
  const sc = entryScope(viewer), P = [...sc.params, from, to];
  let q = `SELECT DISTINCT e.user_id id FROM entries e WHERE ${sc.sql} AND e.work_date BETWEEN ? AND ?`;
  if (projectId) { q += ' AND e.project_id=?'; P.push(projectId); }
  const ids = new Set(db.prepare(q).all(...P).map((r) => r.id));
  if (viewer.role === 'leader' && !projectId) visibleUserIds(viewer).forEach((i) => ids.add(i));
  if (viewer.role === 'leader') ids.add(viewer.id);
  return [...ids];
}

/** Calendar dates in [from,to] whose weekday (0=Sun) is in `workdays`. */
export function workdaysBetween(from, to, workdays) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (workdays.includes(new Date(d + 'T12:00:00Z').getUTCDay())) out.push(d);
  return out;
}

/**
 * Who has not completed their timesheet? A workday is complete when the person's lines add up to >= 0.99 day
 * (a "Day Off" line counts like any other). Used by the dashboard, the daily reminder and the weekly report.
 */
export function compliance(userIds, from, to, settings = getSettings()) {
  const workdays = settings.workdays.split(',').filter(Boolean).map(Number);
  const days = workdaysBetween(from, to, workdays);
  const users = db.prepare(`SELECT id,name,email,team,start_date FROM users WHERE active=1 AND role<>'admin' AND id IN (${inList(userIds)}) ORDER BY name`).all(...userIds);
  const sums = db.prepare(`SELECT user_id, work_date, ROUND(SUM(days),3) d FROM entries WHERE user_id IN (${inList(userIds)}) AND work_date BETWEEN ? AND ? GROUP BY user_id, work_date`).all(...userIds, from, to);
  const map = new Map(sums.map((r) => [`${r.user_id}|${r.work_date}`, r.d]));
  return users.map((u) => {
    const mine = days.filter((d) => !u.start_date || d >= u.start_date);
    const missing = [], partial = [];
    for (const d of mine) {
      const v = map.get(`${u.id}|${d}`) || 0;
      if (v === 0) missing.push(d); else if (v < 0.99) partial.push({ date: d, days: v });
    }
    return { id: u.id, name: u.name, email: u.email, expected: mine.length, complete: mine.length - missing.length - partial.length, missing, partial };
  });
}

export function overview(viewer, from, to, { projectId } = {}) {
  const sc = entryScope(viewer), P = [...sc.params, from, to];
  let base = `${sc.sql} AND e.work_date BETWEEN ? AND ?`;
  if (projectId) { base += ' AND e.project_id=?'; P.push(projectId); }
  const ids = peopleInScope(viewer, from, to, projectId), L = inList(ids);
  const totals = db.prepare(
    `SELECT ROUND(COALESCE(SUM(CASE WHEN p.is_leave=0 THEN e.days END),0),2) days, ROUND(COALESCE(SUM(CASE WHEN p.is_leave=1 THEN e.days END),0),2) leave_days,
            COUNT(*) entries, COUNT(DISTINCT e.user_id) people
     FROM entries e JOIN projects p ON p.id=e.project_id WHERE ${base}`).get(...P);
  const group = (select, join, groupBy, extra = '') => db.prepare(
    `SELECT ${select}, ROUND(SUM(e.days),2) days, COUNT(*) entries FROM entries e JOIN projects p ON p.id=e.project_id ${join}
     WHERE ${base} AND p.is_leave=0 ${extra} GROUP BY ${groupBy} ORDER BY days DESC`).all(...P);
  const by_project = group('p.id, p.name', '', 'p.id');
  const by_person = group('u.id, u.name', 'JOIN users u ON u.id=e.user_id', 'u.id');
  const by_task = group('t.id, t.name', 'JOIN task_types t ON t.id=e.task_type_id', 't.id');
  const by_scope = group("COALESCE(s.name,'—') name", 'LEFT JOIN scopes s ON s.id=e.scope_id', 's.id');
  const matrix = group('u.id user_id, u.name user, t.id task_type_id, t.name task_type', 'JOIN users u ON u.id=e.user_id JOIN task_types t ON t.id=e.task_type_id', 'u.id, t.id');
  const by_day = db.prepare(`SELECT work_date date, ROUND(SUM(days),2) days FROM entries e WHERE ${base} GROUP BY work_date ORDER BY work_date`).all(...P);
  const settings = getSettings();
  const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone }).format(new Date());
  const compTo = to >= localToday ? addDays(localToday, -1) : to; // today is still being filled in
  const comp = from <= compTo ? compliance(ids, from, compTo, settings) : compliance(ids, from, from, settings).map((c) => ({ ...c, expected: 0, complete: 0, missing: [], partial: [] }));
  const lastEntry = db.prepare(`SELECT user_id, MAX(work_date) d FROM entries WHERE user_id IN (${L}) GROUP BY user_id`).all(...ids);
  const lm = new Map(lastEntry.map((r) => [r.user_id, r.d]));
  const people = comp.map((c) => ({ ...c, last_entry: lm.get(c.id) || null }));
  return { totals, by_project, by_person, by_task, by_scope, matrix, by_day, people, workdays: settings.workdays };
}

/** Speed = hours per unit (days × hours/day ÷ quantity), only for lines where a quantity was entered. */
export function productivity(viewer, from, to, { taskTypeId, projectId, userId } = {}) {
  const sc = entryScope(viewer), H = hpd();
  const filt = [sc.sql, 'e.work_date BETWEEN ? AND ?', 'e.quantity>0'];
  const P = [...sc.params, from, to];
  if (userId) { filt.push('e.user_id=?'); P.push(userId); }
  if (taskTypeId) { filt.push('e.task_type_id=?'); P.push(taskTypeId); }
  if (projectId) { filt.push('e.project_id=?'); P.push(projectId); }
  const where = filt.join(' AND ');
  const row = (sel, join, group) => db.prepare(
    `SELECT ${sel}, ROUND(SUM(e.days),2) days, SUM(e.quantity) units, COUNT(*) entries,
            ROUND(1.0*SUM(e.days)*${H}/SUM(e.quantity),2) hrs_per_unit
     FROM entries e ${join} WHERE ${where} GROUP BY ${group}`).all(...P);
  const by_person_task = row('u.id user_id, u.name user, t.id task_type_id, t.name task_type, t.unit_label unit',
    'JOIN users u ON u.id=e.user_id JOIN task_types t ON t.id=e.task_type_id', 'u.id, t.id');
  const by_project_task = row('p.id project_id, p.name project, t.id task_type_id, t.name task_type, t.unit_label unit',
    'JOIN projects p ON p.id=e.project_id JOIN task_types t ON t.id=e.task_type_id', 'p.id, t.id');
  const team = row('t.id task_type_id, t.name task_type, t.unit_label unit', 'JOIN task_types t ON t.id=e.task_type_id', 't.id');
  const teamMap = Object.fromEntries(team.map((t) => [t.task_type_id, t.hrs_per_unit]));
  for (const r of by_person_task) {
    r.team_hrs_per_unit = teamMap[r.task_type_id];
    r.vs_team_pct = r.team_hrs_per_unit ? Math.round(((r.hrs_per_unit - r.team_hrs_per_unit) / r.team_hrs_per_unit) * 100) : 0;
  }
  const trend = db.prepare(
    `SELECT strftime('%Y-%W', e.work_date) wk, MIN(e.work_date) week_start, ROUND(SUM(e.days),2) days, SUM(e.quantity) units,
            ROUND(1.0*SUM(e.days)*${H}/SUM(e.quantity),2) hrs_per_unit
     FROM entries e WHERE ${where} GROUP BY wk ORDER BY wk`).all(...P);
  return { team, by_person_task, by_project_task, trend, hours_per_day: H };
}

/** Live value of a goal's metric for a user (last 30 days). */
export function goalLiveValue(g, today = iso(new Date())) {
  if (g.metric === 'manual') return g.current_value;
  const from = addDays(today, -30), H = hpd();
  const q = g.task_type_id ? ' AND task_type_id=?' : '';
  const args = g.task_type_id ? [g.user_id, from, today, g.task_type_id] : [g.user_id, from, today];
  const r = db.prepare(`SELECT SUM(days) d, SUM(quantity) q FROM entries WHERE user_id=? AND work_date BETWEEN ? AND ? AND quantity>0${q}`).get(...args);
  if (!r?.q) return null;
  return g.metric === 'avg_hrs' ? round((r.d * H) / r.q, 2) : r.q;
}

/** 0..100 progress between start and target (handles lower-is-better). */
export function goalProgress(g, live) {
  if (g.status === 'achieved') return 100;
  if (live == null || g.target_value == null) return 0;
  const start = g.start_value ?? (g.metric === 'units_month' ? 0 : live);
  if (start === g.target_value) return live === g.target_value ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round(((live - start) / (g.target_value - start)) * 100)));
}

/**
 * One person's work profile over [from,to]: what they spend time on, how long a task line takes them vs the team,
 * speed per unit where quantities were entered, and how complete their timesheet is.
 */
export function careerStats(uid, from, to) {
  const H = hpd();
  const per_task = db.prepare(`SELECT t.id task_type_id, t.name task_type, t.unit_label unit, COUNT(*) lines, ROUND(SUM(e.days),2) days,
      ROUND(AVG(e.days),3) avg_days, SUM(e.quantity) units, ROUND(SUM(CASE WHEN e.quantity>0 THEN e.days END)*${H}/NULLIF(SUM(CASE WHEN e.quantity>0 THEN e.quantity END),0),2) hrs_per_unit
    FROM entries e JOIN task_types t ON t.id=e.task_type_id WHERE e.user_id=? AND e.work_date BETWEEN ? AND ? AND t.is_leave=0
    GROUP BY t.id ORDER BY days DESC`).all(uid, from, to);
  const team = Object.fromEntries(db.prepare(`SELECT e.task_type_id id, ROUND(AVG(e.days),3) avg_days,
      ROUND(SUM(CASE WHEN e.quantity>0 THEN e.days END)*${H}/NULLIF(SUM(CASE WHEN e.quantity>0 THEN e.quantity END),0),2) hrs_per_unit
    FROM entries e WHERE e.work_date BETWEEN ? AND ? GROUP BY e.task_type_id`).all(from, to).map((r) => [r.id, r]));
  const total = per_task.reduce((s, r) => s + r.days, 0) || 1;
  for (const r of per_task) {
    r.share = Math.round((r.days / total) * 100);
    r.avg_hours = round(r.avg_days * H, 1);
    r.team_avg_hours = team[r.task_type_id] ? round(team[r.task_type_id].avg_days * H, 1) : null;
    r.team_hrs_per_unit = team[r.task_type_id]?.hrs_per_unit ?? null;
  }
  const top_projects = db.prepare(`SELECT p.id, p.name, ROUND(SUM(e.days),2) days FROM entries e JOIN projects p ON p.id=e.project_id
    WHERE e.user_id=? AND e.work_date BETWEEN ? AND ? AND p.is_leave=0 GROUP BY p.id ORDER BY days DESC LIMIT 6`).all(uid, from, to);
  const settings = getSettings();
  const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone }).format(new Date());
  const compTo = to >= localToday ? addDays(localToday, -1) : to;
  const c = from <= compTo ? compliance([uid], from, compTo, settings)[0] : null;
  const totals = db.prepare(`SELECT ROUND(COALESCE(SUM(CASE WHEN p.is_leave=0 THEN e.days END),0),2) days, ROUND(COALESCE(SUM(CASE WHEN p.is_leave=1 THEN e.days END),0),2) leave_days,
      COALESCE(SUM(e.quantity),0) units, COUNT(DISTINCT CASE WHEN p.is_leave=0 THEN e.project_id END) projects
    FROM entries e JOIN projects p ON p.id=e.project_id WHERE e.user_id=? AND e.work_date BETWEEN ? AND ?`).get(uid, from, to);
  return { from, to, per_task, top_projects, totals,
    completeness: c && c.expected ? { expected: c.expected, complete: c.complete, missing: c.missing.length, partial: c.partial.length, pct: Math.round((c.complete / c.expected) * 100) } : null };
}
