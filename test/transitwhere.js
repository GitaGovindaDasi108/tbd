/* Books in transit show only where they are headed (b208): at the region or
   event they are going to, and at the season they are going into — never at
   the region they left. */
const { T, store } = require(__dirname + '/clientsim.js');
const ship = (id, from, to, toLoc) => ({ shipId: id, fromRegion: from, toRegion: to, toLoc: toLoc || '', status: 'IN_TRANSIT',
  mode: 'devotee', carrier: 'Hari', manifest: { b: 2 } });
T.setUp({ seasonName: 'Tour', activeSeason: 'sA', role: 'admin', books: [{ id: 'b', name: 'Gita', cat: 'big' }],
  payTypes: ['Cash'], currencies: ['EUR'], rates: { perUsd: { EUR: 0.8, USD: 1 } },
  seasons: [{ seasonId: 'sA', name: 'Tour', closedAt: '' }],
  regions: [{ regionId: 'it', name: 'Italy', whLoc: 'w_it', currencies: ['EUR'], books: [], counts: {}, closedAt: '', bookOrder: [] },
            { regionId: 'es', name: 'Spain', whLoc: 'w_es', currencies: ['EUR'], books: [], counts: {}, closedAt: '', bookOrder: [] }],
  events: [{ eventId: 'e_es', name: 'Madrid Fest', regionId: 'es', closedAt: '' }],
  holders: [], partners: [], payouts: [], prices: {}, cash: [], costs: [], stockMoves: [], org: [], outstanding: {}, qr: [], keys: {}, allRegions: [], sales: [],
  shipments: [ship('sh1', 'it', 'es', 'e_es'),          // Italy -> Spain, for the Madrid festival
               ship('sh2', 'es', 'rg_hq')],              // Spain -> Earthly HQ (another "season")
  inventory: [{ location: 'sh1', bookId: 'b', qty: 2 }, { location: 'sh2', bookId: 'b', qty: 2 }] });
const ids = () => T.transitHere().map(r => r.x.shipId).sort().join(',');
const t = [];
T.goTo('region', 'it');
t.push(['Italy, which sent them, does not show them', ids() === '']);
T.goTo('region', 'es');
t.push(['Spain shows the batch coming to it, not the one it sent to HQ', ids() === 'sh1']);
T.goTo('event', 'e_es');
t.push(['the Madrid festival shows the batch aimed at it', ids() === 'sh1']);
T.goTo('season');
t.push(['the season shows only batches going into its own regions', ids() === 'sh1']);
T.goTo('region', 'es');
T.shipmentsModal();
const m = (store['#modal'] || {}).innerHTML || '';
t.push(['the Books in transit window has no "Sent from" list', !/Sent from/.test(m) && /Coming to Spain/.test(m)]);
t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
