/* Pounds on a region's spreadsheet (b214; first written as b213 in another branch).

   "Cash on hand" and "Collections by payment type" had their columns fixed at
   PLN / EUR / USD, so a London region selling in GBP showed £0 in both — and
   its pounds were missing from the payment types' dollar column too. Both
   tables now have a column for every currency in the season. */
global.UrlFetchApp = { fetch: url => {
  const body = /open\.er-api/.test(url)
    ? { rates: { USD: 1, EUR: 0.8, PLN: 4, GBP: 0.75 }, time_last_update_utc: 'today' } : null;
  return { getResponseCode: () => body ? 200 : 404, getContentText: () => JSON.stringify(body) };
} };
const m = require(__dirname + '/mini.js');
m.init();
const t = [];
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason, B = st.books[0].id;
const call = p => m.call(Object.assign({ season: SA }, p));

call({ action: 'createRegion', regionId: 'rg_ldn', whLoc: 'wh_ldn', name: 'London', currencies: 'GBP,USD' });
call({ action: 'setStockBulk', location: 'wh_ldn', items: [{ bookId: B, qty: 9 }], override: true });
call({ action: 'sell', saleId: 'L1', location: 'wh_ldn', bookId: B, legs: [{ type: 'Cash', cur: 'GBP', amt: 35 }] });
call({ action: 'sell', saleId: 'L2', location: 'wh_ldn', bookId: B, legs: [{ type: 'Card', cur: 'GBP', amt: 30 }] });

m.sync(true);
const f = Object.values(SpreadsheetApp._files).find(x => /London/.test(x.getName()));
const sh = f && (f.getSheetByName('Summary') || f.getSheets()[0]);
const g = sh ? sh.grid : [];
const after = (band, first) => {
  const i = g.findIndex(r => r[0] === band);
  return i < 0 ? null : g.slice(i + 1).find(r => r[0] === first);
};
const cashHead = after('CASH ON HAND', 'Account') || [];
const cashWh = g[g.indexOf(cashHead) + 1] || [];
const payHead = after('COLLECTIONS BY PAYMENT TYPE', 'Type') || [];
const cashRow = after('COLLECTIONS BY PAYMENT TYPE', 'Cash') || [];
const cardRow = after('COLLECTIONS BY PAYMENT TYPE', 'Card') || [];
const gc = cashHead.indexOf('GBP'), gp = payHead.indexOf('GBP'), up = payHead.indexOf('USD equivalent');

t.push(['London has a spreadsheet', g.length > 0]);
t.push(['cash on hand has a GBP column', gc > 0]);
t.push(['…and the warehouse holds £35 cash', Number(cashWh[gc]) === 35]);
t.push(['cash on hand keeps the other currencies too', ['PLN', 'EUR', 'USD'].every(c => cashHead.includes(c))]);
t.push(['payment types have a GBP column', gp > 0]);
t.push(['Cash row: £35', Number(cashRow[gp]) === 35]);
t.push(['Card row: £30', Number(cardRow[gp]) === 30]);
t.push(['Card row\'s dollars count the pounds ($40)', Math.abs(Number(cardRow[up]) - 40) < 0.01]);

// Marking a balance paid, when both payments are already taken in other
// currencies, adds it to the first in that currency's own rate: 40 PLN owed =
// $10 = £7.50 (it used to be converted at the euro rate: €8).
call({ action: 'sell', saleId: 'L3', location: 'wh_ldn', bookId: B, dueamt: 40, duecur: 'PLN',
  legs: [{ type: 'Cash', cur: 'GBP', amt: 20 }, { type: 'Card', cur: 'USD', amt: 5 }] });
const r = call({ action: 'markPaid', saleId: 'L3', location: 'wh_ldn' });
const l3 = call({ action: 'getState' }).state.sales.find(x => x.saleId === 'L3') || {};
t.push(['a balance in złoty, marked paid onto a pounds payment, is converted at the pound rate (£20 + £7.50)', r.ok && Math.abs(Number(l3.p1amt) - 27.5) < 0.01]);

t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
