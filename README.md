# Team Timesheet

Fast, mobile-friendly timesheet for the team, with learning suggestions, productivity analytics,
an admin/leader dashboard and career-growth tracking. Zero dependencies — Node 22.5+ only.

## Run
```bash
npm start            # http://localhost:3000
```
First start creates `admin` and prints a random password (or set `ADMIN_PASSWORD`).
Try it with fake data: `DB_PATH=data/demo.db ADMIN_PASSWORD=admin123 npm run seed:demo && DB_PATH=data/demo.db npm start`
(demo users: sara/omar/lina/yusuf/mona/karim, password `demo123`).

## What a timesheet entry holds
Date · person (automatic) · project (predefined) · task (predefined) · task count · **time spent** · description (free text).
Time spent is what makes productivity possible: minutes per unit = time ÷ task count.

## How it learns
`server/suggest.js` ranks projects/tasks per person from their last 120 days (recent days weigh more,
same weekday and same task/words boost), with a light team prior for new joiners. It also offers
one-tap "repeat" combos, description autocomplete, and a duration hint from the person's own speed.

## Roles
- **member** – logs own time, sees own growth plan (only notes shared with them).
- **leader** – dashboard, productivity and growth for their own team (`Reports to` on the user).
- **admin** – everything: users, projects, tasks, career levels, promotions.

## Deploy
Needs a host with a persistent disk (Render/Fly/Railway/VPS). `Dockerfile` included; mount `/data`,
serve over HTTPS (cookie is `Secure` when `COOKIE_SECURE=1`). Back up the single SQLite file.

## Config
`PORT`, `DB_PATH`, `ADMIN_PASSWORD`, `COOKIE_SECURE=1`.
