# Team Timesheet

Fast, mobile-friendly timesheet that replaces the team Excel sheet — with learning suggestions,
automatic email reminders, a weekly "who hasn't filled" report, productivity analytics, an admin/leader
dashboard and career-growth tracking. Node 22.5+; dependencies: `nodemailer`, `write-excel-file`.

## Run it
```bash
npm install
npm start                      # http://localhost:3000
```
First start creates `admin` and prints a random password (or set `ADMIN_PASSWORD`).

**Getting started:** sign in as admin, then
1. *Setup* → check the task items, scopes and career levels; add your projects (name + scope).
2. *Team* → *Add person* for each member: name, username, work email (for reminders), start date, access
   (member / team leader) and *Reports to*. Give each person their initial password privately.
3. *Emails* → set your email for the weekly report and connect SMTP (below).

Try with fake data instead: `DB_PATH=data/demo.db ADMIN_PASSWORD=admin123 npm run seed:demo && DB_PATH=data/demo.db ADMIN_PASSWORD=admin123 npm start`

## What a timesheet line holds (same as the Excel)
Date · Team member (automatic) · Task number (automatic: Task 1, 2, 3… of the day) · Task item (picklist) ·
Task description (free text) · Project (picklist) · Number of days (0.1 … 1; a full day adds up to 1) ·
Project scope (Stone / Fit Out / Landscape — filled automatically from the project).
Optional *quantity* ("how many sheets?") on task items you mark as countable — that is what lets the app learn
**hours per drawing** per person/project.

## How it learns
`server/suggest.js` ranks projects/tasks per person from their last 120 days (recent days weigh more, same
weekday and same words boost), with a light team prior for new joiners. It also gives one-tap "repeat recent"
combos, the scope of the project, "rest of day" and the person's typical days for that project+task.

## Emails (Emails tab)
* **Daily reminder** at 15:30 (Asia/Riyadh) Sunday–Thursday to everyone whose day is not yet complete (< 1 day).
* **Weekly report** to the admin (default Thursday 16:30): per person, missing and partial days Sun→Thu.
* Everything is configurable in the app and every message is kept in the log. Without SMTP they are only recorded.

### Email setup (Microsoft 365 / Outlook)
Set these environment variables where the app runs:
```
SMTP_HOST=smtp.office365.com  SMTP_PORT=587  SMTP_USER=timesheet@yourcompany.com  SMTP_PASS=…  MAIL_FROM=timesheet@yourcompany.com
APP_URL=https://timesheet.yourcompany.com
```
Use a dedicated mailbox. Your IT admin must allow *SMTP AUTH* for it (Exchange admin → mailbox → Manage email apps),
or send via your company's relay. Then use **Emails → Send test email**.

## Export (Export tab — admin and team leaders)
Pick a period (or a preset: this week, last month, …), Excel or CSV, and what to include:
timesheet lines (same columns as the old Excel by default — choose any extra columns such as hours, quantity,
email), summaries by person / project / task item, a person × project table, and missing/incomplete days.
Optionally limit to some people or projects. Leaders only export their own team.

## Roles
member (own data) · leader (own team's dashboard/growth/export; can *propose* projects) · admin (everything; approves projects).

## Planned: Odoo attendance
The sheet counts days; attendance will be compared per person per day with Odoo clock-in hours and flagged
when logged time is far above/below attended time. Needs read access to Odoo (API key) — not built yet.

## Deploy
Needs a host with a **persistent disk** and HTTPS (Render/Fly/Railway/VPS). `Dockerfile` included; mount `/data`.
Back up the single SQLite file (`DB_PATH`). Config: `PORT`, `DB_PATH`, `ADMIN_PASSWORD`, `ADMIN_EMAIL`,
`APP_URL`, `COOKIE_SECURE=1`, `SMTP_*`, `MAIL_FROM`.
