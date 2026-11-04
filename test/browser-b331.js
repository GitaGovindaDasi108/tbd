/* Optional, needs Playwright + Chromium: node test/browser-b331.js
   b331 (Gita, 3 Nov, practice): sections. Edit Sections makes a Diaries
   section; titles move into it; the sales portal groups book cards under
   small section headings; Diaries has its own totals card; price lists and
   the WhatsApp report follow the sections. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });
const shot = n => path.join(os.tmpdir(), 'tbs-b331-' + n + '.png');
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
  const t = [], errors = [];
  const d1 = (await O({ action: 'addBook', name: 'Diary (English) Vol 1', cat: 'other' })).result;
  const d2 = (await O({ action: 'addBook', name: 'Diary (English) Vol 2', cat: 'other' })).result;
  const ss = await O({ action: 'setSections', sections: [{ id: 'big', name: 'Big Books' }, { id: 'aotm', name: 'Adventures' }, { id: 'new', name: 'Diaries', color: '#8E5BA8' }, { id: 'other', name: 'Other' }] });
  const dia = ((ss.result || []).find(x => x.name === 'Diaries') || {}).id;
  t.push(['setSections makes Diaries (' + JSON.stringify(ss.result || ss.error) + ')', !!dia && /^s_/.test(dia)]);
  for (const id of [d1, d2]) await O({ action: 'renameBook', bookId: id, name: id === d1 ? 'Diary (English) Vol 1' : 'Diary (English) Vol 2', cat: dia });
  const books = (await O({ action: 'getState', season: SA })).state.books;
  t.push(['the diaries are in Diaries', books.filter(b => b.id === d1 || b.id === d2).every(b => b.cat === dia)]);
  await O({ action: 'createRegion', regionId: 'rg_x', whLoc: 'wh_x', name: 'Vraja', currencies: 'INR,USD', season: SA, books: [BIG[0], d1, d2].join(','),
    prices: { [BIG[0]]: { INR: 500, USD: 8 }, [d1]: { INR: 300, USD: 4 }, [d2]: { INR: 300, USD: 4 } } });
  await O({ action: 'createEvent', eventId: 'ev_x', name: 'Govardhan', regionId: 'rg_x', season: SA });
  await O({ action: 'adjustStockBulk', location: 'ev_x', items: [BIG[0], d1, d2].map(b => ({ bookId: b, delta: 10 })), override: true, season: SA });
  await O({ action: 'sell', saleId: 'D1', location: 'ev_x', bookId: d1, legs: [{ type: 'Cash', cur: 'INR', amt: 300 }], season: SA });
  await O({ action: 'sell', saleId: 'D2', location: 'ev_x', bookId: d2, legs: [{ type: 'Cash', cur: 'INR', amt: 300 }], season: SA });
  await O({ action: 'sell', saleId: 'B1', location: 'ev_x', bookId: BIG[0], legs: [{ type: 'Cash', cur: 'INR', amt: 500 }], season: SA });

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
      await pg.evaluate(() => goTo('event', 'ev_x')); await pg.waitForTimeout(1000);
      const heads = await pg.evaluate(() => [...document.querySelectorAll('#invGrid .sec-h')].map(h => h.textContent));
      t.push([w + 'px: the shelf has section headings (' + heads.join(', ') + ')', heads.join() === 'Big Books,Diaries']);
      const under = await pg.evaluate(() => { const g = document.querySelector('#invGrid'); let cur = '', ok = true;
        [...g.children].forEach(c => { if (c.classList.contains('sec-h')) cur = c.textContent; else if (c.dataset.id && c.dataset.id !== DONATION_ID) { if (CAT_SHORT[catOfBook(bookById(c.dataset.id))] !== cur) ok = false; } }); return ok; });
      t.push([w + 'px: …each book under its own section', under]);
      t.push([w + 'px: Diaries has its own totals card', await pg.evaluate(() => [...document.querySelectorAll('#totals .tcard.tc-sec .label')].some(l => l.textContent === 'Diaries'))]);
      t.push([w + 'px: page and totals fit', await fits(pg)]);
      await pg.screenshot({ path: shot('event-' + w), fullPage: true });
      await pg.evaluate(() => sectionsModal()); await pg.waitForTimeout(400);
      const names = await pg.evaluate(() => [...document.querySelectorAll('#secList [data-sn]')].map(i => i.value).join());
      t.push([w + 'px: Edit Sections lists ' + names, names === 'Big Books,Adventures,Diaries,Other']);
      t.push([w + 'px: …and fits', await fits(pg)]);
      await pg.screenshot({ path: shot('sections-' + w) });
      await pg.evaluate(() => closeModal());
      await pg.evaluate(() => regionModal()); await pg.waitForTimeout(400);
      const rh = await pg.evaluate(() => [...document.querySelectorAll('#rgPrices .rp-fill .rp-name')].map(e => e.firstChild.textContent.trim()));
      t.push([w + 'px: Add Region lists ' + rh.join(', '), rh.includes('Diaries') && rh.indexOf('Diaries') > rh.indexOf('Big Books')]);
      await pg.evaluate(() => closeModal());
      const wa = await pg.evaluate(() => { try { return buildReport('books'); } catch (e) { return String(e); } });
      t.push([w + 'px: the WhatsApp report names Diaries', /Diaries/.test(String(wa))]);
      await pg.context().close();
    }
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
