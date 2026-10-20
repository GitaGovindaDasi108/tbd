/* Optional, needs Playwright + Chromium: node test/browser-reports.js
   b256: Finance › Reports, pick your own data. The line of choices (Show, At,
   During, Split by, Only, Compared with, As), ready-made questions, saved
   ones, a typed question setting the choices, the charts, the list of
   payments, comparing with last year's one in the series, and the WhatsApp
   report of what is on screen. */
// b259: Reports is off the Finance page for now (Gita, 2026-10-20). Its code
// stays, so this test is paused until it comes back: put Reports back in
// FIN_SECS and delete these two lines.
if (!process.env.TBS_REPORTS) { console.log('browser-reports: paused (Reports is off for now, b259)'); process.exit(0); }
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });
const shot = n => path.join(os.tmpdir(), 'tbs-reports-' + n + '.png');
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

  const owner = await sessionOf('owner@example.com', 'The Owner');
  const O = p => ask(Object.assign({ s: owner }, p));
  const Y = new Date().getUTCFullYear();
  // Last year's Kartika, then this year's: the same region and event, a year apart.
  await O({ action: 'saveSeason', name: 'Kartika ' + (Y - 1) });
  const SB = (await O({ action: 'getState' })).state.activeSeason;
  await O({ action: 'createRegion', regionId: 'rg_zb', whLoc: 'wh_zb', name: 'Zagreb ' + (Y - 1), currencies: 'EUR, USD', season: SB });
  await O({ action: 'createEvent', eventId: 'ev_zb', name: 'Zagreb Kirtan ' + (Y - 1), regionId: 'rg_zb', season: SB });
  await O({ action: 'adjustStockBulk', location: 'ev_zb', items: [{ bookId: 'sr_en', delta: 20 }, { bookId: 'adv_en', delta: 20 }], override: true, season: SB });
  const sellB = (id, book, p, ts) => O(Object.assign({ action: 'sell', saleId: id, location: 'ev_zb', bookId: book, season: SB, ts }, p));
  await sellB('b1', 'sr_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] }, (Y - 1) + '-10-03T10:00:00Z');
  await sellB('b2', 'adv_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 15 }] }, (Y - 1) + '-10-04T10:00:00Z');
  await sellB('b3', 'sr_en', { preorder: true, type: 'PREORDER', legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] }, (Y - 1) + '-10-04T11:00:00Z');
  await O({ action: 'saveSeason', name: 'Kartika ' + Y });
  const SA = (await O({ action: 'getState' })).state.activeSeason;
  await O({ action: 'createRegion', regionId: 'rg_zg', whLoc: 'wh_zg', name: 'Zagreb ' + Y, currencies: 'EUR, USD', season: SA });
  await O({ action: 'createRegion', regionId: 'rg_at', whLoc: 'wh_at', name: 'Athens', currencies: 'USD', season: SA });
  await O({ action: 'createEvent', eventId: 'ev_z1', name: 'Zagreb Kirtan ' + Y, regionId: 'rg_zg', season: SA });
  await O({ action: 'createEvent', eventId: 'ev_z2', name: 'Zagreb Fair', regionId: 'rg_zg', season: SA });
  await O({ action: 'adjustStockBulk', location: 'ev_z1', items: [{ bookId: 'sr_en', delta: 20 }, { bookId: 'adv_en', delta: 20 }], override: true, season: SA });
  await O({ action: 'adjustStockBulk', location: 'ev_z2', items: [{ bookId: 'sr_en', delta: 20 }], override: true, season: SA });
  await O({ action: 'adjustStockBulk', location: 'wh_at', items: [{ bookId: 'sr_en', delta: 20 }], override: true, season: SA });
  const sell = (id, loc, book, p, ts) => O(Object.assign({ action: 'sell', saleId: id, location: loc, bookId: book, season: SA, ts }, p));
  const d = (m, dd) => Y + '-' + String(m).padStart(2, '0') + '-' + String(dd).padStart(2, '0') + 'T10:00:00Z';
  await sell('z1', 'ev_z1', 'sr_en', { legs: [{ type: 'Cash', cur: 'EUR', amt: 37 }] }, d(10, 2));
  await sell('z2', 'ev_z1', 'sr_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] }, d(10, 3));
  await sell('z3', 'ev_z1', 'adv_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 15 }] }, d(10, 3));
  await sell('z4', 'ev_z1', 'adv_en', { legs: [{ type: 'Gift', cur: 'USD', amt: 0 }] }, d(10, 4));
  await sell('z5', 'ev_z2', 'sr_en', { legs: [{ type: 'Card', cur: 'USD', amt: 40 }] }, d(10, 8));
  await sell('a1', 'wh_at', 'sr_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] }, d(9, 15));
  await O({ action: 'expSave', id: 'Xvan001', kind: 'record', date: Y + '-10-02', desc: 'Van hire', amt: 20, cur: 'USD', location: 'ev_z1', category: 'Travel' });
  await O({ action: 'placeMetaSet', kind: 'events', id: 'ev_zb', from: (Y - 1) + '-10-02', to: (Y - 1) + '-10-05' });
  await O({ action: 'placeMetaSet', kind: 'events', id: 'ev_z1', from: Y + '-10-01', to: Y + '-10-05' });
  await O({ action: 'placeMetaSet', kind: 'events', id: 'ev_z2', from: Y + '-10-08', to: Y + '-10-09' });
  await O({ action: 'placeMetaSet', kind: 'regions', id: 'rg_zg', from: Y + '-09-28', to: Y + '-10-12' });

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
  const qout = page => page.evaluate(() => (document.querySelector('.qb-out')||{}).innerText || '');
  const repText = page => page.$eval('#repText', e => e.value);
  try {
    const own = await open('owner@example.com', 'The Owner');
    const S = st => own.evaluate(s => { QB.ask = ''; QB.heard = null; QB.st = Object.assign(qbDefault(), s); finRender(); }, st);
    await own.evaluate(() => finGo('report', '', {reload:true})); await own.waitForTimeout(1800);
    let m = await fpage(own);
    t.push(['Reports and Compare are one section: no Compare on the bar', !(await own.$('#fpSecs [data-sec="compare"]')) && /Reports/.test(await own.$eval('#fpSecs', e => e.innerText))]);
    t.push(['the line of choices: Show, At, During, Split by, Only, Compared with, As', ['Show','At','During','Split by','Only','Compared with','As'].every(w => new RegExp(w, 'i').test(m))]);
    t.push(['ready-made questions are listed', /Books ever sold/.test(m) && /This season vs last year/.test(m) && /UPI payments, listed/.test(m)]);
    t.push(['the old rows-and-columns table is folded away below', !!(await own.$('details.qb-old')) && !(await own.$eval('details.qb-old', e => e.open))]);
    await own.click('[data-qbready="0"]'); await own.waitForTimeout(500);
    m = await fpage(own);
    // Every season: 3 + 5 + 1 Athens = 9 books ... books: b1 b2 b3 (pre-order) z1 z2 z3 z4(gift) z5 a1
    t.push(['"Books ever sold": Big Books and Adventures, in the app\'s form', /9 distributed/.test(m) && /Big Books 6 Sold/.test(m) && /Adventures 2 Sold \+ 1 Gift = 3 Distributed/.test(m)]);
    await S({show:['coll'], during:'ever'});
    m = await qout(own);
    t.push(['Gross shows dollars with the local currency beside it', /Gross/.test(m) && /37 €/.test(m)]);
    await S({show:['books','coll'], split:'year', as:'table'});
    m = await fpage(own);
    const fy = y => 'Fiscal year ' + y + '–' + String(y + 1).slice(2);
    t.push(['b257: split by fiscal year, from 8 October: 2–8 Oct fall in the year before, 8 Oct starts the next', m.includes(fy(Y - 2)) && m.includes(fy(Y - 1)) && m.includes(fy(Y))]);
    await S({show:['books'], during:'thisYear'});
    m = await fpage(own);
    t.push(['…"This fiscal year" runs 8 Oct to 7 Oct', /this fiscal year/i.test(m) && new RegExp('\\(' + (new Date().toISOString().slice(5,10) >= '10-08' ? Y : Y - 1) + '-10-08 to \\d{4}-10-07\\)').test(m)]);
    await own.evaluate(() => finGo('overview', '', {reload:true})); await own.waitForTimeout(1500);
    t.push(['b257: the Overview\'s totals show the other currencies, as the sales page does', /37 €/.test(await own.$eval('.fin-tile:nth-child(5)', e => e.innerText))]);
    await own.evaluate(() => finGo('report', '', {reload:true})); await own.waitForTimeout(1500);
    await S({show:['days'], split:'event', as:'table', at:['s:' + (await own.evaluate(() => FIN.D.seasons.find(s => /Kartika \d{4}$/.test(s.name) && s.name.endsWith(String(new Date().getUTCFullYear()))).id))]});
    m = await fpage(own);
    t.push(['how long each event ran, from its dates', /Zagreb Kirtan \d{4}[^\n]*\n?[^\n]*5 days/.test(m) && /Zagreb Fair[^\n]*\n?[^\n]*2 days/.test(m)]);
    await S({show:['tail'], at:['r:rg_zg']});
    m = await fpage(own);
    t.push(['last event to region end: 3 days', /3 days/.test(m)]);
    // Compare this year's Zagreb Kirtan with last year's.
    await S({show:['books','coll'], at:['e:ev_z1'], cmp:'series'});
    m = await fpage(own);
    t.push(['compared with the previous one in its series (last year\'s)', /Zagreb Kirtan \d{4} · Zagreb \d{4}: /.test(m) && /▲|▼/.test(m)]);
    await own.screenshot({ path: shot('compare'), fullPage: true });
    await S({show:['coll'], split:'pay', as:'pie'});
    t.push(['a pie, with the figures beside it', (await own.$$('.qb-out .fin-pie path')).length >= 2 && /Cash/.test(await fpage(own)) && /share/i.test(await fpage(own))]);
    await S({show:['coll'], split:'month', as:'line'});
    t.push(['a line over time', !!(await own.$('.qb-out svg.qb-chart path'))]);
    await S({show:['books'], split:'region', as:'bars'});
    t.push(['bars', (await own.$$('.qb-out .fin-bar')).length >= 2]);
    await S({show:['coll'], only:'pay:Card', as:'list'});
    m = await fpage(own);
    t.push(['only Card payments, listed', /Zagreb Fair/.test(m) && /1 payment/.test(m) && !/Athens/.test(m.split('Dollars')[1] || '')]);
    // Typed questions.
    const askQ = async q => { await own.fill('#qbAsk', q); await own.click('#qbAskGo'); await own.waitForTimeout(500); return own.evaluate(() => JSON.parse(JSON.stringify(QB.st))); };
    let st = await askQ('adventures sold in Zagreb last year by event');
    t.push(['"adventures sold in Zagreb last year by event" sets Adventures, every Zagreb, last year, by event', st.show.includes('av') && st.at[0] === 'S:regions:Zagreb' && st.during === 'lastYear' && st.split === 'event']);
    st = await askQ('margin this year vs last year');
    t.push(['"margin this year vs last year": Margin, this year, compared with the same time last year', st.show.includes('margin') && st.during === 'thisYear' && st.cmp === 'lastyear']);
    st = await askQ('books by type per region as a pie chart');
    t.push(['"books by type per region as a pie chart": Big Books and Adventures, by region, a pie', st.show.includes('bb') && st.show.includes('av') && st.split === 'region' && st.as === 'pie']);
    st = await askQ('list of Card payments at the last event');
    t.push(['"list of Card payments at the last event": a list, only Card, the last event', st.as === 'list' && st.only === 'pay:Card' && st.at[0] === 'last:e']);
    st = await askQ('how many pre-orders this season compared with the previous one');
    m = await fpage(own);
    t.push(['words it could not use are shown', /Not used:/.test(m) && /season/.test(m.split('Not used:')[1] || '')]);
    t.push(['…and what it did use', /Set from your words:/.test(m) && st.show.includes('pre') && st.cmp === 'series']);
    // Saved questions.
    // (the page's prompt answers 'UPI ref 4471' in these tests)
    await own.click('#qbStar'); await own.waitForTimeout(800);
    t.push(['⭐ saves the question to the top, with the login', /UPI ref 4471/.test(await fpage(own)) && (await own.evaluate(() => (ME.prefs.finSaved||[]).length)) === 1]);
    await own.click('#qbReset'); await own.waitForTimeout(300);
    await own.click('[data-qbmine="0"]'); await own.waitForTimeout(300);
    t.push(['…and brings it back', (await own.evaluate(() => QB.st.show)).includes('pre')]);
    // WhatsApp: what is on screen.
    await S({show:['bb','coll'], split:'event', as:'table', at:['r:rg_zg']});
    await own.click('#reportBtn'); await own.waitForTimeout(400);
    const r = await repText(own);
    t.push(['📋 Report: the choices, each event, and Big Books in the app\'s form', /Show Big Books, Gross/.test(r) && /\*Zagreb Kirtan/.test(r) && /Big Books - 2 Sold/.test(r)]);
    await own.evaluate(() => closeModal());
    await own.screenshot({ path: shot('report'), fullPage: true });
    // Phone.
    const phone = await open('owner@example.com', 'The Owner', 390);
    await phone.evaluate(() => finGo('report', '', {reload:true})); await phone.waitForTimeout(1800);
    t.push(['phone width: no sideways scroll', await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)]);
    await phone.screenshot({ path: shot('phone'), fullPage: true });
  } catch (e) { errors.push('test: ' + e.stack); }
  await browser.close();
  let bad = 0;
  t.forEach(([n, ok]) => { if (!ok) bad++; console.log((ok ? '  ok   ' : '  FAIL ') + n); });
  errors.forEach(e => console.log('  ERROR ' + e));
  console.log(bad || errors.length ? `\n${bad} failed, ${errors.length} errors` : `\nall ${t.length} passed`);
  process.exit(bad || errors.length ? 1 : 0);
})();
