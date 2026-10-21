/* Optional, needs Playwright + Chromium: node test/browser-subregions.js
   b280: sub-regions inside a region (Gita: Spain -> Madrid, Barcelona), practice
   first. One warehouse; each event in one sub-region; the region page shows All
   or one sub-region; Collections by Region, the WhatsApp report and Finance
   show each sub-region on its own; no overflow on phone or computer. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });
const shot = n => path.join(os.tmpdir(), 'tbs-subr-' + n + '.png');
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
  await O({ action: 'createRegion', regionId: 'rg_sp', whLoc: 'wh_sp', name: 'Spain', currencies: 'EUR,USD', season: SA });
  await O({ action: 'createEvent', eventId: 'ev_m1', name: 'Madrid Class', regionId: 'rg_sp', season: SA });
  await O({ action: 'createEvent', eventId: 'ev_b1', name: 'Barcelona Festival', regionId: 'rg_sp', season: SA });
  await O({ action: 'createEvent', eventId: 'ev_g1', name: 'Online Kirtan', regionId: 'rg_sp', season: SA });
  for (const l of ['ev_m1', 'ev_b1', 'ev_g1', 'wh_sp'])
    await O({ action: 'adjustStockBulk', location: l, items: [{ bookId: 'sr_en', delta: 10 }, { bookId: 'adv_en', delta: 10 }], override: true, season: SA });
  const sell = (id, loc, book, p) => O(Object.assign({ action: 'sell', saleId: id, location: loc, bookId: book, season: SA }, p));
  await sell('m1', 'ev_m1', 'sr_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] });
  await sell('m2', 'ev_m1', 'sr_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] });
  await sell('m3', 'ev_m1', 'sr_en', { legs: [{ type: 'Gift', cur: 'USD', amt: 0 }] });
  await sell('b1', 'ev_b1', 'sr_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] });
  await sell('b2', 'ev_b1', 'adv_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 15 }] });
  await sell('w1', 'wh_sp', 'sr_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] });
  await O({ action: 'expCatAdd', name: 'Shipping' });
  await O({ action: 'expSave', id: 'Xship001', kind: 'record', date: '2026-10-10', desc: 'Shipping to Spain', amt: 100, cur: 'USD', location: 'rg_sp', category: 'Shipping' });
  await O({ action: 'expSave', id: 'Xhall001', kind: 'record', date: '2026-10-11', desc: 'Madrid hall', amt: 10, cur: 'USD', location: 'ev_m1', category: 'Shipping' });
  const set = await O({ action: 'setSubRegions', regionId: 'rg_sp', season: SA,
    list: [{ id: 'sr_m', name: 'Madrid' }, { id: 'sr_b', name: 'Barcelona' }], events: { ev_m1: 'sr_m', ev_b1: 'sr_b' } });
  const st0 = (await O({ action: 'getState', season: SA })).state;
  const t = [], errors = [];
  t.push(['server: setSubRegions saves the names and which event is where', set.ok && JSON.stringify(st0.subRegions.regions.rg_sp) === JSON.stringify([{ id: 'sr_m', name: 'Madrid' }, { id: 'sr_b', name: 'Barcelona' }])
    && st0.subRegions.events.ev_m1 === 'sr_m' && st0.subRegions.events.ev_b1 === 'sr_b' && !st0.subRegions.events.ev_g1]);
  const bogus = await O({ action: 'setSubRegions', regionId: 'rg_sp', season: SA, events: { ev_g1: 'sr_nope' } });
  t.push(['server: an event cannot go in a sub-region that does not exist', !(await O({ action: 'getState', season: SA })).state.subRegions.events.ev_g1 && bogus.ok]);

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
  const fpage = page => page.evaluate(() => document.querySelector('#fpBody').innerText);
  const repText = page => page.$eval('#repText', e => e.value);
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
    const own = await open('owner@example.com', 'The Owner');
    await own.evaluate(() => goTo('region', 'rg_sp')); await own.waitForTimeout(500);
    const chips = await own.$$eval('.subr-bar .subr-chip', b => b.map(x => x.textContent.trim()));
    t.push(['the Spain page has All of Spain · Madrid · Barcelona, and ⚙', JSON.stringify(chips) === JSON.stringify(['All of Spain', 'Madrid', 'Barcelona', '⚙'])]);
    const groups = await own.$$eval('[data-act="pickloc"] optgroup', g => g.map(x => x.label + ':' + [...x.children].map(o => o.textContent).join('|')));
    t.push(['the place picker groups events by sub-region, then the general ones', JSON.stringify(groups) === JSON.stringify(['Madrid:Madrid Class', 'Barcelona:Barcelona Festival', 'Spain, general:Online Kirtan'])]);
    t.push(['All of Spain: every sale (6)', await own.evaluate(() => scopedSales().length) === 6]);
    let r = await own.evaluate(() => buildReport(''));
    t.push(['the report on All of Spain adds a By sub-region block, Big Books and Adventures apart', /— BY SUB-REGION —\nMadrid\nBig Books = 2 Sold \+ 1 Gift = 3 Distributed/.test(r)
      && /Barcelona\nBig Books = 1 Sold \+ 0 Gifts = 1 Distributed\nAdventures = 1 Sold \+ 0 Gifts = 1 Distributed/.test(r) && /Spain, general\nBig Books = 1 Sold/.test(r)]);
    t.push(['…and the money by sub-region, after costs', /— BY SUB-REGION \(after costs\) —/.test(r) && /Madrid - \$70/.test(r) && /Barcelona - \$55/.test(r)]);
    for (const w of [1150, 390]) { await own.setViewportSize({ width: w, height: 900 }); await own.waitForTimeout(300); (await spill(own)).forEach(x => spills.push(w + ' region: ' + x)); }
    await own.setViewportSize({ width: 390, height: 900 }); await own.screenshot({ path: shot('region-phone') });
    await own.setViewportSize({ width: 1150, height: 900 });
    await own.click('.subr-chip[data-id="sr_m"]'); await own.waitForTimeout(400);
    t.push(['Madrid chosen: the page counts Madrid\'s 3 sales only', await own.evaluate(() => withSub(()=>scopedSales().map(x=>x.saleId).sort().join(','))) === 'm1,m2,m3']);
    t.push(['…the title says Spain › Madrid', /Spain › Madrid/.test(await own.$eval('#whTitle', e => e.textContent))]);
    t.push(['…the place picker lists Madrid\'s events only', JSON.stringify(await own.$$eval('[data-act="pickloc"] option', o => o.map(x => x.textContent))) === JSON.stringify(['🏠 Warehouse', 'Madrid Class', '＋ New event…'])]);
    t.push(['…the Madrid chip is the one lit', await own.$eval('.subr-chip.on', e => e.dataset.id) === 'sr_m']);
    r = await own.evaluate(() => buildReport(''));
    t.push(['…the report is Madrid\'s, with no By sub-region block', /Big Books Total|Sri Radha/.test(r) && !/BY SUB-REGION/.test(r) && /= 2 Sold/.test(r)]);
    await own.screenshot({ path: shot('madrid') });
    t.push(['…and the real data is untouched outside the drawing', await own.evaluate(() => STATE.sales.length) === 6]);
    // A new event from Madrid's page starts in Madrid.
    await own.evaluate(() => eventModal()); await own.waitForTimeout(200);
    t.push(['a new event asks which sub-region, starting at the one you are looking at', await own.$eval('#evsub', e => e.value) === 'sr_m']);
    await own.fill('#evname', 'Madrid Kirtan'); await own.click('#saveEv'); await own.waitForTimeout(1200);
    const nid = await own.evaluate(() => (STATE.events.find(e => e.name === 'Madrid Kirtan') || {}).eventId);
    t.push(['…and it is saved there', await own.evaluate(id => subOfEvent(id), nid) === 'sr_m']);
    // The Sub-regions window.
    await own.evaluate(() => goTo('region', 'rg_sp')); await own.waitForTimeout(300);
    await own.click('.subr-chip[data-act="subregions"]'); await own.waitForTimeout(300);
    t.push(['⚙ opens Sub-regions of Spain, with each event\'s sub-region', /Sub-regions of Spain/.test(await own.$eval('#modal', e => e.innerText)) && await own.$eval('#srEvents select[data-ev="ev_b1"]', e => e.value) === 'sr_b']);
    await own.click('#srAdd'); await own.fill('#srList [data-i="2"]', 'Valencia'); await own.press('#srList [data-i="2"]', 'Tab');
    await own.selectOption('#srEvents select[data-ev="ev_g1"]', { label: 'Valencia' });
    for (const w of [1150, 390]) { await own.setViewportSize({ width: w, height: 900 }); await own.waitForTimeout(200); (await spill(own)).forEach(x => spills.push(w + ' window: ' + x)); }
    await own.screenshot({ path: shot('window-phone') });
    await own.setViewportSize({ width: 1150, height: 900 });
    await own.click('#srSave'); await own.waitForTimeout(1500);
    const st = (await O({ action: 'getState', season: SA })).state.subRegions;
    t.push(['adding Valencia and putting Online Kirtan in it saves on the server', st.regions.rg_sp.length === 3 && st.regions.rg_sp[2].name === 'Valencia' && st.events.ev_g1 === st.regions.rg_sp[2].id]);
    t.push(['…and the chips show it', (await own.$$eval('.subr-bar .subr-chip', b => b.map(x => x.textContent.trim()))).includes('Valencia')]);
    // Collections by Region, at the season.
    await own.evaluate(() => goTo('season')); await own.waitForTimeout(500);
    const sub = await own.$$eval('#collByRegion tr.cbr-sub th', h => h.map(x => x.textContent.trim()));
    t.push(['Collections by Region: Spain\'s sub-regions beneath it, then its general part', JSON.stringify(sub) === JSON.stringify(['Madrid', 'Barcelona', 'Valencia', 'Spain, general'])]);
    for (const w of [1150, 390]) { await own.setViewportSize({ width: w, height: 900 }); await own.waitForTimeout(300); (await spill(own)).forEach(x => spills.push(w + ' season: ' + x)); }
    await own.setViewportSize({ width: 1150, height: 900 });
    // Finance.
    await own.evaluate(() => finGo('overview', 'rg_sp')); await own.waitForTimeout(1500);
    let m = await own.$eval('#fpBody', e => e.innerText);
    t.push(['Finance on Spain: one level down is By Sub-region, then Spain, general', /By Sub-region/.test(m) && m.indexOf('Madrid') < m.indexOf('Barcelona') && /Spain, general/.test(m)]);
    t.push(['…the bar has a sub-region picker', await own.$$eval('[data-fpick="u"] option', o => o.map(x => x.textContent).join('|')) === 'All of Spain|Madrid|Barcelona|Valencia']);
    await own.evaluate(() => finGo('overview', 'sr_m')); await own.waitForTimeout(1200);
    m = await own.$eval('#fpBody', e => e.innerText);
    t.push(['Finance on Madrid: Sub-region level, its own expense only ($10)', /Sub-region/.test(await own.$eval('#fpNav .lvl-chip', e => e.textContent)) && /Expenses\s*\$10\b/.test(m)]);
    t.push(['…and its share of Spain\'s shared costs, by books distributed, beside Net', /Shared with all of Spain: \$100 of expenses\. Madrid distributed [\d.]+% of Spain's books/.test(m) && /Net after its share/.test(m)]);
    await own.click('#finPP .pp-in'); await own.fill('#finPP .pp-in', 'madr'); await own.waitForTimeout(200);
    const hits = await own.$$eval('#finPP .pp-row', rs => rs.map(r => r.textContent));
    t.push(['the Finance search finds the sub-region, tagged, with its events beneath', hits.includes('MadridSub-region') && hits.includes('Madrid Class') && hits.indexOf('MadridSub-region') < hits.indexOf('Madrid Class')]);
    await own.click('#fpBody h2'); await own.waitForTimeout(100);
    for (const w of [1150, 390]) { await own.setViewportSize({ width: w, height: 900 }); await own.waitForTimeout(300); (await spill(own)).forEach(x => spills.push(w + ' finance: ' + x)); }
    await own.screenshot({ path: shot('finance-phone'), fullPage: true });
    await own.setViewportSize({ width: 1150, height: 900 });
    t.push(['no overflow anywhere (region page, window, season, Finance; phone and computer)' + (spills.length ? ' — ' + spills.slice(0, 4).join(' | ') : ''), !spills.length]);
    // The live app: nothing of it yet.
    const lv = await open('owner@example.com', 'The Owner', 1150, true);
    await lv.evaluate(() => goTo('region', 'rg_sp')); await lv.waitForTimeout(400);
    t.push(['the live app shows no sub-regions yet (practice first)', await lv.evaluate(() => !document.querySelector('.subr-bar') && !document.querySelector('[data-act="pickloc"] optgroup') && !document.querySelector('[data-act="subregions"]'))]);
  } catch (e) { errors.push('test: ' + e.stack); }
  await browser.close();
  let bad = 0;
  t.forEach(([n, ok]) => { if (!ok) bad++; console.log((ok ? '  ok   ' : '  FAIL ') + n); });
  errors.forEach(e => console.log('  ERROR ' + e));
  console.log(bad || errors.length ? `\n${bad} failed, ${errors.length} errors` : `\nall ${t.length} passed`);
  process.exit(bad || errors.length ? 1 : 0);
})();
