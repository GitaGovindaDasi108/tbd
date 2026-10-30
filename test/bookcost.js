/* What each book cost (b320, practice first): a printing's cost per copy, each
   shipment's cost added by weight, oldest copies used first, postage on one
   sale, a returned shipment with a part refund, books from before with no
   cost, lost copies, and the live server keeping none of it.
   The real server code (server/src/core.js) on Node's own SQLite. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });

(async () => {
  const quiet = console.log; console.log = () => {};
  const { DatabaseSync } = require('node:sqlite');
  const mkExec = db => (sql, ...p) => { const st = db.prepare(sql); return /^\s*select/i.test(sql) ? st.all(...p) : (st.run(...p), []); };
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
  const mk = practice => makeServer({ exec: mkExec(new DatabaseSync(':memory:')), timeZone: 'UTC', fetchImpl,
    googleClientId: 'client-123', adminEmails: 'owner@example.com', practice });
  const srv = mk(true), live = mk(false);
  await srv.warm();
  console.log = quiet;
  const asker = s => async p => JSON.parse(await s.request({ postData: { contents: JSON.stringify(p) } }));
  const ask = asker(srv), askLive = asker(live);
  const owner = (await ask({ action: 'signIn', idToken: await token('owner@example.com', 'The Owner') })).result.session;
  const O = p => ask(Object.assign({ s: owner }, p));
  await O({ action: 'saveSeason', name: 'Europe Tour' });
  const SA = (await O({ action: 'getState' })).state.activeSeason;
  await O({ action: 'createRegion', regionId: 'rg_in', whLoc: 'wh_in', name: 'Delhi', currencies: 'INR,USD', season: SA });
  await O({ action: 'createRegion', regionId: 'rg_pl', whLoc: 'wh_pl', name: 'Poland', currencies: 'PLN,EUR,USD', season: SA });
  await O({ action: 'addBook', id: 'bk_seasons', name: 'Seasons (English)', cat: 'big', season: SA });
  const st = (await O({ action: 'getState' })).state;
  const old = st.books.find(b => !b.partnerId && b.id !== 'bk_seasons').id;
  const t = [];
  const wait = () => new Promise(r => setTimeout(r, 5));
  const near = (a, b, e) => Math.abs(a - b) < (e || 0.02);
  // The printing: 2,500 copies for 903,054 ₹ (361.22 ₹ a copy), and books from before alongside.
  await O({ action: 'adjustStockBulk', location: 'wh_in', items: [{ bookId: 'bk_seasons', delta: 2500 }], override: true, movePrefix: 'Mprint1', note: 'From the printer', season: SA });
  await O({ action: 'adjustStockBulk', location: 'wh_in', items: [{ bookId: old, delta: 100 }], override: true, season: SA });
  await wait();
  const X = (id, amt, link, extra) => O(Object.assign({ action: 'expSave', id, kind: 'record', location: 'rg_in', date: '2026-10-29',
    desc: 'Book costs', cur: 'INR', amt, forEmail: '*general', bookLink: link }, extra || {}));
  let r = await X('Xprint01', 903054, { k: 'print', src: 'm:Mprint1' });
  t.push(['Finance records the printing as an expense put on its books', r.ok && r.result.bookLink && r.result.bookLink.src === 'm:Mprint1']);
  r = await O({ action: 'bookCostOpts' });
  t.push(['the expense form lists the books brought in, and their copies', r.ok && r.result.printings.some(x => x.id === 'm:Mprint1' && x.books[0].q === 2500)]);

  // Poland: 142 copies, shipping and receiving 104,612 ₹ (736.70 ₹ a copy).
  await O({ action: 'sendShipment', mode: 'shipping', fromRegion: 'rg_in', toRegion: 'rg_pl', shipId: 'sh_pol001', items: [{ bookId: 'bk_seasons', qty: 142 }], season: SA });
  await wait();
  r = await X('Xship001', 104612, { k: 'ship', sh: 'sh_pol001' }, { weights: { bk_seasons: 900 } });
  t.push(['…and a shipment\'s cost, with the title\'s weight kept', r.ok]);
  await O({ action: 'receiveShipment', shipId: 'sh_pol001', toLoc: 'wh_pl', items: [{ bookId: 'bk_seasons', qty: 142 }], season: SA });
  await wait();
  await O({ action: 'sell', saleId: 'sPL1', location: 'wh_pl', bookId: 'bk_seasons', legs: [{ type: 'Cash', cur: 'PLN', amt: 100 }], season: SA });
  await O({ action: 'sell', saleId: 'sPL2', location: 'wh_pl', bookId: 'bk_seasons', legs: [{ type: 'Cash', cur: 'PLN', amt: 120 }], season: SA });
  await O({ action: 'sell', saleId: 'sIN1', location: 'wh_in', bookId: 'bk_seasons', legs: [{ type: 'Cash', cur: 'INR', amt: 500 }], season: SA });
  await O({ action: 'sell', saleId: 'sOLD', location: 'wh_in', bookId: old, legs: [{ type: 'Cash', cur: 'INR', amt: 500 }], season: SA });
  await wait();
  // One copy posted to a buyer: 1,100 ₹ postage.
  r = await X('Xpost001', 1100, { k: 'post', sale: 'sPL2' });
  r = await O({ action: 'bookCostSales' });
  const C = r.ok ? r.result.sales : {};
  t.push(['a copy sold in Poland cost 361.22 + 736.70 = 1,097.92 ₹', C.sPL1 && near(C.sPL1.o.INR, 1097.93)]);
  t.push(['…the one posted to a buyer 2,197.92 ₹', C.sPL2 && near(C.sPL2.o.INR, 2197.93)]);
  t.push(['…a copy sold straight from the printing 361.22 ₹', C.sIN1 && near(C.sIN1.o.INR, 361.22)]);
  t.push(['…a book from before has no cost (left out of profit)', !C.sOLD]);
  t.push(['…and each knows what it was sold for', C.sPL1 && C.sPL1.g > 0 && C.sPL1.u > 0]);

  // Sent back: 50 copies, 10,000 ₹ shipping, half refunded.
  await O({ action: 'sendShipment', mode: 'shipping', fromRegion: 'rg_in', toRegion: 'rg_pl', shipId: 'sh_ret001', items: [{ bookId: 'bk_seasons', qty: 50 }], season: SA });
  await wait();
  await X('Xship002', 10000, { k: 'ship', sh: 'sh_ret001' });
  const lo = (await askLive({ action: 'signIn', idToken: await token('owner@example.com', 'The Owner') })).result.session;
  r = await askLive({ s: lo, action: 'returnShipment', shipId: 'sh_ret001', toLoc: 'wh_in', items: [{ bookId: 'bk_seasons', qty: 1 }] });
  t.push(['the live app does not return shipments yet', !r.ok && /practice/.test(r.error || '')]);
  r = await O({ action: 'returnShipment', shipId: 'sh_ret001', toLoc: 'wh_in', items: [{ bookId: 'bk_seasons', qty: 50 }], refundCur: 'INR', refundAmt: 5000, date: '2026-10-29', season: SA });
  t.push(['a shipment comes back to the warehouse', r.ok && r.result.status === 'ARRIVED']);
  const st2 = (await O({ action: 'getState' })).state;
  t.push(['…and the shipment keeps what came back and the refund', (st2.shipments || []).some(x => x.shipId === 'sh_ret001' && x.returns && x.returns[0].refund.amt === 5000)]);

  // Books from before travel beside new ones: their share stays an expense.
  await O({ action: 'sendShipment', mode: 'shipping', fromRegion: 'rg_in', toRegion: 'rg_pl', shipId: 'sh_mix001', items: [{ bookId: 'bk_seasons', qty: 20 }, { bookId: old, qty: 20 }], season: SA });
  await wait();
  await X('Xship003', 400, { k: 'ship', sh: 'sh_mix001' }, { weights: { bk_seasons: 900, [old]: 900 } });
  await O({ action: 'receiveShipment', shipId: 'sh_mix001', toLoc: 'wh_pl', items: [{ bookId: 'bk_seasons', qty: 20 }, { bookId: old, qty: 20 }], season: SA });
  await wait();
  // Ten lost: their cost becomes a general expense.
  await O({ action: 'adjustStockBulk', location: 'wh_in', items: [{ bookId: 'bk_seasons', delta: -10 }], override: true, note: 'Damaged', season: SA });
  await wait();
  const F = (await O({ action: 'finData' })).result;
  const ex = id => F.expenses.find(x => x.id === id) || {};
  const per = ex('Xprint01').usd / 2500;
  t.push(['Net leaves out the printing on books still here or sold, not the 10 lost', near(ex('Xprint01').off, per * 2490, 0.05)]);
  t.push(['…the whole of Poland\'s shipping is on its books', near(ex('Xship001').off, ex('Xship001').usd, 0.05)]);
  t.push(['…the postage is on its sale', near(ex('Xpost001').off, ex('Xpost001').usd, 0.05)]);
  t.push(['…a returned shipment stays an expense, less the refund', near(ex('Xship002').off, ex('Xship002').usd / 2, 0.05)]);
  t.push(['…books from before keep their share of a shared shipment as an expense', near(ex('Xship003').off, ex('Xship003').usd / 2, 0.05)]);
  const sl = id => F.sales.find(x => x.id === id) || {};
  t.push(['Finance sees each sale\'s cost', near(sl('sPL1').cb, C.sPL1.u, 0.02) && sl('sOLD').cb === undefined]);
  t.push(['the expenses themselves stay whole', ex('Xprint01').amt === 903054 && ex('Xship001').amt === 104612]);

  // Undo the return: the copies go back on the road and the refund no longer counts.
  const acts = (await O({ action: 'activity', season: SA })).result || [];
  const ent = acts.find(e => e.action === 'returnShipment');
  if (ent) {
    await O({ action: 'undoActivity', id: ent.id, season: SA });
    const F2 = (await O({ action: 'finData' })).result;
    t.push(['undoing a return takes its refund away again', !(F2.expenses.find(x => x.id === 'Xship002') || {}).off]);
  } else t.push(['the return is in the Activity Log', false]);

  // The live server works none of this out.
  r = await askLive({ s: lo, action: 'bookCostSales' });
  t.push(['the live server keeps no book costs', r.ok && !r.result.on]);

  let bad = 0;
  t.forEach(([n, ok]) => { if (!ok) bad++; console.log((ok ? '  ok  ' : '  FAIL ') + n); });
  console.log(bad ? bad + ' of ' + t.length + ' failed' : 'bookcost: all ' + t.length + ' passed');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
