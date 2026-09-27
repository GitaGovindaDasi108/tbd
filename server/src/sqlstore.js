/* The data store on SQLite — Phase 2 of moving off Google Sheets.

   Code.gs keeps every record behind two small objects, STORE_ (tables of rows)
   and KV_ (settings and short-lived memory); see DATA STORE in Code.gs. This
   file supplies both on a SQLite database, synchronously, which is what a
   Cloudflare Durable Object's own database offers (ctx.storage.sql). So the
   app's rules run unchanged: the same Code.gs, with its records here instead
   of in hidden sheets.

   `exec(sql, ...params)` runs one statement and returns its rows as objects.
   On Cloudflare that is ctx.storage.sql.exec(...).toArray(); in the tests it
   is Node's own SQLite (see test/mini.js, TBS_STORE=sqlite).

   Tables keep the same shape as the sheets did — column names, then rows of
   values in order — because the rules count on that (row positions, column
   order, values as they were written). Each row is stored as JSON; dates are
   kept as dates. Everything is also held in memory once read: the Durable
   Object is the only thing that writes, so what it holds is always current.

   (A module with no imports: the Worker bundles it, and the Node tests load it
   with require.) */

export function makeSqlStore(exec) {
  exec('CREATE TABLE IF NOT EXISTS tbl (name TEXT PRIMARY KEY, cols TEXT NOT NULL)');
  exec('CREATE TABLE IF NOT EXISTS row (t TEXT NOT NULL, seq INTEGER NOT NULL, v TEXT NOT NULL, PRIMARY KEY (t, seq))');
  exec('CREATE TABLE IF NOT EXISTS prop (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  exec('CREATE TABLE IF NOT EXISTS temp (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER NOT NULL)');

  /* ---- Values as the sheets gave them back ----
     A date stays a date; nothing is ever null or undefined (a sheet cell is
     '' when empty); numbers and true/false are kept as they are. */
  function enc(v) {
    if (v instanceof Date) return { $d: isNaN(v) ? null : v.toISOString() };
    if (v === null || v === undefined) return '';
    if (typeof v === 'number' && !isFinite(v)) return '';
    return v;
  }
  function dec(v) {
    if (v && typeof v === 'object' && '$d' in v) return v.$d === null ? new Date(NaN) : new Date(v.$d);
    return v;
  }
  const encRow = r => JSON.stringify(r.map(enc));
  const decRow = s => JSON.parse(s).map(dec);
  const pad = (row, n) => { const r = row.slice(); while (r.length < n) r.push(''); return r; };

  /* ---- Tables, held in memory once read ---- */
  const cache = {};          // name -> { cols, seqs: [...], rows: [[...]] }
  function load(t) {
    if (cache[t]) return cache[t];
    const meta = exec('SELECT cols FROM tbl WHERE name = ?', t)[0];
    if (!meta) return null;
    const rs = exec('SELECT seq, v FROM row WHERE t = ? ORDER BY seq', t);
    return (cache[t] = { cols: JSON.parse(meta.cols), seqs: rs.map(r => Number(r.seq)), rows: rs.map(r => decRow(r.v)) });
  }
  const copy = row => row.map(v => (v instanceof Date ? new Date(v.getTime()) : v));
  function nextSeq(tb) { return tb.seqs.length ? tb.seqs[tb.seqs.length - 1] + 1 : 1; }

  const store = {
    has: t => !!load(t),
    read: t => { const tb = load(t); return { cols: tb.cols.slice(), rows: tb.rows.map(copy) }; },
    create: (t, cols) => {
      exec('INSERT OR REPLACE INTO tbl (name, cols) VALUES (?, ?)', t, JSON.stringify(cols));
      exec('DELETE FROM row WHERE t = ?', t);
      cache[t] = { cols: cols.slice(), seqs: [], rows: [] };
    },
    addCols: (t, cols) => {
      const tb = load(t);
      tb.cols = tb.cols.concat(cols);
      exec('UPDATE tbl SET cols = ? WHERE name = ?', JSON.stringify(tb.cols), t);
      // Rows are padded as they are read and written; nothing to rewrite here.
      tb.rows = tb.rows.map(r => pad(r, tb.cols.length));
    },
    append: (t, arrays) => {
      const tb = load(t);
      arrays.forEach(a => {
        const v = encRow(pad(a, tb.cols.length)), s = nextSeq(tb);
        exec('INSERT INTO row (t, seq, v) VALUES (?, ?, ?)', t, s, v);
        tb.seqs.push(s); tb.rows.push(decRow(v));      // held exactly as stored
      });
    },
    // edits: [{ i: row index, cells: { colIndex: value } }]
    setCells: (t, edits) => {
      const tb = load(t);
      edits.forEach(e => {
        const r = pad(tb.rows[e.i], tb.cols.length);
        Object.keys(e.cells).forEach(c => { r[Number(c)] = e.cells[c]; });
        const v = encRow(r);
        tb.rows[e.i] = decRow(v);
        exec('UPDATE row SET v = ? WHERE t = ? AND seq = ?', v, t, tb.seqs[e.i]);
      });
    },
    removeRows: (t, indexes) => {
      const tb = load(t);
      indexes.slice().sort((a, b) => b - a).forEach(i => {
        exec('DELETE FROM row WHERE t = ? AND seq = ?', t, tb.seqs[i]);
        tb.seqs.splice(i, 1); tb.rows.splice(i, 1);
      });
    },
    rewrite: (t, cols, arrays) => {
      exec('INSERT OR REPLACE INTO tbl (name, cols) VALUES (?, ?)', t, JSON.stringify(cols));
      exec('DELETE FROM row WHERE t = ?', t);
      const tb = cache[t] = { cols: cols.slice(), seqs: [], rows: [] };
      arrays.forEach((a, k) => {
        const v = encRow(pad(a, cols.length));
        exec('INSERT INTO row (t, seq, v) VALUES (?, ?, ?)', t, k + 1, v);
        tb.seqs.push(k + 1); tb.rows.push(decRow(v));
      });
    }
  };

  /* ---- Settings (script properties) and short-lived memory (the cache) ---- */
  const now = () => Date.now();
  const kv = {
    getProp: k => { const r = exec('SELECT v FROM prop WHERE k = ?', k)[0]; return r ? r.v : null; },
    setProp: (k, v) => { exec('INSERT OR REPLACE INTO prop (k, v) VALUES (?, ?)', k, String(v)); },
    delProp: k => { exec('DELETE FROM prop WHERE k = ?', k); },
    allProps: () => { const o = {}; exec('SELECT k, v FROM prop').forEach(r => { o[r.k] = r.v; }); return o; },
    getTemp: k => { const r = exec('SELECT v, exp FROM temp WHERE k = ?', k)[0]; return r && Number(r.exp) > now() ? r.v : null; },
    // Apps Script's cache keeps things at most six hours, and 10 minutes when not told.
    putTemp: (k, v, secs) => {
      exec('INSERT OR REPLACE INTO temp (k, v, exp) VALUES (?, ?, ?)', k, String(v), now() + 1000 * Math.min(Number(secs) || 600, 21600));
    },
    delTemp: k => { exec('DELETE FROM temp WHERE k = ?', k); },
    getTempAll: keys => { const o = {}; keys.forEach(k => { const v = kv.getTemp(k); if (v !== null) o[k] = v; }); return o; },
    putTempAll: (obj, secs) => { Object.keys(obj).forEach(k => kv.putTemp(k, obj[k], secs)); },
    delTempAll: keys => { keys.forEach(k => kv.delTemp(k)); },
    // Housekeeping: forget what has run out.
    sweepTemp: () => { exec('DELETE FROM temp WHERE exp <= ?', now()); }
  };

  /* Every table as { head, rows: [{col: value}] } — the shape test/golden.js compares. */
  function dump(norm) {
    const out = {};
    exec('SELECT name FROM tbl ORDER BY name').forEach(({ name }) => {
      const tb = load(name);
      out[name] = { head: tb.cols.map(String), rows: tb.rows.map(r => {
        const o = {};
        tb.cols.forEach((h, i) => { if (h !== '') o[h] = norm(r[i]); });
        return o;
      }) };
    });
    return out;
  }
  /* Forget what is held in memory (the tests use it to prove the database alone is enough). */
  function forget() { Object.keys(cache).forEach(k => delete cache[k]); }

  /* Every table, as stored (dates as {"$d": "…"}), for Google to build the
     spreadsheets from (see reportExport in core.js). */
  function exportAll() {
    const out = {};
    exec('SELECT name FROM tbl ORDER BY name').forEach(({ name }) => {
      const tb = load(name);
      out[name] = { cols: tb.cols.slice(), rows: tb.rows.map(r => JSON.parse(encRow(r))) };
    });
    return out;
  }

  return { store, kv, dump, forget, exportAll };
}

