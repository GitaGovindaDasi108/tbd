/* Optional, needs Playwright + Chromium: node test/browser-b335.js
   b335 (Gita, 24 Nov: "I need the per-book expenses to go live"): on the LIVE
   app (no ?practice, live server), Add Stock offers the printing cost, Deliver
   and Transfer ask about shipping, Cost per Book and Finance › Expenses open,
   and nothing overflows at 390px and 1150px. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });
const shot = n => path.join(os.tmpdir(), 'tbs-b335-' + n + '.png');
const API = 'http://api.test/';

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
    if (/open\.er-api/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ rates: { USD: 1, INR: 80, EUR: 0.9 }, time_last_update_utc: 'today' }) };
    throw new Error('offline');
  };
  const srv = makeServer({ exec, timeZone: 'UTC', fetchImpl, googleClientId: 'client-123', adminEmails: 'owner@example.com', practice: false });
  await srv.warm();
  console.log = quiet;
  const ask = async p => JSON.parse(await srv.request({ postData: { contents: JSON.stringify(p) } }));
  const sessionOf = async (email, name) => (await ask({ action: 'signIn', idToken: await token(email, name) })).result.session;

  const owner = await sessionOf('owner@example.com', 'The Owner');
  const O = p => ask(Object.assign({ s: owner }, p));
  await O({ action: 'saveSeason', name: 'Kartika' });
  const SA = (await O({ action: 'getState' })).state.activeSeason;
  const st0 = (await O({ action: 'getState', season: SA })).state;
  const BIG = st0.books.filter(b => !b.partnerId && b.cat === 'big').map(b => b.id);
  await O({ action: 'createRegion', regionId: 'rg_in', whLoc: 'wh_in', name: 'Vrindavana', currencies: 'INR,USD', season: SA,
    prices: Object.fromEntries(BIG.map(b => [b, { INR: 500, USD: 8 }])) });
  // Mayapur carries only the first big book.
  await O({ action: 'createRegion', regionId: 'rg_my', whLoc: 'wh_my', name: 'Mayapur', currencies: 'INR,USD', season: SA, books: BIG[0],
    prices: { [BIG[0]]: { INR: 450, USD: 7 } } });
  await O({ action: 'createEvent', eventId: 'ev_k', name: 'Kirtan Mela', regionId: 'rg_in', season: SA });
  await O({ action: 'adjustStockBulk', location: 'wh_in', items: BIG.slice(0, 2).map(b => ({ bookId: b, delta: 20 })), override: true, season: SA, movePrefix: 'Mprint1' });
  const pr = await O({ action: 'expSave', id: 'Xprint1', kind: 'record', location: 'rg_in', date: '2026-11-01', desc: 'Printing', cur: 'INR', amt: 8000,
    category: 'Other', receipts: [], payTo: {}, forEmail: '*general', by: 'The Owner', bookLink: { k: 'print', src: 'm:Mprint1', shares: {} } });
  const r1 = await O({ action: 'transferMulti', moves: [{ from: 'wh_in', to: 'wh_my', bookId: BIG[1], qty: 3 }], season: SA });
  const state = async () => (await O({ action: 'getState', season: SA })).state;
  const reg = async id => ((await state()).regions || []).find(r => r.regionId === id);
  const t = [], errors = [];
  t.push(['a printing cost is saved on the books (' + (pr.ok ? 'ok' : pr.error) + ')', pr.ok]);
  t.push(['a title transferred in is carried by Mayapur (' + JSON.stringify((await reg('rg_my')).books) + ')', r1.ok && (await reg('rg_my')).books.includes(BIG[1])]);
  const pm = ((await state()).prices || {}).rg_my || {};
  t.push(['…and takes the price its kind has there (' + JSON.stringify(pm[BIG[1]]) + ')', !!pm[BIG[1]] && pm[BIG[1]].INR === 450 && pm[BIG[1]].USD === 7]);
  const nb = await O({ action: 'addBook', name: 'Seasons', cat: 'big' });
  const pv = ((await state()).prices || {}).rg_in || {};
  t.push(['a new big book takes the big books\' one price in Vrindavana (' + JSON.stringify(pv[nb.result]) + ')', !!pv[nb.result] && pv[nb.result].INR === 500 && pv[nb.result].USD === 8]);
  await O({ action: 'transferMulti', moves: [{ from: 'wh_in', to: 'ev_k', bookId: BIG[0], qty: 5 }], season: SA });
  await O({ action: 'sell', saleId: 'P1', location: 'ev_k', bookId: BIG[0], isPreorder: true, legs: [{ type: 'Cash', cur: 'INR', amt: 500 }], name: 'Radha', season: SA });
  await O({ action: 'sell', saleId: 'S1', location: 'ev_k', bookId: BIG[0], legs: [{ type: 'Cash', cur: 'INR', amt: 500 }], name: 'Govinda', season: SA });
  await O({ action: 'sell', saleId: 'G1', location: 'ev_k', bookId: BIG[0], legs: [{ type: 'Gift', cur: 'INR', amt: 0 }], season: SA });
  await O({ action: 'saveCost', id: 'c1', location: 'ev_k', category: 'Other', cur: 'INR', amt: 100, note: 'tent', season: SA });

  const browser = await chromium.launch();
  async function open(email, name, width, opts) {
    opts = opts || {};
    const ctx = await browser.newContext(Object.assign({ viewport: { width: width || 1150, height: opts.height || 1000 } },
      opts.phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}));
    await ctx.addInitScript(tok => { window.__TOKEN = tok; }, await token(email, name));
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(email + ': ' + e.message));
    page.on('dialog', d => d.accept());
    await page.route('**/*', async route => {
      const req = route.request(), url = req.url();
      if (url.startsWith(API)) {
        const body = await srv.request({ postData: { contents: req.postData() || '{}' } });
        return route.fulfill({ status: 200, contentType: 'application/json', body, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
      if (/accounts\.google\.com\/gsi\/client/.test(url)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: `
        window.google = { accounts: { id: { initialize(o){ window.__gsi = o; },
          renderButton(el){ el.innerHTML = '<button id="fakeGsi">Sign in with Google</button>';
            el.querySelector('button').onclick = () => window.__gsi.callback({ credential: window.__TOKEN }); },
          prompt(){} } } };` });
      if (url.startsWith('http://app.test/')) {
        const rel = new URL(url).pathname.replace(/^\/+/, '') || 'index.html';
        if (rel === 'config.js') return route.fulfill({ status: 200, contentType: 'text/javascript',
          body: `window.TBS_CONFIG = { APPS_SCRIPT_URL: '${API}', GOOGLE_CLIENT_ID: 'client-123', POLL_SECONDS: 3600, LIVE_URL: '', PRACTICE_URL: '${API}' };` });
        const f = path.join(ROOT, rel);
        if (fs.existsSync(f) && fs.statSync(f).isFile())
          return route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : 'text/javascript' });
        return route.fulfill({ status: 404, body: '' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    await page.goto('http://app.test/index.html' + (opts.q || '')); await page.waitForTimeout(1500);
    await page.click('#fakeGsi'); await page.waitForTimeout(2500);
    return page;
  }
  const fits = pg => pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1
    && [...document.querySelectorAll('#modal .m-body, #totals .tcard')].every(e => e.scrollWidth <= e.clientWidth + 1));
  try {
    for (const w of [390, 1150]) {
      const pg = await open('owner@example.com', 'The Owner', w, {});
      t.push([w + 'px: this is the live app', await pg.evaluate(() => !PRACTICE && BC_ON && SHIP_ON)]);
      await pg.evaluate(() => switchSeason(STATE.seasons.find(s => s.name === 'Kartika').seasonId)); await pg.waitForTimeout(2000);
      await pg.evaluate(() => goTo('region', 'rg_in')); await pg.waitForTimeout(800);
      // Add Stock: the printing cost box.
      await pg.evaluate(() => addStockModal()); await pg.waitForTimeout(600);
      t.push([w + 'px: Add Stock offers the printing cost', await pg.evaluate(() => !!document.querySelector('#spBc'))]);
      await pg.evaluate(() => { const c = document.querySelector('#spBc'); if (c) { c.click(); } }); await pg.waitForTimeout(200);
      t.push([w + 'px: …and asks "Did this require shipping costs?"', await pg.evaluate(() => /Did this require shipping costs/.test(document.querySelector('#modal').textContent))]);
      t.push([w + 'px: the Add Stock window fits', await fits(pg)]);
      await pg.screenshot({ path: shot('addstock-' + w) });
      await pg.evaluate(() => closeModal());
      // Transfer: shipping question.
      await pg.evaluate(() => transferStockModal({fromLoc:'wh_in', toLoc:'ev_k'})); await pg.waitForTimeout(1600);
      t.push([w + 'px: Transfer asks "Did this require shipping costs?"', await pg.evaluate(() => /Did this require shipping costs/.test(document.querySelector('#modal').textContent))]);
      await pg.evaluate(() => { const r = document.querySelector('#modal input[name="xfShipQ"][value="1"]'); if (r) r.click(); }); await pg.waitForTimeout(200);
      t.push([w + 'px: …Yes asks the cost, "I don\'t know yet" and reimbursement', await pg.evaluate(() => !!document.querySelector('#xfShipMore') && !document.querySelector('#xfShipMore').hidden && !!document.querySelector('#xfShipUnk'))]);
      t.push([w + 'px: the Transfer window fits', await fits(pg)]);
      await pg.screenshot({ path: shot('transfer-' + w) });
      await pg.evaluate(() => closeModal());
      // Deliver a pre-order: shipping question.
      await pg.evaluate(() => goTo('event', 'ev_k')); await pg.waitForTimeout(800);
      await pg.evaluate(() => deliverModal('P1')); await pg.waitForTimeout(1500);
      t.push([w + 'px: Deliver asks "Did this require shipping costs?"', await pg.evaluate(() => /Did this require shipping costs/.test(document.querySelector('#modal').textContent))]);
      t.push([w + 'px: the Deliver window fits', await fits(pg)]);
      await pg.screenshot({ path: shot('deliver-' + w) });
      await pg.evaluate(() => closeModal());
      // Cost per Book.
      await pg.evaluate(() => costPerBookModal()); await pg.waitForTimeout(1800);
      t.push([w + 'px: Cost per Book opens', await pg.evaluate(() => /Cost per Book/i.test(document.querySelector('#modal').textContent))]);
      t.push([w + 'px: the Cost per Book window fits', await fits(pg)]);
      await pg.screenshot({ path: shot('costperbook-' + w) });
      await pg.evaluate(() => closeModal());
      // Finance › Expenses: the printing card.
      await pg.evaluate(() => finGo('expenses')); await pg.waitForTimeout(2500);
      t.push([w + 'px: Finance › Expenses shows the printing', await pg.evaluate(() => /Printing/.test(document.body.textContent))]);
      t.push([w + 'px: Finance › Expenses fits', await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1
        && [...document.querySelectorAll('.fin-card, .log-item, .fx-item')].every(e => e.scrollWidth <= e.clientWidth + 1))]);
      await pg.screenshot({ path: shot('finexp-' + w), fullPage: true });
      await pg.context().close();
    }
  } catch (e) {
    console.log('STOPPED:', e.message.split('\n').slice(0, 14).join('\n'));
    t.push(['test ran to the end', false]);
  }
  t.push(['no errors in the page' + (errors.length ? ' (' + errors.slice(0, 3).join(' | ') + ')' : ''), !errors.length]);
  await browser.close();
  let bad = 0;
  t.forEach(([n, ok]) => { if (!ok) bad++; console.log((ok ? 'PASS ' : 'FAIL ') + n); });
  console.log(bad ? bad + ' of ' + t.length + ' failed' : 'b335: all ' + t.length + ' passed');
  console.log('screenshots: ' + shot('*'));
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
