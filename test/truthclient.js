/* Dollars from the truth (b198), in the app: dollars received first, then a
   closed region's frozen rates, then a closed season's, then today's — in the
   tiles, the collections table, the payments table, the report, and at HQ. */
const { T, store } = require(__dirname + '/clientsim.js');
let k = 0;
const sale = (loc, cur, amt, o) => Object.assign({ saleId: 's' + (k++), ts: 't', location: loc, type: 'SALE', bookId: 'b', qty: 1,
  p1type: 'Cash', p1cur: cur, p1amt: amt, p2type: '', p2cur: '', p2amt: 0, pending: false, paid: true,
  dueamt: 0, duecur: '', delivered: true, name: '', phone: '', comments: '', bundle: '' }, o || {});
// Today: 0.8 EUR to the dollar. Italy closed when it was 0.5.
const base = {
  seasonName: 'Tour', activeSeason: 'sA', role: 'admin', books: [{ id: 'b', name: 'Gita', cat: 'big' }],
  payTypes: ['Cash', 'Card'], currencies: ['EUR', 'USD'], rates: { perUsd: { EUR: 0.8, USD: 1 } },
  seasons: [{ seasonId: 'sA', name: 'Tour', closedAt: '' }],
  regions: [{ regionId: 'it', name: 'Italy', whLoc: 'w_it', currencies: ['EUR'], books: [], counts: {}, closedAt: '2026-05-01', rates: { EUR: 0.5, USD: 1 }, bookOrder: [] },
            { regionId: 'fr', name: 'France', whLoc: 'w_fr', currencies: ['EUR'], books: [], counts: {}, closedAt: '', bookOrder: [] }],
  events: [{ eventId: 'e_it', name: 'Rome', regionId: 'it', closedAt: '' }],
  holders: [], shipments: [], partners: [], payouts: [], prices: {}, inventory: [],
  sales: [sale('w_it', 'EUR', 40),                          // frozen: $80
          sale('e_it', 'EUR', 40, { usdActual: 70 }),        // received: $70 beats the frozen $80
          sale('w_fr', 'EUR', 40)],                          // open: today's $50
  costs: [{ id: 'c1', location: 'w_it', cur: 'EUR', amt: 10, category: 'Other', ts: 't' }],   // frozen: $20
  cash: [], stockMoves: [], org: [], outstanding: {}, qr: [], keys: { regions: {}, events: {}, sellers: {} }, allRegions: [] };
T.setUp(JSON.parse(JSON.stringify(base)));
const t = [];
T.goTo('season');
T.renderTotals();
const tiles = store['#totals'].innerHTML;
t.push(['Total Collections: $80 + $70 + $50 = $200', /Total Collections<\/div><div class="value">\$200(\.00)?</.test(tiles)]);
t.push(['costs at the frozen rate: −$20, net $180', /costs −\$20(\.00)?</.test(tiles) && /net \$180(\.00)?/.test(tiles)]);

T.renderCollectionsByRegion('#cbr');
const cbr = store['#cbr'].innerHTML;
const row = name => { const m = cbr.match(new RegExp('>' + name + '</a></th>([\\s\\S]*?)</tr>')); return m ? m[1] : ''; };
t.push(['collections: Italy $80 + $70 − $20 = $130', /\$130(\.00)?</.test(row('Italy'))]);
t.push(['collections: France at today\'s rate, $50', /\$50(\.00)?</.test(row('France'))]);

T.renderPayments('#pay');
const cells = [...store['#pay'].innerHTML.matchAll(/<div class="([^"]*)"[^>]*>([^<]*)</g)].map(m => ({ cls: m[1], text: m[2].trim() }));
const cashUsd = cells.find(c => /\busd\b/.test(c.cls) && /ptg-r/.test(c.cls));
t.push(['payments: the Cash row is $200', cashUsd && Number(cashUsd.text.replace(/[^0-9.\-]/g, '')) === 200]);
const italyKid = (() => { const i = cells.findIndex(c => c.text === 'Italy' && /ptg-s/.test(c.cls)); return i < 0 ? null : cells.slice(i + 1).find(c => /\busd\b/.test(c.cls)); })();
t.push(['payments: its Italy line is $150, and adds up', italyKid && Number(italyKid.text.replace(/[^0-9.\-]/g, '')) === 150]);
const costCell = cells.find(c => /usd ptg-cost/.test(c.cls));
t.push(['payments: costs −$20', costCell && /−\$20(\.00)?$/.test(costCell.text)]);

