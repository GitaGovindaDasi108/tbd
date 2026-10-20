/* Optional, needs Playwright + Chromium: node test/browser-finance.js
   b253: the Finance page's first round of improvements, in the practice space.
   Regions and events in the app's own order; the place search before the
   dates; the Overview's seven figures (Big Books Sold, Adventures Sold,
   Donations, Pending Payments, Gross or Expected Gross with Current Collected,
   Expenses, Net with the margin); a WhatsApp report beside every part and the
   top 📋 Report reporting the section; pencils on the page, its windows and
   its passing messages. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });
const shot = n => path.join(os.tmpdir(), 'tbs-finance-' + n + '.png');
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
    if (/open\.er-api/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ rates: { USD: 1, INR: 80 }, time_last_update_utc: 'today' }) };
    throw new Error('offline');
  };
  const srv = makeServer({ exec, timeZone: 'UTC', fetchImpl, googleClientId: 'client-123', adminEmails: 'owner@example.com', practice: true });
  await srv.warm();
  console.log = quiet;
  const ask = async p => JSON.parse(await srv.request({ postData: { contents: JSON.stringify(p) } }));
  const sessionOf = async (email, name) => (await ask({ action: 'signIn', idToken: await token(email, name) })).result.session;

  // Kartika: Zagreb made first, Athens second, then Athens put first by hand —
  // the app's order, which Finance must follow. Then Pune, closed, comes last.
  const owner = await sessionOf('owner@example.com', 'The Owner');
  const O = p => ask(Object.assign({ s: owner }, p));
  await O({ action: 'saveSeason', name: 'Kartika' });
  const SA = (await O({ action: 'getState' })).state.activeSeason;
  await O({ action: 'createRegion', regionId: 'rg_zg', whLoc: 'wh_zg', name: 'Zagreb', currencies: 'USD', season: SA });
  await O({ action: 'createRegion', regionId: 'rg_at', whLoc: 'wh_at', name: 'Athens', currencies: 'USD', season: SA });
  await O({ action: 'reorder', kind: 'region', ids: ['rg_at', 'rg_zg'], season: SA });
  await O({ action: 'createEvent', eventId: 'ev_z2', name: 'Zagreb Fair', regionId: 'rg_zg', season: SA });
  await O({ action: 'createEvent', eventId: 'ev_z1', name: 'Zagreb Kirtan', regionId: 'rg_zg', season: SA });
  await O({ action: 'reorder', kind: 'event', ids: ['ev_z1', 'ev_z2'], season: SA });
  await O({ action: 'adjustStockBulk', location: 'ev_z1', items: [{ bookId: 'sr_en', delta: 20 }, { bookId: 'adv_en', delta: 20 }], override: true, season: SA });
  await O({ action: 'adjustStockBulk', location: 'wh_at', items: [{ bookId: 'sr_en', delta: 20 }], override: true, season: SA });
  const sell = (id, loc, book, p) => O(Object.assign({ action: 'sell', saleId: id, location: loc, bookId: book, season: SA }, p));
  await sell('z1', 'ev_z1', 'sr_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] });
  await sell('z2', 'ev_z1', 'sr_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] });
  await sell('z3', 'ev_z1', 'sr_en', { legs: [{ type: 'Gift', cur: 'USD', amt: 0 }] });
  await sell('z4', 'ev_z1', 'adv_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 15 }] });
  await sell('z5', 'ev_z1', 'sr_en', { pending: true, name: 'Arjuna', phone: '+385 1', legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] });
  await O({ action: 'donate', saleId: 'z6', location: 'ev_z1', legs: [{ type: 'Cash', cur: 'USD', amt: 10 }], season: SA });
  await sell('a1', 'wh_at', 'sr_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] });
  await O({ action: 'expSave', id: 'Xvan001', kind: 'record', date: '2026-10-19', desc: 'Van hire', amt: 20, cur: 'USD', location: 'ev_z1', category: 'Travel' });

  const browser = await chromium.launch();
  const t = [], errors = [];
  async function open(email, name, width) {
    const ctx = await browser.newContext({ viewport: { width: width || 1150, height: 1000 } });
    await ctx.addInitScript(tok => { window.__TOKEN = tok; }, await token(email, name));
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(email + ': ' + e.message));
    page.on('dialog', d => d.accept(d.type() === 'prompt' ? 'UPI ref 4471' : undefined));
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
    await page.goto('http://app.test/index.html?practice'); await page.waitForTimeout(1500);
    await page.click('#fakeGsi'); await page.waitForTimeout(2500);
    return page;
  }
  const fpage = page => page.evaluate(() => document.querySelector('#fpBody').innerText);
  const repText = page => page.$eval('#repText', e => e.value);
  try {
    const own = await open('owner@example.com', 'The Owner');
    await own.evaluate(() => finGo('overview', '')); await own.waitForTimeout(1500);
    // Into Kartika: its regions, in the app's order.
    await own.click('#fpBody [data-act="fingo"]'); await own.waitForTimeout(600);
    let m = await fpage(own);
    t.push(['Kartika\'s regions are in the app\'s order: Athens before Zagreb', m.indexOf('Athens') > -1 && m.indexOf('Athens') < m.indexOf('Zagreb')]);
    const regs = await own.$$eval('[data-fpick="r"] option', os => os.map(o => o.textContent));
    t.push(['…the region dropdown too', regs.indexOf('Athens') === 1 && regs.indexOf('Zagreb') === 2]);
    // The seven tiles.
    const tiles = await own.$$eval('.fin-tile .fin-tl', ts => ts.map(x => x.textContent.trim()));
    t.push(['the Overview shows only the seven figures, in order', JSON.stringify(tiles) === JSON.stringify(['Big Books Sold', 'Adventures Sold', 'Donations', 'Pending Payments', 'Expected Gross', 'Expenses', 'Net'])]);
    const tile = (i) => own.$eval(`.fin-tile:nth-child(${i})`, e => e.innerText.replace(/\s+/g, ' '));
    t.push(['Big Books: $120 in hand, 4 Sold + 1 Gift = 5 Distributed', /\$120/.test(await tile(1)) && /4 Sold \+ 1 Gift = 5 Distributed/.test(await tile(1))]);
    t.push(['Adventures: $15, 1 Sold', /\$15/.test(await tile(2)) && /1 Sold/.test(await tile(2)) && !/Gift/.test(await tile(2))]);
    t.push(['with a payment pending: Expected Gross $185 (120 + 15 + 10 + 40 owed)', /Expected Gross \$185/.test(await tile(5)) && /Current Collected \$145/.test(await tile(5))]);
    t.push(['Net is Gross less Expenses, margin beneath', /\$125/.test(await tile(7)) && /Margin 86\.2%/.test(await tile(7))]);
    // Athens has nothing owed: plain Gross, no subtitle.
    await own.click('#fpBody [data-act="fingo"][data-scope="rg_at"]'); await own.waitForTimeout(600);
    t.push(['nothing pending: the title is Gross and the subtitle goes', /^Gross \$40$/.test((await tile(5)).trim())]);
    // Zagreb's events, in the app's order.
    await own.evaluate(() => finGo('overview', 'rg_zg')); await own.waitForTimeout(600);
    m = await fpage(own);
    t.push(['Zagreb\'s events in the app\'s order: Kirtan before Fair', m.indexOf('Zagreb Kirtan') < m.indexOf('Zagreb Fair')]);
    // The search, before the dates, on the same line.
    const line = await own.evaluate(() => { const f = document.querySelector('#fpBody .fin-filters'); return [...f.children].map(c => c.className || c.tagName); });
    t.push(['a search field comes first on the date line', /fin-search/.test(line[0]) && line.length === 3]);
    await own.click('#finPP .pp-in'); await own.fill('#finPP .pp-in', 'fair'); await own.waitForTimeout(200);
    const hits = await own.$$eval('#finPP .pp-row', rs => rs.map(r => r.textContent));
    t.push(['typing narrows it to the place, keeping its season and region', JSON.stringify(hits) === JSON.stringify(['Kartika', 'Zagreb', 'Zagreb Fair'])]);
    await own.click('#finPP .pp-row:last-child'); await own.waitForTimeout(800);
    t.push(['choosing it takes the page there', /#finance\/overview\/ev_z2/.test(own.url())]);
    await own.screenshot({ path: shot('fin-search') });
    // WhatsApp reports.
    await own.evaluate(() => finGo('overview', 'rg_zg')); await own.waitForTimeout(600);
    await own.click('.fp-h [data-act="finrep"]'); await own.waitForTimeout(400);
    let r = await repText(own);
    t.push(['the Overview\'s 📋: its figures, in the same words', /^Big Books Sold - \$80\n   3 Sold \+ 1 Gift = 4 Distributed\nAdventures Sold - \$15\n   1 Sold\nDonations - \$10\nPending Payments - \$40\nExpected Gross - \$145\n   Current Collected - \$105\nExpenses - \$20\nNet - \$85\n   Margin 81%$/.test(r)]);
    await own.evaluate(() => closeModal());
    await own.click('.fin-h3 [data-act="finrep"]'); await own.waitForTimeout(400);
    r = await repText(own);
    t.push(['the By Event 📋: each event, as the table', /^\*Zagreb Kirtan\*\nBig Books Sold - \$80/.test(r) && /\*Zagreb Fair\*/.test(r) && !/Total/.test(r)]);
    await own.evaluate(() => closeModal());
    await own.click('#reportBtn'); await own.waitForTimeout(400);
    r = await repText(own);
    t.push(['📋 Report at the top: the whole section, with headings', /^\*Zagreb · Kartika — Finance Overview\*\n\n\*OVERVIEW\*\nBig Books Sold/.test(r) && /\*BY EVENT\*/.test(r) && !/SALES BY TITLE/.test(r)]);
    await own.evaluate(() => closeModal());
    await own.click('[data-act="finsec"][data-sec="todo"]'); await own.waitForTimeout(1200);
    await own.click('.fp-h [data-act="finrep"]'); await own.waitForTimeout(400);
    r = await repText(own);
    t.push(['the To do\'s 📋: what is owed and the expenses', /\*Pending Payments\*\nSri Radha \(English\) - \$40/.test(r) && /\*Every Expense\*/.test(r) && /Van hire/.test(r)]);
    await own.evaluate(() => closeModal());
    t.push(['To do tabs read Pending Reimbursements / Pending Payments', /Pending Reimbursements/.test(await fpage(own)) && /Pending Payments/.test(await fpage(own))]);
    await own.click('[data-act="finsec"][data-sec="report"]'); await own.waitForTimeout(1200);
    await own.click('#reportBtn'); await own.waitForTimeout(400);
    r = await repText(own);
    t.push(['the top 📋 on Reports: the report\'s rows', /^\*Zagreb · Kartika — Finance Reports\*/.test(r) && /\*Kartika\*\nBig Books Sold - /.test(r) && /\*Total\*/.test(r)]);
    await own.evaluate(() => closeModal());
    // Pencils on the Finance page and in its windows.
    await own.click('[data-act="finsec"][data-sec="overview"]'); await own.waitForTimeout(1200);
    await own.click('#fpSecs [data-act="editwording"]'); await own.waitForTimeout(800);
    const pens = await own.evaluate(() => [...document.querySelectorAll('#finPage .pencil')].map(p => p.parentElement.textContent.replace('✏️', '').trim()));
    t.push(['Edit Wording works on the Finance page: pencils on headings and tiles', pens.includes('Big Books Sold') && pens.some(x => /^Overview/.test(x)) && pens.some(x => /^By Event/.test(x)) && pens.includes('Search')]);
    t.push(['…but not on place names', !pens.includes('Zagreb Kirtan')]);
    await own.click('.fp-h [data-act="finrep"]'); await own.waitForTimeout(800);
    t.push(['…and inside the report window', await own.evaluate(() => document.querySelectorAll('#modal .pencil').length > 0)]);
    await own.evaluate(() => closeModal());
    await own.evaluate(() => toast('Report copied')); await own.waitForTimeout(400);
    t.push(['…and on a passing message, which waits while editing', await own.evaluate(() => !!document.querySelector('#toast .pencil') && getComputedStyle(document.querySelector('#toast')).pointerEvents === 'auto')]);
    await own.screenshot({ path: shot('fin-pencils') });
    // Rewrite a tile's heading through its pencil.
    await own.evaluate(() => { const p = [...document.querySelectorAll('.fin-tile .fin-tl .pencil')].find(x => x.parentElement.textContent.startsWith('Donations')); p.click(); }); await own.waitForTimeout(600);
    const box = await own.$('#modal textarea, #modal input[type="text"]');
    if (box) { await box.fill('Donations Received'); await own.evaluate(() => { const b = [...document.querySelectorAll('#modal .m-foot button')].find(b => /Save/i.test(b.textContent)); b && b.click(); }); await own.waitForTimeout(1500); }
    t.push(['a rewritten tile heading shows on the page', /Donations Received/.test(await fpage(own))]);
    await own.click('#fpSecs [data-act="editwording"]'); await own.waitForTimeout(500);
    const phone = await open('owner@example.com', 'The Owner', 390);
    await phone.evaluate(() => finGo('overview', 'rg_zg')); await phone.waitForTimeout(1500);
    t.push(['phone width: no sideways scroll on the page', await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)]);
    await phone.screenshot({ path: shot('fin-phone'), fullPage: true });
    await own.setViewportSize({ width: 1150, height: 1000 });
    await own.evaluate(() => finGo('overview', 'rg_zg')); await own.waitForTimeout(800);
    await own.screenshot({ path: shot('fin-overview'), fullPage: true });
  } catch (e) { errors.push('test: ' + e.stack); }
  await browser.close();
  let bad = 0;
  t.forEach(([n, ok]) => { if (!ok) bad++; console.log((ok ? '  ok   ' : '  FAIL ') + n); });
  errors.forEach(e => console.log('  ERROR ' + e));
  console.log(bad || errors.length ? `\n${bad} failed, ${errors.length} errors` : `\nall ${t.length} passed`);
  process.exit(bad || errors.length ? 1 : 0);
})();
