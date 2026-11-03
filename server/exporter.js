// Export timesheet data for a date range as .xlsx (several sheets) or .csv (lines only).
// Respects visibility: admin = everyone, leader = own team, member = self.
import writeExcelFile from 'write-excel-file/node';
import { db, getSettings } from './db.js';
import { visibleUserIds, compliance } from './analytics.js';

// Columns of the "Timesheet" sheet; defaults mirror the old Excel layout and order.
export const LINE_COLUMNS = [
  { key: 'date', label: 'Date', def: true, width: 26 },
  { key: 'member', label: 'Team Member', def: true, width: 20 },
  { key: 'email', label: 'Email', def: false, width: 26 },
  { key: 'team', label: 'Team', def: false, width: 10 },
  { key: 'task_seq', label: 'Task Number', def: true, width: 12 },
  { key: 'task_item', label: 'Task Item', def: true, width: 22 },
  { key: 'description', label: 'Task Description', def: true, width: 50 },
  { key: 'project', label: 'Project', def: true, width: 18 },
  { key: 'days', label: 'Number of Days', def: true, width: 14 },
  { key: 'hours', label: 'Hours', def: false, width: 8 },
  { key: 'quantity', label: 'Quantity', def: false, width: 10 },
  { key: 'unit', label: 'Unit', def: false, width: 10 },
  { key: 'month', label: 'Month', def: true, width: 10 },
  { key: 'scope', label: 'Project Scope', def: true, width: 14 },
  { key: 'updated_at', label: 'Last Edited', def: false, width: 18 },
];
export const SHEETS = [
  { key: 'lines', label: 'Timesheet lines (one row per task)', def: true },
  { key: 'by_person', label: 'Summary by person', def: true },
  { key: 'by_project', label: 'Summary by project', def: true },
  { key: 'by_task', label: 'Summary by task item', def: false },
  { key: 'person_project', label: 'Person × project (days)', def: false },
  { key: 'compliance', label: 'Missing / incomplete days', def: true },
];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const inList = (a) => a.map(() => '?').join(',') || 'NULL';

function query(viewer, { from, to, userIds, projectIds }) {
  let ids = visibleUserIds(viewer);
  if (userIds?.length) ids = ids.filter((i) => userIds.includes(i));
  const P = [...ids, from, to];
  let extra = '';
  if (projectIds?.length) { extra = ` AND e.project_id IN (${inList(projectIds)})`; P.push(...projectIds); }
  const lines = db.prepare(`SELECT e.*, u.name member, u.email, u.team, p.name project, p.is_leave, t.name task_item, t.unit_label unit, s.name scope
    FROM entries e JOIN users u ON u.id=e.user_id JOIN projects p ON p.id=e.project_id JOIN task_types t ON t.id=e.task_type_id LEFT JOIN scopes s ON s.id=e.scope_id
    WHERE e.user_id IN (${inList(ids)}) AND e.work_date BETWEEN ? AND ?${extra} ORDER BY e.work_date, u.name, e.task_seq`).all(...P);
  return { ids, lines };
}

const group = (lines, keyFn, init) => {
  const m = new Map();
  for (const l of lines) { const k = keyFn(l); if (!m.has(k)) m.set(k, init(l)); const g = m.get(k); g._l.push(l); }
  return [...m.values()];
};

