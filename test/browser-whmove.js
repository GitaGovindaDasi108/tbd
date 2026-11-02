/* Optional, needs Playwright + Chromium: node test/browser-whmove.js
   b324: Transfer Sales to an Event (practice, Gita: Vrindavana's seller sold
   out of the warehouse as if it were Parikrama). Everything sold at the
   warehouse moves to an event (a new one, "Parikrama"); the books count as
   sent there first, so the warehouse keeps its count; cash records follow;
   the Activity Log undoes it; not in the live app; no overflow. */
/* (harness as in browser-subregions.js)
   b280: sub-regions inside a region (Gita: Spain -> Madrid, Barcelona), practice
   first. One warehouse; each event in one sub-region; the region page shows All
   or one sub-region; Collections by Region, the WhatsApp report and Finance
   show each sub-region on its own; no overflow on phone or computer. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });
const shot = n => path.join(os.tmpdir(), 'tbs-whmove-' + n + '.png');
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
  const fxAsked = [];
  const fetchImpl = async url => {
    if (/oauth2\/v3\/certs/.test(url)) return { ok: true, status: 200, json: async () => ({ keys: [pub] }) };
    if (/api\.frankfurter\.app\/\d{4}-\d\d-\d\d\?from=EUR&to=USD/.test(url)) { fxAsked.push(url); return { ok: true, status: 200, text: async () => JSON.stringify({ amount: 1, base: 'EUR', date: url.match(/app\/([\d-]+)/)[1], rates: { USD: 1.1 } }) }; }
    if (/frankfurter\.app\/[\d-]+\?from=GBP/.test(url)) return new Promise(() => {});   // b267: a source that never answers
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
  await O({ action: 'saveSeason', name: 'Kartika' });
  const SA = (await O({ action: 'getState' })).state.activeSeason;
  await O({ action: 'createRegion', regionId: 'rg_vr', whLoc: 'wh_vr', name: 'Vrindavana', currencies: 'INR,USD', season: SA });
  await O({ action: 'createEvent', eventId: 'ev_nt', name: 'Night time sales', regionId: 'rg_vr', season: SA });
  await O({ action: 'adjustStockBulk', location: 'wh_vr', items: [{ bookId: 'sr_en', delta: 10 }, { bookId: 'adv_en', delta: 10 }], override: true, season: SA });
  const sell = (id, p) => O(Object.assign({ action: 'sell', saleId: id, location: 'wh_vr', season: SA, override: true }, p));
  await sell('v1', { bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'INR', amt: 500 }], by: 'Radha' });
  await sell('v2', { bookId: 'sr_en', legs: [{ type: 'Gift', cur: 'INR', amt: 0 }], by: 'Radha' });
  await sell('v3', { bookId: 'adv_en', legs: [{ type: 'Cash', cur: 'INR', amt: 200 }], by: 'Radha' });
  await sell('v4', { bookId: 'sr_en', isPreorder: true, legs: [], pending: true, name: 'Gopal', comments: 'call after 6', by: 'Radha' });
  await O({ action: 'donate', saleId: 'v5', location: 'wh_vr', legs: [{ type: 'Cash', cur: 'INR', amt: 100 }], season: SA, by: 'Radha' });
  await O({ action: 'cashMove', cashId: 'c1', fromAcct: 'wh_vr', toAcct: 'BANK', cur: 'INR', amt: 300, season: SA });
  const t = [], errors = [];
  const st0 = (await O({ action: 'getState', season: SA })).state;
  const invOf = (st, loc, b) => Number(((st.inventory || []).find(i => i.location === loc && i.bookId === b) || {}).qty) || 0;
  const invAt = (st, loc) => JSON.stringify((st.inventory || []).filter(i => i.location === loc).map(i => i.bookId + ':' + i.qty).sort());
  t.push(['setup: five records at the warehouse, 8 Sri Radha + 9 Adventures left there', st0.sales.filter(x => x.location === 'wh_vr').length === 5 && invOf(st0, 'wh_vr', 'sr_en') === 8 && invOf(st0, 'wh_vr', 'adv_en') === 9]);
  const whBefore = invAt(st0, 'wh_vr');

  const browser = await chromium.launch();
  async function open(email, name, width, live) {
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
    await page.goto('http://app.test/index.html' + (live ? '?menu' : '?practice')); await page.waitForTimeout(1500);
    await page.click('#fakeGsi'); await page.waitForTimeout(2500);
    return page;
  }
  const spill = pg => pg.evaluate(() => {
    const out = [], vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const W = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > W + 1) out.push('page scrolls sideways');
    document.querySelectorAll('.subr-bar, .subr-bar *, .subr-note, #modal, #modal *, .fin-share, tr.cbr-sub').forEach(e => {
      if (!vis(e)) return;
      const r = e.getBoundingClientRect();
      if (r.right > W + 1) out.push('past the edge: ' + (e.className || e.tagName) + ' ' + Math.round(r.right));
      const cs = getComputedStyle(e);
      if (e.scrollWidth > e.clientWidth + 1 && cs.overflowX === 'visible' && !/^(SELECT|INPUT|OPTION)$/.test(e.tagName)) out.push('spills: ' + (e.className || e.tagName));
    });
    return out;
  });
  const spills = [];

  try {
    const own = await open('owner@example.com', 'The Owner', 1150);
    await own.evaluate(() => goTo('region', 'rg_vr')); await own.waitForTimeout(500);
    t.push(['practice: Advanced has "Transfer Sales to an Event"', await own.evaluate(() => !!document.querySelector('#sideNav [data-act="whmove"]'))]);
    await own.evaluate(() => whMoveModal()); await own.waitForTimeout(400);
    let m = await own.$eval('#modal', e => e.innerText);
    t.push(['the window opens on Vrindavana, listing Night time sales and a new event', await own.$eval('#ppReg', e => e.value) === 'rg_vr'
      && await own.$$eval('#wmEv option', o => o.map(x => x.textContent).join('|')) === 'Night time sales|＋ A new event…']);
    t.push(['it says what moves: 3 books, 1 pre-order, 1 donation', /3 books sold or gifted, 1 pre-order, 1 donation/.test(m)]);
    const whoOpts = (await own.$$eval('#wmWho option', o => o.map(x => x.textContent))).join('|'); t.push(['whose sales: Everyone (5) and the seller by name (' + whoOpts + ')', whoOpts === 'Everyone (5)|The Owner (5)']);
    await own.selectOption('#wmEv', '__new'); await own.waitForTimeout(100);
    await own.click('#ppSave'); await own.waitForTimeout(200);
    t.push(['a new event needs a name', /Give the new event a name/.test(await own.$eval('#modalErr', e => e.textContent))]);
    await own.fill('#wmName', 'Night time sales'); await own.click('#ppSave'); await own.waitForTimeout(200);
    t.push(['…and not one already in the region', /already in Vrindavana/.test(await own.$eval('#modalErr', e => e.textContent))]);
    await own.fill('#wmName', 'Parikrama'); await own.waitForTimeout(100);
    t.push(['the explanation names Parikrama', /to Parikrama/.test(await own.$eval('#wmWhat', e => e.innerText))]);
    for (const w of [1150, 390]) { await own.setViewportSize({ width: w, height: 900 }); await own.waitForTimeout(250); (await spill(own)).forEach(x => spills.push(w + ' window: ' + x)); }
    await own.screenshot({ path: shot('window-phone') });
    await own.setViewportSize({ width: 1150, height: 900 });
    await own.screenshot({ path: shot('window-computer') });
    await own.click('#ppSave'); await own.waitForTimeout(2500);
    const st1 = (await O({ action: 'getState', season: SA })).state;
    const pk = st1.events.find(e => e.name === 'Parikrama');
    t.push(['Parikrama is a new event of Vrindavana', pk && pk.regionId === 'rg_vr']);
    t.push(['every warehouse record is Parikrama\'s now, notes and names kept', pk && !st1.sales.some(x => x.location === 'wh_vr')
      && st1.sales.filter(x => x.location === pk.eventId).length === 5 && st1.sales.find(x => x.saleId === 'v4').comments === 'call after 6']);
    t.push(['the warehouse keeps the count it had', invAt(st1, 'wh_vr') === whBefore]);
    t.push(['Parikrama holds nothing (it was sent what it sold)', !invOf(st1, pk.eventId, 'sr_en') && !invOf(st1, pk.eventId, 'adv_en')]);
    const mv = (st1.stockMoves || []).filter(x => x.toLoc === pk.eventId);
    t.push(['the transfer log shows 2 Sri Radha + 1 Adventures sent to Parikrama', (mv.find(x => x.bookId === 'sr_en') || {}).qty == 2 && (mv.find(x => x.bookId === 'adv_en') || {}).qty == 1]);
    t.push(['the cash record went with the money', (st1.cash || []).some(c => c.id === 'c1' && c.fromAcct === pk.eventId)]);
    t.push(['the app opened Parikrama', await own.evaluate(id => CUR_LOC === id, pk.eventId)]);
    await own.waitForTimeout(300);
    for (const w of [1150, 390]) { await own.setViewportSize({ width: w, height: 900 }); await own.waitForTimeout(250); (await spill(own)).forEach(x => spills.push(w + ' event: ' + x)); }
    await own.setViewportSize({ width: 1150, height: 900 });
    await own.reload(); await own.waitForTimeout(2500);
    await own.screenshot({ path: shot('parikrama'), fullPage: true });
    // The Activity Log says it and undoes it.
    const act = (await O({ action: 'activity', season: SA })).result || {};
    const rows = act.rows || act.items || act || [];
    const row = (Array.isArray(rows) ? rows : []).find(x => /Moved 5 sales from Vrindavana's warehouse to Parikrama/.test(x.text || ''));
    t.push(['Activity Log: "Moved 5 sales from Vrindavana\'s warehouse to Parikrama (3 books …), with 1 cash record"', !!row && /3 books/.test(row.text) && /1 cash record/.test(row.text)]);
    if (row) {
      const u = await O({ action: 'undoActivity', id: row.id, season: SA });
      const st2 = (await O({ action: 'getState', season: SA })).state;
      t.push(['undo: everything is back at the warehouse, Parikrama gone', u.ok && st2.sales.filter(x => x.location === 'wh_vr').length === 5 && !st2.events.some(e => e.name === 'Parikrama')
        && (st2.cash || []).some(c => c.id === 'c1' && c.fromAcct === 'wh_vr') && invAt(st2, 'wh_vr') === whBefore]);
    }
    // Into an event that already exists.
    const r2 = await O({ action: 'moveWhSales', regionId: 'rg_vr', eventId: 'ev_nt', moveId: 'wm_t2', season: SA });
    const st3 = (await O({ action: 'getState', season: SA })).state;
    t.push(['server: into an existing event too', r2.ok && st3.sales.filter(x => x.location === 'ev_nt').length === 5]);
    const r3 = await O({ action: 'moveWhSales', regionId: 'rg_vr', eventId: 'ev_nt', moveId: 'wm_t3', season: SA });
    t.push(['server: nothing left to move says so', !r3.ok && /no sales at Vrindavana/.test(r3.error || '')]);
    t.push(['no overflow (window, event page; phone and computer)' + (spills.length ? ' — ' + spills.slice(0, 4).join(' | ') : ''), !spills.length]);
    // Not in the live app yet.
    const lv = await open('owner@example.com', 'The Owner', 1150, true);
    await lv.evaluate(() => goTo('region', 'rg_vr')); await lv.waitForTimeout(400);
    t.push(['live: not in the menu', await lv.evaluate(() => !document.querySelector('#sideNav [data-act="whmove"]'))]);
  } catch (e) { errors.push('test: ' + e.stack); }
  await browser.close();
  let bad = 0;
  t.forEach(([n, ok]) => { if (!ok) bad++; console.log((ok ? '  ok   ' : '  FAIL ') + n); });
  errors.forEach(e => console.log('  ERROR ' + e));
  console.log(bad || errors.length ? `\n${bad} failed, ${errors.length} errors` : `\nall ${t.length} passed`);
  process.exit(bad || errors.length ? 1 : 0);
})();
