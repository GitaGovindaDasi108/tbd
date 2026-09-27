/* Earthly HQ on the server (b196): made on first opening, a region of its own
   outside every season, with its own warehouse; sells, stocks and sends books
   to seasons like a region; carries every season's records for its summaries;
   can never be closed, deleted, or given events or regions. */
const m = require(__dirname + '/mini.js');
m.init();
const t = [];
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason, PL = st.regions[0], W = PL.whLoc, B = st.books[0].id;
const inSeason = p => m.call(Object.assign({ season: SA }, p));
const atHQ = p => m.call(Object.assign({ season: 'HQ' }, p));
const qty = (state, loc) => { const r = (state.inventory || []).find(i => i.location === loc && i.bookId === B); return r ? Number(r.qty) : 0; };

inSeason({ action: 'setStockBulk', location: W, items: [{ bookId: B, qty: 3 }], override: true });
inSeason({ action: 'sell', saleId: 'SP1', location: W, bookId: B, legs: [{ type: 'Cash', cur: 'PLN', amt: 150 }] });

let r = m.call({ action: 'setSeason', seasonId: 'HQ' });
const hq = r.state;
t.push(['opening HQ makes it: one region, Earthly HQ', r.ok && hq.regions.length === 1 && hq.regions[0].regionId === 'rg_hq' && hq.regions[0].name === 'Earthly HQ']);
t.push(['HQ is named as such', hq.activeSeason === 'HQ' && hq.seasonName === 'Earthly HQ']);
t.push(['HQ carries every season for its summaries', !!hq.everywhere && hq.everywhere.seasons.length === 1 &&
  hq.everywhere.sales.some(x => x.saleId === 'SP1')]);
t.push(['…but its own sales list holds only HQ sales', !(hq.sales || []).some(x => x.saleId === 'SP1')]);
t.push(['HQ knows every currency in use', ['PLN', 'EUR', 'USD', 'INR'].every(c => hq.currencies.includes(c))]);
t.push(['the season is not moved to HQ', m.call({ action: 'getState' }).state.activeSeason === SA]);
m.call({ action: 'setSeason', seasonId: 'HQ' });
t.push(['opening it again makes no second HQ', m.call({ action: 'getState', season: 'HQ' }).state.everywhere.regions.filter(x => x.regionId === 'rg_hq').length === 1]);

r = atHQ({ action: 'adjustStockBulk', location: 'wh_hq', items: [{ bookId: B, delta: 100 }], override: true, note: 'From the printer' });
t.push(['books from the printer go onto the HQ warehouse', r.ok && qty(atHQ({ action: 'getState' }).state, 'wh_hq') === 100]);
r = atHQ({ action: 'sell', saleId: 'SH1', location: 'wh_hq', bookId: B, legs: [{ type: 'Cash', cur: 'INR', amt: 3000 }] });
t.push(['HQ sells from its warehouse, in rupees', r.ok && atHQ({ action: 'getState' }).state.sales.some(x => x.saleId === 'SH1')]);
t.push(['an HQ sale is not in any season', !inSeason({ action: 'getState' }).state.sales.some(x => x.saleId === 'SH1')]);

r = atHQ({ action: 'transferMulti', moves: [{ from: 'wh_hq', to: W, bookId: B, qty: 10 }], movePrefix: 'hqx' });
t.push(['HQ sends books straight to a season\'s warehouse', r.ok && qty(inSeason({ action: 'getState' }).state, W) === 12]);
r = atHQ({ action: 'sendShipment', shipId: 'sh_hqbag1', fromRegion: 'rg_hq', toRegion: PL.regionId, mode: 'devotee', carrier: 'Madhava', items: [{ bookId: B, qty: 5 }] });
t.push(['…or in transit with a devotee', r.ok && qty(atHQ({ action: 'getState' }).state, 'wh_hq') === 84]);
r = inSeason({ action: 'receiveShipment', shipId: 'sh_hqbag1', items: [{ bookId: B, qty: 5 }] });
t.push(['…and the season receives it', r.ok && qty(inSeason({ action: 'getState' }).state, W) === 17]);

t.push(['HQ cannot be deleted', !atHQ({ action: 'deleteRegion', regionId: 'rg_hq', confirmName: 'Earthly HQ', force: true }).ok]);
t.push(['HQ cannot be closed', !atHQ({ action: 'closeLocation', kind: 'region', id: 'rg_hq', counts: {} }).ok]);
t.push(['HQ has no events', !atHQ({ action: 'createEvent', name: 'Fair', regionId: 'rg_hq' }).ok]);
t.push(['no region can be made at HQ', !atHQ({ action: 'createRegion', name: 'Nowhere', currencies: 'USD' }).ok]);
r = atHQ({ action: 'editRegion', regionId: 'rg_hq', name: 'Earthly HQ', currencies: 'INR,USD,EUR' });
t.push(['HQ\'s currencies are set like a region\'s', r.ok && atHQ({ action: 'getState' }).state.regions[0].currencies.includes('EUR')]);

// A link to HQ sees HQ, never every season.
const key = atHQ({ action: 'setKey', kind: 'region', id: 'rg_hq', key: 'khqlink000001' }).result;
const link = m.call({ action: 'getState', k: key }).state;
t.push(['an HQ link opens HQ', !!link && link.regions.length === 1 && link.regions[0].regionId === 'rg_hq']);
t.push(['…without every season\'s figures', link && !link.everywhere]);

// Seasons still read as before, and the spreadsheets still build.
const back = inSeason({ action: 'getState' }).state;
t.push(['a season\'s own view is unchanged (no HQ region, no everywhere)', !back.regions.some(x => x.regionId === 'rg_hq') && !back.everywhere]);
let synced = true; try { m.sync(true); } catch (e) { synced = false; console.log(e); }
t.push(['the readable spreadsheets still build', synced]);
t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
