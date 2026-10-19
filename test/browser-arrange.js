/* Optional, needs Playwright + Chromium: node test/browser-arrange.js
   b243 (practice): ↕ Arrange on the shelf. A Seller picks up book cards and
   drops them where she wants them, by mouse and by finger. The order is her
   own, kept with her login (the real server code, server/src/core.js, in this
   process), so it follows her to her phone; nobody else's shelf changes, and
   Edit Book Display keeps showing everyone's (shared) order. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });
const shot = n => path.join(os.tmpdir(), 'tbs-arrange-' + n + '.png');
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

  // Delhi, with the Chowpatty program, where Sita sells. Every title has copies there.
  const owner = await sessionOf('owner@example.com', 'The Owner');
  const O = p => ask(Object.assign({ s: owner }, p));
  await O({ action: 'saveSeason', name: 'Kartika' });
  const SA = (await O({ action: 'getState' })).state.activeSeason;
  await O({ action: 'createRegion', regionId: 'rg_in', whLoc: 'wh_in', name: 'Delhi', currencies: 'INR,USD', season: SA });
  await O({ action: 'createEvent', eventId: 'ev_cp', name: 'Chowpatty Program', regionId: 'rg_in', season: SA });
  await O({ action: 'peopleAdd', email: 'sita@example.com', name: 'Sita', role: 'S', placeId: 'ev_cp' });
  const B = (await O({ action: 'getState' })).state.books.filter(b => !b.partnerId).map(b => b.id);
  await O({ action: 'adjustStockBulk', location: 'ev_cp', items: B.map(id => ({ bookId: id, delta: 10 })), override: true, season: SA });

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
  const shelf = page => page.$$eval('#invGrid > .book[data-id]', c => c.map(x => x.dataset.id));
  const centre = async (page, sel) => { const b = await (await page.$(sel)).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const atEvent = async page => { await page.evaluate(() => { goTo('event', 'ev_cp'); }); await page.waitForTimeout(600); };
  const anyModal = page => page.evaluate(() => { const m = document.querySelector('#modal'); return !!(m && m.offsetParent && m.innerText.trim()); });
  async function finger(page, from, to, steps = 14) {
    await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
    for (let i = 1; i <= steps; i++) await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove',
      touchPoints: [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }] });
    await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  try {
    /* ---- Sita arranges her shelf with the mouse ---- */
    const sita = await open('sita@example.com', 'Sita');
    await atEvent(sita);
    const shared = await shelf(sita);
    t.push(['the shelf has titles to arrange', shared.length >= 4]);
    t.push(['practice: the Inventory heading has ↕ Arrange', await sita.isVisible('#invHeading .arr-btn')]);
    await sita.click('#invHeading .arr-btn'); await sita.waitForTimeout(200);
    t.push(['Arrange shows how it works, and that it is kept with her login', /kept with your login/.test(await sita.textContent('#invArrBar'))]);
    t.push(['…and a handle on every title', await sita.$$eval('#invGrid .arr-grip', g => g.length) === shared.length]);
    const n = shared.length;
    const from = await centre(sita, `#invGrid > .book[data-id="${shared[n - 1]}"] .bname`);
    const to = await centre(sita, `#invGrid > .book[data-id="${shared[0]}"]`);
    await sita.mouse.move(from.x, from.y); await sita.mouse.down();
    await sita.mouse.move(to.x - 30, to.y, { steps: 20 });
    t.push(['mid-drag: one gap shows where it will land', await sita.$$eval('#invGrid .arr-gap', g => g.length) === 1]);
    await sita.screenshot({ path: shot('middrag') });
    await sita.mouse.up(); await sita.waitForTimeout(600);
    let mine = await shelf(sita);
    t.push(['the last title dragged to the front of the shelf', JSON.stringify(mine) === JSON.stringify([shared[n - 1], ...shared.slice(0, n - 1)])]);
    t.push(['…without selling it (no window opened)', !(await anyModal(sita))]);
    t.push(['…nothing left behind', await sita.evaluate(() => !document.querySelector('.arr-gap, .arr-lift'))]);
    let me = await ask({ action: 'me', s: await sessionOf('sita@example.com', 'Sita') });
    t.push(['her order is kept with her login on the server', (me.result.prefs.bookOrder || [])[0] === shared[n - 1]]);
    await sita.click('#invArrBar [data-act="arrange"]'); await sita.waitForTimeout(200);
    t.push(['Done: the handles go and the shelf sells again', !(await sita.$('#invGrid .arr-grip')) && !(await sita.isVisible('#invArrBar'))]);
    await sita.click(`#invGrid > .book[data-id="${mine[0]}"] .sell-btn`); await sita.waitForTimeout(400);
    t.push(['…(Sell opens the sale as usual)', await anyModal(sita)]);
    await sita.screenshot({ path: shot('desktop') });

    /* ---- Nobody else is affected ---- */
    const own = await open('owner@example.com', 'The Owner');
    await atEvent(own);
    t.push(['the owner still sees the shared order', JSON.stringify(await shelf(own)) === JSON.stringify(shared)]);
    // The owner's own order never leaks into Edit Book Display (everyone's order).
    await own.click('#invHeading .arr-btn'); await own.waitForTimeout(200);
    const a = await centre(own, `#invGrid > .book[data-id="${shared[1]}"] .bname`), b0 = await centre(own, `#invGrid > .book[data-id="${shared[0]}"]`);
    await own.mouse.move(a.x, a.y); await own.mouse.down(); await own.mouse.move(b0.x - 30, b0.y, { steps: 15 }); await own.mouse.up();
    await own.waitForTimeout(600);
    t.push(['the owner arranges their own too', (await shelf(own))[0] === shared[1]]);
    await own.evaluate(() => bookDisplayModal()); await own.waitForTimeout(300);
    t.push(['Edit Book Display still shows (and saves) the shared order', (await own.$$eval('#bdList .ro-row', r => r.map(x => x.dataset.id)))[0] === shared[0]]);
    await own.evaluate(() => closeModal());

    /* ---- Sita on her phone: same order; arranges by finger ---- */
    const ph = await open('sita@example.com', 'Sita', 390, { phone: true, height: 760 });
    await atEvent(ph);
    mine = await shelf(ph);
    t.push(['phone: her order follows her login to another device', mine[0] === shared[n - 1]]);
    await ph.tap('#invHeading .arr-btn'); await ph.waitForTimeout(200);
    t.push(['phone: the handle is finger-sized', await ph.$eval('#invGrid .arr-grip', g => g.getBoundingClientRect().width >= 36)]);
    t.push(['phone: a finger on a card (not its handle) can still scroll the page', await ph.$eval('#invGrid > .book[data-id]', c => getComputedStyle(c).touchAction !== 'none')]);
    await ph.$eval('#invGrid', g => g.scrollIntoView({ block: 'start' })); await ph.waitForTimeout(200);
    const g2 = await centre(ph, `#invGrid > .book[data-id="${mine[2]}"] .arr-grip`);
    const c0 = await centre(ph, `#invGrid > .book[data-id="${mine[0]}"]`);
    await finger(ph, g2, { x: c0.x - 20, y: c0.y });
    await ph.waitForTimeout(700);
    const now = await shelf(ph);
    t.push(['phone: the third title dragged by its handle to the front', now[0] === mine[2] && now.length === mine.length]);
    await ph.screenshot({ path: shot('phone') });
    me = await ask({ action: 'me', s: await sessionOf('sita@example.com', 'Sita') });
    t.push(['…saved with her login', (me.result.prefs.bookOrder || [])[0] === mine[2]]);
    // Back to the shared order.
    await ph.tap('#invArrBar [data-act="arrreset"]'); await ph.waitForTimeout(800);
    t.push(['"Use the shared order" puts the shared order back', JSON.stringify(await shelf(ph)) === JSON.stringify(shared)]);
    me = await ask({ action: 'me', s: await sessionOf('sita@example.com', 'Sita') });
    t.push(['…and forgets hers on the server', !me.result.prefs.bookOrder]);

    /* ---- The live app: no Arrange yet ---- */
    const live = await open('sita@example.com', 'Sita', 1150, { live: true });
    await atEvent(live);
    t.push(['live app: no ↕ Arrange yet (practice first)', !(await live.isVisible('#invHeading .arr-btn'))]);
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
