/* Closed places drop below the open ones, A to Z (b228); the open ones keep
   their chosen order; reopening puts a place back where it was. */
const m = require(__dirname + '/mini.js');
m.init();
const t = [];
const st0 = m.call({ action: 'getState' }).state;
const SA = st0.activeSeason, R = st0.regions[0].regionId;
const A = p => { const r = m.call(Object.assign({ season: SA }, p)); if (!r.ok) console.log('failed', p.action, r.error); return r; };
['Zeta Fair', 'Alpha Mela', 'Mid Fest', 'Beta Kirtan'].forEach((n, i) => A({ action: 'createEvent', eventId: 'ev_' + i, name: n, regionId: R }));
const evs = () => A({ action: 'getState' }).state.events.filter(e => e.regionId === R).map(e => e.name);
const before = evs();
t.push(['(open events in the order made)', before.join() === 'Zeta Fair,Alpha Mela,Mid Fest,Beta Kirtan']);
A({ action: 'closeLocation', kind: 'event', id: 'ev_0', counts: {} });
A({ action: 'closeLocation', kind: 'event', id: 'ev_1', counts: {} });
t.push(['closed events go below the open ones, A to Z', evs().join() === 'Mid Fest,Beta Kirtan,Alpha Mela,Zeta Fair']);
A({ action: 'reopenLocation', kind: 'event', id: 'ev_0' });
t.push(['reopening puts it back where it was', evs().join() === 'Zeta Fair,Mid Fest,Beta Kirtan,Alpha Mela']);

['Wales', 'Austria', 'Malta'].forEach((n, i) => A({ action: 'createRegion', regionId: 'rg_' + i, whLoc: 'wh_' + i, name: n, currencies: 'EUR,USD' }));
const regs = () => A({ action: 'getState' }).state.regions.map(r => r.name);
const first = regs()[0];
A({ action: 'closeLocation', kind: 'region', id: 'rg_0' });
A({ action: 'closeLocation', kind: 'region', id: 'rg_1' });
t.push(['closed regions go below the open ones, A to Z', regs().join() === [first, 'Malta', 'Austria', 'Wales'].join()]);

let bad = 0;
t.forEach(([what, pass]) => { if (!pass) bad++; console.log((pass ? 'PASS ' : 'FAIL ') + what); });
console.log(bad ? bad + ' failed' : 'all ' + t.length + ' passed');
process.exit(bad ? 1 : 0);
