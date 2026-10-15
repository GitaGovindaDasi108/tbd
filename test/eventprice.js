/* An event's own prices, and consignment groups kept for one event (b225). */
const m = require(__dirname + '/mini.js');
m.init();
const t = [];
const st0 = m.call({ action: 'getState' }).state;
const SA = st0.activeSeason, R = st0.regions[0], B = st0.books.filter(b => !b.partnerId).map(b => b.id);
const ok = (r, what) => { if (!r.ok) console.log('setup failed:', what, r.error); return r; };
const as = (who, p) => { m.run('setTrustedWho_(' + JSON.stringify(who) + ')'); return m.call(Object.assign({ season: SA }, p)); };
const A = p => m.call(Object.assign({ season: SA }, p));
const st = () => A({ action: 'getState' }).state;
const region = (b, c) => st().prices[R.regionId][b][c];

ok(A({ action: 'createEvent', eventId: 'ev_p1', name: 'Fest', regionId: R.regionId }), 'ev1');
ok(A({ action: 'createEvent', eventId: 'ev_p2', name: 'Temple', regionId: R.regionId }), 'ev2');
t.push(['no event prices: nothing extra in the state', st().eventPrices === undefined]);
const cur = R.currencies[0];
ok(A({ action: 'setPrices', regionId: R.regionId, prices: { [B[0]]: { [cur]: 30 }, [B[1]]: { [cur]: 10 } } }), 'region prices');
const r1 = A({ action: 'setEventPrices', eventId: 'ev_p1', prices: { [B[0]]: { [cur]: 20 } } });
t.push(['an event price is saved', r1.ok && st().eventPrices.ev_p1[B[0]][cur] === 20]);
t.push(['…the region keeps its own', region(B[0], cur) === 30]);
t.push(['…the other event has none', !st().eventPrices.ev_p2]);

// A bundle at the event is split by the event's prices: 20 and 10 → 2:1.
ok(A({ action: 'setStockBulk', location: 'ev_p1', items: [{ bookId: B[0], qty: 5 }, { bookId: B[1], qty: 5 }], override: true }), 'stock');
ok(A({ action: 'sellBundle', keepBundleId: 'BP', location: 'ev_p1', items: [{ bookId: B[0] }, { bookId: B[1] }], legs: [{ type: 'Cash', cur, amt: 30 }] }), 'bundle');
const parts = st().sales.filter(x => x.bundle === 'BP');
const amt = id => Number((parts.find(x => x.bookId === id) || {}).p1amt);
t.push(['a bundle at the event is split by its own prices (20 + 10)', amt(B[0]) === 20 && amt(B[1]) === 10]);

t.push(['a blank price goes back to the region', A({ action: 'setEventPrices', eventId: 'ev_p1', prices: { [B[0]]: { [cur]: '' } } }).ok
  && st().eventPrices === undefined]);
t.push(['a price must be a number', !A({ action: 'setEventPrices', eventId: 'ev_p1', prices: { [B[0]]: { [cur]: 'abc' } } }).ok]);

const LEAD = { role: 'coordinator', regionId: R.regionId, name: 'Rita', email: 'r@x', grant: 'RL' };
const OTHER = { role: 'coordinator', regionId: 'rg_elsewhere', name: 'Olga', email: 'o@x', grant: 'RL' };
const SELL = { role: 'seller', regionId: R.regionId, eventIds: ['ev_p1'], eventId: 'ev_p1', name: 'Sam', email: 's@x', grant: 'S' };
t.push(['the Regional Lead may set them', as(LEAD, { action: 'setEventPrices', eventId: 'ev_p2', prices: { [B[1]]: { [cur]: 8 } } }).ok]);
t.push(['…not one from another region', !as(OTHER, { action: 'setEventPrices', eventId: 'ev_p2', prices: { [B[1]]: { [cur]: 7 } } }).ok]);
t.push(['…nor a Seller', !as(SELL, { action: 'setEventPrices', eventId: 'ev_p1', prices: { [B[1]]: { [cur]: 7 } } }).ok]);

// Consignment kept for one event.
const g1 = A({ action: 'savePartner', regionId: R.regionId, name: 'Region Group' });
t.push(['a region-wide group has no event (and no new column)', g1.ok && !st().partners.find(x => x.partnerId === g1.result).eventId]);
const g2 = A({ action: 'savePartner', regionId: R.regionId, name: 'Fest Group', eventId: 'ev_p1' });
t.push(['a group kept for one event says so', g2.ok && st().partners.find(x => x.partnerId === g2.result).eventId === 'ev_p1']);
t.push(['…not an event in another region', !A({ action: 'savePartner', regionId: R.regionId, name: 'X', eventId: 'ev_nowhere' }).ok]);
A({ action: 'savePartner', partnerId: g1.result, regionId: R.regionId, name: 'Region Group', eventId: 'ev_p2' });
t.push(['a group can be moved to an event', st().partners.find(x => x.partnerId === g1.result).eventId === 'ev_p2']);
A({ action: 'savePartner', partnerId: g1.result, regionId: R.regionId, name: 'Region Group', eventId: '' });
t.push(['…and back to the whole region', !st().partners.find(x => x.partnerId === g1.result).eventId]);

ok(A({ action: 'deleteEvent', eventId: 'ev_p2' }), 'delete ev2');
t.push(['deleting an event takes its prices', !(st().eventPrices || {}).ev_p2]);
ok(A({ action: 'deleteEvent', eventId: 'ev_p1' }), 'delete ev1');
t.push(['…and its groups serve the whole region again', !st().partners.find(x => x.partnerId === g2.result).eventId]);

let bad = 0;
t.forEach(([what, pass]) => { if (!pass) bad++; console.log((pass ? 'PASS ' : 'FAIL ') + what); });
console.log(bad ? bad + ' failed' : 'all ' + t.length + ' passed');
process.exit(bad ? 1 : 0);
