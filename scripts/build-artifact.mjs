// Builds a single self-contained HTML preview of the app (no server): dist/team-timesheet.html
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
const icon = 'data:image/svg+xml;base64,' + Buffer.from(readFileSync(root + 'public/icon.svg')).toString('base64');
const shim = (f) => root + 'demo/shims/' + f;
// PREVIEW_DATA=data/preview-data.json → preview with the team's own data (keep that file out of git); otherwise fictional sample data
const dataPath = process.env.PREVIEW_DATA && root + process.env.PREVIEW_DATA;
const realData = dataPath && existsSync(dataPath) ? readFileSync(dataPath, 'utf8') : 'null';
if (process.env.PREVIEW_DATA && realData === 'null') throw new Error('PREVIEW_DATA file not found: ' + dataPath);
const out = await build({
  entryPoints: [root + 'demo/entry.js'], bundle: true, format: 'iife', platform: 'browser', target: 'es2020', minify: true, write: false, legalComments: 'none',
  alias: { 'node:sqlite': shim('sqlite.js'), 'node:crypto': shim('crypto.js'), 'node:fs': shim('misc.js'), 'node:path': shim('misc.js'), nodemailer: shim('misc.js'), 'write-excel-file/node': shim('excel.js') },
  inject: [shim('inject.js')],
  define: { 'import.meta.url': '"https://preview.local/server/db.js"', __ICON__: JSON.stringify(icon), __PREVIEW_DATA__: realData },
});
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');
const sqljs = readFileSync(root + 'node_modules/sql.js/dist/sql-asm-memory-growth.js', 'utf8');
const css = readFileSync(root + 'public/style.css', 'utf8');
const html = `<title>Team Timesheet</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="theme-color" content="#c8102e">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Manrope:wght@600;700;800&display=swap">
<style>${css}</style>
<div id="app"><div class="empty" style="padding:30vh 16px;text-align:center;color:#6b5c5e">Loading Team Timesheet…</div></div>
<div id="toast" role="status" aria-live="polite"></div>
<dialog id="dlg"></dialog>
<script>${safe(sqljs)}</script>
<script>${safe(out.outputFiles[0].text)}</script>
`;
mkdirSync(root + 'dist', { recursive: true });
writeFileSync(root + 'dist/team-timesheet.html', html);
console.log('dist/team-timesheet.html', (html.length / 1024).toFixed(0) + ' KB');
