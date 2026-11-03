// Browser preview: runs the real API (server/api.js) on an in-browser SQLite and routes the app's fetch('/api/…') to it.
const REAL = __PREVIEW_DATA__;
const KEY = REAL ? 'ts-preview-real-v1' : 'ts-demo-db-v1', SID = KEY + '-sid';
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }, del: (k) => { try { localStorage.removeItem(k); } catch {} } };
let sid = store.get(SID) || '';

window.DEMO = {
  icon: __ICON__,
  real: !!REAL,
  logins: REAL ? [
    { label: 'Admin — sees everything', u: 'admin', p: 'admin' },
    { label: 'Team leader — Marwan Yousef', u: 'm.yousef', p: 'demo' },
    { label: 'Team member — Hamadi Hayyan', u: 'hamadi.h', p: 'demo' },
  ] : [
    { label: 'Admin — sees everything', u: 'admin', p: 'admin' },
    { label: 'Team leader — Rania Haddad', u: 'rania', p: 'demo' },
    { label: 'Team member — Omar Saleh', u: 'omar', p: 'demo' },
  ],
  reset() { store.del(KEY); store.del(SID); location.hash = ''; location.reload(); },
};

const ready = (async () => {
  globalThis.__SQL = await window.initSqlJs();
  globalThis.__DBKEY = KEY;
  const api = await import('../server/api.js');
  api.seedIfEmpty();
  if (REAL) { const { seedReal } = await import('./seed-real.js'); seedReal(REAL); }
  else { const { seedDemo } = await import('../server/demo.js'); await seedDemo(); }
  save();
  return api;
})();

function save() {
  if (!globalThis.__dirty || !globalThis.__sqldb) return;
  try {
    const bytes = globalThis.__sqldb.export(); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    store.set(KEY, btoa(bin)); globalThis.__dirty = false;
  } catch { /* storage full or blocked: the preview still works for this visit */ }
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
  const api = await ready;
  const headers = {}; new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; });
  headers.cookie = sid ? `sid=${sid}` : '';
  const method = (init.method || 'GET').toUpperCase();
  const r = await api.dispatch({ method, pathname: url.pathname, searchParams: url.searchParams, headers, rawBody: typeof init.body === 'string' ? init.body : '', ip: 'preview' });
  const sc = r.headers['Set-Cookie'];
  if (sc) { sid = (/sid=([^;]*)/.exec(sc) || [])[1] || ''; sid ? store.set(SID, sid) : store.del(SID); }
  if (method !== 'GET') save();
  const h = Object.fromEntries(Object.entries(r.headers).filter(([k]) => k !== 'Set-Cookie' && k !== 'Content-Length'));
  return new Response(r.body, { status: r.status, headers: h });
};

import('../public/app.js');
