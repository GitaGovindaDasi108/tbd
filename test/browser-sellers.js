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
  // Google's spreadsheet side, standing in: the folder map, and a rebuild (b226).
  const GOOGLE = 'https://script.google.com/macros/s/TEST/exec', forwarded = [];
  const fakeMap = sid => ({ driveOk: true, root: { name: 'Transcendental Book Sales', url: 'https://drive.google.com/drive/folders/ROOT' },
    seasons: [{ seasonId: sid, name: 'Europe Tour', folder: { name: 'Europe Tour', url: 'https://drive.google.com/drive/folders/EU' },
      consign: null, folderChosen: false, consignChosen: false,
      files: [{ name: '1 — Europe Tour — Season Summary', url: 'https://docs.google.com/spreadsheets/d/SUM' },
              { name: 'Italy — Europe Tour — Book Sales', url: 'https://docs.google.com/spreadsheets/d/ITA', regionId: 'rg_it' },
              { name: 'Spain — Europe Tour — Book Sales', url: 'https://docs.google.com/spreadsheets/d/ESP', regionId: 'rg_es' }],
      consignFiles: [] }] });
  let SID = '';
  const fetchImpl = async (url, init) => {
    if (/oauth2\/v3\/certs/.test(url)) return { ok: true, status: 200, json: async () => ({ keys: [pub] }) };
    if (url === GOOGLE) {
      const a = JSON.parse(init.body).params.action; forwarded.push(a);
      return { status: 200, text: async () => JSON.stringify(a === 'driveMap' ? { ok: true, result: fakeMap(SID) } : { ok: true }) };
    }
    throw new Error('offline');
  };
  const srv = makeServer({ exec, timeZone: 'UTC', fetchImpl, googleClientId: 'client-123', adminEmails: 'owner@example.com',
                           reportUrl: GOOGLE, reportSecret: 'sec', practiceSecret: 'prac' });
  // b231: the practice space, a second server reading its copy from the one above.
  const PRAC = 'http://practice.test/', LIVE_IN = 'http://live.internal/';
  const prDb = new DatabaseSync(':memory:');
  const prExec = (sql, ...p) => { const st = prDb.prepare(sql); return /^\s*select/i.test(sql) ? st.all(...p) : (st.run(...p), []); };
  const prSrv = makeServer({ exec: prExec, timeZone: 'UTC', googleClientId: 'client-123', adminEmails: '',
    practice: true, liveUrl: LIVE_IN, liveSecret: 'prac',
    fetchImpl: async (url, init) => url === LIVE_IN
      ? { status: 200, text: async () => srv.request({ postData: { contents: init.body } }) } : fetchImpl(url, init) });
  console.log = quiet;
  const ask = async p => JSON.parse(await srv.request({ postData: { contents: JSON.stringify(p) } }));
  const sessionOf = async (email, name) => (await ask({ action: 'signIn', idToken: await token(email, name) })).result.session;

  // The tour: Italy, with Yoga Studio; Gita leads it; Sita and Tulasi sell there.
  const owner = await sessionOf('owner@example.com', 'The Owner');
  const O = p => ask(Object.assign({ s: owner }, p));
  await O({ action: 'saveSeason', name: 'Europe Tour' });
  const st0 = (await O({ action: 'getState' })).state, SA = st0.activeSeason; SID = SA;
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
  async function open(email, name, width, query) {
    const ctx = await browser.newContext({ viewport: { width: width || 1150, height: 1000 } });
    await ctx.addInitScript(tok => { window.__TOKEN = tok; }, await token(email, name));
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(email + ': ' + e.message));
    page.on('dialog', d => d.accept());
    await page.route('**/*', async route => {
      const req = route.request(), url = req.url();
      if (url.startsWith(PRAC)) {
        const body = await prSrv.request({ postData: { contents: req.postData() || '{}' } });
        return route.fulfill({ status: 200, contentType: 'application/json', body, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
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
          body: `window.TBS_CONFIG = { APPS_SCRIPT_URL: '${API}', GOOGLE_CLIENT_ID: 'client-123', POLL_SECONDS: 3600, LIVE_URL: '', PRACTICE_URL: '${PRAC}', CLASSIC_ADMIN: !/[?&](practice|menu)/.test(location.search) };` });
        const f = path.join(ROOT, rel);
        if (fs.existsSync(f) && fs.statSync(f).isFile())
          return route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : 'text/javascript' });
        return route.fulfill({ status: 404, body: '' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    await page.goto('http://app.test/index.html' + (query || '')); await page.waitForTimeout(1500);
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
    /* b230: one line per seller — Big Books, Adventures, everything collected —
       and the cash, with any handover waiting, behind the arrow. */
    const lines = page => page.evaluate(() => {
      const o = {}; document.querySelectorAll('#sellerList .sb-seller').forEach(el => {
        const who = el.querySelector('.sb-who').childNodes[0].textContent.trim();
        const td = [...el.querySelectorAll('.sb-cash tbody tr:first-child td')].map(x => x.textContent.replace(/\s+/g, ' ').trim());
        o[who] = { line: el.querySelector('.sb-line').innerText.replace(/\s+/g, ' '), badge: (el.querySelector('.sb-badge') || {}).textContent || '',
          shown: el.querySelector('.sb-cash').offsetHeight > 0, received: td[0], pending: td[1], submitted: td[2] }; });
      return o; });
    let L = await lines(gita);
    t.push(['the Event Lead\'s Sales by Seller: one line each — Sita: 3 Big Books, 0 Adventures, 105 € collected (card too)',
      /3 Big Books/.test(L.Sita.line) && /0 Adventures/.test(L.Sita.line) && /105/.test(L.Sita.line) && !!L.Tulasi]);
    t.push(['…a red badge on Sita\'s line: a handover is waiting', L.Sita.badge === '1' && !L.Tulasi.badge]);
    t.push(['…the cash is closed until the arrow is tapped', !L.Sita.shown]);
    t.push(['…and there is no separate "Cash Handed Over" panel', await gita.evaluate(() => { const p = document.querySelector('#handPanel'); return !p || p.offsetHeight === 0; })]);
    await gita.click('#sellerList .sb-seller:has-text("Sita") .sb-line'); await gita.waitForTimeout(200);
    L = await lines(gita);
    t.push(['the arrow opens Sita\'s cash: Received 70 €, Pending —, Submitted 70 € awaiting confirmation',
      L.Sita.shown && /70/.test(L.Sita.received) && L.Sita.pending === '—' && /70.*awaiting confirmation/.test(L.Sita.submitted)]);
    t.push(['…with the request and its Received button', !!(await gita.$('#sellerList [data-act="hoyes"]'))]);
    await gita.evaluate(() => { document.querySelector('#sellerPanel').scrollIntoView(); });
    await gita.screenshot({ path: shot('2-lead') });
    await gita.click('#sellerList [data-act="hoyes"]'); await gita.waitForTimeout(2000);
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
    L = await lines(own);
    t.push(['the region\'s Sales by Seller: Sita submitted 70 €, nothing pending, no badge', /70/.test(L.Sita.submitted) && L.Sita.pending === '—' && !L.Sita.badge]);
    await own.evaluate(() => { document.querySelector('#sellerPanel').scrollIntoView(); });
    await own.screenshot({ path: shot('3-region') });

    /* ---- b229: Sales by Seller in step with Track Cash ---- */
    const sbt = async page => { await refresh(page); return lines(page); };
    let v = await sbt(gita);
    t.push(['(before: Tulasi has 35 € pending submission)', /35/.test(v.Tulasi.pending) && v.Tulasi.submitted === '—']);
    await O({ action: 'cashMove', cashId: 'cm1', fromAcct: 'ev_yoga', toAcct: 'BANK', cur: 'EUR', amt: 50, season: SA });
    v = await sbt(gita);
    t.push(['€50 moved on in Track Cash comes out of what the Event Lead received first: Tulasi still has 35 € pending', /35/.test(v.Tulasi.pending)]);
    await O({ action: 'cashMove', cashId: 'cm2', fromAcct: 'ev_yoga', toAcct: 'BANK', cur: 'EUR', amt: 55, season: SA });
    v = await sbt(gita);
    t.push(['all of it with the Global Coordinator: Tulasi has nothing pending, 35 € submitted (moved on by an admin)',
      v.Tulasi.pending === '—' && /35/.test(v.Tulasi.submitted)]);
    await gita.click('#sellerList .sb-seller:has-text("Tulasi") .sb-line'); await gita.waitForTimeout(200);
    await gita.evaluate(() => { document.querySelector('#sellerPanel').scrollIntoView(); });
    await gita.screenshot({ path: shot('10-in-step') });
    const tul = await open('tulasi@example.com', 'Tulasi');
    t.push(['…and Tulasi\'s own "My cash" agrees: nothing with her, no handover button',
      /my cash\s*—/i.test(await tiles(tul)) && !(await tul.$('[data-act="handover"]'))]);
    await own.evaluate(() => goTo('event', 'ev_yoga')); await own.waitForTimeout(400);
    // (this page has not heard of the moves yet: it shows who held the cash before them)
    await own.click('[data-act="cash"]'); await own.waitForTimeout(400);
    t.push(['Track Cash says who holds a place\'s cash: "held by Tulasi 35 € · Event Lead 70 €"',
      /held by Tulasi 35 € · Event Lead 70 €/.test(await own.evaluate(() => document.querySelector('#modal').innerText))]);
    await own.evaluate(() => closeModal()); await refresh(own);
    await own.click('[data-act="cash"]'); await own.waitForTimeout(400);
    const tc = await own.evaluate(() => document.querySelector('#modal').innerText);
    t.push(['Track Cash names no one holding Yoga Studio\'s cash any more', !/held by/.test(tc)]);
    await own.evaluate(() => closeModal());
    await own.evaluate(() => goTo('region', 'rg_it')); await own.waitForTimeout(400);

    /* ---- b224: a closing count that does not match ---- */
    await O({ action: 'createEvent', eventId: 'ev_park', name: 'Park Stall', regionId: 'rg_it', season: SA });
    await O({ action: 'adjustStockBulk', location: 'ev_park', items: [{ bookId: B[0], delta: 10 }], override: true, season: SA });
    await O({ action: 'closeLocation', kind: 'event', id: 'ev_park', counts: { ['ev_park|' + B[0]]: 8 }, note: 'two missing', season: SA });
    // b232: and two more things waiting, so the To do panel has three tabs.
    await O({ action: 'sell', saleId: 'sPend', location: 'ev_yoga', bookId: B[1], legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }], pending: true, name: 'Ananda', season: SA });
    await O({ action: 'sell', saleId: 'sPre', location: 'ev_yoga', bookId: B[2], legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }], isPreorder: true, name: 'Bhakti', season: SA });
    await refresh(own);
    const todo = await own.evaluate(() => ({
      tabs: [...document.querySelectorAll('#todoTabs .todo-tab')].map(b => b.innerText.replace(/\s+/g, ' ').trim()),
      colours: [...document.querySelectorAll('#todoTabs .todo-tab')].map(b => getComputedStyle(b).borderColor),
      old: ['#pendingPanel', '#prePanel', '#countPanel'].filter(id => { const e = document.querySelector(id); return e && e.closest('#todoPanel'); }).length }));
    t.push(['b232: one To do panel, a filter for each kind with its count: Pending Payments 1, Pre-Orders 1, Counts to Look Into 1',
      JSON.stringify(todo.tabs) === JSON.stringify(['Pending Payments 1', 'Pre-Orders 1', 'Counts to Look Into 1']) && todo.old === 3]);
    t.push(['…each kind in its own colour', new Set(todo.colours).size === 3]);
    const panes = () => own.evaluate(() => ['#pendingPanel', '#prePanel', '#countPanel'].map(id => document.querySelector(id).offsetHeight > 0));
    t.push(['b235: all three shown to begin with, each under its own heading', JSON.stringify(await panes()) === '[true,true,true]'
      && await own.evaluate(() => document.querySelectorAll('#todoPanel .todo-h').length === 3 && /Ananda/.test(document.querySelector('#pendingList').innerText))]);
    t.push(['…no sort buttons any more', await own.evaluate(() => !document.querySelector('#todoPanel [data-act="todosort"]'))]);
    await own.click('#todoTabs [data-tab="pending"]'); await own.waitForTimeout(200);
    t.push(['a tap on "Pending Payments" hides them; the others stay', JSON.stringify(await panes()) === '[false,true,true]']);
    await own.evaluate(() => document.querySelector('#todoPanel').scrollIntoView());
    await own.screenshot({ path: shot('12-todo') });
    // The report: kind by kind, only the kinds ticked (to begin with, what is shown).
    await own.click('#todoRep [data-act="todoreport"]'); await own.waitForTimeout(300);
    const rp = async () => own.evaluate(() => ({ text: document.querySelector('#repText').value,
      ticks: [...document.querySelectorAll('#modal [data-rp]')].map(c => c.dataset.rp + ':' + c.checked) }));
    let r1 = await rp();
    t.push(['📋 To Do report: a tick per kind — pending off (hidden), pre-orders and counts on',
      r1.ticks.join() === 'pending:false,preorders:true,prepeople:true,counts:true']);
    t.push(['…the text goes kind by kind: pre-orders, then the count, no pending payments',
      /PRE-ORDERS PENDING[\s\S]*WHO IS WAITING[\s\S]*Bhakti[\s\S]*COUNTS TO LOOK INTO[\s\S]*Park Stall/.test(r1.text) && !/PAYMENTS PENDING\*/.test(r1.text.replace(/PRE-ORDERS PENDING/g, ''))]);
    await own.click('#modal [data-rp="preorders"]'); await own.click('#modal [data-rp="prepeople"]'); await own.click('#modal [data-rp="counts"]');
    await own.click('#modal [data-rp="pending"]'); await own.waitForTimeout(150);
    r1 = await rp();
    t.push(['…untick all but Pending Payments: a report of pending payments only', /PAYMENTS PENDING/.test(r1.text) && /Western/.test(r1.text) && !/PRE-ORDERS|COUNTS/.test(r1.text)]);
    await own.evaluate(() => closeModal());
    await own.click('#todoTabs [data-tab="pending"]'); await own.waitForTimeout(150);
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
    t.push(['…and its filter is gone (nothing open)', await own.evaluate(() => !document.querySelector('#todoTabs [data-tab="counts"]') && document.querySelector('#countPanel').style.display === 'none')]);
    // Prices: the shelf shows the local one; the sell window shows them all.
    await own.evaluate(() => goTo('event', 'ev_yoga')); await own.waitForTimeout(400);
    const price = await own.evaluate(() => document.querySelector('#invGrid .book .price').innerText.trim());
    t.push(['b232: a shelf card shows the local price only ("35 €")', /^35\s*€$/.test(price)]);
    await own.click('#invGrid .book .sell-btn'); await own.waitForTimeout(300);
    t.push(['…the sell window shows every currency\'s ("35 € · $40")', /Price: 35 € · \$40/.test(await own.evaluate(() => document.querySelector('.sale-prices').innerText))]);
    await own.evaluate(() => closeModal());
    await own.evaluate(() => goTo('region', 'rg_it')); await own.waitForTimeout(300);

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

    /* ---- b226: Spreadsheet Links ---- */
    t.push(['no "Sync sheet" in the top bar any more', !(await own.$('#syncBtn')) && !/Sync sheet/.test(await own.evaluate(() => document.querySelector('.util-bar').innerText))]);
    await own.click('[data-act="drivefolder"]'); await own.waitForTimeout(800);
    let dm = await own.evaluate(() => document.querySelector('#modal').innerText);
    t.push(['Universal: Spreadsheet Links has "Rebuild spreadsheets now", the folders and every file', /Rebuild spreadsheets now/.test(dm) && /Top-Level Folder/i.test(dm) && /Spain/.test(dm)]);
    await own.screenshot({ path: shot('8-links-owner') });
    await own.click('#modal [data-act="syncsheet"]'); await own.waitForTimeout(1500);
    t.push(['…pressing it rebuilds them (Google is asked)', forwarded.includes('syncSheets')]);
    await O({ action: 'peopleAdd', email: 'rita@example.com', name: 'Rita', role: 'RL', placeId: 'rg_it' });
    const rita = await open('rita@example.com', 'Rita');
    await rita.click('[data-act="drivefolder"]'); await rita.waitForTimeout(800);
    dm = await rita.evaluate(() => document.querySelector('#modal').innerText);
    t.push(['a Regional Lead: Spreadsheet Links shows only Italy\'s file', /Italy — Europe Tour/.test(dm) && !/Spain|Season Summary/.test(dm)]);
    t.push(['…to view, with how to make a copy; no folders, no rebuild', /Make a copy/.test(dm) && !/Top-Level Folder|Rebuild/i.test(dm)]);
    await rita.screenshot({ path: shot('9-links-lead') });

    /* ---- b231: the practice space ---- */
    const pr = await open('owner@example.com', 'The Owner', 1150, '?practice');
    const bar = await pr.evaluate(() => (document.querySelector('#practiceBar') || {}).innerText || '');
    t.push(['?practice: the practice banner, with "Start over" and "Leave practice"', /Practice space/.test(bar) && /Start over from the live app/.test(bar) && /Leave practice/.test(bar)]);
    t.push(['…the page talks to the practice server, which holds a copy (Italy is there)', await pr.evaluate(() => CONFIG.APPS_SCRIPT_URL === 'http://practice.test/' && (STATE.regions||[]).some(r => r.regionId === 'rg_it'))]);
    t.push(['…and keeps everything on this device apart from the live app ("practice:")', await pr.evaluate(() =>
      Object.keys(localStorage).length > 0 && Object.keys(localStorage).every(k => /^practice:/.test(k)))]);
    await pr.evaluate(B0 => commit({ action: 'sell', saleId: 'PRS1', location: 'ev_yoga', bookId: B0, legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] }, () => {}, null), B[0]);
    await pr.waitForTimeout(1500);
    const both = [(await O({ action: 'getState', season: SA })).state];
    t.push(['a sale made in practice is not in the live records', !both[0].sales.some(x => x.saleId === 'PRS1')]);
    prExec('INSERT INTO session (token, email, exp, made) VALUES (?, ?, ?, ?)', 'Ptest', 'owner@example.com', Date.now() + 864e5, Date.now());
    const prState = JSON.parse(await prSrv.request({ postData: { contents: JSON.stringify({ action: 'getState', season: SA, s: 'Ptest' }) } })).state;
    t.push(['…but is in practice', !!prState && prState.sales.some(x => x.saleId === 'PRS1')]);
    t.push(['"Leave practice" goes back to the live app\'s address', await pr.evaluate(() => !/practice/.test(document.querySelector('#practiceBar a').getAttribute('href')))]);
    await pr.screenshot({ path: shot('11-practice') });
    // b233–b234: in practice, the admin buttons live in a left-hand menu, like Cloudflare's.
    const sn = () => pr.evaluate(() => ({
      panel: document.querySelector('#adminPanel').offsetHeight,
      width: document.querySelector('#sideNav').getBoundingClientRect().width,
      secs: [...document.querySelectorAll('#sideNav .sn-gh')].map(b => b.innerText.replace(/\s+/g, ' ').replace(/[▾▸]/g, '').trim()),
      solo: (document.querySelector('#sideNav .sn-solo') || {}).innerText || '',
      foot: (document.querySelector('#sideNav .sn-foot') || {}).innerText || '',
      bg: getComputedStyle(document.querySelector('#sideNav')).backgroundColor,
      cream: (() => { const x = document.createElement('div'); x.style.background = 'var(--cream)'; document.body.appendChild(x); const c = getComputedStyle(x).backgroundColor; x.remove(); return c; })() }));
    let snv = await sn();
    t.push(['practice: no App Admin panel; a slim column down the left, the page\'s own cream', snv.panel === 0 && snv.width < 70 && snv.bg === snv.cream]);
    t.push(['…sections in the owner\'s order: Books, Money, Season Admin, Advanced, App Development, Settings', /Books.*Money.*Season Admin.*Advanced.*App Development.*Settings/.test(snv.secs.join('|'))]);
    t.push(['…then Support; Sign Out at the foot', /Support/.test(snv.solo) && /Sign Out/.test(snv.foot)]);
    await pr.hover('#sideNav .sn-gh[data-sec="money"]'); await pr.waitForTimeout(350);
    snv = await sn();
    t.push(['the pointer over it opens it out, icons and words together', snv.width > 250]);
    const adv = await pr.evaluate(() => [...document.querySelectorAll('#sideNav .sn-group[data-sec="advanced"] .sn-item .sn-t')].map(x => x.textContent));
    t.push(['Advanced: Spreadsheets, Specialty Reports, Sales Links, App Access', JSON.stringify(adv) === JSON.stringify(['Spreadsheets', 'Specialty Reports', 'Sales Links', 'App Access'])]);
    const dev = await pr.evaluate(() => [...document.querySelectorAll('#sideNav .sn-group[data-sec="dev"] .sn-item .sn-t')].map(x => x.textContent));
    t.push(['App Development: Edit Wording, (Leave) Practice, Permissions', JSON.stringify(dev) === JSON.stringify(['Edit Wording', 'Leave Practice', 'Permissions'])]);
    await pr.click('#sideNav .sn-gh[data-sec="books"]'); await pr.waitForTimeout(150);
    t.push(['a section folds and opens from its heading', await pr.evaluate(() => document.querySelector('#sideNav .sn-group[data-sec="books"] .sn-items').offsetHeight === 0)]);
    await pr.click('#sideNav .sn-gh[data-sec="books"]'); await pr.waitForTimeout(150);
    await pr.screenshot({ path: shot('13-sidenav') });
    await pr.mouse.move(900, 600); await pr.waitForTimeout(350);
    t.push(['…and it folds back when the pointer leaves', (await sn()).width < 70]);
    t.push(['the Activity Log is in the top bar, not in the menu', await pr.evaluate(() =>
      !!document.querySelector('.util-bar [data-act="activity"]') && !document.querySelector('#sideNav [data-act="activity"]'))]);
    await pr.hover('#sideNav'); await pr.waitForTimeout(300);
    await pr.click('#sideNav .sn-item[data-act="cash"]'); await pr.waitForTimeout(400);
    t.push(['an action from it works (Track Cash opens)', await pr.evaluate(() => document.querySelector('#overlay').classList.contains('show'))]);
    await pr.evaluate(() => closeModal());
    await pr.hover('#sideNav'); await pr.waitForTimeout(300);
    await pr.click('#sideNav [data-act="snpin"]'); await pr.waitForTimeout(250);
    await pr.mouse.move(900, 600); await pr.waitForTimeout(300);
    t.push(['"Keep the menu open" keeps it beside the page (the page moves over)', (await sn()).width > 250 && await pr.evaluate(() => parseInt(getComputedStyle(document.body).paddingLeft) > 250)]);
    await pr.screenshot({ path: shot('14-sidenav-pinned') });
    await pr.reload(); await pr.waitForTimeout(2500);
    t.push(['b235: after a reload the menu starts closed, even if it was kept open', (await sn()).width < 70
      && await pr.evaluate(() => parseInt(getComputedStyle(document.body).paddingLeft) < 70)]);
    // Profile and Permissions.
    await pr.hover('#sideNav'); await pr.waitForTimeout(300);
    await pr.click('#sideNav .sn-item[data-act="whoami"]'); await pr.waitForTimeout(300);
    t.push(['Settings › Profile: your name, to change', /Profile/.test(await pr.evaluate(() => document.querySelector('#modal h3').textContent)) && !!(await pr.$('#myName'))]);
    await pr.evaluate(() => closeModal());
    await pr.hover('#sideNav'); await pr.waitForTimeout(300);
    await pr.click('#sideNav .sn-item[data-act="permissions"]'); await pr.waitForTimeout(800);
    t.push(['App Development › Permissions: the table, every role, every row', await pr.evaluate(() => document.querySelectorAll('#modal .pm-lv').length === 40 * 9)]);
    await pr.selectOption('#modal .pm-lv[data-cap="deliver_a_pre_order"][data-role="S"]', 'y'); await pr.waitForTimeout(100);
    t.push(['…a changed box is highlighted', await pr.evaluate(() => !!document.querySelector('#modal .pm-lv[data-cap="deliver_a_pre_order"][data-role="S"]').closest('.pm-changed'))]);
    await pr.click('#modal [data-pmtab="person"]'); await pr.waitForTimeout(150);
    await pr.selectOption('#pmWho', 'tulasi@example.com'); await pr.waitForTimeout(100);
    await pr.selectOption('#modal .pm-pv[data-cap="edit_or_delete_a_sale"]', 'n'); await pr.waitForTimeout(100);
    await pr.screenshot({ path: shot('16-permissions') });
    await pr.click('#pmSave'); await pr.waitForTimeout(800);
    const pm = JSON.parse(await prSrv.request({ postData: { contents: JSON.stringify({ action: 'permGet', s: 'Ptest' }) } })).result;
    t.push(['…saved: Sellers may now deliver pre-orders; Tulasi alone may not edit or delete a sale',
      pm.table.deliver_a_pre_order.S === 'y' && pm.people['tulasi@example.com'].edit_or_delete_a_sale === 'n']);
    t.push(['…and only Universal may', !JSON.parse(await srv.request({ postData: { contents: JSON.stringify({ action: 'permGet', s: tulasi }) } })).ok]);
    // Cards or a list, section by section.
    await pr.evaluate(() => goTo('region', 'rg_it')); await pr.waitForTimeout(500);
    t.push(['card/list view: a switch on each section with cards, none in the top bar', await pr.evaluate(() =>
      !!document.querySelector('#titlePanel .view-tg') && document.querySelector('#viewBtn').style.display === 'none')]);
    await pr.click('#titlePanel .view-tg'); await pr.waitForTimeout(200);
    t.push(['…one section switches to a list on its own', await pr.evaluate(() =>
      document.querySelector('#titlePanel').classList.contains('list-view') && !document.body.classList.contains('list-view'))]);
    const live = await open('owner@example.com', 'The Owner');
    t.push(['the build number and status light: Universal sees them', await live.evaluate(() => document.querySelector('#bld').offsetHeight > 0)]);
    const sel = await open('tulasi@example.com', 'Tulasi');
    t.push(['…a Seller does not', await sel.evaluate(() => document.querySelector('#bld').offsetHeight === 0 && document.querySelector('.util-bar .status').offsetHeight === 0)]);
    const liveMenu = await open('owner@example.com', 'The Owner', 1150, '?menu');
    t.push(['b235: the live app has the left-hand menu too, and no App Admin panel', await liveMenu.evaluate(() =>
      !!document.querySelector('#sideNav') && document.querySelector('#adminPanel').offsetHeight === 0 && !document.querySelector('#practiceBar'))]);
    await liveMenu.hover('#sideNav'); await liveMenu.waitForTimeout(350);
    const look = await liveMenu.evaluate(() => { const h = document.querySelector('#sideNav .sn-gh'), it = document.querySelector('#sideNav .sn-items .sn-item');
      return { hw: getComputedStyle(h).fontWeight, ic: getComputedStyle(it).color, hx: h.querySelector('.sn-t').getBoundingClientRect().left, ix: it.querySelector('.sn-t').getBoundingClientRect().left }; });
    t.push(['…headings not bold; sub-items dark grey and indented under them', Number(look.hw) < 600 && look.ic === 'rgb(74, 74, 74)' && look.ix >= look.hx + 8]);
    await liveMenu.screenshot({ path: shot('17-live-menu') });
    const prPhone = await open('owner@example.com', 'The Owner', 390, '?practice');
    t.push(['practice on a phone: no column, a round ☰ at the bottom left', await prPhone.evaluate(() =>
      document.querySelector('#sideNav').getBoundingClientRect().right <= 0 && document.querySelector('#snFab').offsetHeight > 40)]);
    await prPhone.click('#snFab'); await prPhone.waitForTimeout(300);
    t.push(['…which slides the menu in, without the page going wider than the screen', await prPhone.evaluate(() =>
      document.querySelector('#sideNav').getBoundingClientRect().left >= 0 && document.documentElement.scrollWidth <= innerWidth)]);
    await prPhone.screenshot({ path: shot('15-sidenav-phone') });
    t.push(['the live app shows no banner, and offers "🧪 Practice Space"', await live.evaluate(() => !document.querySelector('#practiceBar')
      && [...document.querySelectorAll('#adminActions a, #sideNav a')].some(a => /Practice/.test(a.textContent) && /practice/.test(a.getAttribute('href'))))]);

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
