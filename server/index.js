// Node HTTP server: serves the web app (public/) and forwards /api/* to dispatch() in api.js.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { dispatch } from './api.js';
import { db, seedIfEmpty } from './db.js';
import { startScheduler } from './notifications.js';
import { smtpConfigured } from './mailer.js';

const PUBLIC = new URL('../public/', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 3000);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 1e6) { const e = new Error('Too large'); e.status = 413; throw e; } chunks.push(c); }
  return Buffer.concat(chunks).toString();
}
async function handleStatic(req, res, url) {
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (p === '/' || !extname(p)) p = '/index.html';
  try {
    const data = await readFile(join(PUBLIC, p));
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream', 'Cache-Control': p === '/index.html' ? 'no-cache' : 'public, max-age=300' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  try {
    if (url.pathname.startsWith('/api/')) {
      const rawBody = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : '';
      const r = await dispatch({ method: req.method, pathname: url.pathname, searchParams: url.searchParams, headers: req.headers, rawBody, ip: req.socket.remoteAddress });
      res.writeHead(r.status, r.headers);
      res.end(r.body);
    } else await handleStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: status === 500 ? 'Server error' : e.message }));
  }
});

const seeded = seedIfEmpty();
db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
server.listen(PORT, () => {
  console.log(`Team Timesheet running on http://localhost:${PORT}`);
  console.log(`Email: ${smtpConfigured() ? 'SMTP configured — reminders will really be sent' : 'SMTP not configured — emails are only recorded (see the Emails tab)'}`);
  if (seeded.createdAdmin) console.log(`\n  First run — admin account created:\n    username: admin\n    password: ${seeded.adminPassword ?? '(from ADMIN_PASSWORD)'}\n  Change it after signing in.\n`);
  startScheduler();
});
