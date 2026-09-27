/* No region's warehouse is the default one.

   The original region's warehouse (id WAREHOUSE, "Poland") used to stand in
   for "the warehouse": every pre-order anywhere was held against it, a
   delivered pre-order that was deleted put its copy back on it, and messages
   named it. Each region now answers for its own. */
const m = require(__dirname + '/mini.js');
m.init();
const t = [];
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason, PL = st.regions[0], W = PL.whLoc;
const B = st.books[0].id;
const c = p => m.call(Object.assign({ season: SA }, p));
const qty = loc => { const r = (c({ action: 'getState' }).state.inventory || []).find(i => i.location === loc && i.bookId === B); return r ? Number(r.qty) : 0; };
const cash = cur => [{ type: 'Cash', cur: cur, amt: 30 }];

c({ action: 'createRegion', regionId: 'rg_it', whLoc: 'wh_it', name: 'Italy', currencies: 'EUR,USD' });
c({ action: 'createEvent', eventId: 'ev_roma', name: 'Roma', regionId: 'rg_it' });
c({ action: 'setStockBulk', location: W, items: [{ bookId: B, qty: 1 }], override: true });
c({ action: 'setStockBulk', location: 'wh_it', items: [{ bookId: B, qty: 1 }], override: true });
c({ action: 'sell', saleId: 'P1', location: 'ev_roma', bookId: B, isPreorder: true, legs: cash('EUR'), name: 'Luca' });

let r = c({ action: 'sell', saleId: 'S1', location: W, bookId: B, legs: cash('PLN') });
t.push(['Italy\'s pre-order does not hold back the original warehouse', r.ok]);
r = c({ action: 'sell', saleId: 'S2', location: 'wh_it', bookId: B, legs: cash('EUR') });
t.push(['it holds back Italy\'s own warehouse', !r.ok && /pre-order/.test(r.error || '')]);
t.push(['  and the warning names Italy', /Italy/.test(r.error || '')]);

r = c({ action: 'markDelivered', saleId: 'P1', fromStock: true, fromLoc: 'wh_it' });
t.push(['pre-order delivered from Italy\'s shelf', r.ok && qty('wh_it') === 0]);
c({ action: 'deleteSale', saleId: 'P1' });
t.push(['deleting it puts the copy back on Italy\'s shelf', qty('wh_it') === 1]);
t.push(['  not on the original warehouse', qty(W) === 0]);

// A delivery recorded before the shelf was kept: back to its own region's warehouse.
c({ action: 'sell', saleId: 'P2', location: 'ev_roma', bookId: B, isPreorder: true, legs: cash('EUR'), name: 'Gia' });
c({ action: 'markDelivered', saleId: 'P2', fromStock: true, fromLoc: 'wh_it' });
const sh = m.sheet('_sales'), iF = sh.grid[0].indexOf('dfrom');
sh.grid.forEach((row, i) => { if (i && row[0] === 'P2') row[iF] = ''; });
m.clear();
c({ action: 'deleteSale', saleId: 'P2' });
t.push(['an older delivery goes back to its own region\'s warehouse', qty('wh_it') === 1 && qty(W) === 0]);

r = c({ action: 'sell', saleId: 'S3', bookId: B, legs: cash('EUR') });
t.push(['a sale that names no place is refused, not sent to a default', !r.ok]);

// The page: the same rules.
const { T } = require(__dirname + '/clientsim.js');
T.setUp({ seasonName: 'S', books: [{ id: 'b', name: 'Gita', cat: 'big' }], payTypes: ['Cash'], currencies: ['EUR'],
  rates: { perUsd: { EUR: .9, USD: 1 } }, role: 'admin', seasons: [{ seasonId: 's', name: 'S' }], activeSeason: 's',
  regions: [{ regionId: 'pl', name: 'Poland', whLoc: 'WAREHOUSE', currencies: ['PLN'] }, { regionId: 'it', name: 'Italy', whLoc: 'wh_it', currencies: ['EUR'] }],
  events: [{ eventId: 'roma', name: 'Roma', regionId: 'it' }], holders: [], shipments: [], partners: [], payouts: [], prices: {},
  inventory: [{ location: 'wh_it', bookId: 'b', qty: 1 }, { location: 'WAREHOUSE', bookId: 'b', qty: 1 }],
  sales: [{ saleId: 'p', location: 'roma', type: 'PREORDER', bookId: 'b', delivered: false }],
  cash: [], stockMoves: [], org: [], outstanding: {}, qr: [], keys: {}, allRegions: [] });
t.push(['page: Italy\'s shelf would break Italy\'s pre-order, named as Italy', /Italy — Warehouse/.test(T.shortfallLine('b', 0, 'wh_it'))]);
t.push(['page: the original warehouse holds nothing for it', T.shortfallLine('b', 0, 'WAREHOUSE') === '']);
t.push(['page: a delivered copy goes back to the shelf it came from',
  T.restoreLocOf({ type: 'SALE', bookId: 'b', location: 'roma', dsource: 'Regional warehouse', dfrom: 'wh_it' }) === 'wh_it']);
t.push(['page: an older delivery goes back to its own region\'s warehouse',
  T.restoreLocOf({ type: 'SALE', bookId: 'b', location: 'roma', dsource: 'Regional warehouse' }) === 'wh_it']);
t.push(['page: a copy from outside the region is not put on any shelf',
  T.restoreLocOf({ type: 'SALE', bookId: 'b', location: 'roma', dsource: 'Outside the region' }) === '']);
t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
