/* Deleting a season in the app (b200): gone from the screen the moment the
   name is confirmed — the season list, Earthly HQ's summaries and its books
   in transit — with the save sent behind it. */
const { T } = require(__dirname + '/clientsim.js');
const sale = (id, loc) => ({ saleId: id, ts: 't', location: loc, type: 'SALE', bookId: 'b', qty: 1, p1type: 'Cash', p1cur: 'USD', p1amt: 10,
  p2type: '', p2cur: '', p2amt: 0, pending: false, paid: true, dueamt: 0, duecur: '', delivered: true });
const ship = (id, from, to) => ({ shipId: id, fromRegion: from, toRegion: to, status: 'IN_TRANSIT', mode: 'devotee', manifest: [] });
T.setUp({ seasonName: 'Earthly HQ', activeSeason: 'HQ', role: 'admin', books: [{ id: 'b', name: 'Gita', cat: 'big' }],
  payTypes: ['Cash'], currencies: ['USD'], rates: { perUsd: { USD: 1 } },
  seasons: [{ seasonId: 'real', name: 'Tour 2026', closedAt: '' }, { seasonId: 'test', name: 'Test Season', closedAt: '' }],
  regions: [{ regionId: 'rg_hq', name: 'Earthly HQ', whLoc: 'wh_hq', currencies: ['USD'], books: [] }],
  events: [], holders: [], partners: [], payouts: [], prices: {}, cash: [], costs: [], stockMoves: [], org: [], outstanding: {}, qr: [], keys: {}, allRegions: [],
  shipments: [ship('sh_a', 'rg_hq', 'rg_t'), ship('sh_b', 'rg_hq', 'rg_r')],
  inventory: [{ location: 'sh_a', bookId: 'b', qty: 7 }, { location: 'sh_b', bookId: 'b', qty: 2 }, { location: 'wh_hq', bookId: 'b', qty: 40 }],
  sales: [],
  everywhere: {
    seasons: [{ seasonId: 'real', name: 'Tour 2026', closedAt: '' }, { seasonId: 'test', name: 'Test Season', closedAt: '' }],
    regions: [{ regionId: 'rg_r', name: 'Italy', whLoc: 'w_r', seasonId: 'real', currencies: ['USD'] },
              { regionId: 'rg_t', name: 'Testland', whLoc: 'w_t', seasonId: 'test', currencies: ['USD'] },
              { regionId: 'rg_hq', name: 'Earthly HQ', whLoc: 'wh_hq', seasonId: 'HQ', currencies: ['USD'] }],
    events: [{ eventId: 'e_t', name: 'Fest', regionId: 'rg_t' }], holders: [], partners: [], costs: [],
    shipments: [ship('sh_a', 'rg_hq', 'rg_t'), ship('sh_b', 'rg_hq', 'rg_r')],
    sales: [sale('s1', 'w_r'), sale('s2', 'e_t')],
    inventory: [{ location: 'w_t', bookId: 'b', qty: 9 }, { location: 'w_r', bookId: 'b', qty: 3 }],
    currencies: ['USD'] } });
T.goTo('region', 'rg_hq');
T.deleteSeasonNow({ seasonId: 'test', name: 'Test Season' });
const S = T.getState(), ev = S.everywhere, t = [];
t.push(['the season leaves the list at once', !S.seasons.some(x => x.seasonId === 'test') && S.seasons.length === 1]);
t.push(['…and HQ\'s summaries', !ev.seasons.some(x => x.seasonId === 'test') && !ev.regions.some(r => r.regionId === 'rg_t')]);
t.push(['its sales and stock are gone from HQ', !ev.sales.some(x => x.saleId === 's2') && !ev.inventory.some(i => i.location === 'w_t')]);
t.push(['books in transit to it are gone from HQ', !S.shipments.some(x => x.shipId === 'sh_a') && !S.inventory.some(i => i.location === 'sh_a')]);
t.push(['other seasons keep theirs', S.shipments.some(x => x.shipId === 'sh_b') && ev.sales.some(x => x.saleId === 's1')]);
t.push(['the deletion is on its way to the server', T.ops().length === 1]);
t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
