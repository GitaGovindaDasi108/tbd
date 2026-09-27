/* Dollars from the truth (b198), on the server.

   In order of trust: dollars actually received; the rates a closed region was
   frozen at; a closed season's; today's. Closing a region keeps its rates,
   reopening lets them go, a region closed before this existed has them filled
   in from the day it closed, and the spreadsheets count from all of it. */
let RATES = { EUR: 0.8, PLN: 4 };          // what "today" answers, per dollar
const asked = [];
global.UrlFetchApp = { fetch: url => {
  asked.push(url);
  let body = null;
  const hist = url.match(/frankfurter\.app\/(\d{4}-\d{2}-\d{2})\?/);
  if (hist) body = { date: hist[1], rates: { EUR: 0.5, PLN: 2 } };        // the day it closed
  else if (/open\.er-api/.test(url)) body = { rates: Object.assign({ USD: 1 }, RATES), time_last_update_utc: 'today' };
  return { getResponseCode: () => body ? 200 : 404, getContentText: () => JSON.stringify(body) };
} };
const m = require(__dirname + '/mini.js');
m.init();
const t = [];
const today = r => { RATES = r; m.run("_fxMemo = null; tempDel_('fx_v4_' + allCurrencies_().join('-'))"); m.clear(); };
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason, PL = st.regions[0], W = PL.whLoc, B = st.books[0].id;
const call = p => m.call(Object.assign({ season: SA }, p));

call({ action: 'setStockBulk', location: W, items: [{ bookId: B, qty: 9 }], override: true });
call({ action: 'sell', saleId: 'S1', location: W, bookId: B, legs: [{ type: 'Cash', cur: 'EUR', amt: 40 }] });
call({ action: 'sell', saleId: 'S2', location: W, bookId: B, legs: [{ type: 'Card', cur: 'EUR', amt: 40 }] });
call({ action: 'setUsdActual', saleId: 'S2', usd: 45 });
call({ action: 'saveCost', id: 'C1', location: W, cur: 'EUR', amt: 8, category: 'Other' });

const summary = () => {
  m.sync(true);
  const f = Object.values(require('../test/mini.js').sheet ? SpreadsheetApp._files : {})
    .find(x => /Poland/.test(x.getName()));
  const sh = f && (f.getSheetByName('Summary') || f.getSheets()[0]);
  return sh ? sh.grid : [];
};
const rowAfter = (g, label) => { const i = g.findIndex(r => r[0] === label); return i >= 0 ? g[i] : null; };
const headRow = (g, first) => g.find(r => r[0] === first);

// Open: 40 EUR at 0.8 = $50; S2 counts the $45 that arrived.
let g = summary();
let tot = g[g.findIndex(r => r[0] === 'Total collections (USD)') + 1] || [];
t.push(['open region: $50 at today\'s rate + $45 received = $95', Math.abs(Number(tot[0]) - 95) < 0.01]);
let net = rowAfter(g, 'Net');
t.push(['costs at today\'s rate: 8 EUR = $10, net $85', net && Math.abs(Number(net[4]) - 85) < 0.01]);

// Close the region: today's rates are kept with it.
let r = call({ action: 'closeLocation', kind: 'region', id: PL.regionId, counts: {} });
const row = () => m.call({ action: 'getState', season: SA }).state.regions.find(x => x.regionId === PL.regionId);
t.push(['closing a region keeps its rates', r.ok && row().rates && row().rates.EUR === 0.8]);
today({ EUR: 0.4, PLN: 8 });
g = summary();
tot = g[g.findIndex(r => r[0] === 'Total collections (USD)') + 1] || [];
t.push(['rates move, a closed region does not: still $95', Math.abs(Number(tot[0]) - 95) < 0.01]);
net = rowAfter(g, 'Net');
t.push(['…and its costs stay $10 (net $85)', net && Math.abs(Number(net[4]) - 85) < 0.01]);
t.push(['its spreadsheet says the rates are frozen', g.some(x => /FROZEN when this region closed/.test(String(x[0])))]);
const byCur = rowAfter(g, 'EUR');
t.push(['collections by currency: EUR column is $95 too', byCur && Math.abs(Number(byCur[4]) - 95) < 0.01]);

// Reopen: back to today's.
call({ action: 'reopenLocation', kind: 'region', id: PL.regionId });
t.push(['reopening lets the rates go', !row().rates]);
g = summary();
tot = g[g.findIndex(r => r[0] === 'Total collections (USD)') + 1] || [];
t.push(['…so it counts at today\'s again: $100 + $45 = $145', Math.abs(Number(tot[0]) - 145) < 0.01]);

// A region closed before rates were kept: filled in from the day it closed.
call({ action: 'closeLocation', kind: 'region', id: PL.regionId, counts: {} });
const raw = m.mem ? null : m.sheet('_regions');
const cols = raw.grid[0], fi = cols.indexOf('frozenRates'), ri = raw.grid.findIndex(x => x[0] === PL.regionId);
raw.grid[ri][fi] = '';                              // as an older build left it
m.clear();
t.push(['(an old closed region has no rates)', !row().rates]);
asked.length = 0;
m.sync(false);
t.push(['the background sync looks up the day it closed', asked.some(u => /frankfurter\.app\/\d{4}-\d{2}-\d{2}\?from=USD&to=EUR/.test(u))]);
t.push(['…and keeps those rates', row().rates && row().rates.EUR === 0.5]);
g = summary();
tot = g[g.findIndex(r => r[0] === 'Total collections (USD)') + 1] || [];
t.push(['…so 40 EUR is $80 (+ $45 received) = $125', Math.abs(Number(tot[0]) - 125) < 0.01]);
asked.length = 0;
m.sync(false);
t.push(['it does not look again within the hour', !asked.some(u => /frankfurter\.app\/\d/.test(u))]);

// HQ gets the region's rates too.
const hq = m.call({ action: 'setSeason', seasonId: 'HQ' }).state;
const er = hq.everywhere.regions.find(x => x.regionId === PL.regionId);
t.push(['HQ is told the closed region\'s rates', er && er.rates && er.rates.EUR === 0.5]);

t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
