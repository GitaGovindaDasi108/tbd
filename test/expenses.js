/* Expenses (b238): recording, receipts, paying back, Finance's rules and To do.
   The real server code (server/src/core.js) on Node's own SQLite, with a
   stand-in Google sign-in, as test/auth.js does. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });

(async () => {
  const quiet = console.log; console.log = () => {};
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const exec = (sql, ...p) => { const st = db.prepare(sql); return /^\s*select/i.test(sql) ? st.all(...p) : (st.run(...p), []); };
  const { makeServer } = await import(path.join(ROOT, 'server', 'src', 'core.js'));
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pub = Object.assign(await crypto.subtle.exportKey('jwk', pair.publicKey), { kid: 'k1', alg: 'RS256', use: 'sig' });
  const b64 = x => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
  async function token(email, name) {
    const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const body = b64({ iss: 'https://accounts.google.com', aud: 'client-123', email, name, email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600 });
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(head + '.' + body));
    return head + '.' + body + '.' + Buffer.from(sig).toString('base64url');
  }
  const fetchImpl = async url => {
    if (/oauth2\/v3\/certs/.test(url)) return { ok: true, status: 200, json: async () => ({ keys: [pub] }) };
    if (/open\.er-api/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ rates: { USD: 1, INR: 80, PLN: 4, EUR: 0.9 }, time_last_update_utc: 'today' }) };
    throw new Error('offline');
  };
  // The practice space (b238: expenses are tried there first). A live server alongside, which refuses them.
  const srv = makeServer({ exec, timeZone: 'UTC', fetchImpl, googleClientId: 'client-123', adminEmails: 'owner@example.com', practice: true });
  const liveDb = new DatabaseSync(':memory:');
  const live = makeServer({ exec: (sql, ...p) => { const st = liveDb.prepare(sql); return /^\s*select/i.test(sql) ? st.all(...p) : (st.run(...p), []); },
    timeZone: 'UTC', fetchImpl, googleClientId: 'client-123', adminEmails: 'owner@example.com' });
  await srv.warm();                     // today's rates, fetched ahead as the worker does
  console.log = quiet;
  const ask = async p => JSON.parse(await srv.request({ postData: { contents: JSON.stringify(p) } }));
  const sessionOf = async (email, name) => (await ask({ action: 'signIn', idToken: await token(email, name) })).result.session;

  const owner = await sessionOf('owner@example.com', 'The Owner');
  const O = p => ask(Object.assign({ s: owner }, p));
  await O({ action: 'saveSeason', name: 'Europe Tour' });
  const SA = (await O({ action: 'getState' })).state.activeSeason;
  await O({ action: 'createRegion', regionId: 'rg_in', whLoc: 'wh_in', name: 'Delhi', currencies: 'INR,USD', season: SA });
  await O({ action: 'createRegion', regionId: 'rg_pl', whLoc: 'wh_pl', name: 'Poland', currencies: 'PLN,EUR,USD', season: SA });
  await O({ action: 'createEvent', eventId: 'ev_cp', name: 'Chowpatty Program', regionId: 'rg_in', season: SA });
  await O({ action: 'setPayTypes', kind: 'region', id: 'rg_in', types: ['Cash', 'UPI', 'Card'], season: SA });
  await O({ action: 'peopleAdd', email: 'sita@example.com', name: 'Sita', role: 'S', placeId: 'ev_cp' });
  await O({ action: 'peopleAdd', email: 'fin@example.com', name: 'Madhava', role: 'F', placeId: '' });
  await O({ action: 'peopleAdd', email: 'fa@example.com', name: 'Asst', role: 'FA', placeId: '' });
  await O({ action: 'peopleAdd', email: 'ra@example.com', name: 'Radha', role: 'RA', placeId: 'rg_pl' });
  const st = (await O({ action: 'getState' })).state;
  const book = st.books.find(b => !b.partnerId).id;
  await O({ action: 'adjustStockBulk', location: 'ev_cp', items: [{ bookId: book, delta: 5 }], override: true, season: SA });
  await O({ action: 'sell', saleId: 'sP1', location: 'ev_cp', bookId: book, pending: true, name: 'Arjuna', phone: '+91 1',
    legs: [{ type: 'UPI', cur: 'INR', amt: 300 }], season: SA });
  const sita = await sessionOf('sita@example.com', 'Sita'), fin = await sessionOf('fin@example.com', 'Madhava');
  const fa = await sessionOf('fa@example.com', 'Asst'), ra = await sessionOf('ra@example.com', 'Radha');
  const S = p => ask(Object.assign({ s: sita }, p)), Fi = p => ask(Object.assign({ s: fin }, p));
  const t = [];
  {
    const ls = (JSON.parse(await live.request({ postData: { contents: JSON.stringify({ action: 'signIn', idToken: await token('owner@example.com', 'O') }) } }))).result.session;
    const r0 = JSON.parse(await live.request({ postData: { contents: JSON.stringify({ s: ls, action: 'expOptions' }) } }));
    t.push(['the live server refuses expenses (practice space first)', !r0.ok && /practice space/.test(r0.error)]);
  }
  // A cost recorded the old way, before the two were one.
  await O({ action: 'saveCost', id: 'Cold1', location: 'ev_cp', category: 'Card machine fee', cur: 'INR', amt: 25, note: 'SumUp', season: SA });

  // A Seller: one place to record at, Delhi's rupees first, UPI and cash, never card.
  let r = await S({ action: 'expOptions' });
  t.push(['a Seller can open the expense form', r.ok && r.result.places.length === 1 && r.result.places[0].id === 'ev_cp']);
  t.push(['…labelled with event, region and season', r.ok && r.result.places[0].label === 'Chowpatty Program · Delhi · Europe Tour']);
  t.push(['…the currency starts at the region\'s own', r.ok && r.result.defaultCur === 'INR']);
  const ms = r.ok ? r.result.methods.map(m => m.name) : [];
  t.push(['…cash, UPI and a bank transfer are offered; card and gift never', ms.includes('Cash') && ms.includes('UPI') && ms.includes('Bank transfer') && !ms.includes('Card') && !ms.includes('Gift')]);
  t.push(['…UPI asks for the UPI ID, and arrives in rupees', r.ok && r.result.methods.find(m => m.name === 'UPI').fields[0].k === 'upi' && r.result.methods.find(m => m.name === 'UPI').cur === 'INR']);
  t.push(['…cash asks for a phone number', r.ok && r.result.methods.find(m => m.name === 'Cash').fields[0].k === 'phone']);
  t.push(['…paid back in the region\'s currencies', r.ok && r.result.curs.join() === 'INR,USD']);
  t.push(['…and is not Finance (no list of people)', r.ok && !r.result.fin && !r.result.people.length]);

  // A receipt, then the expense.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64');
  r = await S({ action: 'receiptPut', id: 'Rabc1234', name: 'taxi.png', mime: 'image/png', data: png });
  t.push(['a receipt photo is kept', r.ok && r.result.id === 'Rabc1234']);
  r = await S({ action: 'receiptPut', id: 'Rbad1234', name: 'x.exe', mime: 'application/x-msdownload', data: png });
  t.push(['…a file that is not a photo or PDF is refused', !r.ok]);
  r = await S({ action: 'expSave', id: 'Xs1aaaaa', kind: 'reimburse', location: 'ev_cp', date: '2026-10-17', desc: 'Taxi with books',
    cur: 'INR', amt: 450, method: 'UPI', reimbCur: 'INR', payTo: {}, receipts: ['Rabc1234'] });
  t.push(['paying back by UPI without a UPI ID is refused', !r.ok && /UPI ID/.test(r.error)]);
  r = await S({ action: 'expSave', id: 'Xs1aaaaa', kind: 'reimburse', location: 'ev_cp', date: '2026-10-17', desc: 'Taxi with books',
    cur: 'INR', amt: 450, method: 'UPI', reimbCur: 'GBP', payTo: { upi: 'sita@okbank' }, receipts: ['Rabc1234'] });
  t.push(['…as is a currency Finance does not pay in here', !r.ok && /currency/.test(r.error)]);
  r = await S({ action: 'expSave', id: 'Xs1aaaaa', kind: 'reimburse', location: 'wh_pl', date: '2026-10-17', desc: 'x', cur: 'INR', amt: 1, method: 'Cash', reimbCur: 'INR', payTo: { phone: '1' } });
  t.push(['…and a place outside the Seller\'s reach', !r.ok]);
  r = await S({ action: 'expSave', id: 'Xs1aaaaa', kind: 'reimburse', location: 'ev_cp', date: '2026-10-17', desc: 'Taxi with books',
    cur: 'INR', amt: 450, method: 'UPI', reimbCur: 'INR', payTo: { upi: 'sita@okbank', name: 'Sita D' }, notes: 'Two trips', receipts: ['Rabc1234'] });
  t.push(['a Seller records an expense to be paid back', r.ok && r.result.status === 'pending' && r.result.byName === 'Sita' && r.result.byEmail === 'sita@example.com']);
  t.push(['…with the place, payment details and receipt on it', r.ok && r.result.placeLabel === 'Chowpatty Program · Delhi · Europe Tour' &&
    r.result.payTo.upi === 'sita@okbank' && r.result.receipts[0].name === 'taxi.png']);
  r = await S({ action: 'expSave', id: 'Xs2aaaaa', kind: 'record', location: 'ev_cp', desc: 'Tape', cur: 'INR', amt: 40 });
  t.push(['…and one for the records only', r.ok && r.result.status === 'recorded' && !r.result.method]);
  r = await S({ action: 'expList' });
  t.push(['she sees her own expenses', r.ok && r.result.length === 2]);
  r = await S({ action: 'expTodo' });
  t.push(['…but not the Finance To do', !r.ok]);
  r = await S({ action: 'receiptGet', id: 'Rabc1234' });
  t.push(['…and can open her receipt again', r.ok && r.result.data === png && r.result.mime === 'image/png']);

  // A regional assistant, who cannot use the rest of the app yet, can still record one.
  r = await ask({ s: ra, action: 'getState' });
  t.push(['a Regional Assistant still cannot open the app (Stage 2)', !r.ok && r.noAccess]);
  r = await ask({ s: ra, action: 'expOptions' });
  t.push(['…but can open the expense form, for Poland and its places', r.ok && r.result.places.map(x => x.id).join() === 'rg_pl' && r.result.defaultCur === 'PLN']);

  // A sales link (no sign-in), with the name the phone was given.
  const link = (await O({ action: 'setKey', kind: 'event', id: 'ev_cp', season: SA })).result;
  r = await ask({ k: link, by: 'Gopal', action: 'expSave', id: 'Xk1aaaaa', kind: 'reimburse', location: 'ev_cp', desc: 'Chai for helpers',
    cur: 'INR', amt: 120, method: 'Cash', reimbCur: 'INR', payTo: { phone: '+91 98' } });
  t.push(['a sales link records an expense under the name it was given', r.ok && r.result.byName === 'Gopal' && !r.result.byEmail]);
  r = await ask({ k: link, by: 'Gopal', action: 'expList' });
  t.push(['…and sees it', r.ok && r.result.length === 1]);
  r = await ask({ k: 'nonsense', by: 'X', action: 'expOptions' });
  t.push(['a broken link is refused', !r.ok]);

  // Finance.
  r = await Fi({ action: 'getState' });
  t.push(['Finance still has no rest-of-app view (Stage 2)', !r.ok && r.noAccess]);
  r = await Fi({ action: 'expTodo' });
  t.push(['Finance\'s To do lists the payments still owed, in every season', r.ok && r.result.pending.length === 1 && r.result.pending[0].name === 'Arjuna' &&
    r.result.pending[0].owed[0].amt === 300 && r.result.pending[0].region === 'Delhi']);
  t.push(['…and the expenses still to pay back (not the record-only one)', r.ok && r.result.reimb.length === 2 && r.result.reimb.every(x => x.kind === 'reimburse')]);
  r = await Fi({ action: 'receiptGet', id: 'Rabc1234' });
  t.push(['Finance can open anyone\'s receipt', r.ok]);
  r = await ask({ s: ra, action: 'receiptGet', id: 'Rabc1234' });
  t.push(['…someone else cannot', !r.ok]);
  r = await Fi({ action: 'expOptions', location: 'ev_cp' });
  t.push(['Finance gets a list of people to record for', r.ok && r.result.people.some(x => x.email === 'sita@example.com' && x.name === 'Sita')]);
  t.push(['…and may record anywhere', r.ok && r.result.places.some(x => x.id === 'wh_pl' || x.id === 'rg_pl')]);
  r = await Fi({ action: 'expSave', id: 'Xf1aaaaa', kind: 'reimburse', location: 'rg_pl', forEmail: 'ra@example.com', desc: 'Van fuel',
    cur: 'PLN', amt: 200, method: 'Bank transfer', reimbCur: 'PLN', payTo: { holder: 'Radha', iban: 'PL00 1234' } });
  t.push(['Finance records one on someone\'s behalf', r.ok && r.result.forName === 'Radha' && r.result.byName === 'Madhava']);
  r = await ask({ s: ra, action: 'expList' });
  t.push(['…and it is in that person\'s own list', r.ok && r.result.length === 1 && r.result[0].id === 'Xf1aaaaa']);
  r = await S({ action: 'expSave', id: 'Xs3aaaaa', kind: 'record', location: 'ev_cp', forEmail: 'ra@example.com', desc: 'x', cur: 'INR', amt: 1 });
  t.push(['someone not in Finance cannot record for another person', r.ok && !r.result.forEmail]);

  // Rules: no PayPal anywhere, no UPI in Delhi except for Sita; rupees only in Delhi.
  r = await Fi({ action: 'expRulesSet', rules: { levels: { '': { methods: { PayPal: false } }, rg_in: { methods: { UPI: false }, curs: ['INR'] } },
    people: { 'sita@example.com': { methods: { UPI: true } } } } });
  t.push(['Finance saves which ways and currencies are offered', r.ok && r.result.rules.levels.rg_in.curs.join() === 'INR']);
  r = await ask({ s: fa, action: 'expRulesSet', rules: {} });
  t.push(['…the Finance Assistant may see them but not change them', !r.ok && (await ask({ s: fa, action: 'expRulesGet' })).ok]);
  r = await S({ action: 'expOptions' });
  const ms2 = r.ok ? r.result.methods.map(m => m.name) : [];
  t.push(['Sita, overridden, keeps UPI in Delhi; PayPal is gone', ms2.includes('UPI') && !ms2.includes('PayPal') && r.result.curs.join() === 'INR']);
  r = await ask({ k: link, by: 'Gopal', action: 'expOptions' });
  t.push(['…a link in Delhi has no UPI', r.ok && !r.result.methods.some(m => m.name === 'UPI')]);
  r = await ask({ k: link, by: 'Gopal', action: 'expSave', id: 'Xk2aaaaa', kind: 'reimburse', location: 'ev_cp', desc: 'x', cur: 'INR', amt: 5,
    method: 'UPI', reimbCur: 'INR', payTo: { upi: 'g@x' } });
  t.push(['…and the server refuses it too', !r.ok && /not offered/.test(r.error)]);

  // Paying back.
  r = await ask({ s: fa, action: 'expMark', id: 'Xs1aaaaa', status: 'paid' });
  t.push(['the Finance Assistant cannot mark one paid back', !r.ok]);
  r = await Fi({ action: 'expMark', id: 'Xs1aaaaa', status: 'paid', note: 'UPI ref 123' });
  t.push(['Finance marks one paid back, with a note', r.ok && r.result.status === 'paid' && r.result.doneBy === 'Madhava']);
  r = await S({ action: 'expDelete', id: 'Xs1aaaaa' });
  t.push(['…after which its owner cannot delete it', !r.ok]);
  r = await Fi({ action: 'expTodo' });
  t.push(['…and it leaves the To do', r.ok && !r.result.reimb.some(x => x.id === 'Xs1aaaaa') && r.result.reimb.length === 2]);
  r = await S({ action: 'expDelete', id: 'Xs2aaaaa' });
  t.push(['someone may delete their own unpaid expense', r.ok && (await S({ action: 'expList' })).result.length === 2]);
  r = await O({ action: 'expList', scope: 'all' });
  t.push(['Universal sees every expense, the cost recorded before among them', r.ok && r.result.length === 5 &&
    r.result.some(x => x.id === 'Cold1' && x.byName === 'Record Costs' && x.category === 'Card machine fee' && x.amt === 25)]);

  // One with Record Costs: every expense at a region or event is a cost too, so it comes off the net.
  let costs = (await O({ action: 'getState', season: SA })).state.costs;
  t.push(['an expense at an event is kept as a cost there (comes off the net)', costs.some(c => c.id === 'Xk1aaaaa' && c.location === 'ev_cp' && Number(c.amt) === 120)]);
  t.push(['…one at a region, against its warehouse', costs.some(c => c.id === 'Xf1aaaaa' && c.location === 'wh_pl')]);
  r = await Fi({ action: 'expMark', id: 'Xk1aaaaa', status: 'declined', note: 'No receipt' });
  costs = (await O({ action: 'getState', season: SA })).state.costs;
  t.push(['a declined expense leaves the costs', r.ok && !costs.some(c => c.id === 'Xk1aaaaa')]);
  await Fi({ action: 'expMark', id: 'Xk1aaaaa', status: 'pending' });
  costs = (await O({ action: 'getState', season: SA })).state.costs;
  t.push(['…and comes back if it is waiting again', costs.some(c => c.id === 'Xk1aaaaa')]);
  r = await S({ action: 'expOptions' });
  t.push(['the form offers the kinds of cost and the payment types', r.ok && r.result.categories.includes('Travel') && r.result.categories.includes('Card machine fee') && r.result.payTypes.includes('Card')]);
  const PT = (await O({ action: 'savePartner', regionId: 'rg_in', name: 'ISKCON Juhu', season: SA })).result;
  r = await S({ action: 'expOptions' });
  t.push(['…and the region\'s consignment groups', r.ok && r.result.partners.some(g => g.id === PT)]);
  r = await S({ action: 'expSave', id: 'Xs9aaaaa', kind: 'record', location: 'ev_cp', desc: 'Card fee for Juhu books', cur: 'INR', amt: 12,
    category: 'Card machine fee', payType: 'Card', partnerId: PT });
  costs = (await O({ action: 'getState', season: SA })).state.costs;
  t.push(['a group\'s expense is its cost (off what it is owed)', r.ok && costs.some(c => c.id === 'Xs9aaaaa' && c.partnerId === PT && c.category === 'Card machine fee' && c.payType === 'Card')]);
  r = await S({ action: 'expDelete', id: 'Xs9aaaaa' });
  costs = (await O({ action: 'getState', season: SA })).state.costs;
  t.push(['deleting the expense deletes its cost', r.ok && !costs.some(c => c.id === 'Xs9aaaaa')]);

  // The finance section's rows.
  r = await S({ action: 'finData' });
  t.push(['the finance figures are Finance\'s only', !r.ok]);
  r = await Fi({ action: 'finData' });
  const D = r.result;
  t.push(['Finance gets every sale as a row: place, title, books, dollars', r.ok && D.sales.some(x => x.id === 'sP1' && x.r === 'rg_in' && x.e === 'ev_cp' && x.q === 1 && x.pu > 0 && x.gu === 0)]);
  t.push(['…and every expense, in dollars', r.ok && D.expenses.some(x => x.id === 'Xf1aaaaa' && x.r === 'rg_pl' && x.usd > 0 && x.kind === 'reimburse')]);
  t.push(['…seasons, regions and events, each with its series', r.ok && D.seasons.some(x => x.name === 'Europe Tour' && x.series === 'Europe Tour') && D.events.some(x => x.id === 'ev_cp')]);
  await O({ action: 'saveSeason', name: 'Kartika 2025' }); await O({ action: 'saveSeason', name: 'Kartika 2026' });
  r = await Fi({ action: 'finData' });
  t.push(['seasons that repeat are one series (the year left out)', r.result.seasons.filter(x => x.series === 'Kartika').length === 2]);
  const k25 = r.result.seasons.find(x => x.name === 'Kartika 2025').id;
  r = await Fi({ action: 'finSeriesSet', kind: 'seasons', id: k25, series: 'Kartika (Vrindavan)' });
  t.push(['Finance can regroup one', r.ok && r.result.seasons.find(x => x.id === k25).series === 'Kartika (Vrindavan)']);
  r = await ask({ s: fa, action: 'finSeriesSet', kind: 'seasons', id: k25, series: 'x' });
  t.push(['…the Finance Assistant cannot', !r.ok]);

  // View as (practice, Universal only).
  r = await O({ action: 'viewAsList' });
  t.push(['Universal gets the list of people to view the app as', r.ok && r.result.people.some(x => x.email === 'sita@example.com')]);
  r = await O({ action: 'getState', va: { email: 'sita@example.com' } });
  t.push(['viewing as Sita, the app is hers: one event only', r.ok && r.state.role === 'seller' && r.state.lockedEvent === 'ev_cp']);
  r = await O({ action: 'me', va: { role: 'RL', placeId: 'rg_pl' } });
  t.push(['viewing as a role nobody holds: a Regional Lead for Poland', r.ok && r.result.grants.length === 1 && r.result.grants[0].role === 'RL' && !r.result.universal]);
  r = await O({ action: 'getState', va: { role: 'RL', placeId: 'rg_pl' } });
  t.push(['…who sees Poland\'s regional page', r.ok && r.state.role === 'coordinator' && r.state.lockedRegion === 'rg_pl']);
  r = await O({ action: 'getState', va: { role: 'F' } });
  t.push(['…as Finance: "Not quite yet", as a Finance person sees it', !r.ok && r.noAccess]);
  r = await S({ action: 'getState', va: { email: 'owner@example.com' } });
  t.push(['someone not Universal cannot view as anyone', r.ok && r.state.role === 'seller']);
  r = await O({ action: 'getState' });
  t.push(['…and afterwards Universal is Universal again', r.ok && (r.state.role || 'admin') === 'admin']);
  {
    const ls = (JSON.parse(await live.request({ postData: { contents: JSON.stringify({ action: 'signIn', idToken: await token('owner@example.com', 'O') }) } }))).result.session;
    const r1 = JSON.parse(await live.request({ postData: { contents: JSON.stringify({ s: ls, action: 'viewAsList' }) } }));
    t.push(['View as is refused on the live server', !r1.ok]);
  }

  // Receipts are not in the state, nor in the copies.
  const state = JSON.stringify((await O({ action: 'getState' })).state);
  t.push(['receipts never travel in the state', !state.includes(png.slice(0, 40))]);
  t.push(['the expense table is a normal app table (copied with the rest)', srv.app.dbHas_('_expenses')]);

  let bad = 0;
  t.forEach(([n, ok]) => { if (!ok) bad++; console.log((ok ? '  ok  ' : '  FAIL ') + n); });
  console.log(bad ? bad + ' of ' + t.length + ' failed' : 'expenses: all ' + t.length + ' passed');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
