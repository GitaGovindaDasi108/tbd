/* Optional, needs Playwright + Chromium: node test/browser-arrange.js
   b243 (practice): arranging the books. A Seller picks up book cards and
   drops them where she wants them, by mouse and by finger. The order is her
   own, kept with her login (the real server code, server/src/core.js, in this
   process), so it follows her to another computer; nobody else's shelf
   changes, and Edit Book Display keeps showing everyone's (shared) order.
   b244: a small ⇅ beside the list/cards switch on every panel of book cards
   (the season's Distribution by Title too), and a phone keeps an order of its
   own, apart from the computer's. */
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
  const shelf = page => page.$$eval('#invGrid > .book[data-id]:not(.don-card)', c => c.map(x => x.dataset.id));
  const cards = page => page.$$eval('#invGrid > [data-id]', c => c.map(x => x.dataset.id));
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
    const tg = '#invHeading .arr-tg';
    t.push(['the shelf has titles to arrange', shared.length >= 4]);
    t.push(['practice: a small ⇅ on the Inventory heading, beside the list/cards switch',
      await sita.isVisible(tg) && await sita.$eval(tg, b => b.textContent === '⇅' && b.previousElementSibling && b.previousElementSibling.classList.contains('view-tg'))]);
    await sita.click(tg); await sita.waitForTimeout(300);
    t.push(['arranging: a note at the foot of the screen, for computers', /for computers/.test(await sita.textContent('#arrDock'))]);
    t.push(['…and a Drag bar on every title, and on the donation card (b249)', await sita.$$eval('#invGrid .arr-grip', g => g.length) === shared.length + 1]);
    const n = shared.length;
    const from = await centre(sita, `#invGrid > .book[data-id="${shared[n - 1]}"] .bname`);
    const to = await centre(sita, `#invGrid > .book[data-id="${shared[0]}"]`);
    await sita.mouse.move(from.x, from.y); await sita.mouse.down();
    await sita.mouse.move(to.x, to.y, { steps: 20 });
    // b248: nothing shuffles while dragging; the book it will swap with is outlined.
    t.push(['mid-drag: the book under it is outlined, the rest stay put', await sita.$$eval('#invGrid .arr-target', g => g.map(x => x.dataset.id).join()) === shared[0]
      && JSON.stringify(await sita.$$eval('#invGrid > [data-id]:not(.arr-lift):not(.don-card)', c => c.map(x => x.dataset.id))) === JSON.stringify(shared.slice(0, n - 1))]);
    await sita.screenshot({ path: shot('middrag') });
    await sita.mouse.up(); await sita.waitForTimeout(700);
    let mine = await shelf(sita);
    const swapped = (l, i, j) => { const c = l.slice(); [c[i], c[j]] = [c[j], c[i]]; return c; };
    t.push(['the last title dropped on the first: the two swap, nothing else moves', JSON.stringify(mine) === JSON.stringify(swapped(shared, 0, n - 1))]);
    t.push(['…without selling it (no window opened)', !(await anyModal(sita))]);
    t.push(['…nothing left behind', await sita.evaluate(() => !document.querySelector('.arr-gap, .arr-lift'))]);
    t.push(['…still arranging after the drop (Drag bars back)', await sita.$$eval('#invGrid .arr-grip', g => g.length) === shared.length + 1]);
    // b249: the donation card swaps like a title.
    const before = await cards(sita);
    t.push(['(the donation card starts last)', before[before.length - 1] === '__donation']);
    const dFrom = await centre(sita, '#invGrid > .don-card .bname'), dTo = await centre(sita, `#invGrid > .book[data-id="${mine[1]}"]`);
    await sita.mouse.move(dFrom.x, dFrom.y); await sita.mouse.down();
    await sita.mouse.move(dTo.x, dTo.y, { steps: 20 }); await sita.mouse.up(); await sita.waitForTimeout(700);
    const afterDon = await cards(sita);
    t.push(['the donation card dropped on the second title: the two swap', afterDon[1] === '__donation' && afterDon[afterDon.length - 1] === mine[1] && afterDon.length === before.length]);
    // …and back, so the checks below see the titles as they were.
    const dBack = await centre(sita, '#invGrid > .don-card .bname'), dLast = await centre(sita, `#invGrid > .book[data-id="${mine[1]}"]`);
    await sita.mouse.move(dBack.x, dBack.y); await sita.mouse.down();
    await sita.mouse.move(dLast.x, dLast.y, { steps: 20 }); await sita.mouse.up(); await sita.waitForTimeout(700);
    t.push(['…and swapped back, it is last again', JSON.stringify(await cards(sita)) === JSON.stringify(before)]);
    let me = await ask({ action: 'me', s: await sessionOf('sita@example.com', 'Sita') });
    t.push(['her computer order is kept with her login', (me.result.prefs.bookOrder || [])[0] === shared[n - 1] && !me.result.prefs.bookOrderPhone]);
    await sita.click('#arrDock [data-act="arrange"]'); await sita.waitForTimeout(300);
    t.push(['Done: the Drag bars go and the shelf sells again', !(await sita.$('#invGrid .arr-grip')) && !(await sita.isVisible('#arrDock'))]);
    /* b304 (Gita): in a list it is the usual drag and drop: the book goes in
       where it is dropped, and the rest move along. */
    await sita.click('#invHeading .view-tg:not(.arr-tg)'); await sita.waitForTimeout(400);
    await sita.click(tg); await sita.waitForTimeout(300);
    const L0 = await shelf(sita), m0 = L0.length;
    const lf = await centre(sita, `#invGrid > .book[data-id="${L0[m0 - 1]}"] .bname`);
    const lb = await (await sita.$(`#invGrid > .book[data-id="${L0[1]}"]`)).boundingBox();
    await sita.mouse.move(lf.x, lf.y); await sita.mouse.down();
    await sita.mouse.move(lb.x + lb.width / 2, lb.y + lb.height * 0.25, { steps: 25 });
    t.push(['list: mid-drag the rows make room, nothing is outlined', await sita.evaluate(() => !document.querySelector('#invGrid .arr-target') && !!document.querySelector('#invGrid > .arr-gap'))]);
    await sita.mouse.up(); await sita.waitForTimeout(700);
    const L1 = await shelf(sita);
    t.push(['list: the last title dropped above the second goes in second, the rest move along (' + L1.slice(0, 3).join(',') + ')',
      JSON.stringify(L1) === JSON.stringify([L0[0], L0[m0 - 1]].concat(L0.slice(1, m0 - 1)))]);
    // Back as it was: cards, not arranging.
    await sita.click('#arrDock [data-act="arrange"]'); await sita.waitForTimeout(300);
    await sita.click('#invHeading .view-tg:not(.arr-tg)'); await sita.waitForTimeout(400);
    await sita.evaluate(o => { MY_ORDER.set(o); renderAll(); }, mine); await sita.waitForTimeout(500);
    await sita.click(`#invGrid > .book[data-id="${mine[0]}"] .sell-btn`); await sita.waitForTimeout(400);
    t.push(['…(Sell opens the sale as usual)', await anyModal(sita)]);
    await sita.evaluate(() => closeModal());

    /* ---- Another computer: same order ---- */
    const sita2 = await open('sita@example.com', 'Sita');
    await atEvent(sita2);
    t.push(['another computer: her order follows her login', (await shelf(sita2))[0] === shared[n - 1]]);

    /* ---- Nobody else is affected; the season's panels have the ⇅ too ---- */
    const own = await open('owner@example.com', 'The Owner');
    await atEvent(own);
    t.push(['the owner still sees the shared order', JSON.stringify(await shelf(own)) === JSON.stringify(shared)]);
    await own.evaluate(() => goTo('season')); await own.waitForTimeout(800);
    const ST = '#seasonTitleList > .stat-grid';
    const titles = () => own.$$eval(ST + ' > [data-id]', c => c.map(x => x.dataset.id));
    t.push(['season: Distribution by Title has the ⇅ too', await own.evaluate(() => { const g = document.querySelector('#seasonTitleList'); const h = g && g.closest('.panel').querySelector(':scope > h2'); return !!(h && h.querySelector('.arr-tg') && h.querySelector('.arr-tg').offsetParent); })]);
    t.push(['…and the Warehouse Overview', await own.evaluate(() => { const g = document.querySelector('#whOverview'); const h = g && g.closest('.panel').querySelector(':scope > h2'); return !!(h && h.querySelector('.arr-tg')); })]);
    await own.evaluate(() => document.querySelector('#seasonTitleList').closest('.panel').querySelector('.arr-tg').click()); await own.waitForTimeout(300);
    // b271: titles nothing was distributed of only show while arranging.
    const sOrder = await titles();
    await own.$eval(ST, g => g.scrollIntoView({ block: 'center' })); await own.waitForTimeout(200);
    const a = await centre(own, `${ST} > [data-id="${sOrder[2]}"] .sc-name`), b0 = await centre(own, `${ST} > [data-id="${sOrder[0]}"]`);
    await own.mouse.move(a.x, a.y); await own.mouse.down(); await own.mouse.move(b0.x, b0.y, { steps: 20 }); await own.mouse.up();
    await own.waitForTimeout(800);
    t.push(['season: the third title swapped with the first in Distribution by Title', (await titles())[0] === sOrder[2] && (await titles())[2] === sOrder[0]]);
    t.push(['…and the Warehouse Overview follows the same order', await own.$eval('#whOverview .stat-grid > [data-id]', c => c.dataset.id) === sOrder[2]]);
    await own.screenshot({ path: shot('season') });
    await own.evaluate(() => { document.querySelector('#arrDock [data-act="arrange"]').click(); }); await own.waitForTimeout(200);
    // The owner's own order never leaks into Edit Book Display (everyone's order).
    await own.evaluate(() => bookDisplayModal()); await own.waitForTimeout(300);
    t.push(['Edit Book Display still shows (and saves) the shared order', (await own.$$eval('#bdList .ro-row', r => r.map(x => x.dataset.id)))[0] === sOrder[0]]);
    await own.evaluate(() => closeModal());

    /* ---- b248: hide and show from Arrange; no Edit Book Display in practice ---- */
    await atEvent(own);
    t.push(['practice: Edit Book Display is gone from the menu', !!(await own.$('[data-act="addstock"]')) && !(await own.$('[data-act="bookdisplay"]'))]);
    const ev = await shelf(own);
    await own.click(tg); await own.waitForTimeout(300);
    t.push(['arranging (Universal): "Hide here" on every title (not the donation card)', await own.$$eval('#invGrid .arr-hide', b => b.length) === ev.length && !(await own.$('#invGrid .don-card .arr-hide'))]);
    await own.click(`#invGrid > [data-id="${ev[1]}"] .arr-hide`); await own.waitForTimeout(800);
    t.push(['"Hide here" takes the title off this shelf', !(await shelf(own)).includes(ev[1]) && (await shelf(own)).length === ev.length - 1]);
    t.push(['…still arranging, and "Hidden here (1)" in the note', /Hidden here \(1\)/.test(await own.textContent('#arrDock'))]);
    await own.click('#arrDock [data-act="arrhidden"]'); await own.waitForTimeout(300);
    await own.click(`#modal [data-show-title="${ev[1]}"]`); await own.waitForTimeout(800);
    await own.evaluate(() => closeModal()); await own.waitForTimeout(300);
    t.push(['"Hidden here" › Show puts it back', (await shelf(own)).includes(ev[1])]);
    await own.click('#arrDock [data-act="arrange"]'); await own.waitForTimeout(200);
    t.push(['Sita (not Universal) gets no "Hide here"', await sita.evaluate(() => { ARRANGE = true; renderAll(); const n = document.querySelectorAll('#invGrid .arr-hide').length; ARRANGE = false; renderAll(); return n; }) === 0]);

    /* ---- Sita on her phone: an order of its own; arranges by finger ---- */
    const ph = await open('sita@example.com', 'Sita', 390, { phone: true, height: 760 });
    await atEvent(ph);
    mine = await shelf(ph);
    t.push(['phone: starts from the shared order, not her computer\'s', JSON.stringify(mine) === JSON.stringify(shared)]);
    await ph.tap(tg); await ph.waitForTimeout(300);
    t.push(['phone: the note says this order is for phones', /for phones/.test(await ph.textContent('#arrDock'))]);
    t.push(['phone: the Drag bar is finger-sized', await ph.$eval('#invGrid .arr-grip', g => g.getBoundingClientRect().height >= 36)]);
    t.push(['phone: a finger on a card (not its Drag bar) can still scroll the page', await ph.$eval('#invGrid > .book[data-id]', c => getComputedStyle(c).touchAction !== 'none')]);
    await ph.$eval('#invGrid', g => g.scrollIntoView({ block: 'start' })); await ph.waitForTimeout(200);
    const g2 = await centre(ph, `#invGrid > .book[data-id="${mine[2]}"] .arr-grip`);
    const c0 = await centre(ph, `#invGrid > .book[data-id="${mine[0]}"]`);
    await finger(ph, g2, { x: c0.x, y: c0.y });
    await ph.waitForTimeout(800);
    const now = await shelf(ph);
    t.push(['phone: the third title dragged by its Drag bar swaps with the first', JSON.stringify(now) === JSON.stringify(swapped(mine, 0, 2))]);
    await ph.screenshot({ path: shot('phone') });
    me = await ask({ action: 'me', s: await sessionOf('sita@example.com', 'Sita') });
    t.push(['…saved as her phone order, her computer order untouched', (me.result.prefs.bookOrderPhone || [])[0] === mine[2] && (me.result.prefs.bookOrder || [])[0] === shared[n - 1]]);
    await sita2.reload(); await sita2.waitForTimeout(2500); await atEvent(sita2);
    t.push(['…the computer still shows her computer order', (await shelf(sita2))[0] === shared[n - 1]]);
    // Back to the shared order, on phones.
    await ph.tap('#arrDock [data-act="arrreset"]'); await ph.waitForTimeout(900);
    t.push(['"Use the shared order" puts the shared order back on the phone', JSON.stringify(await shelf(ph)) === JSON.stringify(shared)]);
    me = await ask({ action: 'me', s: await sessionOf('sita@example.com', 'Sita') });
    t.push(['…forgets only her phone order', !me.result.prefs.bookOrderPhone && (me.result.prefs.bookOrder || [])[0] === shared[n - 1]]);

    /* ---- b250: the live app has it all too ---- */
    const live = await open('sita@example.com', 'Sita', 1150, { live: true });
    await atEvent(live);
    t.push(['live app: the ⇅ is there', await live.isVisible(tg)]);
    t.push(['…and Sita sees her own (computer) order there too', (await shelf(live))[0] === shared[n - 1]]);
    await live.click(tg); await live.waitForTimeout(300);
    const lv = await shelf(live);
    const l1 = await centre(live, `#invGrid > .book[data-id="${lv[1]}"] .bname`), l2 = await centre(live, `#invGrid > .book[data-id="${lv[2]}"]`);
    await live.mouse.move(l1.x, l1.y); await live.mouse.down(); await live.mouse.move(l2.x, l2.y, { steps: 20 }); await live.mouse.up();
    await live.waitForTimeout(700);
    t.push(['live app: dropping one book on another swaps them', JSON.stringify(await shelf(live)) === JSON.stringify(swapped(lv, 1, 2))]);
    const liveOwn = await open('owner@example.com', 'The Owner', 1150, { live: true });
    await atEvent(liveOwn);
    t.push(['live app: Edit Book Display is gone from the menu', !!(await liveOwn.$('[data-act="addstock"]')) && !(await liveOwn.$('[data-act="bookdisplay"]'))]);
    await liveOwn.click(tg); await liveOwn.waitForTimeout(300);
    t.push(['live app (Universal): "Hide here" and "Hidden here" while arranging', !!(await liveOwn.$('#invGrid .arr-hide')) && !!(await liveOwn.$('#arrDock [data-act="arrhidden"]'))]);

    /* ---- b251: a region's warehouse and Earthly HQ have "Hide here" too; the season says where it is ---- */
    await liveOwn.click('#arrDock [data-act="arrange"]'); await liveOwn.waitForTimeout(200);
    await liveOwn.evaluate(() => goTo('region', 'rg_in')); await liveOwn.waitForTimeout(600);
    await liveOwn.click(tg); await liveOwn.waitForTimeout(300);
    t.push(['live app: a region\'s warehouse has "Hide here" while arranging', !!(await liveOwn.$('#invGrid .arr-hide')) && !!(await liveOwn.$('#arrDock [data-act="arrhidden"]'))]);
    await liveOwn.click('#arrDock [data-act="arrange"]'); await liveOwn.waitForTimeout(200);
    await liveOwn.evaluate(() => goTo('season')); await liveOwn.waitForTimeout(600);
    await liveOwn.evaluate(() => document.querySelector('#seasonTitleList').closest('.panel').querySelector('.arr-tg').click()); await liveOwn.waitForTimeout(300);
    /* b252: the season's own page hides too (Distribution by Title and the Warehouse Overview). */
    const SL = '#seasonTitleList .stat-grid > [data-id]', WO = '#whOverview .stat-grid > [data-id]';
    const ids = sel => liveOwn.$$eval(sel, c => c.map(x => x.dataset.id));
    const sl = await ids(SL);
    t.push(['season: "Hide here" on every title while arranging', sl.length > 1 && (await liveOwn.$$eval('#seasonTitleList .arr-hide', b => b.length)) === sl.length && !!(await liveOwn.$('#arrDock [data-act="arrhidden"]'))]);
    await liveOwn.evaluate(id => document.querySelector(`#seasonTitleList [data-id="${id}"] .arr-hide`).click(), sl[0]); await liveOwn.waitForTimeout(1200);
    t.push(['season: "Hide here" takes it off Distribution by Title and the Warehouse Overview', !(await ids(SL)).includes(sl[0]) && !(await ids(WO)).includes(sl[0])]);
    t.push(['…and the server keeps it hidden for the season', String((await O({ action: 'getState', season: SA })).state.seasonHidden || '').split(',').includes(sl[0])]);
    await liveOwn.click('#arrDock [data-act="arrange"]'); await liveOwn.waitForTimeout(200);
    await liveOwn.evaluate(() => goTo('region', 'rg_in')); await liveOwn.waitForTimeout(600);
    t.push(['…the region\'s own shelf still has it', (await shelf(liveOwn)).includes(sl[0])]);
    await liveOwn.evaluate(() => goTo('season')); await liveOwn.waitForTimeout(600);
    await liveOwn.evaluate(() => document.querySelector('#seasonTitleList').closest('.panel').querySelector('.arr-tg').click()); await liveOwn.waitForTimeout(300);
    await liveOwn.click('#arrDock [data-act="arrhidden"]'); await liveOwn.waitForTimeout(300);
    t.push(['season: "Hidden here" says the season page', /on the season page/.test(await liveOwn.textContent('#modal'))]);
    await liveOwn.click(`#modal [data-show-title="${sl[0]}"]`); await liveOwn.waitForTimeout(1000);
    await liveOwn.evaluate(() => closeModal()); await liveOwn.waitForTimeout(300);
    t.push(['season: "Hidden here" › Show puts it back', (await ids(SL)).includes(sl[0]) && (await ids(WO)).includes(sl[0])]);
    await liveOwn.click('#arrDock [data-act="arrange"]'); await liveOwn.waitForTimeout(200);
    await liveOwn.evaluate(() => switchSeason(HQ_ID)); await liveOwn.waitForTimeout(2500);
    await liveOwn.click(tg); await liveOwn.waitForTimeout(300);
    const hq = await shelf(liveOwn);
    t.push(['Earthly HQ: "Hide here" while arranging', hq.length > 1 && (await liveOwn.$$eval('#invGrid .arr-hide', b => b.length)) === hq.length]);
    await liveOwn.click(`#invGrid > [data-id="${hq[0]}"] .arr-hide`); await liveOwn.waitForTimeout(1200);
    t.push(['Earthly HQ: "Hide here" takes the title off its shelf', !(await shelf(liveOwn)).includes(hq[0])]);
    const st = (await O({ action: 'getState', season: 'HQ' })).state;
    t.push(['…and the server keeps it hidden at HQ', String(((st.regions || []).find(r => r.regionId === 'rg_hq') || {}).hidden || '').split(',').includes(hq[0])]);
    await liveOwn.click('#arrDock [data-act="arrhidden"]'); await liveOwn.waitForTimeout(300);
    await liveOwn.click(`#modal [data-show-title="${hq[0]}"]`); await liveOwn.waitForTimeout(1000);
    await liveOwn.evaluate(() => closeModal()); await liveOwn.waitForTimeout(300);
    t.push(['Earthly HQ: "Hidden here" › Show puts it back', (await shelf(liveOwn)).includes(hq[0])]);
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
