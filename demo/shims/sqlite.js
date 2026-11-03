// node:sqlite's DatabaseSync API on top of sql.js (pure JavaScript SQLite), persisted to localStorage.
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; }
  all(...p) { const st = this.db.prepare(this.sql); try { st.bind(p.map(norm)); const out = []; while (st.step()) out.push(st.getAsObject()); return out; } finally { st.free(); } }
  get(...p) { const st = this.db.prepare(this.sql); try { st.bind(p.map(norm)); return st.step() ? st.getAsObject() : undefined; } finally { st.free(); } }
  run(...p) {
    this.db.run(this.sql, p.map(norm));
    const changes = this.db.getRowsModified();
    const lastInsertRowid = this.db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    globalThis.__dirty = true;
    return { changes, lastInsertRowid };
  }
}
export class DatabaseSync {
  constructor() {
    const SQL = globalThis.__SQL;
    let bytes = null;
    try { const b64 = localStorage.getItem(globalThis.__DBKEY); if (b64) bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); } catch {}
    try { this.db = bytes ? new SQL.Database(bytes) : new SQL.Database(); } catch { this.db = new SQL.Database(); }
    globalThis.__sqldb = this.db;
  }
  exec(sql) { if (/^\s*PRAGMA journal_mode/i.test(sql)) sql = sql.replace(/PRAGMA journal_mode\s*=\s*WAL;?/i, ''); this.db.exec(sql); globalThis.__dirty = true; }
  prepare(sql) { return new Statement(this.db, sql); }
}
