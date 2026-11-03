// Pattern learning: ranks projects / task items / descriptions for a person from their own history
// (recency-decayed, weighted by task item, weekday and description keywords), with a light team-wide
// prior so new members still get sensible suggestions. Scope is learned from the chosen project.
import { db } from './db.js';

const STOP = new Set('the a an of and or to for in on at with by from is are was were be this that it as per new'.split(' '));
export const tokens = (s) =>
  new Set(String(s || '').toLowerCase().split(/[^a-z0-9؀-ۿ]+/).filter((t) => t.length > 1 && !STOP.has(t)));

const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
const weekday = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const rank = (map, limit) => {
  const total = [...map.values()].reduce((s, v) => s + v, 0) || 1;
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id, s]) => ({ id, confidence: +(s / total).toFixed(3) }));
};
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function suggest(userId, { projectId, taskTypeId, text = '', date }) {
  date ||= new Date().toISOString().slice(0, 10);
  const mine = db.prepare(
    `SELECT project_id, task_type_id, scope_id, description, work_date, days, quantity FROM entries
     WHERE user_id=? AND work_date<=? AND work_date>=date(?, '-120 day') ORDER BY work_date DESC, id DESC LIMIT 1500`).all(userId, date, date);
  const team = db.prepare(
    `SELECT project_id, task_type_id, work_date FROM entries
     WHERE user_id<>? AND work_date<=? AND work_date>=date(?, '-14 day') LIMIT 3000`).all(userId, date, date);

  const qTok = tokens(text), wd = weekday(date);
  const projScore = new Map(), taskScore = new Map();
  const bump = (m, k, w) => m.set(k, (m.get(k) || 0) + w);
  const overlap = (d) => { if (!qTok.size) return 0; const rt = tokens(d); let h = 0; for (const t of qTok) if (rt.has(t)) h++; return h / qTok.size; };

  for (const r of mine) {
    const age = Math.max(0, dayDiff(date, r.work_date));
    let w = Math.exp(-age / 21);
    if (weekday(r.work_date) === wd) w *= 1.3;
    const o = overlap(r.description);
    bump(projScore, r.project_id, w * (taskTypeId && r.task_type_id === taskTypeId ? 2 : 1) * (1 + 3 * o));
    bump(taskScore, r.task_type_id, w * (projectId && r.project_id === projectId ? 2.5 : 1) * (1 + 2 * o));
  }
  for (const r of team) {
    const w = 0.15 * Math.exp(-Math.max(0, dayDiff(date, r.work_date)) / 7);
    bump(projScore, r.project_id, taskTypeId && r.task_type_id === taskTypeId ? w * 1.5 : w);
    bump(taskScore, r.task_type_id, projectId && r.project_id === projectId ? w * 1.5 : w);
  }

  // quick-repeat combos from the last 21 days (project + task item + description) with typical days
  const combos = new Map();
  for (const r of mine) {
    if (dayDiff(date, r.work_date) > 21) break;
    const k = `${r.project_id}|${r.task_type_id}|${r.description.trim().toLowerCase()}`;
    const c = combos.get(k) || { project_id: r.project_id, task_type_id: r.task_type_id, scope_id: r.scope_id, description: r.description.trim(), count: 0, last: r.work_date, _d: [] };
    c.count++; c._d.push(r.days); combos.set(k, c);
  }
  const quick = [...combos.values()].map(({ _d, ...c }) => ({ ...c, days: median(_d) }))
    .sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1)).slice(0, 5);

  const seen = new Set(), descriptions = [];
  for (const r of mine) {
    const d = r.description.trim();
    if (!d || seen.has(d.toLowerCase())) continue;
    if (projectId && r.project_id !== projectId) continue;
    if (taskTypeId && r.task_type_id !== taskTypeId) continue;
    seen.add(d.toLowerCase()); descriptions.push(d);
    if (descriptions.length >= 12) break;
  }

  // scope follows the project: this person's most used scope on it, else the project's default
  let scope_id = null;
  if (projectId) {
    const c = new Map();
    for (const r of mine) if (r.project_id === projectId && r.scope_id) bump(c, r.scope_id, 1);
    scope_id = [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      ?? db.prepare('SELECT default_scope_id s FROM projects WHERE id=?').get(projectId)?.s ?? null;
  }
  // typical days this person books for this exact project + task item
  let hint = null;
  if (projectId && taskTypeId) {
    const ds = mine.filter((r) => r.project_id === projectId && r.task_type_id === taskTypeId).map((r) => r.days);
    if (ds.length >= 3) hint = { days: median(ds), samples: ds.length };
  }
  return { projects: rank(projScore, 5), task_types: rank(taskScore, 5), combos: quick, descriptions, scope_id, hint };
}
