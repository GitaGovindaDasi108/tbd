/* Optional, needs Playwright + Chromium: node test/browser-sellers.js
   b223: sales remember who made them; a Seller sees "My sales" and "My cash"
   instead of the event's totals, and hands cash to their Event Lead by name;
   the Event Lead confirms it; leads see Sales by Seller.

   The real page talks to the real server code (server/src/core.js, the same
   that runs on Cloudflare), in this process, with a stand-in Google sign-in. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });
const shot = n => path.join(os.tmpdir(), 'tbs-sellers-' + n + '.png');
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
    throw new Error('offline');
  };
  const srv = makeServer({ exec, timeZone: 'UTC', fetchImpl, googleClientId: 'client-123', adminEmails: 'owner@example.com' });
  console.log = quiet;
  const ask = async p => JSON.parse(await srv.request({ postData: { contents: JSON.stringify(p) } }));
  const sessionOf = async (email, name) => (await ask({ action: 'signIn', idToken: await token(email, name) })).result.session;

  // The tour: Italy, with Yoga Studio; Gita leads it; Sita and Tulasi sell there.
  const owner = await sessionOf('owner@example.com', 'The Owner');
  const O = p => ask(Object.assign({ s: owner }, p));
  await O({ action: 'saveSeason', name: 'Europe Tour' });
  const st0 = (await O({ action: 'getState' })).state, SA = st0.activeSeason;
  const B = st0.books.filter(b => !b.partnerId).map(b => b.id);
  await O({ action: 'createRegion', regionId: 'rg_it', whLoc: 'wh_it', name: 'Italy', currencies: 'EUR,USD', season: SA });
  await O({ action: 'createEvent', eventId: 'ev_yoga', name: 'Yoga Studio', regionId: 'rg_it', season: SA });
  await O({ action: 'adjustStockBulk', location: 'ev_yoga', items: B.slice(0, 3).map(b => ({ bookId: b, delta: 20 })), override: true, season: SA });
  await O({ action: 'peopleAdd', email: 'gita@example.com', name: 'Gita', role: 'EL', placeId: 'ev_yoga' });
  await O({ action: 'peopleAdd', email: 'sita@example.com', name: 'Sita', role: 'S', placeId: 'ev_yoga' });
  await O({ action: 'peopleAdd', email: 'tulasi@example.com', name: 'Tulasi', role: 'S', placeId: 'ev_yoga' });
  const tulasi = await sessionOf('tulasi@example.com', 'Tulasi');
  await ask({ s: tulasi, action: 'sell', saleId: 'sT1', location: 'ev_yoga', bookId: B[0], legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] });

  const browser = await chromium.launch();
  const t = [], errors = [];
  async function open(email, name, width) {
    const ctx = await browser.newContext({ viewport: { width: width || 1150, height: 1000 } });
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
          body: `window.TBS_CONFIG = { APPS_SCRIPT_URL: '${API}', GOOGLE_CLIENT_ID: 'client-123', POLL_SECONDS: 3600, LIVE_URL: '' };` });
        const f = path.join(ROOT, rel);
        if (fs.existsSync(f) && fs.statSync(f).isFile())
          return route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : 'text/javascript' });
        return route.fulfill({ status: 404, body: '' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    await page.goto('http://app.test/index.html'); await page.waitForTimeout(1500);
    await page.click('#fakeGsi'); await page.waitForTimeout(2500);
    return page;
  }
  const tiles = page => page.evaluate(() => document.querySelector('#totals').innerText.replace(/\s+/g, ' '));
  const refresh = async page => { await page.evaluate(() => pull()); await page.waitForTimeout(800); };

  try {
    /* ---- A Seller ---- */
    const sita = await open('sita@example.com', 'Sita Devi');
    await sita.evaluate(() => { const b = shelfBooks()[0].id; return b; });
    // Two cash sales and one by card, through the page's own saving path.
    await sita.evaluate(async b => {
      const loc = CUR_LOC;
      const one = (id, type, amt) => commit({ action: 'sell', saleId: id, location: loc, bookId: b, legs: [{ type, cur: 'EUR', amt }] },
        st => { st.sales.push({ saleId: id, ts: new Date().toISOString(), location: loc, type: 'SALE', bookId: b, qty: 1,
          p1type: type, p1cur: 'EUR', p1amt: amt, p2type: '', p2cur: '', p2amt: 0, pending: false, paid: true, delivered: true,
          soldBy: myName(), soldById: ME.email }); }, null);
      one('sS1', 'Cash', 35); one('sS2', 'Cash', 35); one('sS3', 'Card', 35);
    }, B[0]);
    await sita.waitForTimeout(2500); await refresh(sita);
    let tl = await tiles(sita);
    t.push(['a Seller\'s top bar shows "My sales": her own 3, not the event\'s 4', /my sales\s*3\s*sold/i.test(tl)]);
    t.push(['…and "My cash": the €70 she took in cash (the card sale is not cash)', /my cash\s*70\s*€/i.test(tl)]);
    t.push(['…and no event totals (no Total Collections)', !/total collections/i.test(tl)]);
    t.push(['…the button names her Event Lead', /Hand your cash to Gita/.test(tl)]);
    const st = (await O({ action: 'getState', season: SA })).state;
    t.push(['her sales carry her sign-in on the server', st.sales.filter(x => x.soldById === 'sita@example.com').length === 3 &&
      (st.sales.find(x => x.saleId === 'sT1') || {}).soldById === 'tulasi@example.com']);
    await sita.screenshot({ path: shot('1-seller') });

    await sita.click('[data-act="handover"]'); await sita.waitForTimeout(300);
    await sita.click('#hoGo'); await sita.waitForTimeout(2000); await refresh(sita);
    tl = await tiles(sita);
    t.push(['handing it over: "€70 waiting for Gita to confirm"', /waiting for Gita to confirm/.test(tl) && /my cash\s*—/i.test(tl)]);

    // Another Seller cannot confirm it.
    const hid = (await O({ action: 'getState', season: SA })).state.handovers[0].id;
    let r = await ask({ s: tulasi, action: 'handoverAnswer', id: hid, accept: true });
    t.push(['another Seller cannot confirm it', !r.ok && /Only the person/.test(r.error)]);
    r = await ask({ s: await sessionOf('sita@example.com'), action: 'handoverAnswer', id: hid, accept: true });
    t.push(['…nor can Sita herself', !r.ok]);

    /* ---- The Event Lead ---- */
    const gita = await open('gita@example.com', 'Gita');
    const hand = await gita.evaluate(() => (document.querySelector('#handPanel') || {}).innerText || '');
    t.push(['the Event Lead sees "Sita → Gita · €70" with a Received button', /Sita[\s\S]*Gita[\s\S]*70/.test(hand) && !!(await gita.$('#handList [data-act="hoyes"]'))]);
    const sellers = await gita.evaluate(() => (document.querySelector('#sellerPanel') || {}).innerText || '');
    t.push(['…and Sales by Seller: Sita and Tulasi, each with their own books and cash', /Sita/.test(sellers) && /Tulasi/.test(sellers)]);
    await gita.screenshot({ path: shot('2-lead'), fullPage: true });
    await gita.click('#handList [data-act="hoyes"]'); await gita.waitForTimeout(2000);
    r = (await O({ action: 'getState', season: SA })).state.handovers[0];
    t.push(['she taps Received: confirmed, with her name', r.status === 'received' && r.answeredBy === 'Gita']);

    await refresh(sita);
    tl = await tiles(sita);
    t.push(['Sita\'s "My cash" is now clear, nothing waiting', /my cash\s*—/i.test(tl) && !/waiting/.test(tl)]);
    // Renaming herself keeps her sales hers.
    await ask({ s: await sessionOf('sita@example.com'), action: 'setMyName', name: 'Sita D.' });
    await sita.reload(); await sita.waitForTimeout(2500);
    t.push(['after renaming herself, "My sales" still counts her 3', /my sales\s*3\s*sold/i.test(await tiles(sita))]);

    /* ---- The owner, at the region ---- */
    const own = await open('owner@example.com', 'The Owner');
    await own.evaluate(() => goTo('region', 'rg_it')); await own.waitForTimeout(600);
    const sb = await own.evaluate(() => document.querySelector('#sellerPanel').innerText);
    t.push(['the region\'s Sales by Seller: Sita handed €70, nothing still with her', /Sita[^\n]*\n?[\s\S]*70/.test(sb)]);
    await own.evaluate(() => { document.querySelector('#sellerPanel').scrollIntoView(); });
    await own.screenshot({ path: shot('3-region') });

    /* ---- b224: a closing count that does not match ---- */
    await O({ action: 'createEvent', eventId: 'ev_park', name: 'Park Stall', regionId: 'rg_it', season: SA });
    await O({ action: 'adjustStockBulk', location: 'ev_park', items: [{ bookId: B[0], delta: 10 }], override: true, season: SA });
    await O({ action: 'closeLocation', kind: 'event', id: 'ev_park', counts: { ['ev_park|' + B[0]]: 8 }, note: 'two missing', season: SA });
    await refresh(own);
    const cnt = await own.evaluate(() => (document.querySelector('#countPanel') || {}).innerText || '');
    t.push(['the region shows the count to look into: expected 10, counted 8', /Park Stall[\s\S]*expected\s*10[\s\S]*counted\s*8/i.test(cnt)]);
    await own.evaluate(() => document.querySelector('#countPanel').scrollIntoView());
    await own.screenshot({ path: shot('5-count') });
    await own.click('#countList [data-act="cntanswer"]'); await own.waitForTimeout(300);
    await own.click('#cntAccept'); await own.waitForTimeout(200);
    t.push(['accepting without a reason is refused', /Say what you found/.test(await own.evaluate(() => $('#modalErr').textContent))]);
    await own.fill('#cntWhy', 'two given to the temple'); await own.click('#cntAccept'); await own.waitForTimeout(2000);
    const after = (await O({ action: 'getState', season: SA })).state;
    const inv = (after.inventory || []).find(x => x.location === 'ev_park' && x.bookId === B[0]);
    t.push(['accepted: the stock is now 8, with the owner\'s name', inv && Number(inv.qty) === 8 &&
      after.mismatches[0].status === 'accepted' && after.mismatches[0].answeredBy === 'The Owner']);
    await refresh(own);
    t.push(['…and the panel is gone (nothing open)', await own.evaluate(() => document.querySelector('#countPanel').style.display === 'none')]);

    /* ---- b225: an event's own prices; a consignment group for one event ---- */
    await O({ action: 'createEvent', eventId: 'ev_cafe', name: 'Cafe', regionId: 'rg_it', season: SA });
    await O({ action: 'setPrices', regionId: 'rg_it', prices: { [B[1]]: { EUR: 15 } }, season: SA });
    const g = await O({ action: 'savePartner', regionId: 'rg_it', name: 'Yoga Friends', eventId: 'ev_yoga', season: SA });
    await O({ action: 'saveConsignBook', partnerId: g.result, name: 'Friends Songbook', cat: 'small', regionId: 'rg_it', location: 'ev_yoga', stock: 3, season: SA });
    await refresh(own);
    await own.evaluate(() => goTo('event', 'ev_yoga')); await own.waitForTimeout(500);
    await own.click('[data-act="eventprices"]'); await own.waitForTimeout(300);
    t.push(['Event Prices shows the region\'s price greyed in the blank box', await own.evaluate(b =>
      document.querySelector(`.ep[data-book="${b}"][data-cur="EUR"]`).placeholder === '15', B[1])]);
    await own.fill(`.ep[data-book="${B[1]}"][data-cur="EUR"]`, '12');
    await own.screenshot({ path: shot('6-prices') });
    await own.click('#epSave'); await own.waitForTimeout(2000);
    const ep = (await O({ action: 'getState', season: SA })).state.eventPrices;
    t.push(['saved on the server: 12 at Yoga Studio', ep && ep.ev_yoga[B[1]].EUR === 12]);
    t.push(['the shelf at Yoga Studio asks 12', await own.evaluate(b => priceFor(bookById(b), 'EUR'), B[1]) === 12]);
    t.push(['…the button counts it: "Event Prices (1 set)"', /Event Prices \(1 set\)/.test(await own.evaluate(() => document.querySelector('[data-act="eventprices"]').innerText))]);
    t.push(['…Yoga Friends\' title is on this shelf', await own.evaluate(() => shelfBooks().some(b => b.name === 'Friends Songbook'))]);
    await own.evaluate(() => goTo('event', 'ev_cafe')); await own.waitForTimeout(500);
    t.push(['at the Cafe it is still the region\'s 15', await own.evaluate(b => priceFor(bookById(b), 'EUR'), B[1]) === 15]);
    t.push(['…and Yoga Friends\' title is not offered there', await own.evaluate(() => !baseShelfBooks().some(b => b.name === 'Friends Songbook'))]);
    await own.click('[data-act="partners"]'); await own.waitForTimeout(300);
    t.push(['…nor is the group listed in its Consignment Books', !/Yoga Friends/.test(await own.evaluate(() => document.querySelector('.modal').innerText))]);
    await own.evaluate(() => closeModal());
    await own.evaluate(() => goTo('region', 'rg_it')); await own.waitForTimeout(500);
    await own.click('[data-act="partners"]'); await own.waitForTimeout(300);
    t.push(['at the region the group shows "Only at Yoga Studio"', /Yoga Friends[\s\S]*Only at Yoga Studio/.test(await own.evaluate(() => document.querySelector('.modal').innerText))]);
    await own.screenshot({ path: shot('7-consign') });
    await own.evaluate(() => closeModal());

    /* ---- Phone ---- */
    const phone = await open('sita@example.com', 'Sita', 390);
    await phone.screenshot({ path: shot('4-phone') });
    t.push(['phone: nothing wider than the screen', await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)]);
  } catch (e) {
    console.log('STOPPED:', e.message.split('\n').slice(0, 12).join('\n'));
    t.push(['test ran to the end', false]);
  }
  t.push(['no errors in the page', errors.length === 0]);
  if (errors.length) console.log('page errors:', errors);
  t.forEach(([n, okk]) => console.log((okk ? 'PASS' : 'FAIL'), n));
  console.log('screenshots:', shot('*'));
  await browser.close();
  if (t.some(x => !x[1])) process.exitCode = 1;
})();
