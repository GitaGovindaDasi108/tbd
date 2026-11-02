/* b322 (Gita, 2026-11-02): at a closed place the sale and its money stay locked,
   but the name, phone and notes on a sale (pre-orders, payments still owed) can
   still be changed, with editSaleNotes. */
const m = require(__dirname + '/mini.js');
m.init();
const t = [];
const st0 = m.call({ action: 'getState' }).state;
const SA = st0.activeSeason, R = st0.regions[0].regionId, WH = st0.regions[0].whLoc;
const A = p => m.call(Object.assign({ season: SA }, p));
A({ action: 'createEvent', eventId: 'ev_cn', name: 'Night Kirtan', regionId: R });
const B = st0.books[0].id;
A({ action: 'sell', saleId: 'sl_pre', location: 'ev_cn', bookId: B, isPreorder: true,
    legs: [{ type: 'Cash', cur: 'PLN', amt: 50 }], dueamt: 100, duecur: 'PLN', name: 'Radha', phone: '+48111', comments: 'call first', override: true });
A({ action: 'sellBundle', location: 'ev_cn', keepBundleId: 'bn_cn', items: [{ bookId: B, pre: true }, { bookId: B, pre: true }],
    legs: [{ type: 'Cash', cur: 'PLN', amt: 200 }], name: 'Govinda', override: 'true' });
A({ action: 'closeLocation', kind: 'event', id: 'ev_cn', counts: {} });
const sale = id => A({ action: 'getState' }).state.sales.find(s => s.saleId === id) || {};
const before = sale('sl_pre');

const ed = A({ action: 'editSale', saleId: 'sl_pre', type: 'PREORDER', location: 'ev_cn', bookId: B,
               legs: [{ type: 'Cash', cur: 'PLN', amt: 999 }], name: 'X' });
t.push(['a full edit (money) is still refused at a closed event', !ed.ok && /closed/.test(ed.error || '')]);
const r = A({ action: 'editSaleNotes', saleId: 'sl_pre', name: 'Radha Dasi', phone: '+48222', comments: 'delivers Sunday' });
if (!r.ok) console.log(r.error, JSON.stringify(before));
t.push(['editing the name, phone and notes works at a closed event', r.ok]);
const after = sale('sl_pre');
t.push(['…the name, phone and notes changed', after.name === 'Radha Dasi' && after.phone === '+48222' && after.comments === 'delivers Sunday']);
t.push(['…and the book, place, amounts and owed stay exactly as they were',
  ['bookId', 'location', 'type', 'p1amt', 'p1cur', 'dueamt', 'duecur', 'ts'].every(k => String(after[k]) === String(before[k]))]);
const rb = A({ action: 'editSaleNotes', bundle: 'bn_cn', comments: 'two copies' });
const mem = A({ action: 'getState' }).state.sales.filter(s => s.bundle === 'bn_cn');
t.push(['a multi-book sale’s notes change on every one of its books', rb.ok && mem.length === 2 && mem.every(s => s.comments === 'two copies' && s.name === 'Govinda')]);
const gone = A({ action: 'editSaleNotes', saleId: 'nope', comments: 'x' });
t.push(['a sale that is not there is refused', !gone.ok]);
const log = A({ action: 'getActivity' });
const txt = JSON.stringify((log && log.result) || '');
t.push(['the Activity Log says what was edited', /Edited the name, phone or notes on a sale/.test(txt) || !log.ok]);

let bad = 0;
t.forEach(([what, pass]) => { if (!pass) bad++; console.log((pass ? 'PASS ' : 'FAIL ') + what); });
console.log(bad ? bad + ' failed' : 'all ' + t.length + ' passed');
process.exit(bad ? 1 : 0);
