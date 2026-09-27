/* The Earthly HQ spreadsheet (b199): one file at the top of the folder, its
   first tab every season added up (the Summaries Portal as a sheet), then
   HQ's own Summary and warehouse tab. Rebuilt by the same sync as the rest. */
const m = require(__dirname + '/mini.js');
m.init();
const t = [];
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason, W = st.regions[0].whLoc, B = st.books[0].id;
const inSeason = p => m.call(Object.assign({ season: SA }, p));
const atHQ = p => m.call(Object.assign({ season: 'HQ' }, p));
const hqFile = () => Object.values(SpreadsheetApp._files).find(f => /Earthly HQ — Book Sales/.test(f.getName()));
const quiet = () => m.run("propDel_('lastWriteAt'); tempDel_('tbs_rendering')");

inSeason({ action: 'setStockBulk', location: W, items: [{ bookId: B, qty: 5 }], override: true });
inSeason({ action: 'sell', saleId: 'S1', location: W, bookId: B, legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] });
m.sync(true);
t.push(['no HQ file until HQ has been opened', !hqFile()]);

m.call({ action: 'setSeason', seasonId: 'HQ' });
atHQ({ action: 'adjustStockBulk', location: 'wh_hq', items: [{ bookId: B, delta: 20 }], override: true, note: 'printer' });
atHQ({ action: 'sell', saleId: 'H1', location: 'wh_hq', bookId: B, legs: [{ type: 'Card', cur: 'USD', amt: 25 }] });
quiet(); m.sync(false);
let f = hqFile();
t.push(['the background sync makes the Earthly HQ file', !!f]);
const tabs = () => f.getSheets().map(s => s.getName());
// (The stand-in files do not keep tab order; orderTabs_ puts All Seasons first.)
t.push(['it has an All Seasons tab, kept by the tab tidy-up', f && tabs().includes('All Seasons')]);
t.push(['…then HQ\'s own Summary and warehouse', f && tabs().includes('Summary') && tabs().includes('Earthly HQ — Warehouse Sales')]);
t.push(['it sits at the top of the folder, not in a season\'s', f && !/Europe Tour/.test(f.getName())]);

const grid = () => f.getSheetByName('All Seasons').grid;
const rowOf = (g, label, from) => { const i = g.findIndex((r, j) => j >= (from || 0) && r[0] === label); return i < 0 ? null : g[i]; };
const sect = (g, name) => g.findIndex(r => r[0] === name);
let g = grid();
const headI = sect(g, 'TOTAL SALES BY TITLE') + 1;
t.push(['a column per season, then Earthly HQ, then Total', g[headI][1] === 'Europe Tour' && g[headI][2] === 'Earthly HQ' && g[headI][3] === 'Total']);
const title = g[headI + 1];
t.push(['Total Sales by Title: 1 in the season, 1 at HQ, 2 in all', title[1] === 1 && title[2] === 1 && title[3] === 2]);
const col = rowOf(g, 'Collected (USD)', sect(g, 'COLLECTIONS BY SEASON'));
t.push(['Collections by Season: $40, $25, $65', col && col[1] === 40 && col[2] === 25 && col[3] === 65]);
const sold = rowOf(g, 'Sold', sect(g, 'SALES BY SEASON'));
t.push(['Sales by Season: sold 1 and 1', sold && sold[1] === 1 && sold[2] === 1]);
const pay = sect(g, 'COLLECTIONS BY PAYMENT TYPE (USD)');
t.push(['Collections by Payment: Card $25 at HQ, Cash $40 in the season',
  rowOf(g, 'Card', pay)[2] === 25 && rowOf(g, 'Cash', pay)[1] === 40]);
const wh = rowOf(g, 'TOTAL', sect(g, 'SEASONAL WAREHOUSE OVERVIEW (books on hand)'));
t.push(['Seasonal Warehouse Overview: 4 in the season, 19 at HQ', wh && wh[1] === 4 && wh[2] === 19]);
t.push(['the headline adds it all up: $65', rowOf(g, 65) || g.some(r => r[0] === 65)]);

// A sale in the season: the season's files and HQ's are redrawn together.
inSeason({ action: 'sell', saleId: 'S2', location: W, bookId: B, legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] });
quiet(); m.sync(false);
g = grid();
t.push(['a season sale reaches the HQ file on the next sync', rowOf(g, 'Collected (USD)', sect(g, 'COLLECTIONS BY SEASON'))[3] === 105]);

// A manual Sync in a season refreshes it too.
inSeason({ action: 'sell', saleId: 'S3', location: W, bookId: B, legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] });
m.sync(true);
g = grid();
t.push(['…and so does a manual Sync sheet in a season', rowOf(g, 'Collected (USD)', sect(g, 'COLLECTIONS BY SEASON'))[3] === 145]);

// At HQ, the app's link to "this region's file" is the HQ file.
st = atHQ({ action: 'getState' }).state;
t.push(['HQ\'s spreadsheet link is the Earthly HQ file', st.sheetLinks && st.sheetLinks.regions.rg_hq === f.getId()]);
const map = m.call({ action: 'driveMap' }).result;
t.push(['the Spreadsheet folders map lists it', map && map.hq && /Earthly HQ/.test(map.hq.name) && map.hq.url.includes(f.getId())]);
t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
