/* An in-memory stand-in for the data store — no Google Sheets at all.

   Code.gs keeps every record behind two small objects, STORE_ (tables of
   rows) and KV_ (settings and short-lived memory). mini.js swaps these in when
   TBS_STORE=memory, so the whole app runs with its records held here instead.

   If the golden replay gives identical results this way, the app's rules
   depend on nothing but that contract — which is what lets the records move
   to a real database by writing one more of these. */
const tables = {};          // name -> { cols: [...], rows: [[...], ...] }
const props = {};
const temp = {};

const pad = (row, n) => { const r = row.slice(0, Math.max(n, row.length)); while (r.length < n) r.push(''); return r; };

const store = {
  has: t => !!tables[t],
  read: t => ({ cols: tables[t].cols.slice(), rows: tables[t].rows.map(r => r.slice()) }),
  create: (t, cols) => { tables[t] = { cols: cols.slice(), rows: [] }; },
  addCols: (t, cols) => {
    const tb = tables[t];
    cols.forEach(c => { tb.cols.push(c); tb.rows.forEach(r => { while (r.length < tb.cols.length) r.push(''); }); });
  },
  append: (t, arrays) => { const tb = tables[t]; arrays.forEach(a => tb.rows.push(pad(a, tb.cols.length))); },
  setCells: (t, edits) => {
    const tb = tables[t];
    edits.forEach(e => Object.keys(e.cells).forEach(c => { tb.rows[e.i][Number(c)] = e.cells[c]; }));
  },
  removeRows: (t, indexes) => {
    const tb = tables[t];
    indexes.slice().sort((a, b) => b - a).forEach(i => tb.rows.splice(i, 1));
  },
  rewrite: (t, cols, arrays) => { tables[t] = { cols: cols.slice(), rows: arrays.map(a => pad(a, cols.length)) }; }
};

const kv = {
  getProp: k => (k in props ? props[k] : null),
  setProp: (k, v) => { props[k] = String(v); },
  delProp: k => { delete props[k]; },
  allProps: () => Object.assign({}, props),
  getTemp: k => (k in temp ? temp[k] : null),
  putTemp: (k, v) => { temp[k] = String(v); },
  delTemp: k => { delete temp[k]; },
  getTempAll: keys => { const o = {}; keys.forEach(k => { if (k in temp) o[k] = temp[k]; }); return o; },
  putTempAll: obj => { Object.keys(obj).forEach(k => { temp[k] = String(obj[k]); }); },
  delTempAll: keys => { keys.forEach(k => { delete temp[k]; }); }
};

/* Every table as { head, rows: [{col: value}] } — the shape golden.js compares. */
function dump(norm) {
  const out = {};
  Object.keys(tables).forEach(t => {
    const tb = tables[t];
    out[t] = { head: tb.cols.map(String), rows: tb.rows.map(r => {
      const o = {};
      tb.cols.forEach((h, i) => { if (h !== '') o[h] = norm(r[i]); });
      return o;
    }) };
  });
  return out;
}

module.exports = { store, kv, dump, tables };
