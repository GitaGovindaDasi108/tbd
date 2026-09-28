/* Payment types and the currency they arrive in (b210); the pre-order report.

   "$ Received" is for money that lands in a DOLLAR account (Zelle, PayPal...),
   not for card or cash, and not for an account in another currency (UPI in
   rupees). Each type's currency is set once for the whole tour. The pre-order
   report lists each person: name, phone, the book(s), and any comment. */
const { T } = require(__dirname + '/clientsim.js');
const m = require(__dirname + '/mini.js');
const t = [];

// ---- The app: which payments are "digital dollar" ones ----
let k = 0;
const sale = (type, cur, o) => Object.assign({ saleId: 's' + (k++), ts: 't', location: 'w', type: 'SALE', bookId: 'b', qty: 1,
  p1type: type, p1cur: cur, p1amt: 40, p2type: '', p2cur: '', p2amt: 0, pending: false, paid: true, delivered: true,
  name: '', phone: '', comments: '' }, o || {});
const base = { seasonName: 'Tour', activeSeason: 'sA', role: 'admin', books: [{ id: 'b', name: 'Sri Radha', cat: 'big' }, { id: 'c', name: 'Gita', cat: 'big' }],
  payTypes: ['Cash', 'Card', 'Zelle', 'UPI'], currencies: ['EUR', 'USD', 'INR'], rates: { perUsd: { EUR: 0.8, INR: 80, USD: 1 } },
  seasons: [{ seasonId: 'sA', name: 'Tour', closedAt: '' }],
  regions: [{ regionId: 'r', name: 'Italy', whLoc: 'w', currencies: ['EUR', 'USD'], books: [], counts: {}, closedAt: '', bookOrder: [] }],
  events: [], holders: [], partners: [], payouts: [], prices: {}, cash: [], costs: [], stockMoves: [], org: [], outstanding: {}, qr: [],
  keys: {}, allRegions: [], shipments: [], inventory: [], sales: [] };
T.setUp(JSON.parse(JSON.stringify(base)));
T.goTo('region', 'r');
t.push(['card: no "$ Received"', !T.digitalSale(sale('Card', 'EUR'))]);
t.push(['cash: no "$ Received"', !T.digitalSale(sale('Cash', 'EUR'))]);
t.push(['Zelle (a dollar account): "$ Received"', T.digitalSale(sale('Zelle', 'EUR')) && T.payTypeCur('Zelle') === 'USD']);
t.push(['UPI arrives in rupees: nothing to convert, no "$ Received"', !T.digitalSale(sale('UPI', 'INR')) && T.payTypeCur('UPI') === 'INR']);
T.setUp(Object.assign(JSON.parse(JSON.stringify(base)), { payTypeCur: { Zelle: 'none', Revolut: 'USD' } }));
T.goTo('region', 'r');
t.push(['a type set to "—" is not digital, whatever the starting guess', !T.digitalSale(sale('Zelle', 'EUR')) && T.payTypeCur('Zelle') === '']);
t.push(['a new type set to dollars is', T.digitalSale(sale('Revolut', 'EUR'))]);

// ---- The pre-order report ----
T.setUp(Object.assign(JSON.parse(JSON.stringify(base)), { sales: [
  sale('Cash', 'EUR', { type: 'PREORDER', delivered: false, name: 'Radha Devi', phone: '+48 600 100 200', comments: 'Collect Sunday', bundle: 'B1' }),
  sale('Cash', 'EUR', { type: 'PREORDER', delivered: false, name: 'Radha Devi', phone: '+48 600 100 200', comments: 'Collect Sunday', bundle: 'B1', bookId: 'c' }),
  sale('Cash', 'EUR', { type: 'PREORDER', delivered: false, name: '', phone: '' }),
  sale('Cash', 'EUR', { type: 'PREORDER', delivered: true, name: 'Done Already', phone: '+1' }) ] }));
T.goTo('region', 'r');
const rep = T.buildReport('preorders');
process.stdout.write('   report:\n' + rep.split('\n').map(x => '     ' + x).join('\n') + '\n');
t.push(['the report names the person', /1\. Radha Devi/.test(rep)]);
t.push(['…with their phone number', /📞 \+48 600 100 200/.test(rep)]);
t.push(['…the books they ordered together, on one line', /📖 Sri Radha, Gita/.test(rep)]);
t.push(['…and their comment', /💬 Collect Sunday/.test(rep)]);
t.push(['someone with no details is still listed, plainly', /2\. \(no name\)/.test(rep) && /📞 no number/.test(rep)]);
t.push(['a delivered pre-order is not listed', !/Done Already/.test(rep)]);
t.push(['the total counts books and people', /Total - 3 books for 2 people/.test(rep)]);

// ---- The server: setting a type's currency ----
const quiet = console.log; console.log = () => {};
m.init();
const SA = m.call({ action: 'getState' }).state.activeSeason;
let r = m.call({ action: 'setPayTypeCurrency', type: 'UPI', cur: 'inr', season: SA });
t.push(['an admin sets UPI to rupees for the whole tour', r.ok && m.call({ action: 'getState' }).state.payTypeCur.UPI === 'INR']);
r = m.call({ action: 'setPayTypeCurrency', type: 'Card', cur: '', season: SA });
t.push(['"—" is kept as "not digital"', r.ok && m.call({ action: 'getState' }).state.payTypeCur.Card === 'none']);
r = m.call({ action: 'setPayTypeCurrency', type: 'UPI', cur: 'rupees', season: SA });
t.push(['a currency that is not a 3-letter code is refused', r.ok === false]);
console.log = quiet;
t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
