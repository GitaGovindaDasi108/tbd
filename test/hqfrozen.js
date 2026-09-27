/* At Earthly HQ a closed season's dollars stay at the rates it was frozen at,
   so HQ adds up to exactly what each season shows for itself (b196). */
const { T, store } = require(__dirname + '/clientsim.js');
const sale = (id, loc, cur, amt) => ({ saleId: id, ts: 't', location: loc, type: 'SALE', bookId: 'b', qty: 1,
  p1type: 'Cash', p1cur: cur, p1amt: amt, p2type: '', p2cur: '', p2amt: 0, pending: false, paid: true,
  dueamt: 0, duecur: '', delivered: true, name: '', phone: '', comments: '' });
T.setUp({ seasonName: 'Earthly HQ', activeSeason: 'HQ', role: 'admin', books: [{ id: 'b', name: 'Gita', cat: 'big' }],
  payTypes: ['Cash'], currencies: ['INR', 'USD'], rates: { perUsd: { EUR: 0.8, INR: 80, USD: 1 } },
  seasons: [{ seasonId: 'old', name: 'Tour 2025', closedAt: '2025-12-01' }, { seasonId: 'now', name: 'Tour 2026', closedAt: '' }],
  regions: [{ regionId: 'rg_hq', name: 'Earthly HQ', whLoc: 'wh_hq', currencies: ['INR', 'USD'], books: [] }],
  events: [], holders: [], shipments: [], partners: [], payouts: [], prices: {}, inventory: [],
  sales: [sale('h1', 'wh_hq', 'INR', 800)], cash: [], costs: [], stockMoves: [], org: [], outstanding: {}, qr: [], keys: {}, allRegions: [],
  everywhere: {
    seasons: [{ seasonId: 'old', name: 'Tour 2025', closedAt: '2025-12-01', rates: { EUR: 0.5, USD: 1 } },
              { seasonId: 'now', name: 'Tour 2026', closedAt: '', rates: null }],
    regions: [{ regionId: 'r1', name: 'Italy', whLoc: 'w1', seasonId: 'old', currencies: ['EUR'] },
              { regionId: 'r2', name: 'Italy', whLoc: 'w2', seasonId: 'now', currencies: ['EUR'] },
              { regionId: 'rg_hq', name: 'Earthly HQ', whLoc: 'wh_hq', seasonId: 'HQ', currencies: ['INR', 'USD'] }],
    events: [], holders: [], partners: [], shipments: [], costs: [],
    sales: [sale('o1', 'w1', 'EUR', 35), sale('n1', 'w2', 'EUR', 35)],
    inventory: [], currencies: ['USD', 'EUR', 'INR'] } });
T.goTo('region', 'rg_hq');
store['#x'] = store['#x'] || undefined;
T.withRollup(() => T.renderCollectionsByRegion('#x'));
const h = (require(__dirname + '/clientsim.js').store['#x'] || {}).innerHTML || '';
const row = name => { const m = h.match(new RegExp('>' + name + '</a></th>([\\s\\S]*?)</tr>')); return m ? m[1] : ''; };
const t = [];
t.push(['a closed season: 35 EUR at its frozen 0.5 = $70', /\$70(\.00)?</.test(row('Tour 2025'))]);
t.push(['an open season: 35 EUR at today\'s 0.8 = $43.75', /\$43\.75/.test(row('Tour 2026'))]);
t.push(['HQ\'s own: 800 INR at 80 = $10', /\$10(\.00)?</.test(row('Earthly HQ'))]);
t.push(['all seasons add up: $123.75', /All seasons[\s\S]*\$123\.75/.test(h)]);
t.push(['the page\'s own state is untouched afterwards', T.isHQ() && !h.includes('undefined')]);
t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
