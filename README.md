# Team Timesheet

Fast, mobile-friendly timesheet for the team: logging in a few taps with learning suggestions, automatic reminders,
a weekly "who hasn't filled" report, productivity analytics, project dashboards for team leaders, career tracking,
and Excel/CSV export. Node 22.5+, SQLite, two dependencies (`nodemailer`, `write-excel-file`).

## Go live (about 10 minutes)

The app needs a small always-on server with a **persistent disk** and **https**. The simplest route is Render:

1. Sign in at <https://dashboard.render.com> and connect your GitHub account.
2. **New → Blueprint**, choose this repository. `render.yaml` sets everything up (Docker, 1 GB disk, health check, https).
   The disk needs a paid instance (starter plan).
3. When asked, fill in: `ADMIN_PASSWORD` (your first password), `ADMIN_EMAIL` (your work email: it becomes the admin's sign-in email and the address for the weekly report), `APP_URL` (the address Render shows,
   e.g. `https://team-timesheet.onrender.com`), and the email settings below (can be added later).
4. Open the address, sign in as `admin` (or with `ADMIN_EMAIL`) and the password you chose.
5. Share the address with the team. They install it on their phone from the browser menu (“Add to Home Screen”).

Any other host works too (Azure, Fly.io, a VPS): run the `Dockerfile`, mount a volume at `/data`, serve over https.
Local test: `npm install && ADMIN_PASSWORD=choose-one npm start` → <http://localhost:3000>.

## Setting up your team

1. **Setup → Projects**: add projects (name + scope) and assign team leaders. **Task items & lists**: check the task items, scopes, levels.
2. **Setup → Team & roles → Add team member**: name, work email, role (member / team leader / admin), job title, start date, reports to.
   An account is created straight away and the person gets an email with a link to **choose their own password**.
   They then sign in with their work email. If email is not connected yet, the screen shows the link to send them yourself.
3. Edit anyone's **name, email and role** from the same page. *Reset link* / *Resend invite* sends a fresh link.
   People can also use **Forgot password?** on the sign-in page.
4. **Setup → Emails & reminders**: your email for the weekly report, schedule, and the app address.

## Biometric sign-in

Settings → *Fingerprint / face sign-in* → **Enable on this device**. After that the sign-in screen offers one tap with
fingerprint, face or the device screen lock (passkeys / WebAuthn). The private key never leaves the device; the server
stores only the public key. It needs https (or localhost), so it works on the live app. Each person can enable several
devices and remove them in Settings.

## Email setup (Microsoft 365 / Outlook)

Set these on the server (in Render: Environment):
```
SMTP_HOST=smtp.office365.com  SMTP_PORT=587  SMTP_USER=timesheet@yourcompany.com  SMTP_PASS=…  MAIL_FROM=timesheet@yourcompany.com
```
Use a dedicated mailbox. Your IT admin must allow *SMTP AUTH* for it (Exchange admin → mailbox → Manage email apps),
or send via your company's relay. Then **Emails → Send test email**. Without SMTP every message is only recorded in the log.

Emails the app sends: invitations and password links, daily reminder (default 15:30 Sun–Thu, Asia/Riyadh) to people whose day
is not complete, weekly report to the admin (default Thursday 16:30), project proposals and decisions, new goals/milestones.

## Who sees what

| | Logs time | Dashboard & export | Career pages |
|---|---|---|---|
| **Member** | yes | own data | own (with their goals & milestones, visible to the admin only) |
| **Team leader** | yes | own + everyone's work on the projects assigned to them | own |
| **Admin** | no | everything; edits any line in the Team log | everyone's; approves leaders' project proposals |

## What a timesheet line holds (same as the old Excel)
Date · Team member · Task number (automatic) · Task item · Task description · Project · Number of days (a full day adds to 1) ·
Project scope (comes from the project). Optional *quantity* on countable items (sheets, drawings, RFIs) lets the app learn
hours per unit. Time in the app is stored in days; hours = days × the working hours per day (default 8).

## How it learns
`server/suggest.js` ranks projects and task items per person from their last 120 days (recent days weigh more, same weekday and
words boost), with a light team prior for new joiners. It also offers one-tap "repeat recent" combos, the person's typical days for a
project + task, and "rest of day".

## Export
Dashboard → **Export**: period, Excel or CSV, which sheets (lines, by person, by project, by task item, person × project,
missing days), which columns, optional person/project filters. Members export themselves; leaders their own + their projects; admin everything.

## Operations
* **Data**: one SQLite file at `DB_PATH` (`/data/timesheet.db` in Docker). A copy is saved nightly to `/data/backups/` (last 14 kept).
  Download a backup occasionally.
* **Config** (environment): `PORT`, `DB_PATH`, `ADMIN_PASSWORD`, `ADMIN_EMAIL`, `APP_URL`, `COOKIE_SECURE=1`, `TRUST_PROXY=1`, `SMTP_*`, `MAIL_FROM`.
* **Health check**: `GET /healthz`.
* **Preview build**: `npm run build:preview` makes a single-file demo that runs in the browser with sample data (`PREVIEW_DATA=<json>` to embed your own, never commit it).
* **Planned**: Odoo clock-in comparison (needs read access to Odoo).
