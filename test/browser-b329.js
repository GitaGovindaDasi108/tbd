/* Optional, needs Playwright + Chromium: node test/browser-b329.js
   b329 (Gita, 3 Nov): printing cost cards named "Original Printing (N Books)"
   and "Printing Costs transferred to X (N Books)", book price lists A to Z in
   Big Books / Adventures / Other, Add Stock asks about shipping before the
   books, Cost per Book in local currency and dollars, no Cost of Books Sold
   line on the totals bar, My Expenses under your name in the menu (green
   when paid back), Reset in Arrange. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });
const shot = n => path.join(os.tmpdir(), 'tbs-b329-' + n + '.png');
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
  t.push(['a printing cost is saved on the books (' + (pr.ok ? 'ok' : pr.error) + ')', pr.ok]);
  await O({ action: 'transferMulti', moves: [{ from: 'wh_in', to: 'ev_k', bookId: BIG[0], qty: 5 }], season: SA });
  await O({ action: 'sell', saleId: 'S1', location: 'ev_k', bookId: BIG[0], legs: [{ type: 'Cash', cur: 'INR', amt: 500 }], name: 'Govinda', season: SA });
  await O({ action: 'expSave', id: 'Xmine1', kind: 'reimburse', location: 'ev_k', date: '2026-11-02', desc: 'Tape and markers', cur: 'INR', amt: 300,
    category: 'Other', receipts: [], payTo: { phone: '+91 1' }, method: 'Cash', reimbCur: 'INR', by: 'The Owner' });
  await O({ action: 'expSave', id: 'Xmine2', kind: 'reimburse', location: 'ev_k', date: '2026-11-03', desc: 'Taxi', cur: 'INR', amt: 200,
    category: 'Other', receipts: [], payTo: { phone: '+91 1' }, method: 'Cash', reimbCur: 'INR', by: 'The Owner' });
  const mk = await O({ action: 'expMark', id: 'Xmine1', status: 'paid', note: '', paidOn: '2026-11-03' });
  t.push(['a reimbursement is paid back (' + (mk.ok ? 'ok' : mk.error) + ')', mk.ok]);

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
      t.push([w + 'px: no Cost of Books Sold line on the totals bar', await pg.evaluate(() => !/Cost of Books Sold/.test(document.querySelector('#totals').textContent) && /Expenses/.test(document.querySelector('#totals').textContent))]);
      t.push([w + 'px: totals fit', await fits(pg)]);
      await pg.screenshot({ path: shot('totals-' + w) });
      // Add Region: Big Books, Adventures, Other, each A to Z.
      await pg.evaluate(() => regionModal()); await pg.waitForTimeout(400);
      const rg = await pg.evaluate(() => {
        const heads = [...document.querySelectorAll('#rgPrices .rp-fill .rp-name')].map(e => e.firstChild.textContent.trim());
        const groups = []; let g = null;
        [...document.querySelectorAll('#rgPrices .rp-row')].forEach(r => { if (r.classList.contains('rp-fill')) { g = []; groups.push(g); } else if (g && r.dataset.row) g.push((bookById(r.dataset.row)||{}).name || ''); });
        return { heads, az: groups.every(l => l.every((n, i) => !i || l[i-1].localeCompare(n, undefined, {sensitivity:'base', numeric:true}) <= 0)) };
      });
      t.push([w + 'px: Add Region lists ' + rg.heads.join(', '), 'Big Books,Adventures,Other'.startsWith(rg.heads.join()) && rg.heads.length >= 2]);
      t.push([w + 'px: …each A to Z', rg.az]);
      t.push([w + 'px: the new region window fits', await fits(pg)]);
      await pg.screenshot({ path: shot('region-' + w) });
      await pg.evaluate(() => closeModal());
      // Add Stock: the shipping question comes before the books.
      await pg.evaluate(() => goTo('region', 'rg_in')); await pg.waitForTimeout(600);
      await pg.evaluate(() => addStockModal()); await pg.waitForTimeout(800);
      t.push([w + 'px: Add Stock asks "Did this require shipping costs?" before the books', await pg.evaluate(() => { const a = document.querySelector('#spShip'), b = document.querySelector('#spBody');
        return !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) && /Did this require shipping costs/.test(a.textContent); })]);
      await pg.evaluate(() => document.querySelector('#modal input[name="spShipQ"][value="1"]').click()); await pg.waitForTimeout(200);
      t.push([w + 'px: the Add Stock window fits', await fits(pg)]);
      await pg.screenshot({ path: shot('addstock-' + w) });
      await pg.evaluate(() => closeModal());
      // Cost per Book: local currency and dollars.
      await pg.evaluate(() => costPerBookModal()); await pg.waitForTimeout(1500);
      const cpb = await pg.evaluate(() => (document.querySelector('#modal .cpb-row')||{}).textContent || '');
      t.push([w + 'px: Cost per Book gives rupees and dollars (' + cpb.replace(/\s+/g, ' ').trim() + ')', /₹/.test(cpb) && /\$/.test(cpb)]);
      t.push([w + 'px: …and fits', await fits(pg)]);
      await pg.screenshot({ path: shot('costperbook-' + w) });
      await pg.evaluate(() => closeModal());
      // Arrange has Reset.
      await pg.evaluate(() => goTo('event', 'ev_k')); await pg.waitForTimeout(600);
      await pg.evaluate(() => { const b = document.querySelector('.arr-tg'); if (b) b.click(); }); await pg.waitForTimeout(400);
      t.push([w + 'px: Arrange has a Reset button', await pg.evaluate(() => !!document.querySelector('#arrDock [data-act="arraz"]'))]);
      await pg.evaluate(() => document.querySelector('#arrDock [data-act="arraz"]').click()); await pg.waitForTimeout(300);
      await pg.evaluate(() => document.querySelector('.sure-ov [data-sure="1"]').click()); await pg.waitForTimeout(600);
      const ord = await pg.evaluate(() => { const ids = MY_ORDER.get().filter(id => id !== DONATION_ID).map(bookById).filter(Boolean);
        const r = b => CATS.indexOf(catOfBook(b));
        return ids.length > 3 && ids.every((b, i) => !i || r(ids[i-1]) < r(b) || (r(ids[i-1]) === r(b) && bookAZ(ids[i-1], b) <= 0)); });
      t.push([w + 'px: …which puts the books Big Books, Adventures, Other, A to Z', ord]);
      t.push([w + 'px: arranging fits', await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)]);
      await pg.screenshot({ path: shot('arrange-' + w) });
      await pg.evaluate(() => { const b = document.querySelector('#arrDock [data-act="arrange"]'); if (b) b.click(); });
      // Your name in the menu: Profile and My Expenses.
      await pg.evaluate(() => { document.body.classList.add('sn-open'); const g = document.querySelector('#sideNav .sn-me .sn-gh'); if (g) g.click(); }); await pg.waitForTimeout(300);
      const me = await pg.evaluate(() => [...document.querySelectorAll('#sideNav .sn-me .sn-items .sn-t')].map(e => e.textContent));
      t.push([w + 'px: your name opens Profile and My Expenses (' + me.join(', ') + ')', me.join() === 'Profile,My Expenses']);
      await pg.evaluate(() => document.body.classList.remove('sn-open'));
      await pg.evaluate(() => myExpensesModal()); await pg.waitForTimeout(1500);
      const my = await pg.evaluate(() => [...document.querySelectorAll('#modal .fx-item')].map(e => ({ w: e.querySelector('.fx-w').textContent, paid: e.classList.contains('fx-paid'), bg: getComputedStyle(e).backgroundColor })));
      t.push([w + 'px: My Expenses lists your expenses (' + my.map(x => x.w).join(', ') + ')', my.length === 2]);
      t.push([w + 'px: …the paid-back one is green, the waiting one is not', my.some(x => x.w === 'Tape and markers' && x.paid && x.bg === 'rgb(227, 241, 232)') && my.some(x => x.w === 'Taxi' && !x.paid)]);
      t.push([w + 'px: …and fits', await fits(pg)]);
      await pg.screenshot({ path: shot('myexpenses-' + w) });
      await pg.evaluate(() => closeModal());
      // The expense form no longer lists "Your expenses".
      await pg.evaluate(() => expensesModal()); await pg.waitForTimeout(1500);
      t.push([w + 'px: the expense form has no "Your expenses" list', await pg.evaluate(() => !/Your expenses/.test(document.querySelector('#modal').textContent))]);
      await pg.evaluate(() => closeModal());
      // Finance › Expenses: the printing's cards.
      await pg.evaluate(() => finGo('expenses', '')); await pg.waitForTimeout(2500);
      const cards = await pg.evaluate(() => [...document.querySelectorAll('.fin-ex .fx-item.fx-print .fx-w')].map(e => e.textContent));
      t.push([w + 'px: printing cards ' + JSON.stringify(cards), cards.includes('Original Printing (32 Books)') && cards.includes('Printing Costs transferred to Kirtan Mela (5 Books)')]);
      await pg.evaluate(() => { const r = document.querySelector('.fin-ex .fx-item.fx-print .fx-row'); if (r) r.click(); }); await pg.waitForTimeout(300);
      await pg.evaluate(() => { const d = document.querySelector('.fin-ex .fx-item.open .bc-hist'); if (d) d.open = true; }); await pg.waitForTimeout(200);
      t.push([w + 'px: …its History starts "Original Printing (40 Books)"', await pg.evaluate(() => [...document.querySelectorAll('.bc-hw')].some(e => /Original Printing \(40 Books\)/.test(e.textContent)))]);
      t.push([w + 'px: Finance › Expenses fits', await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)]);
      await pg.screenshot({ path: shot('finexp-' + w) });
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
