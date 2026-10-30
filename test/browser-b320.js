/* Optional, needs Playwright + Chromium: node test/browser-b320.js
   b320 (Track profit per book, practice first): the screens for book costs.
   Cost and profit in a sale's drop-down (Finance), the expense form's "put this
   cost on books", Add Stock's printing cost, Shipment Returned, Net in Finance,
   and none of it on the live app. Checked for overflow at 390px and 1150px. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });
const shot = n => path.join(os.tmpdir(), 'tbs-b320-' + n + '.png');
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
    if (/open\.er-api/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ rates: { USD: 1, INR: 80, PLN: 4 }, time_last_update_utc: 'today' }) };
    throw new Error('offline');
  };
  const srv = makeServer({ exec, timeZone: 'UTC', fetchImpl, googleClientId: 'client-123', adminEmails: 'owner@example.com', practice: true });
  await srv.warm();
  console.log = quiet;
  const ask = async p => JSON.parse(await srv.request({ postData: { contents: JSON.stringify(p) } }));
  const sessionOf = async (email, name) => (await ask({ action: 'signIn', idToken: await token(email, name) })).result.session;

  const owner = await sessionOf('owner@example.com', 'The Owner');
  const O = p => ask(Object.assign({ s: owner }, p));
  await O({ action: 'saveSeason', name: 'Europe Tour' });
  const SA = (await O({ action: 'getState' })).state.activeSeason;
  await O({ action: 'createRegion', regionId: 'rg_in', whLoc: 'wh_in', name: 'Delhi', currencies: 'INR,USD', season: SA });
  await O({ action: 'createRegion', regionId: 'rg_pl', whLoc: 'wh_pl', name: 'Poland', currencies: 'PLN,EUR,USD', season: SA });
  await O({ action: 'addBook', id: 'bk_seasons', name: 'Seasons (English)', cat: 'big', season: SA });
  const wait = () => new Promise(r => setTimeout(r, 5));
  await O({ action: 'adjustStockBulk', location: 'wh_in', items: [{ bookId: 'bk_seasons', delta: 2500 }], override: true, movePrefix: 'Mprint1', season: SA });
  await wait();
  const X = (id, amt, link, extra) => O(Object.assign({ action: 'expSave', id, kind: 'record', location: 'rg_hq', date: '2026-10-29',
    desc: 'Book costs', cur: 'INR', amt, forEmail: '*general', bookLink: link }, extra || {}));
  await X('Xprint01', 903054, { k: 'print', src: 'm:Mprint1' });
  await O({ action: 'sendShipment', mode: 'shipping', fromRegion: 'rg_in', toRegion: 'rg_pl', shipId: 'sh_pol001', items: [{ bookId: 'bk_seasons', qty: 142 }], season: SA });
  await wait();
  await X('Xship001', 104612, { k: 'ship', sh: 'sh_pol001' }, { weights: { bk_seasons: 900 } });
  await O({ action: 'receiveShipment', shipId: 'sh_pol001', toLoc: 'wh_pl', items: [{ bookId: 'bk_seasons', qty: 142 }], season: SA });
  await wait();
  await O({ action: 'sell', saleId: 'sPL1', location: 'wh_pl', bookId: 'bk_seasons', legs: [{ type: 'Cash', cur: 'PLN', amt: 100 }], season: SA });
  await O({ action: 'sendShipment', mode: 'shipping', fromRegion: 'rg_in', toRegion: 'rg_pl', shipId: 'sh_ret001', items: [{ bookId: 'bk_seasons', qty: 50 }], season: SA });
  await wait();
  await X('Xship002', 10000, { k: 'ship', sh: 'sh_ret001' });

  const browser = await chromium.launch();
  const t = [], errors = [];
  async function open(email, name, width, opts) {
    opts = opts || {};
    const ctx = await browser.newContext(Object.assign({ viewport: { width: width || 1150, height: opts.height || 1000 } },
      opts.phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}));
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
    await page.goto('http://app.test/index.html' + (opts.live ? '' : '?practice')); await page.waitForTimeout(1500);
    await page.click('#fakeGsi'); await page.waitForTimeout(2500);
    page.cdp = await ctx.newCDPSession(page);
    return page;
  }
  const fits = pg => pg.evaluate(() => {
    const bad = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) bad.push('page ' + document.documentElement.scrollWidth);
    document.querySelectorAll('#modal *, .li-det *, .sh-card *').forEach(el => {
      if (!el.offsetParent) return;
      const r = el.getBoundingClientRect();
      if (r.width && r.right > innerWidth + 1) bad.push((el.id || el.className || el.tagName) + ' ' + Math.round(r.right));
    });
    return bad.slice(0, 5);
  });
  try {
    for (const w of [390, 1150]) {
      const pg = await open('owner@example.com', 'The Owner', w, w < 500 ? { phone: true, height: 844 } : {});
      // The Sales Log at Poland: cost and profit in the drop-down.
      await pg.evaluate(() => goTo('region', 'rg_pl')); await pg.waitForTimeout(800);
      await pg.evaluate(() => { BC.at = 0; bcRefresh(true); }); await pg.waitForTimeout(800);
      await pg.evaluate(() => { const r = document.querySelector('#log .log-item[data-id="sPL1"]'); if (r) r.click(); }); await pg.waitForTimeout(400);
      const det = await pg.evaluate(() => (document.querySelector('#log .log-item[data-id="sPL1"] .li-det') || {}).innerText || '');
      if (process.env.DBG) console.log('DBG', w, JSON.stringify(det), await pg.evaluate(() => JSON.stringify({ bc: BC, mine: bcMine(), fm: financeMe(), n: document.querySelectorAll('#log .log-item').length, ids: [...document.querySelectorAll('#log .log-item')].map(x => x.dataset.id) })));
      t.push([w + 'px: a sale shows what its book cost (' + det.replace(/\s+/g, ' ').match(/Cost of book[^\n]*/i) + ')', /Cost of book[^\n]*1,097\.93[^\n]*≈\$13\.72/i.test(det)]);
      t.push([w + 'px: …and the profit or loss, with Add postage', /Profit\s+≈\$11\.28/i.test(det) && /Add postage/.test(det)]);
      t.push([w + 'px: the drop-down fits (' + (await fits(pg)).join('; ') + ')', !(await fits(pg)).length]);
      const li = await pg.$('#log .log-item[data-id="sPL1"]'); if (li) await li.screenshot({ path: shot('log-' + w) });
      // Books in Transit: Shipment Returned.
      const btn = await pg.$('#transitPanel [data-act="shreturn"][data-id="sh_ret001"]');
      if (!btn) { await pg.evaluate(() => { const d = document.querySelector('#transitPanel details[data-sh="sh_ret001"]'); if (d) d.open = true; }); }
      await pg.evaluate(() => { const d = document.querySelector('#transitPanel details[data-sh="sh_ret001"]'); if (d) d.open = true; });
      const hasBtn = await pg.evaluate(() => !!document.querySelector('#transitPanel [data-act="shreturn"][data-id="sh_ret001"]'));
      t.push([w + 'px: a shipment on its way has Shipment Returned', hasBtn]);
      if (hasBtn && w === 1150) {
        await pg.click('#transitPanel [data-act="shreturn"][data-id="sh_ret001"]'); await pg.waitForTimeout(400);
        t.push([w + 'px: the return window fits (' + (await fits(pg)).join('; ') + ')', !(await fits(pg)).length]);
        await pg.screenshot({ path: shot('return-' + w) });
        await pg.fill('#rtAmt', '5000'); await pg.fill('#rtCur', 'INR');
        await pg.click('#rtGo'); await pg.waitForTimeout(1500);
        const sh = ((await O({ action: 'getState', season: SA })).state.shipments || []).find(x => x.shipId === 'sh_ret001') || {};
        t.push(['the return is saved: all 50 back, refund 5,000 INR', sh.status === 'ARRIVED' && sh.returns && sh.returns[0].n === 50 && sh.returns[0].refund.amt === 5000]);
      } else if (hasBtn) {
        await pg.click('#transitPanel [data-act="shreturn"][data-id="sh_ret001"]'); await pg.waitForTimeout(400);
        t.push([w + 'px: the return window fits (' + (await fits(pg)).join('; ') + ')', !(await fits(pg)).length]);
        await pg.screenshot({ path: shot('return-' + w) });
        await pg.evaluate(() => closeModal());
      }
      // The expense form: put a cost on a shipment, with its weights.
      await pg.evaluate(() => expensesModal()); await pg.waitForTimeout(800);
      await pg.check('#xBc'); await pg.waitForTimeout(800);
      await pg.selectOption('#xBcK', 'ship'); await pg.waitForTimeout(300);
      await pg.selectOption('#xBcSrc', 'sh_pol001'); await pg.waitForTimeout(300);
      const wv = await pg.evaluate(() => (document.querySelector('#modal [data-bcw="bk_seasons"]') || {}).value);
      t.push([w + 'px: the expense form puts a cost on a shipment, with the weight kept (' + wv + ' g)', wv === '900']);
      t.push([w + 'px: …and fits (' + (await fits(pg)).join('; ') + ')', !(await fits(pg)).length]);
      await pg.screenshot({ path: shot('expense-' + w) });
      await pg.selectOption('#xBcK', 'print'); await pg.waitForTimeout(300);
      const opts = await pg.evaluate(() => [...document.querySelectorAll('#xBcSrc option')].map(o => o.textContent));
      t.push([w + 'px: …or on a printing (' + (opts[1] || '') + ')', opts.some(x => /Seasons \(English\) 2,500/.test(x))]);
      await pg.evaluate(() => closeModal());
      // Add Stock: the printing cost box.
      await pg.evaluate(() => addStockModal()); await pg.waitForTimeout(500);
      await pg.check('#spBc'); await pg.waitForTimeout(200);
      t.push([w + 'px: Add Stock asks for a new printing\'s cost', await pg.evaluate(() => !$('#spBcBox').hidden)]);
      t.push([w + 'px: …and fits (' + (await fits(pg)).join('; ') + ')', !(await fits(pg)).length]);
      await pg.screenshot({ path: shot('addstock-' + w) });
      await pg.evaluate(() => closeModal());
      // Finance: Net counts the books sold, not the bills on books.
      await pg.evaluate(() => finGo('overview')); await pg.waitForTimeout(2500);
      const fin = await pg.evaluate(() => { const a = finAgg(FIN.D.sales, FIN.D.expenses); return { net: a.net, coll: a.coll, spent: a.spent, off: a.off || 0, cogs: a.cogs || 0 }; });
      t.push([w + 'px: Finance Net = Gross − Expenses + bills on books − books sold (' + JSON.stringify(fin) + ')',
        fin.off > 0 && fin.cogs > 0 && Math.abs(fin.net - (fin.coll - fin.spent + fin.off - fin.cogs)) < 0.01]);
      t.push([w + 'px: Finance fits (' + (await fits(pg)).join('; ') + ')', !(await fits(pg)).length]);
      await pg.screenshot({ path: shot('finance-' + w), fullPage: true });
      await pg.context().close();
    }
    // Live: none of it.
    const lp = await open('owner@example.com', 'The Owner', 1150, { live: true });
    await lp.evaluate(() => addStockModal()); await lp.waitForTimeout(400);
    t.push(['live: no printing cost in Add Stock', await lp.evaluate(() => !document.querySelector('#spBc'))]);
    await lp.evaluate(() => closeModal());
    t.push(['live: no Shipment Returned, no cost in the Sales Log', await lp.evaluate(() => !BC_ON && !document.querySelector('[data-act="shreturn"]'))]);
    await lp.context().close();
  } catch (e) {
    console.log('STOPPED:', e.message.split('\n').slice(0, 14).join('\n'));
    t.push(['test ran to the end', false]);
  }
  t.push(['no errors in the page', errors.length === 0]);
  if (errors.length) console.log('page errors:', errors);
  t.forEach(([n, okk]) => console.log((okk ? 'PASS' : 'FAIL'), n));
  console.log('screenshots:', shot('*'));
  await browser.close();
  if (t.some(x => !x[1])) process.exitCode = 1;
})();