const rep = T.buildReport();
t.push(['report: Total ≈ $200', /Total[^\n]*≈ \$200(\.00)?\b/.test(rep)]);
t.push(['report: Italy after costs ≈ $130', /Italy[^\n]*≈ \$130(\.00)?\b/.test(rep)]);
t.push(['report: Net after costs ≈ $180', /Net after costs[^\n]*≈ \$180(\.00)?\b/.test(rep)]);

// Reopened: the rates go, and Italy counts at today's rate again.
const open = JSON.parse(JSON.stringify(base)); open.regions[0].closedAt = ''; delete open.regions[0].rates;
T.setUp(open); T.goTo('season'); T.renderTotals();
t.push(['open again: $50 + $70 + $50 = $170', /Total Collections<\/div><div class="value">\$170(\.00)?</.test(store['#totals'].innerHTML)]);

// At HQ: a closed region's rates come before its closed season's.
T.setUp({ seasonName: 'Earthly HQ', activeSeason: 'HQ', role: 'admin', books: [{ id: 'b', name: 'Gita', cat: 'big' }],
  payTypes: ['Cash'], currencies: ['INR', 'USD'], rates: { perUsd: { EUR: 0.8, INR: 80, USD: 1 } },
  seasons: [{ seasonId: 'old', name: 'Tour 2025', closedAt: '2025-12-01' }],
  regions: [{ regionId: 'rg_hq', name: 'Earthly HQ', whLoc: 'wh_hq', currencies: ['INR', 'USD'], books: [] }],
  events: [], holders: [], shipments: [], partners: [], payouts: [], prices: {}, inventory: [],
  sales: [], cash: [], costs: [], stockMoves: [], org: [], outstanding: {}, qr: [], keys: {}, allRegions: [],
  everywhere: {
    seasons: [{ seasonId: 'old', name: 'Tour 2025', closedAt: '2025-12-01', rates: { EUR: 0.4, USD: 1 } }],
    regions: [{ regionId: 'r1', name: 'Italy', whLoc: 'w1', seasonId: 'old', currencies: ['EUR'], closedAt: '2025-06-01', rates: { EUR: 0.5, USD: 1 } },
              { regionId: 'r2', name: 'Spain', whLoc: 'w2', seasonId: 'old', currencies: ['EUR'], closedAt: '', rates: null },
              { regionId: 'rg_hq', name: 'Earthly HQ', whLoc: 'wh_hq', seasonId: 'HQ', currencies: ['INR', 'USD'] }],
    events: [], holders: [], partners: [], shipments: [],
    costs: [{ id: 'c2', location: 'w2', cur: 'EUR', amt: 4, category: 'Other', ts: 't' }],
    sales: [sale('w1', 'EUR', 40), sale('w2', 'EUR', 40), sale('w2', 'EUR', 40, { usdActual: 99 })],
    inventory: [], currencies: ['USD', 'EUR', 'INR'] } });
T.goTo('region', 'rg_hq');
T.withRollup(() => T.renderCollectionsByRegion('#hq'));
const h = store['#hq'].innerHTML;
const hrow = name => { const m = h.match(new RegExp('>' + name + '</a></th>([\\s\\S]*?)</tr>')); return m ? m[1] : ''; };
// Italy (region frozen 0.5) $80 + Spain (season frozen 0.4) $100 + received $99 − cost 4 EUR at 0.4 = $10 → $269
t.push(['HQ: region rates, then season rates, then received, less costs = $269', /\$269(\.00)?</.test(hrow('Tour 2025'))]);
t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
