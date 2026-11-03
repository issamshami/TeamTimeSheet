// Pattern learning: ranks projects / tasks / descriptions for a person from their own history
// (recency-decayed, weighted by task type, weekday and description keywords), with a light
// team-wide prior so brand-new members still get sensible suggestions.
import { db } from './db.js';

const STOP = new Set('the a an of and or to for in on at with by from is are was were be this that it as per new'.split(' '));
export const tokens = (s) =>
  new Set(String(s || '').toLowerCase().split(/[^a-z0-9؀-ۿ]+/).filter((t) => t.length > 1 && !STOP.has(t)));

const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
const weekday = (d) => new Date(d + 'T00:00:00Z').getUTCDay();

function rank(map, limit) {
  const total = [...map.values()].reduce((s, v) => s + v, 0) || 1;
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([id, s]) => ({ id, confidence: +(s / total).toFixed(3) }));
}

export function suggest(userId, { projectId, taskTypeId, text = '', date }) {
  date ||= new Date().toISOString().slice(0, 10);
  const mine = db.prepare(
    `SELECT project_id, task_type_id, description, work_date, task_count, minutes FROM entries
     WHERE user_id=? AND work_date<=? AND work_date>=date(?, '-120 day') ORDER BY work_date DESC, id DESC LIMIT 1000`
  ).all(userId, date, date);
  const team = db.prepare(
    `SELECT project_id, task_type_id, work_date FROM entries
     WHERE user_id<>? AND work_date<=? AND work_date>=date(?, '-14 day') LIMIT 2000`
  ).all(userId, date, date);

  const qTok = tokens(text);
  const wd = weekday(date);
  const projScore = new Map(), taskScore = new Map();
  const bump = (m, k, w) => m.set(k, (m.get(k) || 0) + w);

  for (const r of mine) {
    const age = Math.max(0, dayDiff(date, r.work_date));
    let w = Math.exp(-age / 21);
    if (weekday(r.work_date) === wd) w *= 1.3;
    // projects: boosted when the same task type / matching words were used with it
    let pw = w;
    if (taskTypeId && r.task_type_id === taskTypeId) pw *= 2;
    if (qTok.size) {
      const rt = tokens(r.description);
      let hit = 0; for (const t of qTok) if (rt.has(t)) hit++;
      pw *= 1 + (3 * hit) / qTok.size;
    }
    bump(projScore, r.project_id, pw);
    // tasks: boosted when used with the chosen project
    let tw = w;
    if (projectId && r.project_id === projectId) tw *= 2.5;
    if (qTok.size) {
      const rt = tokens(r.description);
      let hit = 0; for (const t of qTok) if (rt.has(t)) hit++;
      tw *= 1 + (2 * hit) / qTok.size;
    }
    bump(taskScore, r.task_type_id, tw);
  }
  for (const r of team) {
    const age = Math.max(0, dayDiff(date, r.work_date));
    const w = 0.15 * Math.exp(-age / 7);
    bump(projScore, r.project_id, taskTypeId && r.task_type_id === taskTypeId ? w * 1.5 : w);
    bump(taskScore, r.task_type_id, projectId && r.project_id === projectId ? w * 1.5 : w);
  }

  // quick-repeat combos: distinct (project, task, description) in the last 21 days
  const combos = new Map();
  for (const r of mine) {
    if (dayDiff(date, r.work_date) > 21) break;
    const k = `${r.project_id}|${r.task_type_id}|${r.description.trim().toLowerCase()}`;
    const c = combos.get(k) || { project_id: r.project_id, task_type_id: r.task_type_id, description: r.description.trim(), count: 0, last: r.work_date, avgCount: 0 };
    c.count++; c.avgCount += r.task_count; combos.set(k, c);
  }
  const quick = [...combos.values()]
    .map((c) => ({ ...c, avgCount: Math.max(1, Math.round(c.avgCount / c.count)) }))
    .sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1)).slice(0, 5);

  // descriptions for autocomplete (project/task filtered when chosen)
  const seen = new Set(), descriptions = [];
  for (const r of mine) {
    const d = r.description.trim();
    if (!d || seen.has(d.toLowerCase())) continue;
    if (projectId && r.project_id !== projectId) continue;
    if (taskTypeId && r.task_type_id !== taskTypeId) continue;
    seen.add(d.toLowerCase()); descriptions.push(d);
    if (descriptions.length >= 12) break;
  }

  // personal speed for this exact combo -> duration hint (minutes per unit)
  let hint = null;
  if (projectId && taskTypeId) {
    const h = db.prepare(
      `SELECT SUM(minutes) m, SUM(task_count) c, COUNT(*) n FROM entries
       WHERE user_id=? AND project_id=? AND task_type_id=? AND task_count>0 AND work_date>=date(?, '-120 day')`
    ).get(userId, projectId, taskTypeId, date);
    if (h?.c > 0 && h.n >= 2) hint = { minutes_per_unit: Math.round(h.m / h.c), samples: h.n, scope: 'project' };
  }
  if (!hint && taskTypeId) {
    const h = db.prepare(
      `SELECT SUM(minutes) m, SUM(task_count) c, COUNT(*) n FROM entries
       WHERE user_id=? AND task_type_id=? AND task_count>0 AND work_date>=date(?, '-120 day')`
    ).get(userId, taskTypeId, date);
    if (h?.c > 0 && h.n >= 3) hint = { minutes_per_unit: Math.round(h.m / h.c), samples: h.n, scope: 'task' };
  }

  return { projects: rank(projScore, 5), task_types: rank(taskScore, 5), combos: quick, descriptions, hint };
}
