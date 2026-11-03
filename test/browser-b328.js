/* Optional, needs Playwright + Chromium: node test/browser-b328.js
   b328 (Gita, 3 Nov): distributed on one line, HQ without the Summaries
   Portal box (practice), Select / Deselect all titles, Clear everything in
   Transfer, transferred titles carried and priced like their kind, Net Sales
   only for Universal / Finance, expenses red, shipping on Deliver and
   Transfer (practice), Pending Expenses, Cost per Book, Edit Location's id. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });
const shot = n => path.join(os.tmpdir(), 'tbs-b328-' + n + '.png');
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
  const srv = makeServer({ exec, timeZone: 'UTC', fetchImpl, googleClientId: 'client-123', adminEmails: 'owner@example.com', practice: true });
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
      const pg = await open('owner@example.com', 'The Owner', w, { q: '?practice' });
      await pg.evaluate(() => switchSeason(STATE.seasons.find(s => s.name === 'Kartika').seasonId)); await pg.waitForTimeout(2000);
      await pg.evaluate(() => goTo('event', 'ev_k')); await pg.waitForTimeout(800);
      // 1. "N distributed" on one line.
      const dist = await pg.evaluate(() => { const e = document.querySelector('#totals .dist-n'); if(!e) return null;
        const r = e.getClientRects(); return { lines: r.length, text: e.textContent }; });
      t.push([w + 'px: "' + (dist && dist.text) + '" is on one line', !!dist && dist.lines === 1]);
      // Net Sales: Universal sees it, minus the cost of the books sold.
      t.push([w + 'px: Universal sees Net Sales on the totals card', await pg.evaluate(() => /Net Sales/.test(document.querySelector('#totals').textContent))]);
      t.push([w + 'px: Expenses are red', await pg.evaluate(() => { const e = document.querySelector('#totals .sub-cost'); return !!e && getComputedStyle(e).color === 'rgb(192, 57, 43)'; })]);
      t.push([w + 'px: totals and page fit', await fits(pg)]);
      await pg.screenshot({ path: shot('totals-' + w) });
      // 3. Select / Deselect all on a new region.
      await pg.evaluate(() => regionModal()); await pg.waitForTimeout(400);
      await pg.click('#rgPrices .rp-sel-b[data-sel="*"][data-on="0"]');
      const none = await pg.evaluate(() => [...document.querySelectorAll('#modal .bk-cb')].every(c => !c.checked));
      await pg.click('#rgPrices .rp-fill .rp-sel-b[data-sel="big"][data-on="1"]');
      const big = await pg.evaluate(() => [...document.querySelectorAll('#modal .bk-cb')].filter(c => c.checked).map(c => catOfBook(bookById(c.value))));
      t.push([w + 'px: Deselect all unticks every title', none]);
      t.push([w + 'px: Big Books › Select all ticks only the big books (' + big.length + ')', big.length > 0 && big.every(c => c === 'big')]);
      t.push([w + 'px: the new region window fits', await fits(pg)]);
      await pg.screenshot({ path: shot('region-' + w) });
      await pg.evaluate(() => closeModal());
      // 4. Transfer: Transfer everything, then Clear everything; the shipping question is there.
      await pg.evaluate(() => goTo('region', 'rg_in')); await pg.waitForTimeout(600);
      await pg.evaluate(() => transferStockModal({fromLoc:'wh_in', toLoc:'ev_k'})); await pg.waitForTimeout(400);
      const okTo = true;
      await pg.waitForTimeout(1200);
      const hasAll = await pg.evaluate(() => !!document.querySelector('#xfAll') && !!document.querySelector('#xfClear'));
      t.push([w + 'px: Transfer has Transfer everything and Clear everything' + (okTo ? '' : ' (To not picked)'), hasAll]);
      if (hasAll) {
        await pg.click('#xfAll'); await pg.waitForTimeout(200);
        const filled = await pg.evaluate(() => [...document.querySelectorAll('#xfBody .xf-in')].some(i => i.value));
        await pg.click('#xfClear'); await pg.waitForTimeout(200);
        const cleared = await pg.evaluate(() => [...document.querySelectorAll('#xfBody .xf-in')].every(i => !i.value));
        t.push([w + 'px: …Clear everything empties what Transfer everything filled', filled && cleared]);
        t.push([w + 'px: …and asks "Did this require shipping costs?"', await pg.evaluate(() => /Did this require shipping costs/.test(document.querySelector('#modal').textContent))]);
        await pg.evaluate(() => { document.querySelector('#modal input[name="xfShipQ"][value="1"]').click(); }); await pg.waitForTimeout(200);
        t.push([w + 'px: …Yes asks the cost, "I don\'t know yet" and reimbursement', await pg.evaluate(() => !document.querySelector('#xfShipMore').hidden && !!document.querySelector('#xfShipUnk') && !!document.querySelector('#xfShipRbF'))]);
        t.push([w + 'px: the transfer window fits', await fits(pg)]);
        await pg.screenshot({ path: shot('transfer-' + w) });
      }
      await pg.evaluate(() => closeModal());
      // 2. Earthly HQ: no Summaries Portal box in practice.
      await pg.evaluate(() => switchSeason('HQ')); await pg.waitForTimeout(2500);
      const hq = await pg.evaluate(() => { const p = document.querySelector('#summaryPortal'), h = p.querySelector('.portal-h');
        return { on: p.classList.contains('on'), head: h ? getComputedStyle(h).display : '', shown: getComputedStyle(p).display }; });
      t.push([w + 'px: Earthly HQ shows its windows without the Summaries Portal box (' + JSON.stringify(hq) + ')', !hq.on && hq.head === 'none' && hq.shown !== 'none']);
      t.push([w + 'px: Earthly HQ fits', await fits(pg)]);
      await pg.screenshot({ path: shot('hq-' + w), fullPage: true });
      await pg.context().close();
    }

    // Deliver a pre-order with shipping: delivered, and its shipping recorded on that sale.
    const pg = await open('owner@example.com', 'The Owner', 390, { q: '?practice' });
    await pg.evaluate(() => switchSeason(STATE.seasons.find(s => s.name === 'Kartika').seasonId)); await pg.waitForTimeout(2000);
    await pg.evaluate(() => goTo('event', 'ev_k')); await pg.waitForTimeout(600);
    await pg.evaluate(() => deliverModal('P1')); await pg.waitForTimeout(1500);
    t.push(['Deliver asks "Did this require shipping costs?"', await pg.evaluate(() => /Did this require shipping costs/.test(document.querySelector('#modal').textContent))]);
    await pg.evaluate(() => document.querySelector('#modal input[name="dvShipQ"][value="1"]').click());
    await pg.fill('#dvShipAmt', '200'); await pg.selectOption('#dvShipCur', 'INR');
    t.push(['…Yes asks the cost and "Do you require reimbursement?"', await pg.evaluate(() => /Do you require reimbursement/.test(document.querySelector('#modal').textContent))]);
    t.push(['the deliver window fits at 390px', await fits(pg)]);
    await pg.screenshot({ path: shot('deliver-390') });
    await pg.click('#dvGo'); await pg.waitForTimeout(2500);
    const st = await state();
    const P1 = st.sales.find(x => x.saleId === 'P1');
    const ex = (await O({ action: 'expList', scope: 'all' })).result || [];
    const shipEx = ex.find(x => x.bookLink && x.bookLink.k === 'post' && x.bookLink.sale === 'P1');
    t.push(['the pre-order is delivered', !!P1 && (P1.delivered === true || P1.type === 'SALE')]);
    t.push(['…its shipping is an expense on that sale, at the event that sold it (' + (shipEx ? shipEx.amt + ' ' + shipEx.cur + ' at ' + shipEx.location : 'none') + ')', !!shipEx && shipEx.amt === 200 && shipEx.location === 'ev_k' && shipEx.category === 'Shipping']);
    // Pending Expense from a transfer: kept on the person's To Do.
    await pg.evaluate(() => pendExpAdd({ id: 'pe1', ts: new Date().toISOString(), location: 'rg_my', category: 'Shipping', desc: 'Shipping: 3 books from Vrindavana to Mayapur', cur: 'INR' }));
    await pg.waitForTimeout(1500);
    t.push(['a Pending Expense shows on the To Do', await pg.evaluate(() => /Pending Expenses/.test(document.querySelector('#todoPanel').textContent) && /from Vrindavana to Mayapur/.test(document.querySelector('#pexpList').textContent))]);
    t.push(['…and is kept with the person', await pg.evaluate(() => (ME.prefs.pendExp || []).length === 1)]);
    await pg.screenshot({ path: shot('todo-390') });
    // Cost per Book opens for Universal.
    await pg.evaluate(() => costPerBookModal()); await pg.waitForTimeout(1500);
    t.push(['Cost per Book opens', await pg.evaluate(() => /Cost per Book/.test(document.querySelector('#modal').textContent))]);
    t.push(['…and fits at 390px', await fits(pg)]);
    t.push(['…with each title\'s cost per copy (' + await pg.evaluate(() => (document.querySelector('#modal .cpb-row')||{}).textContent) + ')', await pg.evaluate(() => document.querySelectorAll('#modal .cpb-row').length > 0)]);
    await pg.screenshot({ path: shot('costperbook-390') });
    await pg.evaluate(() => closeModal());
    await pg.evaluate(() => finGo('expenses')); await pg.waitForTimeout(2500);
    t.push(['Finance › Expenses: the printing cost card has its own colour', await pg.evaluate(() => { const e = document.querySelector('.fx-item.fx-print'); return !!e && getComputedStyle(e).backgroundColor === 'rgb(227, 241, 238)'; })]);
    t.push(['…and the Expenses figure is red', await pg.evaluate(() => { const e = document.querySelector('.fin-exp .fin-tv'); return !!e && getComputedStyle(e).color === 'rgb(192, 57, 43)'; })]);
    t.push(['Finance › Expenses fits at 390px', await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)]);
    await pg.screenshot({ path: shot('finexp-390') });
    await pg.evaluate(() => finGo('overview')); await pg.waitForTimeout(1500);
    await pg.evaluate(() => finGo('leave')).catch(()=>{});
    await pg.evaluate(() => { document.body.classList.remove('fin-mode'); }); 
    await pg.evaluate(() => closeModal());
    // Expense form: no "printing or shipping" box on a new expense; Shipping is a kind.
    await pg.evaluate(() => expensesModal()); await pg.waitForTimeout(1500);
    const form = await pg.evaluate(() => ({ box: !!document.querySelector('#xBc'), cats: (EXP.opt || {}).categories || [] }));
    t.push(['a new expense has no "cost of printing or shipping books" box', !form.box]);
    t.push(['…and Shipping is a kind of expense (' + form.cats.join(', ') + ')', form.cats.includes('Shipping')]);
    await pg.evaluate(() => closeModal());
    // Edit Location renames the event itself.
    const saved = await pg.evaluate(async () => { const p = (STATE.events||[]).find(e => e.eventId === 'ev_k');
      return placeIdOf('event', p) === 'ev_k' && placeIdOf('region', (STATE.regions||[]).find(r => r.regionId === 'rg_in')) === 'rg_in'; });
    t.push(['Edit Location takes the event\'s own id (and a region\'s), not its region\'s or season\'s', saved]);
    await pg.context().close();

    // A Regional Lead does not see Net Sales.
    await O({ action: 'peopleAdd', email: 'rl@example.com', name: 'Lead', role: 'RL', placeId: 'rg_in' });
    const rl = await open('rl@example.com', 'Lead', 1150, { q: '' });
    await rl.evaluate(() => goTo('region', 'rg_in')); await rl.waitForTimeout(800);
    t.push(['a Regional Lead sees no Net Sales on the totals card', await rl.evaluate(() => !!document.querySelector('#totals .tcard') && !/Net Sales/.test(document.querySelector('#totals').textContent))]);
    await rl.screenshot({ path: shot('rl-1150') });
    await rl.context().close();
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
