/* A closing count that does not match the records (b224): the records are not
   rewritten; the count is flagged to the next person up, who accepts it (the
   difference is applied, with their reason) or settles it (records stay). */
const m = require(__dirname + '/mini.js');
m.init();
const t = [];
const st0 = m.call({ action: 'getState' }).state;
const SA = st0.activeSeason, R = st0.regions[0], B = st0.books[0].id, B2 = st0.books[1].id;
const ok = (r, what) => { if (!r.ok) console.log('setup failed:', what, r.error); return r; };
const as = (who, p) => { m.run('setTrustedWho_(' + JSON.stringify(who) + ')'); return m.call(Object.assign({ season: SA }, p)); };
const ADMIN = { role: 'admin', name: 'Uma', email: 'u@x', grant: 'U' };
const LEAD = { role: 'coordinator', regionId: R.regionId, name: 'Rita', email: 'r@x', grant: 'RL' };
const SELL = { role: 'seller', regionId: R.regionId, eventIds: ['ev_cf'], eventId: 'ev_cf', name: 'Sam', email: 's@x', grant: 'S' };

ok(as(ADMIN, { action: 'createEvent', eventId: 'ev_cf', name: 'Count Fest', regionId: R.regionId }), 'event');
ok(as(ADMIN, { action: 'setStockBulk', location: 'ev_cf', items: [{ bookId: B, qty: 10 }, { bookId: B2, qty: 4 }], override: true }), 'stock');
const qty = (loc, b) => { const s = m.call({ action: 'getState', season: SA }).state; const r = (s.inventory || []).find(x => x.location === loc && x.bookId === b); return r ? Number(r.qty) : 0; };

const c = as(LEAD, { action: 'closeLocation', kind: 'event', id: 'ev_cf', counts: { ['ev_cf|' + B]: 7, ['ev_cf|' + B2]: 4 }, note: 'end of day' });
t.push(['closing with a short count works', c.ok]);
t.push(['the records are not rewritten (still 10)', qty('ev_cf', B) === 10]);
const st = m.call({ action: 'getState', season: SA }).state;
const open = (st.mismatches || []).filter(x => x.placeId === 'ev_cf' && x.status === 'open');
t.push(['one count is flagged (the matching one is not)', open.length === 1 && open[0].bookId === B]);
t.push(['it says expected 10, counted 7, and who counted', open.length && open[0].expected == 10 && open[0].counted == 7 && open[0].by === 'Rita']);
t.push(['the close reply lists it as outstanding', c.ok && c.result.outstanding.counts === 1]);
const id = open.length ? open[0].id : '';

t.push(['a seller cannot settle it', !as(SELL, { action: 'mismatchAnswer', id, accept: true, answer: 'x' }).ok]);
t.push(['a reason is needed', !as(LEAD, { action: 'mismatchAnswer', id, accept: true, answer: '' }).ok]);
const a = as(LEAD, { action: 'mismatchAnswer', id, accept: true, answer: 'three given away' });
t.push(['the Regional Lead accepts it', a.ok]);
t.push(['…and the difference is applied (now 7)', qty('ev_cf', B) === 7]);
const done = (m.call({ action: 'getState', season: SA }).state.mismatches || []).find(x => x.id === id);
t.push(['…with their name and reason', done && done.status === 'accepted' && done.answeredBy === 'Rita' && done.answer === 'three given away']);
t.push(['answering again changes nothing', as(LEAD, { action: 'mismatchAnswer', id, accept: true, answer: 'again' }).ok && qty('ev_cf', B) === 7]);

// A second event: the error is found, so the records stay.
ok(as(ADMIN, { action: 'createEvent', eventId: 'ev_cg', name: 'Count Gala', regionId: R.regionId }), 'event 2');
ok(as(ADMIN, { action: 'setStockBulk', location: 'ev_cg', items: [{ bookId: B, qty: 5 }], override: true }), 'stock 2');
as(ADMIN, { action: 'closeLocation', kind: 'event', id: 'ev_cg', counts: { ['ev_cg|' + B]: 2 } });
const m2 = (m.call({ action: 'getState', season: SA }).state.mismatches || []).find(x => x.placeId === 'ev_cg');
const r2 = as(ADMIN, { action: 'mismatchAnswer', id: m2 && m2.id, accept: false, answer: 'three sales were on paper' });
t.push(['settling leaves the records as they were (still 5)', r2.ok && qty('ev_cg', B) === 5]);
t.push(['…and it is marked resolved', (m.call({ action: 'getState', season: SA }).state.mismatches || []).find(x => x.placeId === 'ev_cg').status === 'resolved']);

let bad = 0;
t.forEach(([what, pass]) => { if (!pass) bad++; console.log((pass ? 'PASS ' : 'FAIL ') + what); });
console.log(bad ? bad + ' failed' : 'all ' + t.length + ' passed');
process.exit(bad ? 1 : 0);
