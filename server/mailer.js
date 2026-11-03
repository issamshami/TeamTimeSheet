// Email sending. Every message is recorded in `outbox`. If SMTP_* env vars are set it is really sent
// (Office 365 example in README); otherwise it is only recorded, so the whole flow can be tried safely.
import nodemailer from 'nodemailer';
import { db } from './db.js';

let transport = null;
export const smtpConfigured = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
function getTransport() {
  if (transport) return transport;
  const port = Number(process.env.SMTP_PORT || 587);
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465, // 587 = STARTTLS
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transport;
}
export const fromAddress = () => process.env.MAIL_FROM || process.env.SMTP_USER || 'timesheet@localhost';

export async function sendMail({ to, subject, html, kind }) {
  const ins = db.prepare('INSERT INTO outbox (kind,to_addr,subject,html,status,error) VALUES (?,?,?,?,?,?)');
  if (!to) { ins.run(kind, '(none)', subject, html, 'skipped', 'No email address'); return { status: 'skipped' }; }
  if (!smtpConfigured()) { ins.run(kind, to, subject, html, 'not_sent', 'SMTP not configured — message only recorded'); return { status: 'not_sent' }; }
  try {
    await getTransport().sendMail({ from: `Team Timesheet <${fromAddress()}>`, to, subject, html });
    ins.run(kind, to, subject, html, 'sent', null);
    return { status: 'sent' };
  } catch (e) {
    ins.run(kind, to, subject, html, 'failed', String(e.message).slice(0, 500));
    return { status: 'failed', error: e.message };
  }
}
