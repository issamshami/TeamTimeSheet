// Daily reminder (default 15:30, Sun–Thu) + weekly "who did not fill" report for the admin.
// All times are evaluated in the configured timezone (default Asia/Riyadh).
import { db, getSettings } from './db.js';
import { sendMail, smtpConfigured } from './mailer.js';
import { compliance, addDays } from './analytics.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function localNow(tz, at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hhmm: `${p.hour}:${p.minute}` };
}
const minutesOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const link = (s) => s.app_url || process.env.APP_URL || '';
const fmtDate = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

const shell = (title, body, s) => `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:620px;margin:auto;color:#16211f">
<h2 style="color:#0f766e;margin:0 0 12px">${esc(title)}</h2>${body}
${link(s) ? `<p style="margin-top:20px"><a href="${esc(link(s))}" style="background:#0f766e;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;display:inline-block">Open Timesheet</a></p>` : ''}
<p style="color:#888;font-size:12px;margin-top:24px">Sent automatically by Team Timesheet.</p></div>`;

/** Who still owes today's timesheet? */
export function reminderRecipients(date, s = getSettings()) {
  const ids = db.prepare("SELECT id FROM users WHERE active=1 AND role<>'admin'").all().map((r) => r.id);
  const comp = compliance(ids, date, date, { ...s, workdays: '0,1,2,3,4,5,6' }); // check the given day regardless of weekday
  const total = db.prepare(`SELECT user_id, ROUND(SUM(days),2) d FROM entries WHERE work_date=? GROUP BY user_id`).all(date);
  const tm = new Map(total.map((r) => [r.user_id, r.d]));
  const rows = comp.filter((c) => c.expected > 0).map((c) => ({ ...c, logged: tm.get(c.id) || 0, incomplete: c.complete === 0 })); // not started yet = nothing expected
  const targets = s.reminder_only_incomplete === '1' ? rows.filter((r) => r.incomplete) : rows;
  return { date, recipients: targets.filter((r) => r.email), no_email: targets.filter((r) => !r.email).map((r) => r.name), already_done: rows.length - targets.length };
}

export async function sendReminders(date, { dry = false } = {}) {
  const s = getSettings(), plan = reminderRecipients(date, s);
  if (dry) return { ...plan, sent: 0, dry: true };
  let sent = 0, failed = 0;
  for (const r of plan.recipients) {
    const msg = r.logged > 0 ? `You have logged <b>${r.logged}</b> of 1 day so far for today (${esc(fmtDate(date))}).` : `You have not logged anything yet for today (${esc(fmtDate(date))}).`;
    const res = await sendMail({
      kind: 'reminder', to: r.email, subject: 'Reminder: please fill in today\'s timesheet',
      html: shell('Timesheet reminder', `<p>Hi ${esc(r.name.split(' ')[0])},</p><p>${msg}</p><p>It only takes a minute — your usual projects and tasks are one tap away.</p>`, s),
    });
    if (res.status === 'sent') sent++; else if (res.status === 'failed') failed++;
  }
  return { ...plan, sent, failed, dry: false, smtp: smtpConfigured() };
}

/** Week = Sunday … report date. */
export function weeklyRange(date) {
  const wd = new Date(date + 'T12:00:00Z').getUTCDay();
  return { from: addDays(date, -wd), to: date };
}
export function weeklyReportData(date, s = getSettings()) {
  const { from, to } = weeklyRange(date);
  const ids = db.prepare("SELECT id FROM users WHERE active=1 AND role<>'admin'").all().map((r) => r.id);
  const people = compliance(ids, from, to, s);
  return { from, to, people, behind: people.filter((p) => p.missing.length || p.partial.length), no_email: people.filter((p) => !p.email).map((p) => p.name) };
}
export async function sendWeeklyReport(date, { dry = false } = {}) {
  const s = getSettings(), d = weeklyReportData(date, s);
  const to = s.admin_email || db.prepare("SELECT email FROM users WHERE role='admin' AND email<>'' LIMIT 1").get()?.email || '';
  const rows = d.behind.map((p) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #e3e9e7"><b>${esc(p.name)}</b></td><td style="padding:6px 10px;border-bottom:1px solid #e3e9e7">${p.complete}/${p.expected}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #e3e9e7">${p.missing.map((x) => esc(fmtDate(x))).join(', ') || '–'}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #e3e9e7">${p.partial.map((x) => `${esc(fmtDate(x.date))} (${x.days})`).join(', ') || '–'}</td></tr>`).join('');
  const html = shell(`Weekly timesheet status — ${fmtDate(d.from)} to ${fmtDate(d.to)}`,
    d.behind.length ? `<p><b>${d.behind.length}</b> of ${d.people.length} people have missing or incomplete days:</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px"><tr style="text-align:left;color:#5d6b68"><th style="padding:6px 10px">Person</th><th style="padding:6px 10px">Complete</th><th style="padding:6px 10px">Missing days</th><th style="padding:6px 10px">Partial (&lt;1 day)</th></tr>${rows}</table>`
      : `<p>Everyone completed their timesheet this week. 🎉</p>`, s)
    + (d.no_email.length ? `<p style="font-size:13px;color:#b45309">No email on file for: ${esc(d.no_email.join(', '))}</p>` : '');
  if (dry) return { ...d, sent_to: to, dry: true };
  const res = await sendMail({ kind: 'weekly_report', to, subject: `Weekly timesheet status — ${d.behind.length} need follow-up`, html });
  return { ...d, sent_to: to, dry: false, status: res.status };
}

export async function sendTest(to) {
  const s = getSettings();
  return sendMail({ kind: 'test', to, subject: 'Team Timesheet test email', html: shell('It works', '<p>This is a test email from Team Timesheet. Reminders and reports will arrive like this.</p>', s) });
}

// ---------- scheduler ----------
const CATCH_UP_MIN = 180; // if the server was down at the exact time, still send within 3 hours
export async function tick(at = new Date()) {
  const s = getSettings(), now = localNow(s.timezone, at);
  const workdays = s.workdays.split(',').filter(Boolean).map(Number);
  const due = (time) => { const diff = minutesOf(now.hhmm) - minutesOf(time); return diff >= 0 && diff <= CATCH_UP_MIN; };
  const claim = (job) => db.prepare('INSERT OR IGNORE INTO job_runs (job,run_date) VALUES (?,?)').run(job, now.date).changes === 1;
  const ran = [];
  if (s.reminders_enabled === '1' && workdays.includes(now.weekday) && due(s.reminder_time) && claim('reminder')) {
    ran.push({ job: 'reminder', ...(await sendReminders(now.date)) });
  }
  if (s.weekly_report_enabled === '1' && now.weekday === Number(s.weekly_report_day) && due(s.weekly_report_time) && claim('weekly_report')) {
    ran.push({ job: 'weekly_report', ...(await sendWeeklyReport(now.date)) });
  }
  return ran;
}
export function startScheduler() {
  const run = () => tick().then((r) => r.forEach((x) => console.log(`[scheduler] ${x.job}: ${x.sent ?? x.status ?? ''} (${x.recipients?.length ?? x.behind?.length ?? 0} people)`))).catch((e) => console.error('[scheduler]', e));
  setInterval(run, 30000); setTimeout(run, 3000);
}
