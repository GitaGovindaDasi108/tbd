/* Deleting a season takes EVERYTHING of it (b200): regions, events, devotees'
   shelves, stock, sales, costs, consignment groups — and books in transit to
   or from it, which used to be left behind and kept showing at Earthly HQ.
   One pass per table, so it is quick. A sweep clears what older builds left. */
const m = require(__dirname + '/mini.js');
m.init();
const t = [];
const st0 = m.call({ action: 'getState' }).state;
const SA = st0.activeSeason, W = st0.regions[0].whLoc, B = st0.books[0].id;
const ok = (r, what) => { if (!r.ok) console.log('setup failed:', what, r.error); return r; };
const atHQ = p => m.call(Object.assign({ season: 'HQ' }, p));
m.call({ action: 'setSeason', seasonId: 'HQ' });
atHQ({ action: 'adjustStockBulk', location: 'wh_hq', items: [{ bookId: B, delta: 50 }], override: true, note: 'printer' });

const ST = ok(m.call({ action: 'saveSeason', name: 'Test Season' }), 'season').result;
const inT = p => m.call(Object.assign({ season: ST }, p));
ok(inT({ action: 'createRegion', regionId: 'rg_t1', whLoc: 'wh_t1', name: 'Testland', currencies: 'EUR,USD' }), 'r1');
ok(inT({ action: 'createRegion', regionId: 'rg_t2', whLoc: 'wh_t2', name: 'Testville', currencies: 'EUR,USD' }), 'r2');
ok(inT({ action: 'createEvent', eventId: 'ev_t', name: 'Test Fest', regionId: 'rg_t1' }), 'event');
ok(inT({ action: 'saveHolder', holderId: 'hd_t', regionId: 'rg_t1', name: 'Test Devotee' }), 'holder');
ok(inT({ action: 'setStockBulk', location: 'wh_t1', items: [{ bookId: B, qty: 30 }], override: true }), 'stock');
for (let i = 0; i < 12; i++) inT({ action: 'sell', saleId: 'TS' + i, location: i % 2 ? 'wh_t1' : 'ev_t', bookId: B, legs: [{ type: 'Cash', cur: 'EUR', amt: 10 }] });
ok(inT({ action: 'saveCost', id: 'TC1', location: 'wh_t1', cur: 'EUR', amt: 5, category: 'Other' }), 'cost');
// Books on their way from HQ to the test season, and from it to the real one.
ok(atHQ({ action: 'sendShipment', shipId: 'sh_hq2t', fromRegion: 'rg_hq', toRegion: 'rg_t1', mode: 'devotee', carrier: 'X', items: [{ bookId: B, qty: 7 }] }), 'ship in');
ok(inT({ action: 'sendShipment', shipId: 'sh_t2pl', fromRegion: 'rg_t1', toRegion: st0.regions[0].regionId, mode: 'devotee', carrier: 'Y', items: [{ bookId: B, qty: 3 }] }), 'ship out');
t.push(['(HQ sees both shipments in transit before)', atHQ({ action: 'getState' }).state.everywhere.shipments.filter(x => /sh_hq2t|sh_t2pl/.test(x.shipId)).length === 2]);

global.__ops = { read: 0, write: 0, append: 0 };
let calls = 0; const sh = m.sheet('_sales'); const dr = sh.deleteRow, drs = sh.deleteRows;
const count = s => { const a = s.deleteRow, b = s.deleteRows; s.deleteRow = i => { calls++; return a(i); }; s.deleteRows = (i, n) => { calls++; return b(i, n); }; };
['_sales', '_inventory', '_stockmoves', '_events', '_regions', '_shipments', '_holders', '_costs'].forEach(n => { const s = m.sheet(n); if (s) count(s); });
const r = m.call({ action: 'deleteSeason', seasonId: ST, confirmName: 'Test Season', season: SA });
t.push(['the season is deleted', r.ok && !m.call({ action: 'getState' }).state.seasons.some(x => x.seasonId === ST)]);
t.push(['in a handful of sheet calls, not one per row (' + calls + ')', calls <= 20]);

const hq = atHQ({ action: 'getState' }).state;
t.push(['no books in transit to or from it remain at HQ', !hq.shipments.some(x => /sh_hq2t|sh_t2pl/.test(x.shipId))
  && !hq.everywhere.shipments.some(x => /sh_hq2t|sh_t2pl/.test(x.shipId))]);
const rows = n => (m.sheet(n) ? m.sheet(n).grid.slice(1) : []).map(x => x.join('|'));
const left = ['_regions', '_events', '_holders', '_inventory', '_sales', '_costs', '_shipments', '_stockmoves', '_prices']
  .filter(n => rows(n).some(x => /rg_t1|rg_t2|wh_t1|wh_t2|ev_t\b|hd_t|sh_hq2t|sh_t2pl|TS\d|TC1/.test(x)));
t.push(['nothing of it is left in any table' + (left.length ? ': ' + left.join(', ') : ''), !left.length]);
t.push(['the other season is untouched', m.call({ action: 'getState', season: SA }).state.regions.length === 1]);

// Left behind by an older build: a shipment to a region that is gone.
const shs = m.sheet('_shipments'), cols = shs.grid[0];
const row = cols.map(c => ({ shipId: 'sh_old', fromRegion: 'rg_hq', toRegion: 'rg_gone', status: 'IN_TRANSIT', mode: 'devotee' }[c] || ''));
shs.grid.push(row);
m.sheet('_inventory').grid.push(['sh_old', B, 4]);
m.clear();
t.push(['an orphaned shipment is hidden at once', !atHQ({ action: 'getState' }).state.shipments.some(x => x.shipId === 'sh_old')]);
m.run("propDel_('lastWriteAt'); tempDel_('orphan_sweep')");
m.sync(false);
t.push(['…and the background sweep erases it and its books',
  !rows('_shipments').some(x => /sh_old/.test(x)) && !rows('_inventory').some(x => /sh_old/.test(x))]);
// Your live case: the shipment's record is gone, its books were left behind.
m.sheet('_inventory').grid.push(['sh_40hie4ne', B, 12]);
m.clear();
const seen = atHQ({ action: 'getState' }).state;
t.push(['books left on a shipment with no record are not shown', !seen.inventory.some(i => i.location === 'sh_40hie4ne')
  && !seen.everywhere.inventory.some(i => i.location === 'sh_40hie4ne')]);
m.run("tempDel_('orphan_sweep')");
m.call({ action: 'setStockBulk', season: SA, location: W, items: [{ bookId: B, qty: 9 }], override: true });
t.push(['…and the next save erases them', !rows('_inventory').some(x => /sh_40hie4ne/.test(x))]);
t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