export async function buildExport(viewer, opts) {
  const { from, to, format = 'xlsx' } = opts;
  const hpd = Number(getSettings().hours_per_day) || 8;
  const cols = LINE_COLUMNS.filter((c) => (opts.columns?.length ? opts.columns.includes(c.key) : c.def));
  const sheets = format === 'csv' ? ['lines'] : (opts.sheets?.length ? opts.sheets : SHEETS.filter((s) => s.def).map((s) => s.key));
  const { ids, lines } = query(viewer, opts);
  const value = (l, k) => {
    switch (k) {
      case 'date': return new Date(l.work_date + 'T00:00:00Z');
      case 'task_seq': return `Task ${l.task_seq}`;
      case 'days': return l.days;
      case 'hours': return r2(l.days * hpd);
      case 'month': { const [y, m] = l.work_date.split('-'); return `${MON[+m - 1]},${y}`; }
      case 'quantity': return l.quantity ?? null;
      case 'unit': return l.quantity ? l.unit : null;
      default: return l[k] ?? null;
    }
  };
  const base = `timesheet_${from}_to_${to}`;

  if (format === 'csv') {
    const q = (v) => { if (v == null) return ''; if (v instanceof Date) return v.toISOString().slice(0, 10); const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const text = [cols.map((c) => q(c.label)).join(','), ...lines.map((l) => cols.map((c) => q(value(l, c.key))).join(','))].join('\r\n');
    return { name: `${base}.csv`, type: 'text/csv; charset=utf-8', data: Buffer.from('﻿' + text, 'utf8'), rows: lines.length };
  }

  const head = (labels) => labels.map((v) => ({ value: v, fontWeight: 'bold', backgroundColor: '#D9F0EC' }));
  const num = (v) => (v == null ? null : { value: v, type: Number });
  const out = [];
  const work = (ls) => ls.filter((l) => !l.is_leave);

  if (sheets.includes('lines')) {
    out.push({ sheet: 'Timesheet', columns: cols.map((c) => ({ width: c.width })), stickyRowsCount: 1, data: [head(cols.map((c) => c.label)),
      ...lines.map((l) => cols.map((c) => { const v = value(l, c.key);
        if (c.key === 'date') return { value: v, type: Date, format: 'dddd, mmmm d, yyyy' };
        return typeof v === 'number' ? num(v) : v == null ? null : { value: String(v), type: String }; }))] });
  }
  if (sheets.includes('by_person')) {
    const g = group(lines, (l) => l.user_id, (l) => ({ name: l.member, email: l.email, _l: [] })).sort((a, b) => a.name.localeCompare(b.name));
    out.push({ sheet: 'By person', columns: [{ width: 22 }, { width: 26 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 10 }], data: [
      head(['Team Member', 'Email', 'Working days', 'Working hours', 'Days off', 'Lines', 'Quantity']),
      ...g.map((x) => { const w = work(x._l), d = w.reduce((s, l) => s + l.days, 0);
        return [x.name, x.email || null, num(r2(d)), num(r2(d * hpd)), num(r2(x._l.filter((l) => l.is_leave).reduce((s, l) => s + l.days, 0))), num(x._l.length), num(x._l.reduce((s, l) => s + (l.quantity || 0), 0))]; })] });
  }
  if (sheets.includes('by_project')) {
    const g = group(work(lines), (l) => l.project_id, (l) => ({ name: l.project, scope: l.scope, _l: [] })).map((x) => ({ ...x, d: x._l.reduce((s, l) => s + l.days, 0) })).sort((a, b) => b.d - a.d);
    out.push({ sheet: 'By project', columns: [{ width: 22 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 40 }], data: [
      head(['Project', 'Project Scope', 'Days', 'Hours', 'People', 'Team members']),
      ...g.map((x) => { const ppl = [...new Set(x._l.map((l) => l.member))]; return [x.name, x.scope || null, num(r2(x.d)), num(r2(x.d * hpd)), num(ppl.length), ppl.join(', ')]; })] });
  }
  if (sheets.includes('by_task')) {
    const g = group(work(lines), (l) => l.task_type_id, (l) => ({ name: l.task_item, unit: l.unit, _l: [] })).map((x) => ({ ...x, d: x._l.reduce((s, l) => s + l.days, 0) })).sort((a, b) => b.d - a.d);
    out.push({ sheet: 'By task item', columns: [{ width: 24 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 14 }], data: [
      head(['Task Item', 'Days', 'Hours', 'Quantity', 'Unit', 'Hours per unit']),
      ...g.map((x) => { const counted = x._l.filter((l) => l.quantity > 0), q = counted.reduce((s, l) => s + l.quantity, 0), qd = counted.reduce((s, l) => s + l.days, 0);
        return [x.name, num(r2(x.d)), num(r2(x.d * hpd)), q ? num(q) : null, q ? x.unit : null, q ? num(r2((qd * hpd) / q)) : null]; })] });
  }
  if (sheets.includes('person_project')) {
    const w = work(lines), people = [...new Set(w.map((l) => l.member))].sort(), projs = [...new Set(w.map((l) => l.project))].sort();
    const m = new Map(); for (const l of w) m.set(`${l.member}|${l.project}`, (m.get(`${l.member}|${l.project}`) || 0) + l.days);
    out.push({ sheet: 'Person x project', columns: [{ width: 22 }, ...projs.map(() => ({ width: 12 })), { width: 10 }], data: [
      head(['Team Member', ...projs, 'Total']),
      ...people.map((p) => [p, ...projs.map((x) => (m.get(`${p}|${x}`) ? num(r2(m.get(`${p}|${x}`))) : null)), num(r2(projs.reduce((s, x) => s + (m.get(`${p}|${x}`) || 0), 0)))])] });
  }
  if (sheets.includes('compliance')) {
    const c = compliance(ids, from, to).filter((p) => p.expected > 0); // skip people who had not started yet
    out.push({ sheet: 'Missing days', columns: [{ width: 22 }, { width: 26 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 50 }, { width: 40 }], data: [
      head(['Team Member', 'Email', 'Workdays', 'Complete', 'Missing', 'Missing dates', 'Partial days (days logged)']),
      ...c.map((p) => [p.name, p.email || null, num(p.expected), num(p.complete), num(p.missing.length), p.missing.join(', ') || null, p.partial.map((x) => `${x.date} (${x.days})`).join(', ') || null])] });
  }
  if (!out.length) throw new Error('Choose at least one thing to include');
  const data = await writeExcelFile(out).toBuffer();
  return { name: `${base}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data, rows: lines.length };
}
