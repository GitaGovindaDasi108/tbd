/* Optional, needs Playwright + Chromium: node test/browser-finance.js
   b254: the Finance page's first round of improvements, in the practice space.
   Regions and events in the app's own order; the place search before the
   dates; the Overview's seven figures (Big Books Sold, Adventures Sold,
   Donations, Pending Payments, Gross or Expected Gross with Current Collected,
   Expenses, Net with the margin); a WhatsApp report beside every part and the
   top 📋 Report reporting the section; pencils on the page, its windows and
   its passing messages. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });
const shot = n => path.join(os.tmpdir(), 'tbs-finance-' + n + '.png');
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

  // Kartika: Zagreb made first, Athens second, then Athens put first by hand —
  // the app's order, which Finance must follow. Then Pune, closed, comes last.
  const owner = await sessionOf('owner@example.com', 'The Owner');
  const O = p => ask(Object.assign({ s: owner }, p));
  await O({ action: 'saveSeason', name: 'Kartika' });
  const SA = (await O({ action: 'getState' })).state.activeSeason;
  await O({ action: 'createRegion', regionId: 'rg_zg', whLoc: 'wh_zg', name: 'Zagreb', currencies: 'USD', season: SA });
  await O({ action: 'createRegion', regionId: 'rg_at', whLoc: 'wh_at', name: 'Athens', currencies: 'USD', season: SA });
  await O({ action: 'reorder', kind: 'region', ids: ['rg_at', 'rg_zg'], season: SA });
  await O({ action: 'createEvent', eventId: 'ev_z2', name: 'Zagreb Fair', regionId: 'rg_zg', season: SA });
  await O({ action: 'createEvent', eventId: 'ev_z1', name: 'Zagreb Kirtan', regionId: 'rg_zg', season: SA });
  await O({ action: 'reorder', kind: 'event', ids: ['ev_z1', 'ev_z2'], season: SA });
  await O({ action: 'adjustStockBulk', location: 'ev_z1', items: [{ bookId: 'sr_en', delta: 20 }, { bookId: 'adv_en', delta: 20 }], override: true, season: SA });
  await O({ action: 'adjustStockBulk', location: 'wh_at', items: [{ bookId: 'sr_en', delta: 20 }], override: true, season: SA });
  const sell = (id, loc, book, p) => O(Object.assign({ action: 'sell', saleId: id, location: loc, bookId: book, season: SA }, p));
  await sell('z1', 'ev_z1', 'sr_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] });
  await sell('z2', 'ev_z1', 'sr_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] });
  await sell('z3', 'ev_z1', 'sr_en', { legs: [{ type: 'Gift', cur: 'USD', amt: 0 }] });
  await sell('z4', 'ev_z1', 'adv_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 15 }] });
  await sell('z5', 'ev_z1', 'sr_en', { pending: true, name: 'Arjuna', phone: '+385 1', legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] });
  await O({ action: 'donate', saleId: 'z6', location: 'ev_z1', legs: [{ type: 'Cash', cur: 'USD', amt: 10 }], season: SA });
  await sell('a1', 'wh_at', 'sr_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 40 }] });
  // b277: the kinds of expense are Finance's own list, added to as they go.
  await O({ action: 'expCatAdd', name: 'Travel' }); await O({ action: 'expCatAdd', name: 'Food' });
  await O({ action: 'expSave', id: 'Xvan001', kind: 'record', date: '2026-10-19', desc: 'Van hire', amt: 20, cur: 'USD', location: 'ev_z1', category: 'Travel' });
  await O({ action: 'expSave', id: 'Xlunch01', kind: 'reimburse', date: '2026-10-18', desc: 'Lunch for helpers', amt: 30, cur: 'USD', location: 'ev_z1', category: 'Food',
    method: 'Cash', reimbCur: 'USD', payTo: { phone: '+385 99 1' } });

  const browser = await chromium.launch();
  const t = [], errors = [];
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
  try {
    const own = await open('owner@example.com', 'The Owner');
    const csvOf = async (part) => { const dl = own.waitForEvent('download', { timeout: 5000 }).catch(() => null);
      await own.click(`[data-act="fincsv"][data-part="${part}"]`); const d = await dl; await own.waitForTimeout(200);
      const L = await own.evaluate(() => FIN.lastCsv || {name:'', rows:[]}); return { got: !!d, name: d ? d.suggestedFilename() : '', rows: L.rows }; };
    let csv;
    await own.evaluate(() => finGo('overview', '')); await own.waitForTimeout(1500);
    // Into Kartika: its regions, in the app's order.
    await own.click('#fpBody [data-act="fingo"]'); await own.waitForTimeout(600);
    let m = await fpage(own);
    t.push(['Kartika\'s regions are in the app\'s order: Athens before Zagreb', m.indexOf('Athens') > -1 && m.indexOf('Athens') < m.indexOf('Zagreb')]);
    const regs = await own.$$eval('[data-fpick="r"] option', os => os.map(o => o.textContent));
    t.push(['…the region dropdown too', regs.indexOf('Athens') === 1 && regs.indexOf('Zagreb') === 2]);
    // The seven tiles.
    const tiles = await own.$$eval('.fin-tile .fin-tl', ts => ts.map(x => x.textContent.trim()));
    t.push(['the Overview shows only the seven figures, in order', JSON.stringify(tiles) === JSON.stringify(['Big Books Sold', 'Adventures Sold', 'Donations', 'Pending Payments', 'Gross', 'Expenses', 'Net'])]);
    const tile = (i) => own.$eval(`.fin-tile:nth-child(${i})`, e => e.innerText.replace(/\s+/g, ' '));
    t.push(['Big Books: $120 in hand, 4 Sold + 1 Gift = 5 Distributed', /\$120/.test(await tile(1)) && /4 Sold \+ 1 Gift = 5 Distributed/.test(await tile(1))]);
    t.push(['Adventures: $15, 1 Sold', /\$15/.test(await tile(2)) && /1 Sold/.test(await tile(2)) && !/Gift/.test(await tile(2))]);
    t.push(['b259: the title stays Gross, showing what is in hand ($145), with a blue Expected Gross $185 beneath', /^Gross \$145\.00 Expected \$185\.00$/.test((await tile(5)).trim())]);
    t.push(['…the Expected line is blue', await own.$eval('.fin-tile:nth-child(5) .fin-ex-l', e => getComputedStyle(e).color) === 'rgb(47, 111, 176)']);
    t.push(['b259: Expenses shows what was spent ($20), Expected Expenses $50 while Lunch is owed', /^Expenses \$20\.00 Expected \$50\.00$/.test((await tile(6)).trim())]);
    t.push(['Net is what came in less what went out, margin beneath, then Expected Net', /^Net \$125\.00 Margin 86\.2% Expected \$135\.00$/.test((await tile(7)).trim())]);
    // Athens has nothing owed: plain Gross, no subtitle.
    await own.click('#fpBody [data-act="fingo"][data-scope="rg_at"]'); await own.waitForTimeout(600);
    t.push(['nothing pending: the title is Gross and the subtitle goes', /^Gross \$40\.00$/.test((await tile(5)).trim())]);
    // Zagreb's events, in the app's order.
    await own.evaluate(() => finGo('overview', 'rg_zg')); await own.waitForTimeout(600);
    m = await fpage(own);
    t.push(['Zagreb\'s events in the app\'s order: Kirtan before Fair', m.indexOf('Zagreb Kirtan') < m.indexOf('Zagreb Fair')]);
    // b293: the same path as the Sales side: links, a ▾ of the others at each level, then Events….
    t.push(['b293: the path reads Earthly HQ › Kartika › Zagreb as links, the chip just "Region"', await own.$eval('#fpNav', x => [...x.querySelectorAll('.crumb-link')].map(l => l.textContent).join(' › ')) === '🌍 Earthly HQ › Kartika › Zagreb'
      && await own.$eval('#fpNav .lvl-chip', x => x.textContent.trim()) === 'Region']);
    t.push(['b293: …then an Events… drop-down in the app\'s order', JSON.stringify(await own.$$eval('#fpNav select.crumb-sel[data-fpick="e"] option', o => o.map(x => x.textContent))) === JSON.stringify(['Events…', 'Zagreb Kirtan', 'Zagreb Fair'])]);
    t.push(['b293: Zagreb\'s ▾ lists the other regions', JSON.stringify(await own.$$eval('#fpNav .crumb-more [data-fpick="r"] option', o => o.map(x => x.textContent))) === JSON.stringify(['Athens', 'Zagreb'])]);
    await own.click('#fpNav .crumb-link[data-scope="' + SA + '"]'); await own.waitForTimeout(600);
    t.push(['b293: Kartika\'s link goes up to the season', await own.evaluate(() => !!finScopeF().s && !finScopeF().r)]);
    await own.evaluate(() => finGo('overview', 'rg_zg')); await own.waitForTimeout(600);
    // b295: the search sits beside the path on every section; the date line keeps just the dates.
    const line = await own.evaluate(() => { const f = document.querySelector('#fpBody .fin-filters'); return [...f.children].map(c => c.className || c.tagName); });
    t.push(['b295: the place search is in the path bar, the date line has just the dates', line.length === 2 && await own.evaluate(() => !!document.querySelector('#fpNav #finPP'))]);
    for (const sec of ['expenses', 'reimb']) { await own.evaluate(s => finGo(s, 'rg_zg'), sec); await own.waitForTimeout(500);
      t.push(['b295: the place search is on ' + sec + ' too', await own.evaluate(() => !!document.querySelector('#fpNav #finPP .pp-in'))]); }
    await own.evaluate(() => finGo('overview', 'rg_zg')); await own.waitForTimeout(500);
    // b297 (Gita): the Overview table, each kind's Sold, Gifted, Distributed and Gross, then Total Gross, the rest, and Margin last; titles right over the figures.
    const ovh = await own.evaluate(() => { const r = document.querySelectorAll('.fin-ovw thead tr'); return { g: [...r[0].querySelectorAll('th.fin-g')].map(x => x.textContent.trim()),
      c: [...r[1].querySelectorAll('th')].map(x => x.textContent.replace(/[▸◂]/g, '').trim()), al: getComputedStyle(r[1].querySelector('th')).textAlign }; });
    // b298 (Gita): just Sold shows; a tap on it opens Gifted and Distributed, another folds them.
    const vis = () => own.evaluate(() => [...document.querySelectorAll('.fin-ovw thead tr')[1].querySelectorAll('th')].filter(x => x.offsetParent).map(x => x.textContent.replace(/[▸◂]/g, '').trim()).slice(0, 4).join());
    const v0 = await vis();
    await own.click('.fin-ovw thead th[data-fsold="bb"]'); await own.waitForTimeout(200);
    const v1 = await vis(), span = await own.$eval('.fin-ovw [data-fg="bb"]', x => x.colSpan);
    await own.click('.fin-ovw tbody td[data-fsold="bb"]'); await own.waitForTimeout(200);
    t.push(['b298: the Overview table shows just Sold and Gross for each kind', v0 === 'Sold,Gross,Sold,Gross']);
    t.push(['b298: …tapping Sold opens Gifted and Distributed, tapping again folds them', v1 === 'Sold,Gifted,Distributed,Gross' && span === 4 && await vis() === v0]);
    t.push(['b297: Overview table grouped Big Books, Adventures, Other', JSON.stringify(ovh.g) === JSON.stringify(['Big Books', 'Adventures', 'Other'])]);
    t.push(['b297: …Sold, Gifted, Distributed, Gross under each, then Total Gross … Margin last', ovh.c.slice(0, 4).join() === 'Sold,Gifted,Distributed,Gross' && ovh.c[12] === 'Total Gross' && ovh.c[ovh.c.length - 1] === 'Margin']);
    t.push(['b297: the column titles are right-aligned over their figures', ovh.al === 'right']);
    await own.click('#finPP .pp-in'); await own.fill('#finPP .pp-in', 'fair'); await own.waitForTimeout(200);
    const hits = await own.$$eval('#finPP .pp-row', rs => rs.map(r => r.textContent));
    t.push(['typing narrows it to the place, keeping its season and region', JSON.stringify(hits) === JSON.stringify(['Kartika', 'Zagreb', 'Zagreb Fair'])]);
    await own.click('#finPP .pp-row:last-child'); await own.waitForTimeout(800);
    t.push(['choosing it takes the page there', /#finance\/overview\/ev_z2/.test(own.url())]);
    await own.screenshot({ path: shot('fin-search') });
    // WhatsApp reports.
    await own.evaluate(() => finGo('overview', 'rg_zg')); await own.waitForTimeout(600);
    await own.click('.fp-h [data-act="finrep"]'); await own.waitForTimeout(400);
    let r = await repText(own);
    t.push(['the Overview\'s 📋: its figures, in the same words', /^Big Books Sold - \$80\.00\n   3 Sold \+ 1 Gift = 4 Distributed\nAdventures Sold - \$15\.00\n   1 Sold\nDonations - \$10\.00\nPending Payments - \$40\.00\nGross - \$105\.00\n   Expected - \$145\.00\nExpenses - \$20\.00\n   Expected - \$50\.00\nNet - \$85\.00\n   Margin 81%\n   Expected - \$95\.00$/.test(r)]);
    await own.evaluate(() => closeModal());
    // b259: ⬇️ CSV beside the 📋, and the charts under everything.
    csv = await csvOf('overview');
    t.push(['b259: Overview ⬇️ CSV: a row per event and the total, every figure with its Expected', csv.got && /^Finance Overview Zagreb - Kartika \d{4}-\d\d-\d\d\.csv$/.test(csv.name) && csv.rows[0].includes('Expected Gross (USD)') &&
      JSON.stringify(csv.rows.map(r => r[0])) === JSON.stringify(['', 'Zagreb Kirtan', 'Zagreb Fair', 'Total']) && csv.rows[3][15] === 105 && csv.rows[3][16] === 145 && csv.rows[0][1] === 'Big Books Sold' && csv.rows[0][15] === 'Total Gross (USD)']);
    m = await own.$eval('#finCharts', e => e.innerText);
    t.push(['b284: under the Overview, with a payment pending: Income by Source (Actual) and (Expected), money in and out (with Expected), by event, and expenses by type', /Income by Source \(Actual\)/.test(m) && /Income by Source \(Expected\)/.test(m) && /Expected Gross/.test(m) && /Money in and out/.test(m) && /Gross\s*\$105\.00\s*Expected \$145\.00/.test(m) && /Gross, Expenses and Net by Event/.test(m) && /Expenses by type/.test(m)
      && await own.evaluate(() => document.querySelector('#finCharts') === document.querySelector('#fpBody').lastElementChild)]);
    await own.screenshot({ path: shot('overview-charts'), fullPage: true });
    await own.click('.fin-h3 [data-act="finrep"]'); await own.waitForTimeout(400);
    r = await repText(own);
    t.push(['the By Event 📋: each event, as the table', /^\*Zagreb Kirtan\*\nBig Books Sold - \$80/.test(r) && /\*Zagreb Fair\*/.test(r) && !/\*Total\*/.test(r)]);
    await own.evaluate(() => closeModal());
    await own.evaluate(() => document.querySelector('#reportBtn').click()); await own.waitForTimeout(400);   // in practice it sits in the menu (b299)
    r = await repText(own);
    t.push(['📋 Report at the top: the whole section, with headings', /^\*Zagreb · Kartika — Finance Overview\*\n\n\*OVERVIEW\*\nBig Books Sold/.test(r) && /\*BY EVENT\*/.test(r) && !/SALES BY TITLE/.test(r)]);
    await own.evaluate(() => closeModal());
    // b292: no To do anywhere, practice too.
    t.push(['b292: the Finance bar is Overview, Expenses and Reimbursements: no To do, Reports or Visualize', JSON.stringify(await own.$$eval('#fpSecs [data-act="finsec"]', bs => bs.map(b => b.dataset.sec))) === JSON.stringify(['overview', 'expenses', 'reimb'])
      && await own.evaluate(() => !FIN_BTNS('U').some(b => /To do/.test(b)))]);
    await own.evaluate(() => finGo('todo', 'rg_zg')); await own.waitForTimeout(800);
    t.push(['b292: an old To do address opens the Overview', /#finance\/overview/.test(own.url())]);
    await own.evaluate(() => finGo('report', 'rg_zg')); await own.waitForTimeout(800);
    t.push(['b259: an old Reports address opens the Overview', /#finance\/overview/.test(own.url())]);
    // Pencils on the Finance page and in its windows.
    await own.click('[data-act="finsec"][data-sec="overview"]'); await own.waitForTimeout(1200);
    await own.evaluate(() => { const b = document.createElement('button'); b.dataset.act = 'editwording'; document.body.appendChild(b); b.click(); b.remove(); }); await own.waitForTimeout(800);
    const pens = await own.evaluate(() => [...document.querySelectorAll('#finPage .pencil')].map(p => p.parentElement.textContent.replace(/✏️/g, '').trim()));
    t.push(['Edit Wording works on the Finance page: pencils on headings and tiles', pens.includes('Big Books Sold') && pens.some(x => /^Overview/.test(x)) && pens.some(x => /^By Event/.test(x)) && pens.includes('Search')]);
    t.push(['…but not on place names', !pens.includes('Zagreb Kirtan')]);
    await own.click('.fp-h [data-act="finrep"]'); await own.waitForTimeout(800);
    t.push(['…and inside the report window', await own.evaluate(() => document.querySelectorAll('#modal .pencil').length > 0)]);
    await own.evaluate(() => closeModal());
    await own.evaluate(() => toast('Report copied')); await own.waitForTimeout(400);
    t.push(['…and on a passing message, which waits while editing', await own.evaluate(() => !!document.querySelector('#toast .pencil') && getComputedStyle(document.querySelector('#toast')).pointerEvents === 'auto')]);
    await own.screenshot({ path: shot('fin-pencils') });
    // Rewrite a tile's heading in place: tap its words, type, Enter. No window.
    await own.evaluate(() => { const el = [...document.querySelectorAll('.fin-tile .fin-tl')].find(x => x.textContent.startsWith('Donations')); el.click(); }); await own.waitForTimeout(300);
    t.push(['tapping words opens a box right over them, not a window', await own.evaluate(() => !!document.querySelector('.lbl-in-box') && !document.querySelector('#overlay').classList.contains('show'))]);
    t.push(['…holding the words as they read now', (await own.$eval('.lbl-in-box', b => b.textContent)) === 'Donations']);
    await own.keyboard.press('Control+A'); await own.keyboard.type('Donations Received'); await own.keyboard.press('Enter'); await own.waitForTimeout(1500);
    t.push(['Enter keeps it: the tile now reads Donations Received', /Donations Received/.test(await fpage(own)) && !(await own.$('.lbl-in'))]);
    // A button's words by its pencil; Esc leaves them alone.
    await own.click('#fpSecs [data-sec="reimb"] .pencil'); await own.waitForTimeout(300);
    t.push(['a button\'s pencil opens the same box, and the button does not fire', !!(await own.$('.lbl-in-box')) && !/#finance\/reimb/.test(own.url())]);
    await own.keyboard.type('Nope'); await own.keyboard.press('Escape'); await own.waitForTimeout(400);
    t.push(['Esc leaves it as it was', /Reimbursements/.test(await own.$eval('#fpSecs [data-sec="reimb"]', b => b.textContent)) && !(await own.$('.lbl-in'))]);
    await own.evaluate(() => { const b = document.createElement('button'); b.dataset.act = 'editwording'; document.body.appendChild(b); b.click(); b.remove(); }); await own.waitForTimeout(500);
    /* ---- b254 round two: Expenses, Reimbursements, Visualize, the link ---- */
    await own.evaluate(() => finGo('expenses', 'rg_zg', {reload:true})); await own.waitForTimeout(1500);
    m = await fpage(own);
    t.push(['Expenses: the bar says Expenses $20 with Expected Expenses $50, while Lunch is owed', /Expenses\s*\$20\.00\s*Expected \$50\.00/.test(m)]);
    const btnRight = (sel, btn) => own.evaluate(([sel, btn]) => { const h = document.querySelector(sel + ' .fin-sh'), b = h && h.querySelector(btn); if(!b) return false;
        const hr = h.getBoundingClientRect(), br = b.getBoundingClientRect(); return Math.abs(hr.right - br.right) < 4 && br.top < hr.bottom && br.height < 34; }, [sel, btn]);
    const exBtn = !(await own.$('#finExS [data-act="expenses"]')) && !!(await own.$('#fpSecs [data-act="expenses"]'));
    await own.evaluate(() => finGo('reimb', 'rg_zg')); await own.waitForTimeout(800);
    t.push(['b284: Reimbursements is its own screen, Reimbursements Due over it, no expenses list', await own.evaluate(() => !!document.querySelector('#finRbS') && /Reimbursements Due\s*\$30/.test(document.querySelector('#finRbS').innerText) && !document.querySelector('#finExS'))]);
    t.push(['b291: Send Reimbursements Link and Add an Expense sit side by side on the Finance bar, not on the title rows', exBtn && await own.evaluate(() => { const a = document.querySelector('#fpSecs [data-act="finsendlink"]'), b = document.querySelector('#fpSecs [data-act="expenses"]'); return !!a && !!b && a.nextElementSibling === b && !document.querySelector('#finRbS [data-act="finsendlink"]'); }) && !(await own.$('#fsName'))]);
    await own.evaluate(() => finGo('expenses', 'rg_zg')); await own.waitForTimeout(800);
    t.push(['b291: the Finance bar has 🧾 Add an Expense where Go to Sales Portal was (that is in the menu); no Edit Wording', await own.evaluate(() => {
      const bar = document.querySelector('#fpSecs').innerText; return /Add an Expense/.test(bar) && !/Edit Wording|Go to Sales Portal/.test(bar) && !/Back to app/.test(document.querySelector('#finPage').innerText); })]);
    const order = () => own.$$eval('.fin-ex .fx-item .fx-w', ts => ts.map(x => x.textContent.trim()));
    t.push(['b260: an expense is one row: date, what for and amount; the rest opens beneath it', await own.evaluate(() => {
      const it = document.querySelector('.fin-ex .fx-item'), r = it.querySelector('.fx-row');
      return /^\d{4}-\d\d-\d\d\s+\S/.test(r.innerText) && /\$\d/.test(r.querySelector('.fx-a').innerText) && getComputedStyle(it.querySelector('.fx-det')).display === 'none'; })]);
    t.push(['b260: the Amount heading sits right over the amounts', await own.evaluate(() => {
      const h = document.querySelector('.fin-ex .fx-head .fx-a').getBoundingClientRect(), a = document.querySelector('.fin-ex .fx-item .fx-a').getBoundingClientRect();
      return Math.abs(h.right - a.right) < 14; })]);
    await own.click('.fin-ex .fx-item [data-act="exopen"]'); await own.waitForTimeout(200);
    t.push(['…tapping it shows who, the type, where and the status, with Edit and Delete', await own.evaluate(() => { const d = document.querySelector('.fin-ex .fx-item.open .fx-det');
      return !!d && /Who/i.test(d.innerText) && /Where/i.test(d.innerText) && /Status/i.test(d.innerText) && !!d.querySelector('[data-act="expedit"]'); })]);
    await own.click('.fin-ex .fx-item.open [data-act="exopen"]'); await own.waitForTimeout(200);
    t.push(['…newest first to start', JSON.stringify(await order()) === JSON.stringify(['Van hire', 'Lunch for helpers'])]);
    await own.selectOption('#finExSort', 'amount'); await own.waitForTimeout(300);
    t.push(['…sorted by amount: the largest first', (await order())[0] === 'Lunch for helpers']);
    t.push(['b259: no row of round buttons; Type and Status are filters with checkboxes', !(await own.$('.fin-radios')) && !!(await own.$('[data-act="finexflt"][data-f="type"]'))]);
    await own.click('[data-act="finexflt"][data-f="type"]'); await own.waitForTimeout(300);
    await own.screenshot({ path: shot('exp-filter') });
    await own.check('[data-xf="type"][value="Travel"]'); await own.waitForTimeout(300);
    t.push(['…ticking Travel shows only travel', JSON.stringify(await order()) === JSON.stringify(['Van hire']) && /Type \(1\)/.test(await own.$eval('[data-act="finexflt"][data-f="type"]', b => b.textContent))]);
    await own.click('[data-act="finexclr"][data-f="type"]'); await own.waitForTimeout(300);
    t.push(['…Clear brings them all back', (await order()).length === 2]);
    t.push(['…each row can be edited', (await own.$$('.fin-ex [data-act="expedit"]')).length === 2]);
    t.push(['b284: Expenses and Reimbursements are two buttons on the bar', !!(await own.$('#fpSecs [data-sec="expenses"]')) && !!(await own.$('#fpSecs [data-sec="reimb"]'))]);
    await own.click('#fpSecs [data-sec="reimb"]'); await own.waitForTimeout(1200);
    await own.click('[data-act="finrbtab"][data-tab="pending"]'); await own.waitForTimeout(800);
    m = await fpage(own);
    const rbs = await own.$eval('#finRbS', e => e.innerText);
    t.push(['Reimbursements: Lunch is pending, with the same bar', /Lunch for helpers/.test(rbs) && /Reimbursements Due\s*\$30/.test(m) && !/Van hire/.test(rbs)]);
    t.push(['b284: Reimbursements has its own charts: waiting by person, paid back by month', await own.evaluate(() => /Waiting to be paid back, by person/.test(document.querySelector('#finCharts').innerText))]);
    t.push(['…Paid back and Declined are separate tabs', !!(await own.$('[data-act="finrbtab"][data-tab="paid"]')) && !!(await own.$('[data-act="finrbtab"][data-tab="declined"]'))]);
    t.push(['b260: reimbursements are rows: the person, the amount, Pay and Decline', await own.evaluate(() => { const r = document.querySelector('#finRbS .rb-item .li-row');
      return !!r && /The Owner/.test(r.innerText) && /\$30/.test(r.innerText) && !!r.querySelector('[data-act="exppaid"]') && /^Pay$/.test(r.querySelector('[data-act="exppaid"]').textContent.trim()) && /^Decline$/.test(r.querySelector('[data-act="expdecline"]').textContent.trim()); })]);
    t.push(['…Reimbursement Settings is inside it, not on the bar', /⚙️ Settings/.test(m) && !/Reimbursement Settings/.test(await own.$eval('#fpSecs', e => e.innerText))]);
    await own.click('[data-act="finrbtab"][data-tab="settings"]'); await own.waitForTimeout(1200);
    t.push(['…its Where is a searchable drop-down', !!(await own.$('#rsPlaceC .pp-in')) && /By place/.test(await fpage(own))]);
    // b293: each group in its own square: four across on a computer, one under another on a phone.
    const rsTiles = () => own.$$eval('#fpBody .rs-tile', x => x.map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; }));
    const rsW = await rsTiles(), rsB = await own.$eval('#fpBody', e => e.getBoundingClientRect().width);
    t.push(['b293: Reimbursement Settings are four squares side by side, each a quarter wide', rsW.length === 4 && new Set(rsW.map(x => x[0])).size === 4 && rsW.every(x => x[1] <= rsB / 4 + 2)]);
    await own.setViewportSize({ width: 390, height: 1000 }); await own.waitForTimeout(300);
    const rsN = await rsTiles();
    t.push(['b293: …on a phone, one under another, nothing spilling', rsN.length === 4 && new Set(rsN.map(x => x[0])).size === 1 &&
      await own.evaluate(() => ![...document.querySelectorAll('#fpBody *, #fpNav *')].some(e => e.offsetParent && e.getBoundingClientRect().right > document.documentElement.clientWidth + 1))]);
    await own.screenshot({ path: shot('b293-rs-phone') });
    await own.setViewportSize({ width: 1150, height: 1000 }); await own.waitForTimeout(300);
    // b257: a way of paying back can be removed for good, and brought back.
    const ways = () => own.$$eval('.rs-row label > span', ss => ss.map(x => x.textContent.trim()));
    const had = await ways();
    await own.click('[data-act="rsgone"][data-m="Bank transfer"]'); await own.waitForTimeout(1200);
    t.push(['b257: 🗑 removes a way of paying back for good', had.includes('Bank transfer') && !(await ways()).includes('Bank transfer') && /Removed for good: Bank transfer/.test(await fpage(own))]);
    const opts = (await O({ action: 'expOptions' })).result;
    t.push(['…and the expense form no longer offers it', !opts.methods.some(x => x.name === 'Bank transfer')]);
    await own.click('[data-act="rsback"][data-m="Bank transfer"]'); await own.waitForTimeout(1200);
    t.push(['…"Bring back" returns it', (await ways()).includes('Bank transfer')]);
    await own.click('[data-act="finrbtab"][data-tab="links"]'); await own.waitForTimeout(1200);
    await own.click('#finLinkMake'); await own.waitForTimeout(1200);
    t.push(['Links: a link anyone can use, to send by WhatsApp or email', !!(await own.$('#fpBody a[href^="https://wa.me/?text="]')) && !!(await own.$('#fpBody a[href^="https://mail.google.com/mail/?view=cm"]'))]);
    // b255: just a name and a number, then Send.
    await own.click('[data-act="finsendlink"]'); await own.waitForTimeout(400);
    t.push(['Send Reimbursements Link opens a small window: a name, an email or number, and Send', !!(await own.$('#modal #fsName')) && !!(await own.$('#modal #fsTo')) && !!(await own.$('#modal #fsGo'))]);
    const popP = own.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
    await own.fill('#fsName', 'Bhima'); await own.fill('#fsTo', '+385 98 7654');
    await own.click('#fsGo'); await own.waitForTimeout(1500);
    const pop = await popP;
    const wa = await own.$eval('#fsDone a', a => decodeURIComponent(a.href)).catch(() => '');
    const url = (wa.match(/(http:\/\/app\.test\S+)/) || [])[1] || '';
    t.push(['…Send opens WhatsApp to Bhima with the link written', !!pop && /^https:\/\/wa\.me\/385987654\?text=Hare Krishna Bhima!/.test(wa) && /reimb=rb_/.test(url)]);
    if (pop) await pop.close();
    await own.evaluate(() => closeModal()); await own.waitForTimeout(800);
    m = await fpage(own);
    await own.screenshot({ path: shot('expenses'), fullPage: true });
    t.push(['…and the Links tab lists it as sent to Bhima, not used yet (in its dropdown)', /Sent to Bhima · \+385 98 7654 · not used yet/.test(await own.$eval('#fpBody', e => e.textContent))]);
    // Someone not in the app opens it: no sign-in, only the form.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const pub = await ctx.newPage();
    pub.on('pageerror', e => errors.push('public: ' + e.message));
    await ctx.route('**/*', async route => {
      const req = route.request(), u = req.url();
      if (u.startsWith(API)) return route.fulfill({ status: 200, contentType: 'application/json', body: await srv.request({ postData: { contents: req.postData() || '{}' } }), headers: { 'Access-Control-Allow-Origin': '*' } });
      // b259: the day's exchange rate, as the European Central Bank gives it.
      if (u.startsWith('http://app.test/')) {
        const rel = new URL(u).pathname.replace(/^\/+/, '') || 'index.html';
        if (rel === 'config.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: `window.TBS_CONFIG = { APPS_SCRIPT_URL: '${API}', GOOGLE_CLIENT_ID: 'client-123', POLL_SECONDS: 3600, LIVE_URL: '', PRACTICE_URL: '${API}' };` });
        const f = path.join(ROOT, rel);
        if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : 'text/javascript' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    await pub.goto(url); await pub.waitForTimeout(2000);
    m = await pub.evaluate(() => document.querySelector('#modal').innerText);
    await pub.screenshot({ path: shot('public-form'), fullPage: true });
    t.push(['b257: the form has an × that leaves for travelingmonk.com', await pub.$eval('#modal h3 a.x', a => a.href).catch(() => '') === 'https://travelingmonk.com/' && await pub.$eval('#modal h3 a.x', a => getComputedStyle(a).display !== 'none')]);
    t.push(['…and on a phone it is one column, nothing sideways', await pub.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 &&
      getComputedStyle(document.querySelector('#modal .exp-form .row2')).gridTemplateColumns.split(' ').length === 1)]);
    t.push(['the link opens the form alone, no sign-in', /Send in an expense to be paid back/.test(m) && /WhatsApp or phone number/i.test(m) && !/Sign in/i.test(m) && !/Paid with/i.test(m)]);
    t.push(['…for the place it was sent from: Zagreb', /For Zagreb · Kartika/.test(m)]);
    t.push(['…it already knows Bhima and the number', await pub.$eval('#xPubName', e => e.value) === 'Bhima' && await pub.$eval('#xPubPhone', e => e.value) === '+385 98 7654']);
    await pub.fill('#xPubPhone', '+385 98 7');
    await pub.fill('#xAmt', '12'); await pub.fill('#xDesc', 'Parking at the fair');
    await pub.click('#xCatC .pp-in'); await pub.fill('#xCatC .pp-in', 'oth'); await pub.waitForTimeout(150); await pub.click('#xCatC .pp-row[data-v="Other"]'); await pub.waitForTimeout(300);
    t.push(['choosing Other asks what it is', !!(await pub.$('#xCatOther'))]);
    await pub.fill('#xCatOther', 'Parking');
    await pub.selectOption('#xMethod', 'Cash'); await pub.waitForTimeout(200);
    t.push(['b259: no "Take a photo" on a computer, only choosing a file', !(await pub.$('#xCam')) && !/Take a photo/i.test(await pub.evaluate(() => document.querySelector('#modal').innerText))]);
    t.push(['b259: the number to pay back to has "Same as above"', !!(await pub.$('[data-same="phone"]'))]);
    // b263: the form stays still as it redraws: what you touched stays put, no pop.
    const spot = () => pub.$eval('[data-same="phone"]', c => Math.round(c.getBoundingClientRect().top));
    await pub.$eval('[data-same="phone"]', c => c.scrollIntoView({ block: 'center' }));
    const before = await spot();
    await pub.check('[data-same="phone"]'); await pub.waitForTimeout(300);
    t.push(['b263: ticking "Same as above" leaves the box where it was, no jump to the top', Math.abs((await spot()) - before) <= 2 && before > 150]);
    t.push(['…and the form does not pop in again', await pub.$eval('#modal', m => m.classList.contains('still') && getComputedStyle(m).animationName === 'none')]);
    await pub.focus('#xDesc'); await pub.$eval('#xDesc', i => i.setSelectionRange(3, 3));
    await pub.evaluate(() => { expRead(); expDraw(); });
    t.push(['…and a field being typed in keeps its cursor through a redraw', await pub.evaluate(() => document.activeElement && document.activeElement.id === 'xDesc' && document.activeElement.selectionStart === 3)]);
    t.push(['…ticking it fills in the number from above, and it cannot be typed over', await pub.$eval('[data-payto="phone"]', i => i.value === '+385 98 7' && i.readOnly) && await pub.$eval('#xAmt', e => e.value) === '12']);
    // b255: a second one in the same form, then check them both before sending.
    t.push(['b284: paid back in the currency spent (dollars) unless "a different currency" is ticked: no currency menu until then', await pub.evaluate(() => {
      const ok = EXP.opt.curs.includes(EXP.form.cur);
      return ok ? !!document.querySelector('#xOtherCur') && !document.querySelector('#xRCur') : !document.querySelector('#xOtherCur') && !!document.querySelector('#xRCur') && /can't be paid back here/.test(document.querySelector('#modal').innerText); })]);
    await pub.click('#xMore'); await pub.waitForTimeout(400);
    m = await pub.evaluate(() => document.querySelector('#modal').innerText);
    t.push(['"Add another expense" keeps the first in a list and starts the next', /Added so far\s*1/i.test(m) && /Parking at the fair/.test(m) && await pub.$eval('#xAmt', e => e.value) === '']);
    t.push(['b260: one way of being paid back per form: the next follows the first, Cash', !(await pub.$('#xMethod')) && /Paid back by Cash in USD, like the first expense/.test(await pub.evaluate(() => document.querySelector('#modal').innerText))]);
    await pub.fill('#xAmt', '8'); await pub.fill('#xDesc', 'Tea for the volunteers');
    // b259: spent in euros, to be paid back in dollars.
    await pub.selectOption('#xCur', 'EUR'); await pub.waitForTimeout(200);
    // b284: paid back in another currency only when ticked; until then the currency menu is not there.
    t.push(['b284: "Same as above" is only offered when there is something above to copy, so it can never wipe a number', await pub.evaluate(() => { const was = EXP.pub.phone; EXP.pub.phone = ''; const r = expSameHas('phone'); EXP.pub.phone = was; return r === '' && expSameHas('phone') === 'phone'; })]);
    if (await pub.$('#xOtherCur')) await pub.check('#xOtherCur'); await pub.waitForTimeout(200);
    if (await pub.$('#xRCur')) await pub.selectOption('#xRCur', 'USD');
    t.push(['b272: no exact-dollars box on the link\'s form (it is asked on the check page)', !(await pub.$('#xUsd'))]);
    t.push(['…and Save becomes "Review all 2 expenses"', /Review all 2 expenses/.test(await pub.$eval('#xSave', e => e.textContent))]);
    await pub.waitForTimeout(400);
    t.push(['b267: the rate is asked for while the form is filled in, before Save', await pub.evaluate(() => Object.keys(FX).some(k => /\|EUR\|USD$/.test(k)))]);
    await pub.click('#xSave'); await pub.waitForTimeout(500);
    m = await pub.evaluate(() => document.querySelector('#modal').innerText);
    t.push(['the review shows both, with the total, before anything is sent', /Check your expenses/i.test(m) && /Parking at the fair/.test(m) && /Tea for the volunteers/.test(m) && /\$12/.test(m) && /8(\.00)? €|€8/.test(m)]);
    t.push(['b260: euros paid back in dollars: the server finds that day\'s rate, and the review shows what to pay', fxAsked.length > 0 && /To pay back: \$8\.80 \(1 EUR = 1\.1 USD on \d{4}-\d\d-\d\d\)/.test(m)]);
    t.push(['b267: so the check page comes straight up, no "Checking" page first', !/Checking the exchange rate/.test(m)]);
    t.push(['b267: it says the rate is an estimate', /This is an estimate - reimbursement rate may change based on current exchange rates\./.test(m)]);
    await pub.check('#xrExact'); await pub.waitForTimeout(200);
    await pub.fill('[data-xex="1"]', '9.5'); await pub.waitForTimeout(150);
    m = await pub.evaluate(() => document.querySelector('#modal').innerText);
    t.push(['b267: "I have the exact numbers for reimbursement" gives each expense its own box, and the total follows', /To pay back: \$9\.50 \(the exact amount given\)/.test(m) && /\$21\.50/.test(await pub.$eval('#xrPay', e => e.textContent))]);
    await pub.uncheck('#xrExact'); await pub.waitForTimeout(200);
    t.push(['…and unticked, it goes back to the rate', /To pay back: \$8\.80 \(1 EUR/.test(await pub.evaluate(() => document.querySelector('#modal').innerText))]);
    await pub.screenshot({ path: shot('review') });
    await pub.click('#xrBack'); await pub.waitForTimeout(300);
    t.push(['…"Back" returns to the form as it was', await pub.$eval('#xDesc', e => e.value) === 'Tea for the volunteers']);
    await pub.click('#xSave'); await pub.waitForTimeout(400);
    await own.evaluate(() => poll()); await own.waitForTimeout(800);       // Finance open, watching
    await pub.click('#xrGo'); await pub.waitForTimeout(2500);
    await own.evaluate(() => poll()); await own.waitForTimeout(2000);
    t.push(['b272: Finance, open on another screen, gets the new reimbursements with no refresh', await own.evaluate(() => FINP.on && EXP.todo.reimb.some(x => /Tea for the volunteers/.test(x.desc)) && /\d/.test(document.querySelector('[data-sec="reimb"] .fin-n').textContent))]);
    m = await pub.evaluate(() => document.querySelector('#modal').innerText);
    t.push(['sent: "received and will be processed at the earliest convenience", both listed', /2 expenses have been received and will be processed at the earliest convenience/.test(m) && /Tea for the volunteers/.test(m)]);
    t.push(['b259: the confirmation shows the dollars too', /To pay back: \$8\.80/.test(m)]);
    t.push(['b267: …and says it is an estimate', /This is an estimate/.test(m)]);
    t.push(['…with no "Send in another": the link was for one', !(await pub.$('#rpAnother'))]);
    t.push(['…and Done and × leave for travelingmonk.com', await pub.$eval('#modal .m-foot a', a => a.href).catch(() => '') === 'https://travelingmonk.com/' && !!(await pub.$('#modal h3 a.x'))]);
    await pub.screenshot({ path: shot('public') });
    await pub.goto(url); await pub.waitForTimeout(1500);
    t.push(['opened again, the link says it has been used', /already been used/.test(await pub.evaluate(() => document.querySelector('#modal').innerText))]);
    t.push(['b272: …and offers "Request for this to be reactivated"', /Request for this to be reactivated/.test(await pub.$eval('#rbAsk', b => b.textContent).catch(() => ''))]);
    await pub.fill('#rbAskNote', 'Two more receipts'); await pub.click('#rbAsk'); await pub.waitForTimeout(1200);
    t.push(['b272: …pressed, it says the request has been sent', /Your request has been sent/.test(await pub.evaluate(() => document.querySelector('#modal').innerText))]);
    await own.evaluate(() => poll()); await own.waitForTimeout(2500);
    t.push(['b272: Finance sees a red dot on Links (and on Expenses), with the request on the link', await own.evaluate(() =>
      !!document.querySelector('[data-tab="links"] .fin-dot') && !!document.querySelector('[data-sec="reimb"] .fin-dot') && /Asked to be reactivated.*Bhima.*Two more receipts/.test(document.querySelector('#fpBody').textContent))]);
    t.push(['b284: …that link is first, one line, in colour with a red border, Turn Back On beside the name', await own.evaluate(() => { const f = document.querySelector('.fl-item');
      return f.classList.contains('fl-ask') && !f.classList.contains('fin-dim') && getComputedStyle(f).borderTopColor === 'rgb(217, 48, 37)' && /Turn Back On/.test(f.querySelector('.fl-row').innerText) && f.querySelector('.fl-row').getBoundingClientRect().height < 50; })]);
    await own.click('.fl-ask [data-act="finlinkoff"]'); await own.waitForTimeout(1500);
    t.push(['b272: turning it back on clears the dot', await own.evaluate(() => !document.querySelector('.fin-dot'))]);
    await pub.goto(url); await pub.waitForTimeout(1500);
    t.push(['b272: …and the link opens the form again', !!(await pub.$('#xAmt'))]);
    await ctx.close();
    await own.evaluate(() => { FIN.rb.tab = 'pending'; finGo('reimb', 'rg_zg', {reload:true}); }); await own.waitForTimeout(1500);
    m = await own.$eval('#finRbS', e => e.textContent);
    t.push(['…it lands in Pending, with Other: Parking and how to reach Bhima (in its dropdown)', /Parking at the fair/.test(m) && /Other: Parking/.test(m) && /\+385 98 7/.test(m)]);
    t.push(['b257: Bhima\'s two, paid back the same way, are one square with one total', await own.evaluate(() => {
      const g = [...document.querySelectorAll('#finRbS .exp-group')].find(e => /Bhima/.test(e.textContent));
      return !!g && /Parking at the fair/.test(g.textContent) && /Tea for the volunteers/.test(g.textContent) && /\$20\.80/.test(g.querySelector('.li-amt').textContent) && /2 expenses/.test(g.querySelector('.li-row').innerText) && /To pay back: \$8\.80/.test(g.textContent); })]);
    await own.evaluate(() => [...document.querySelectorAll('#finRbS .exp-group')].find(e => /Bhima/.test(e.textContent)).querySelector('[data-act="rbopen"]').click()); await own.waitForTimeout(200);
    // b259: each line can be accepted or declined; the total follows.
    await own.evaluate(() => { const g = [...document.querySelectorAll('#finRbS .exp-group')].find(e => /Bhima/.test(e.textContent));
      const row = [...g.querySelectorAll('[data-act="rbline"][data-on=""]')].find(b => /Parking/.test(b.closest('.exp-line, .exp-li, div').parentElement.innerText)) || g.querySelector('[data-act="rbline"][data-on=""]'); row.click(); }); await own.waitForTimeout(500);
    t.push(['b259: declining one line takes it off the total, and the row stays open', await own.evaluate(() => { const g = [...document.querySelectorAll('#finRbS .exp-group')].find(e => /Bhima/.test(e.textContent));
      return /2 expenses · 1 declined/.test(g.querySelector('.li-row').innerText) && g.querySelector('.li-amt').textContent.trim() === '≈$8.80' && g.classList.contains('open'); })]);
    await own.evaluate(() => { FIN.rbNo.clear(); finReimbRender(); }); await own.waitForTimeout(300);
    t.push(['…with a one-tap WhatsApp confirmation, ready written', /received%20and%20will%20be%20processed/.test(await own.$eval('#fpBody a[href^="https://wa.me/385987"]', a => a.href))]);
    // b259: the charts under Expenses, and the two CSVs.
    csv = await csvOf('reimb');
    t.push(['b259: Reimbursements ⬇️ CSV: the tab being looked at (Pending), with what to pay back', /^Reimbursements Pending /.test(csv.name) && csv.rows.some(r => r[1] === 'Tea for the volunteers' && r[11] === '8.8 USD') && csv.rows.some(r => r[1] === 'Parking at the fair' && r[11] === '12 USD')]);
    await own.evaluate(() => finGo('expenses', 'rg_zg')); await own.waitForTimeout(1000);
    m = await own.$eval('#finCharts', e => e.innerText);
    t.push(['b276: under Expenses & Reimbursements: expenses by type, by month, and by the places under this page; no income charts', /Expenses by type/.test(m) && /Food/.test(m) && /Expenses by month/.test(m) && /Expenses by (Season|Region|Event)/.test(m) && !/Gross/.test(m)
      && await own.evaluate(() => document.querySelector('#finCharts') === document.querySelector('#fpBody').lastElementChild && document.querySelectorAll('#finCharts .fin-pie').length >= 2)]);
    await own.screenshot({ path: shot('exp-charts'), fullPage: true });
    csv = await csvOf('expenses');
    t.push(['b259: Expenses ⬇️ CSV: a row per expense listed, with date, what for, who, type, amount and status', csv.rows[0].join('|').startsWith('Date|What for|Who|Type|Where|Amount|Currency|In dollars') && csv.rows.length === 1 + (await own.$$('.fin-ex .fx-item')).length]);
    /* ---- b255: dates, repeats, and the Dates & Repeats page ---- */
    await O({ action: 'placeMetaSet', kind: 'events', id: 'ev_z1', from: '2025-10-22', to: '2025-10-24' });
    await own.evaluate(() => { finLeave({quiet:true}); goTo('region', 'rg_at'); eventModal(); }); await own.waitForTimeout(1200);
    t.push(['New event asks the dates it runs', !!(await own.$('#pmFrom')) && !!(await own.$('#pmTo'))]);
    await own.fill('#evname', 'Athens Kirtan'); await own.fill('#pmFrom', '2026-10-25'); await own.dispatchEvent('#pmFrom', 'change'); await own.waitForTimeout(300);
    m = await own.$eval('#pmRepeat', e => e.hidden ? '' : e.innerText);
    await own.screenshot({ path: shot('event-dates') });
    t.push(['…dates near last year\'s Zagreb Kirtan: "Is this a recurring event?"', /Is this a recurring event\?/.test(m) && /Zagreb Kirtan/.test(m)]);
    await own.fill('#pmTo', '2026-10-20');
    await own.click('#saveEv'); await own.waitForTimeout(300);
    t.push(['…an end before the start is refused', /end date is before/.test(await own.$eval('#modalErr', e => e.textContent))]);
    await own.fill('#pmTo', '2026-10-27');
    await own.click('#saveEv'); await own.waitForTimeout(300);
    t.push(['…and it asks for an answer first', /recurring event/.test(await own.$eval('#modalErr', e => e.textContent))]);
    await own.click('#pmRepeat [data-pm="Zagreb Kirtan"]'); await own.click('#saveEv'); await own.waitForTimeout(2500);
    let meta = (await O({ action: 'placeMetaGet' })).result;
    let made = meta.events.find(e => e.name === 'Athens Kirtan') || {};
    t.push(['…saved with its dates, as part of the recurring Zagreb Kirtan', made.from === '2026-10-25' && made.to === '2026-10-27' && made.series === 'Zagreb Kirtan']);
    await own.evaluate(() => regionModal()); await own.waitForTimeout(1200);
    await own.fill('#rgName', 'Zagreb 2027'); await own.dispatchEvent('#rgName', 'input'); await own.waitForTimeout(300);
    m = await own.$eval('#pmRepeat', e => e.hidden ? '' : e.innerText);
    await own.screenshot({ path: shot('region-repeat') });
    t.push(['New region with the same name: "Is this part of the recurring Zagreb?"', /Is this part of the recurring Zagreb\?/.test(m) && /Zagreb · Kartika/.test(m)]);
    await own.evaluate(() => closeModal());
    t.push(['Dates & Repeats is in App Development, not on Finance\'s bar', await own.evaluate(() => SN_SECTIONS.find(x=>x.key==='dev').acts.includes('placedates'))
      && !(await own.evaluate(() => FIN_SECS.some(x=>x[0]==='dates')))]);
    t.push(['…and the side menu has it', await own.evaluate(() => !!document.querySelector('[data-act="placedates"]'))]);
    await own.evaluate(() => { const b = document.createElement('button'); b.dataset.act = 'placedates'; b.id = 'tPd'; document.body.appendChild(b); });
    await own.click('#tPd'); await own.waitForTimeout(1500);
    const mtext = () => own.evaluate(() => document.querySelector('#modal').innerText);
    m = await mtext();
    t.push(['…in the app\'s order: Athens before Zagreb', m.indexOf('Athens') < m.indexOf('Zagreb')]);
    t.push(['…it lists every place with its dates', /Dates & Repeats/.test(m) && /Zagreb Kirtan/.test(m) && await own.$eval('#modal tr:has-text("Zagreb Kirtan") [data-dt="from"]', e => e.value) === '2025-10-22']);
    const atF = '#modal tr:has-text("Athens") >> nth=0 >> [data-dt="from"]';
    await own.fill(atF, '2026-10-01'); await own.dispatchEvent(atF, 'change'); await own.waitForTimeout(1000);
    meta = (await O({ action: 'placeMetaGet' })).result;
    t.push(['…a date typed there saves at once', (meta.regions.find(r => r.id === 'rg_at') || {}).from === '2026-10-01']);
    await own.check('#dtMissing'); await own.waitForTimeout(300);
    t.push(['…"Only those without dates" hides the ones done', !/Zagreb Kirtan/.test(await mtext()) && /Zagreb Fair/.test(await mtext())]);
    await own.screenshot({ path: shot('dates') });
    await own.evaluate(() => closeModal());
    /* ---- b260: Where reaches closed places for Finance; Finance in the Activity Log; one Gmail tab ---- */
    srv.app.dbUpdate_('_events', { eventId: 'ev_z2' }, { closedAt: new Date().toISOString() }); srv.app.sheetMemoClear_(); srv.app.cacheClear_(); srv.app.bumpRev_();
    let opts2 = (await O({ action: 'expOptions' })).result;
    t.push(['b260: Universal\'s Where includes a closed event, marked (closed)', opts2.places.some(pl => pl.id === 'ev_z2' && pl.closed && /^Zagreb Fair \(closed\)/.test(pl.label))]);
    srv.app.dbUpdate_('_events', { eventId: 'ev_z2' }, { closedAt: '' }); srv.app.sheetMemoClear_(); srv.app.cacheClear_(); srv.app.bumpRev_();
    const act = (await O({ action: 'activity' })).result || [];
    t.push(['b260: Finance\'s changes are in the Activity Log: added, paid back, declined, links', act.some(e => /^Expense added: Van hire, 20 USD at Zagreb Kirtan/.test(e.text) && e.canUndo)
      && act.some(e => /^Made a reimbursement link for Bhima/.test(e.text)) && act.some(e => /^Expense added: Tea for the volunteers/.test(e.text) && e.who === 'Bhima')]);
    await own.evaluate(() => { finLeave({quiet:true}); goTo('season'); activityModal(); }); await own.waitForTimeout(1800);
    t.push(['b260: …and on the Activity Log page itself', /Expense added: Van hire/.test(await own.evaluate(() => document.querySelector('#alList').innerText))]);
    await own.evaluate(() => { const r = [...document.querySelectorAll('#alList .al-row')].find(x => /Expense added: Van hire/.test(x.innerText)); r.querySelector('[data-alundo]').click(); });
    // b298: asked in the app's own window, not the browser's.
    await own.waitForTimeout(300); await own.click('.sure-ov [data-sure="1"]');
    await own.waitForTimeout(2000);
    const exps = (await O({ action: 'expList', scope: 'all' })).result;
    t.push(['b260: Delete on "Expense added" takes the expense away again, and the log says so', !exps.some(x => x.desc === 'Van hire') && /Undid: Expense added: Van hire/.test(await own.evaluate(() => document.querySelector('#alList').innerText))]);
    await own.evaluate(() => closeModal());
    // Many entries: 50 at a time.
    for (let i = 0; i < 60; i++) srv.app.dbInsert_('_activity', { id: 'Atest' + i, ts: new Date(Date.now() - 86400000 * 3 - i * 1000), season: (await O({ action: 'getState' })).state.activeSeason, who: 'Test', action: 'x', text: 'Filler entry ' + i, locs: '', regions: '', moves: '', undo: '', undoneAt: '', undoneBy: '' });
    await own.evaluate(() => activityModal()); await own.waitForTimeout(1800);
    const rowsN = () => own.$$eval('#alList .al-row', r => r.length);
    const n1 = await rowsN();
    t.push(['b260: the Activity Log shows the latest 50, then "Show older"', n1 === 50 && !!(await own.$('[data-almore]'))]);
    await own.click('[data-almore]'); await own.waitForTimeout(300);
    t.push(['…which shows more', (await rowsN()) > 50]);
    await own.evaluate(() => closeModal());
    t.push(['b260: every Gmail button opens in the one Gmail tab', await own.evaluate(() => typeof GMAIL_TAB === 'string' && GMAIL_TAB === 'tbsGmail')]);
    // b265: the form starts at Earthly HQ; titles have room above them; a quiet tick; exact dollars; dollars last.
    // b299: Finance at Earthly HQ takes the sales side there too, so come back into the season first.
    await own.evaluate(async () => { if (isHQ()) await switchSeason((STATE.seasons || []).find(s => s.seasonId !== HQ_ID).seasonId); CUR_REGION = 'rg_zg'; goTo('event', 'ev_z1'); }).catch(() => {});
    await own.evaluate(() => expensesModal()); await own.waitForTimeout(1500);
    t.push(['b265: a new expense starts at Earthly HQ, even opened at an event', await own.evaluate(() => EXP.form.location === 'rg_hq' && /Earthly HQ/.test(document.querySelector('#xLocC .pp-in').value))]);
    t.push(['…and the event can still be chosen', await own.evaluate(() => EXP.opt.places.some(p => p.id === 'ev_z1'))]);
    t.push(['b265: each title has room between it and the box above', await own.evaluate(() => {
      const a = document.querySelector('#xDate'), l = [...document.querySelectorAll('#modal .exp-form .field > label')].find(x => /What was it for/.test(x.textContent));
      const box = document.querySelector('#xAmt').getBoundingClientRect(), lab = l.getBoundingClientRect();
      return lab.top - box.bottom >= 10 && a; })]);
    t.push(['b265: "Check to receive reimbursement" is plain text with a box', await own.$eval('.exp-rb', e => getComputedStyle(e).fontWeight === '400' && getComputedStyle(e).borderTopStyle === 'none' && /^ ?Check to receive reimbursement$/.test(e.textContent.trim()) )]);
    await own.selectOption('#xCur', 'USD'); await own.waitForTimeout(300);   // (Earthly HQ's own currency comes first once it has been opened)
    t.push(['b265: no exact-dollars box for dollars', !(await own.$('#xUsd'))]);
    await own.selectOption('#xCur', 'EUR'); await own.waitForTimeout(300);
    await own.$eval('#modal', m => m.scrollIntoView()); await own.screenshot({ path: shot('b265-form') });
    t.push(['…but one for another currency', !!(await own.$('#xUsd'))]);
    await own.evaluate(() => closeModal());
    fxAsked.length = 0;
    await O({ action: 'expSave', id: 'Xeur0001', kind: 'record', date: '2026-10-15', desc: 'Stall fee', amt: 10, cur: 'EUR', location: 'rg_hq', category: 'Other' });
    await O({ action: 'expSave', id: 'Xeur0002', kind: 'record', date: '2026-10-15', desc: 'Printing', amt: 10, cur: 'EUR', usdAmt: 12.5, location: 'ev_z1', category: 'Other',
      usdDay: { rate: 99, on: '2026-10-15' } });
    srv.app.sheetMemoClear_(); srv.app.cacheClear_();
    const FD = srv.app.financeData_();
    const ux = id => (FD.expenses || []).find(x => x.id === id);
    t.push(['b265: an expense in euros counts at the rate on its own day', fxAsked.some(u => /2026-10-15/.test(u)) && ux('Xeur0001') && ux('Xeur0001').usd === 11]);
    t.push(['…the exact dollars given win over any rate (and the page cannot send its own rate)', ux('Xeur0002') && ux('Xeur0002').usd === 12.5]);
    t.push(['…and Earthly HQ is a place an expense can belong to', (await O({ action: 'expList', scope: 'all' })).result.some(x => x.id === 'Xeur0001' && x.placeLabel === 'Earthly HQ')]);
    t.push(['b265: dollars come last, out of brackets: (500 ден) $9.08', await own.evaluate(() => finDual(500, 'MKD', 9.08) === '(' + cashFmt(500, 'MKD') + ') $9.08' && finDual(20, 'USD', 20) === cashFmt(20, 'USD'))]);
    await own.evaluate(() => finGo('expenses')); await own.waitForTimeout(1500);
    const fxLine = (pg, o, a) => pg.evaluate(([o, a]) => [...document.querySelectorAll('.fx-item .fx-row')].some(r => r.querySelector('.fx-o').textContent.trim() === o && r.querySelector('.fx-a').textContent.trim() === a), [o, a]);
    t.push(['…and the Expenses list reads that way (b279: the original amount in its own column)', await fxLine(own, await own.evaluate(() => cashFmt(10, 'EUR')), '$12.50')]);
    // b267: quicker rates, a fallback, exact amounts flagged, totals by currency, dollars received.
    let t0 = Date.now(); const slow = await srv.fxOn('2026-10-10', 'GBP', 'USD');
    t.push(['b267: a source that does not answer is given up on in a few seconds', Date.now() - t0 < 5000]);
    const inr = await srv.fxOn('2026-10-10', 'INR', 'USD');
    t.push(['b267: no rate for the day: the fallback, from the rates kept every hour, says so', inr && inr.fallback && Math.abs(inr.rate - 1 / 80) < 1e-9 && slow === null]);
    const last = srv.rateNow('EUR', 'USD');
    t.push(['…and a pair looked up before falls back to its latest rate', last && last.rate === 1.1 && last.fallback]);
    await O({ action: 'expSave', id: 'Xexact01', kind: 'reimburse', date: '2026-10-12', desc: 'Train tickets', amt: 10, cur: 'EUR', location: 'ev_z1', category: 'Travel',
      method: 'Cash', reimbCur: 'USD', payTo: { phone: '+385 99 1' }, payExact: 20 });
    await O({ action: 'expSave', id: 'Xinr0001', kind: 'reimburse', date: '2026-10-12', desc: 'Chai', amt: 800, cur: 'INR', location: 'ev_z1', category: 'Food',
      method: 'Cash', reimbCur: 'USD', payTo: { phone: '+385 99 1' } });
    const xl = (await O({ action: 'expList', scope: 'all' })).result, xe = xl.find(x => x.id === 'Xexact01'), xi = xl.find(x => x.id === 'Xinr0001');
    t.push(['b267: an exact amount is kept, with that day\'s figure beside it', xe.payAmt.exact && xe.payAmt.amt === 20 && xe.payAmt.est === 11]);
    t.push(['b267: with no rate for the day, Finance still gets a figure (the fallback)', xi.payAmt && xi.payAmt.fallback && xi.payAmt.amt === 10]);
    srv.app.dbUpdate_('_expenses', { id: 'Xinr0001' }, { payAmt: '' }); srv.app.sheetMemoClear_(); srv.app.cacheClear_();
    t.push(['…even one saved with none: Finance works one out', (await O({ action: 'expList', scope: 'all' })).result.find(x => x.id === 'Xinr0001').payAmt.amt === 10]);
    await O({ action: 'expSave', id: 'Xpln0001', kind: 'reimburse', date: '2026-10-12', desc: 'Bus', amt: 765, cur: 'PLN', location: 'ev_z1', category: 'Travel',
      method: 'Cash', reimbCur: 'USD', payTo: { phone: '+385 99 1' } });
    // (Paid back in złoty, as someone could ask where złoty are offered.)
    srv.app.dbUpdate_('_expenses', { id: 'Xpln0001' }, { reimbCur: 'PLN', payAmt: '' }); srv.app.sheetMemoClear_(); srv.app.cacheClear_();
    await own.evaluate(() => { FIN.rb.tab = 'pending'; finGo('reimb', '', {reload:true}); }); await own.waitForTimeout(1800);
    m = await fpage(own);
    t.push(['b267: Reimbursements Due shows each currency it will be paid in, dollars first', new RegExp('\\$[\\d,.]+ \\+ ' + (await own.evaluate(() => cashFmt(765, 'PLN'))).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(m)]);
    t.push(['b267: an exact amount well above the day\'s rate is flagged', /⚠ 82% more than that day's rate \(\$11\.00\)/.test(await own.$eval('#finRbS', e => e.textContent)) && /⚠ 1 above the day's rate/.test(m)]);
    t.push(['b267: totals put dollars first: $169.05 + 765 zł', await own.evaluate(() => finMix({ PLN: 765, USD: 169.05 }) === '$169.05 + ' + cashFmt(765, 'PLN') && finTotals([1], () => [[765, 'PLN'], [169.05, 'USD']]) === cashFmt(169.05, 'USD') + ' + ' + cashFmt(765, 'PLN'))]);
    // b284: waiting to be paid back somewhere else than the place being looked at: said, with where.
    await O({ action: 'expSave', id: 'Xaway001', kind: 'reimburse', date: '2026-10-12', desc: 'Taxi', amt: 5, cur: 'USD', location: 'rg_at', category: 'Travel', method: 'Cash', reimbCur: 'USD', payTo: { phone: '+30 1' } });
    await own.evaluate(() => { FIN.rb.tab = 'pending'; finGo('reimb', 'rg_zg', {reload:true}); }); await own.waitForTimeout(1500);
    t.push(['b284: a reimbursement waiting in another place is flagged on Reimbursements, with where, and one tap shows every season', await own.evaluate(() => {
      const n = document.querySelector('.fin-away'); return !!n && /1 more is waiting to be paid back elsewhere/.test(n.innerText) && /Athens/.test(n.innerText) && !!n.querySelector('[data-act="fingo"][data-scope=""]'); })]);
    await O({ action: 'expDelete', id: 'Xaway001' });
    // b284: choosing Where in the expense form leaves the form where it was.
    await own.evaluate(() => expensesModal()); await own.waitForTimeout(1200);
    await own.$eval('#xLocC .pp-in', i => i.scrollIntoView({ block: 'center' })); await own.waitForTimeout(200);
    const whereTop = () => own.$eval('#xLocC .pp-in', i => Math.round(i.getBoundingClientRect().top));
    const wt0 = await whereTop();
    await own.click('#xLocC .pp-in'); await own.fill('#xLocC .pp-in', 'Kirtan'); await own.waitForTimeout(200);
    await own.click('#xLocC .pp-row[data-v="ev_z1"]'); await own.waitForTimeout(800);
    const wt1 = await whereTop();
    t.push(['b284: choosing Where keeps the form still (the box stays put) and Where is chosen' + (Math.abs(wt1 - wt0) > 2 ? ' ' + wt0 + '→' + wt1 : ''), Math.abs(wt1 - wt0) <= 2 && await own.evaluate(() => EXP.form.location === 'ev_z1')]);
    await own.evaluate(() => closeModal()); await own.waitForTimeout(300);
    // Dollars received: 35 € taken at the Kirtan fetched $40.
    await sell('eur1', 'ev_z1', 'sr_en', { legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] });
    await own.evaluate(() => finGo('overview', '', {reload:true})); await own.waitForTimeout(1800);
    await own.evaluate(() => finConvModal()); await own.waitForTimeout(300);
    await own.click('#cvPlace .pp-in'); await own.fill('#cvPlace .pp-in', 'Kirtan'); await own.waitForTimeout(150); await own.click('#cvPlace .pp-row[data-v="ev_z1"]');
    await own.selectOption('#cvRows .cv-cur', 'EUR'); await own.fill('#cvRows .cv-amt', '35'); await own.fill('#cvUsd', '40');
    await own.click('#cvSave'); await own.waitForTimeout(1500);
    const sale = await own.evaluate(() => FIN.D.sales.find(x => x.id === 'eur1'));
    t.push(['b267: Dollars received: 35 € from the Kirtan fetched $40, and that sale now counts $40', sale && sale.gu === 40 && sale.cv === 1]);
    t.push(['…listed with its rate', /\(.*35.*\) \$40/.test(await own.evaluate(() => document.querySelector('#modal').innerText))]);
    // b296 (Gita, live): 250.13 ден for $253 made Macedonia's dollars 55 times too big. A rate far from the day's asks first.
    const convN = async () => (await O({ action: 'finData' })).result.convs.length;
    const n0 = await convN();
    await own.evaluate(() => finConvModal()); await own.waitForTimeout(300);
    await own.click('#cvPlace .pp-in'); await own.fill('#cvPlace .pp-in', 'Kirtan'); await own.waitForTimeout(150); await own.click('#cvPlace .pp-row[data-v="ev_z1"]');
    await own.selectOption('#cvRows .cv-cur', 'EUR'); await own.fill('#cvRows .cv-amt', '35'); await own.fill('#cvUsd', '2000');
    await own.click('#cvSave'); await own.waitForTimeout(1200);
    // b298: asked in the app's own window.
    const asked = await own.evaluate(() => { const o = document.querySelector('.sure-ov'); return o ? o.innerText : ''; });
    if (asked) await own.click('.sure-ov [data-sure="0"]');
    t.push(['b296: 35 € for $2000 asks "Please check the numbers" first, and Cancel saves nothing' + (asked ? '' : ' (no question)'), /Please check the numbers/.test(asked) && /\$38\.50/.test(asked) && await convN() === n0]);
    await own.click('#cvSave'); await own.waitForTimeout(1200); await own.click('.sure-ov [data-sure="1"]'); await own.waitForTimeout(1500);
    t.push(['b296: …OK saves it anyway', await convN() === n0 + 1 && (await own.evaluate(() => FIN.D.sales.find(x => x.id === 'eur1').gu)) > 40]);
    await own.evaluate(() => closeModal());
    const slip = ((await O({ action: 'activity' })).result || []).find(e => /^Dollars received: 35 EUR .* fetched \$2000/.test(e.text));
    t.push(['b296: the Activity Log can Delete a Dollars received entry', !!slip && slip.canUndo]);
    if (slip) await O({ action: 'expUndo', id: slip.id });
    t.push(['b296: …and Delete takes it away; the earlier one stays and the sale is back at $40', await convN() === n0 && await own.evaluate(async () => { await finGo('overview', '', {reload:true}); return true; })
      && (await O({ action: 'finData' })).result.sales.find(x => x.id === 'eur1').gu === 40]);
    await own.waitForTimeout(1200);
    /* b298 (Gita): several currencies exchanged together for one dollar figure,
       "85 euros + 6250 den + $5 = $253"; and Total collections fills in every currency. */
    await sell('mkd1', 'ev_z1', 'sr_en', { legs: [{ type: 'Cash', cur: 'MKD', amt: 6250 }] });
    await sell('usd5', 'ev_z1', 'sr_en', { legs: [{ type: 'Cash', cur: 'USD', amt: 5 }] });
    await own.evaluate(() => finGo('overview', '', {reload:true})); await own.waitForTimeout(1800);
    await own.evaluate(() => finConvModal()); await own.waitForTimeout(300);
    await own.click('#cvPlace .pp-in'); await own.fill('#cvPlace .pp-in', 'Kirtan'); await own.waitForTimeout(150); await own.click('#cvPlace .pp-row[data-v="ev_z1"]');
    await own.check('#cvAll'); await own.waitForTimeout(200);
    const rowsAll = await own.$$eval('#cvRows .cv-row', rs => rs.map(r => r.querySelector('.cv-cur').value + ' ' + r.querySelector('.cv-amt').value));
    t.push(['b298: Total collections fills in every currency taken there (' + rowsAll.join(', ') + ')', rowsAll.includes('MKD 6250') && rowsAll.some(x => /^USD /.test(x)) && rowsAll.some(x => /^EUR /.test(x))]);
    await own.evaluate(() => { const rs = [...document.querySelectorAll('#cvRows .cv-row')]; rs.forEach(r => { const k = r.querySelector('.cv-cur').value; if (k === 'EUR') r.querySelector('.cv-amt').value = '85'; if (k === 'USD') r.querySelector('.cv-amt').value = '5'; }); });
    await own.fill('#cvUsd', '253');
    await own.click('#cvSave'); await own.waitForTimeout(1500);
    if (await own.$('.sure-ov')) { await own.click('.sure-ov [data-sure="1"]'); await own.waitForTimeout(1500); }
    const multi = (await O({ action: 'finData' })).result.convs.find(c => Array.isArray(c.parts));
    const pe = multi && multi.parts.find(x => x.cur === 'EUR'), pm = multi && multi.parts.find(x => x.cur === 'MKD'), pu = multi && multi.parts.find(x => x.cur === 'USD');
    t.push(['b298: one entry, 85 € + 6250 ден + $5 = $253; the $248 shared out between euros and denars', !!multi && multi.usd === 253 && pu && pu.usd === 5 && pe && pm && Math.round((pe.usd + pm.usd) * 100) === 24800 && pe.usd > 0 && pm.usd > 0]);
    t.push(['b298: …listed as one line', /85(\.00)? € \+ 6[,.]?250(\.00)? ден \+ \$5(\.00)? fetched \$253(\.00)?/.test(await own.evaluate(() => document.querySelector('#modal').innerText))]);
    const nM = await convN();
    await own.evaluate(id => document.querySelector('#modal [data-cvdel="' + id + '"]').click(), multi.id); await own.waitForTimeout(300);
    t.push(['b298: Remove asks in the app\'s own window', !!(await own.$('.sure-ov'))]);
    await own.click('.sure-ov [data-sure="1"]'); await own.waitForTimeout(1500);
    t.push(['b298: …and Remove takes it away', await convN() === nM - 1]);
    await own.evaluate(() => finConvModal()); await own.waitForTimeout(300);
    await own.evaluate(() => closeModal());
    t.push(['b269: Dollars received is no longer on the Overview', !/Dollars received/.test(await fpage(own))]);
    await own.evaluate(() => finGo('expenses', '', {reload:true})); await own.waitForTimeout(1500);
    t.push(['b291: Dollars received and Add an expense are no longer on the Expenses screen', await own.evaluate(() => !document.querySelector('#fpBody .fin-sh-btns') && !/Dollars received/.test(document.querySelector('#fpBody').innerText))]);
    t.push(['b291: in practice a "≈$" figure is a button that opens Dollars received', await own.evaluate(() => { const b = document.querySelector('#fpBody .fin-est'); if(!b || !/^−?≈\$/.test(b.textContent)) return false;
      b.click(); const ok = !!document.querySelector('#cvRows .cv-amt'); closeModal(); return ok; })]);
    t.push(['b276: the Expenses screen charts expenses only (income is on the Overview)', await own.evaluate(() => /Expenses by month/.test(document.querySelector('#finCharts').innerText) && !/Gross|Net/.test(document.querySelector('#finCharts').innerText))]);
    t.push(['b269: every colour key in the charts keeps its square, even squeezed beside big figures', await own.evaluate(() => {
      document.querySelectorAll('#finCharts .fc-legend').forEach(l => { l.style.flex = 'none'; l.style.width = '170px'; l.querySelectorAll('b').forEach(b => { b.textContent = '$12,345.67'; }); });
      return [...document.querySelectorAll('#finCharts .fin-key')].every(k => k.getBoundingClientRect().width >= 10); })]);
    t.push(['b269: estimated dollars carry ~, logged ones none: (10 €) ~$11 and (10 €) $12.50', await own.evaluate(() => { const t = document.querySelector('#fpBody').innerText;
      return /\n\$30(\.00)?\n/.test(t); }) && await fxLine(own, '10.00 €', '≈$11.00') && await fxLine(own, '10.00 €', '$12.50')]);
    t.push(['b269: what is owed reads in the person\'s currency, dollars beside: 765 zł (≈$…)', await own.evaluate(() => {
      const x = finExpList().find(y => y.id === 'Xpln0001'); return new RegExp('^' + cashFmt(765, 'PLN').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\(≈\\$[\\d.,]+\\)$').test(finPayText([x])); })]);
    t.push(['b269: …and all in dollars, just one figure', await own.evaluate(() => finPayText([finExpList().find(y => y.id === 'Xexact01')]) === '$20.00')]);
    // The fallback is the rate nearest the day asked for.
    srv.kv.setProp('fxHist', JSON.stringify({ 'CHF>USD': { '2026-09-01': 1.1, '2026-10-01': 1.2, '2026-10-20': 1.3 } }));
    t.push(['b269: no rate for the day: the nearest day\'s rate is used', srv.rateNow('CHF', 'USD', '2026-10-05').rate === 1.2 && srv.rateNow('CHF', 'USD', '2026-10-15').rate === 1.3 && srv.rateNow('CHF', 'USD', '2026-08-01').rate === 1.1]);
    const phone = await open('owner@example.com', 'The Owner', 390);
    await phone.evaluate(() => finGo('overview', 'rg_zg')); await phone.waitForTimeout(1500);
    await phone.evaluate(() => document.querySelector('#finCharts').scrollIntoView()); await phone.screenshot({ path: shot('b269-phone-charts') });
    t.push(['b269: on a phone too, every chart key keeps its colour square', await phone.evaluate(() => [...document.querySelectorAll('#finCharts .fin-key')].length > 0 && [...document.querySelectorAll('#finCharts .fin-key')].every(k => k.getBoundingClientRect().width >= 10))]);
    t.push(['phone width: no sideways scroll on the page', await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)]);
    await phone.screenshot({ path: shot('fin-phone'), fullPage: true });
    await own.setViewportSize({ width: 1150, height: 1000 });
    await own.evaluate(() => finGo('overview', 'rg_zg')); await own.waitForTimeout(800);
    await own.screenshot({ path: shot('fin-overview'), fullPage: true });

    /* b272 (Gita, 2026-10-21): nothing spills out of its box, ever. Every
       Finance screen, a year of months and big figures, computer to phone. */
    const spill = pg => pg.evaluate(() => {
      const out = [], vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const scroller = e => { for (let p = e.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return p; } return null; };
      document.querySelectorAll('#fpBody *').forEach(e => {
        if (!vis(e)) return;
        const cs = getComputedStyle(e);
        if (e.scrollWidth > e.clientWidth + 1 && /auto|scroll|hidden/.test(cs.overflowX) && cs.textOverflow !== 'ellipsis' && !e.closest('.fin-tabs') && !e.classList.contains('fin-ovw')) out.push('scrolls sideways: ' + (e.className || e.tagName));
        const box = e.parentElement.closest('.fc-box, .fin-tile, .exp-card, section, #fpBody') || document.querySelector('#fpBody');
        const sc = scroller(e); if (sc && box.contains(sc)) return;
        const r = e.getBoundingClientRect(), b = box.getBoundingClientRect();
        if (r.right > b.right + 1.5 || r.left < b.left - 1.5) out.push((e.className || e.tagName) + ' out of ' + (box.className || box.id) + ' "' + (e.textContent || '').trim().slice(0, 30) + '"');
      });
      if (document.documentElement.scrollWidth > innerWidth + 1) out.push('the page scrolls sideways');
      return [...new Set(out)];
    });
    await own.evaluate(() => { const D = FIN.D, S = D.sales.slice(), E = D.expenses.slice();
      for (let m = 1; m <= 12; m++) { const mm = '2026-' + String(m).padStart(2, '0') + '-10';
        S.forEach(x => D.sales.push(Object.assign({}, x, { d: mm, gu: (x.gu || 0) * (m * 37 % 11 + 1) * 40 })));
        E.forEach(x => D.expenses.push(Object.assign({}, x, { id: x.id + m, d: mm, date: mm, usd: (x.usd || 0) * (m * 13 % 7 + 1) * 60 }))); } });
    const spilt = [];
    for (const w of [1440, 1000, 820, 700, 560, 390, 360]) { await own.setViewportSize({ width: w, height: 1000 });
      for (const sec of ['overview', 'expenses', 'reimb', 'todo']) { await own.evaluate(s => finGo(s, ''), sec); await own.waitForTimeout(500);
        (await spill(own)).forEach(x => spilt.push(w + ' ' + sec + ': ' + x));
        if (w === 390 || w === 1440) await own.locator('#fpBody').screenshot({ path: shot('b271-' + w + '-' + sec) }); } }
    t.push(['b272: no overflow on any Finance screen, from a wide computer to a small phone' + (spilt.length ? ' — ' + spilt.slice(0, 4).join(' | ') : ''), !spilt.length]);
    await own.setViewportSize({ width: 1440, height: 1000 }); await own.evaluate(() => finGo('overview', '')); await own.waitForTimeout(600);
    t.push(['b284: on a computer the charts sit several to a row, none wider than half the page', await own.evaluate(() => {
      const g = document.querySelector('#finCharts .fc-grid'), W = g.getBoundingClientRect().width, bs = [...g.querySelectorAll('.fc-box')].map(b => b.getBoundingClientRect());
      return bs.length > 2 && bs.every(b => b.width <= W / 2 + 1) && bs[0].top === bs[1].top; })]);
    await own.evaluate(() => finGo('overview', '')); await own.waitForTimeout(500);
    t.push(['b272: the Overview charts Net beside Gross and Expenses, by place and month by month', await own.evaluate(() => { const c = document.querySelector('#finCharts');
      return /Month by month: Gross, Expenses and Net/.test(c.innerText) && [...c.querySelectorAll('.fc-keys')].every(k => /Net/.test(k.textContent)); })]);
    t.push(['b272: books on two lines: "65 Sold + 13 Gifts", then "= 78 Distributed"', await own.evaluate(() => /Sold \+ \d+ Gifts?<br>= \d+ Distributed/.test(document.querySelector('.fin-tile .fin-ts').innerHTML))]);
    // ---- Finance never sits blank (b287) ----
    await own.evaluate(() => { finLeave({quiet:true}); FIN.D = null; localStorage.setItem(finCacheKey(), JSON.stringify([{sales:{}}, null, [], {curs:[]}])); });
    await own.evaluate(() => finGo('overview', '')); await own.waitForTimeout(1500);
    t.push(['b287: a device copy that won\'t draw is dropped and Finance opens with fresh figures', await own.evaluate(() => /Gross/.test(document.querySelector('#fpBody').innerText) && !/couldn't open/.test(document.querySelector('#fpBody').innerText))]);
    await own.evaluate(() => { finLeave({quiet:true}); FIN.D = null; window.__post = post; post = async () => { throw new Error('No connection to the server.'); }; });
    await own.evaluate(() => finGo('overview', '', {reload:true})); await own.waitForTimeout(500);
    t.push(['b287: no answer from the server shows why, with Try again', await own.evaluate(() => /couldn't open: No connection/.test(document.querySelector('#fpBody').innerText) && !!document.querySelector('#finRetry'))]);
    await own.evaluate(() => { post = window.__post; document.querySelector('#finRetry').click(); }); await own.waitForTimeout(1500);
    t.push(['…and Try again opens it', await own.evaluate(() => /Gross/.test(document.querySelector('#fpBody').innerText))]);
    await own.evaluate(() => finLeave({quiet:true}));
    // ---- Edit Finance-Only Locations (b288, practice) ----
    await own.evaluate(async () => { await post({action:'finPlaceAdd', name:'Hotel Lobby', parent:'rg_zg'}); FIN.D = null; });
    t.push(['b288: the Finance menu has Edit Finance-Only Locations in practice', await own.evaluate(() => FIN_BTNS('U').some(b => /Edit Finance-Only Locations/.test(b)))]);
    await own.evaluate(() => finPlacesModal()); await own.waitForTimeout(800);
    await own.fill('#fplC .pp-in', 'Hotel'); await own.waitForTimeout(200);
    await own.evaluate(() => { const r = [...document.querySelectorAll('#fplC .pp-row')].find(x => /Hotel Lobby/.test(x.textContent)); r && r.dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); r && r.click(); });
    await own.waitForTimeout(500);
    t.push(['b288: choosing one from the searchable list shows its name, where it sits, and Remove', await own.evaluate(() => $('#fplName') && $('#fplName').value === 'Hotel Lobby' && !!$('#fplDel') && /No expenses are recorded here/.test($('#modal').innerText))]);
    for (const w of [390, 1150]) { await own.setViewportSize({ width: w, height: 900 }); await own.waitForTimeout(200);
      t.push(['b288: no overflow in Edit Finance-Only Locations at ' + w + 'px', await own.evaluate(() => { const m = $('#modal'); return m.scrollWidth <= m.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth; })]); }
    await own.fill('#fplName', 'Hotel Lobby Kiosk'); await own.click('#fplSave'); await own.waitForTimeout(1500);
    await own.locator('#modal').screenshot({ path: shot('b288-finplaces') });
    t.push(['b288: Save renames it', await own.evaluate(() => (FIN.D.finPlaces || []).some(x => x.name === 'Hotel Lobby Kiosk') && $('#fplName').value === 'Hotel Lobby Kiosk')]);
    await own.click('#fplDel'); await own.waitForTimeout(1500);
    t.push(['b288: Remove takes it away', await own.evaluate(() => !(FIN.D.finPlaces || []).some(x => /Hotel Lobby/.test(x.name)) && !$('#fplName'))]);
    await own.evaluate(() => closeModal());
    // A refresh comes back to exactly where you were.
    const where = pg => pg.evaluate(() => ({ hash: location.hash, sec: FINP.sec, scope: FINP.scope, tab: FIN.rb.tab, y: Math.round(window.scrollY), modal: $('#overlay').classList.contains('show') }));
    await own.setViewportSize({ width: 1150, height: 700 });
    await own.evaluate(() => { FIN.rb.tab = 'paid'; finGo('expenses', 'rg_zg', {reload:true}); }); await own.waitForTimeout(1500);
    await own.evaluate(() => window.scrollTo(0, 400)); await own.waitForTimeout(400);
    const w0 = await where(own);
    await own.reload(); await own.waitForTimeout(4500);
    const w1 = await where(own);
    { const ok = w0.y === 400 && w1.hash === w0.hash && w1.sec === 'expenses' && w1.scope === 'rg_zg' && w1.tab === 'paid' && Math.abs(w1.y - 400) < 3;
      t.push(['b272: a refresh in Finance comes back to the same section, place, tab and scroll' + (ok ? '' : ' ' + JSON.stringify([w0, w1])), ok]); }
    await own.evaluate(() => finLeave()); await own.waitForTimeout(600);
    await own.evaluate(() => goTo('event', 'ev_z1')); await own.waitForTimeout(800);
    await own.click('#adminActions [data-act="cash"]').catch(() => own.evaluate(() => document.querySelector('[data-act="cash"]').click())); await own.waitForTimeout(1200);
    const open0 = await own.evaluate(() => $('#overlay').classList.contains('show') && document.querySelector('#modal').innerText.slice(0, 40));
    await own.reload(); await own.waitForTimeout(4500);
    const open1 = await own.evaluate(() => $('#overlay').classList.contains('show') && document.querySelector('#modal').innerText.slice(0, 40));
    t.push(['b272: a refresh with a page open from the menu (Track Cash) opens it again, at the same event', !!open0 && open1 === open0 && await own.evaluate(() => CUR_LOC === 'ev_z1')]);
    await own.evaluate(() => closeModal()); await own.waitForTimeout(300);
    await own.reload(); await own.waitForTimeout(3500);
    t.push(['b272: …and once closed, a refresh leaves it closed', await own.evaluate(() => !$('#overlay').classList.contains('show'))]);
    /* b274: Finance is live. The live app (no ?practice) has it all, in the menu
       as Gita named it, plus Universal's "Bring Wording & Settings from Practice". */
    const lv = await open('owner@example.com', 'The Owner', 1150, true);
    const menu = await lv.evaluate(() => [...document.querySelectorAll('#sideNav .sn-item, #sideNav .sn-gh')].map(b => b.textContent.replace(/\s+/g, ' ').trim()).join('|'));
    t.push(['b274: the live app\'s menu has Laksmi, Add an Expense, Finance and Dates & Repeats, and no Record Costs or To do', /Laksmi/.test(menu) && /Add an Expense/.test(menu) && /Finance/.test(menu) && /Dates & Repeats/.test(menu) && !/Record Costs/.test(menu) && !/To do/.test(menu)]);
    t.push(['b274: …and Universal\'s "Bring Wording & Settings from Practice"', /Bring Wording & Settings from Practice/.test(menu)]);
    { // b288: wording changed in both places is shown side by side, one choice each (servers stood in for).
      await lv.evaluate(() => {
        localStorage.setItem('practice:tbs_session', 'tok'); window.__sent = [];
        const of = window.fetch; window.fetch = async (u, o) => /finCarryOut/.test(String(o && o.body)) ? { text: async () => JSON.stringify({ ok: true, result: { labels: [], props: {}, base: {} } }) } : of(u, o);
        window.__post = post; post = async q => { if (q.action !== 'finCarryIn') return window.__post(q); window.__sent.push(q);
          return { result: q.plan ? { plan: true, take: 2, keep: 1, both: [{ key: 'Panel: Finance › Overview', practice: 'Laksmi Overview', live: 'Money Overview' }, { key: 'Sell', practice: '', live: 'Sell a book' }] } : { words: 3, set: [] } }; };
        finCarryModal(); });
      await lv.click('#fcGo'); await lv.waitForTimeout(500);
      t.push(['b288: Bring Wording: words changed in both places are listed with both versions', await lv.evaluate(() => document.querySelectorAll('#fcBoth .fc-item').length === 2 && /Laksmi Overview/.test($('#fcBoth').innerText) && /Money Overview/.test($('#fcBoth').innerText) && /the original wording/.test($('#fcBoth').innerText) && /2 more, changed only in practice/.test($('#fcBoth').innerText))]);
      for (const w of [390, 1150]) { await lv.setViewportSize({ width: w, height: 900 }); await lv.waitForTimeout(200);
        t.push(['b288: no overflow in the choices at ' + w + 'px', await lv.evaluate(() => { const m = $('#modal'); return m.scrollWidth <= m.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth; })]); }
      await lv.setViewportSize({ width: 390, height: 900 }); await lv.waitForTimeout(500); await lv.screenshot({ path: shot('b288-choices-390') }); await lv.setViewportSize({ width: 1150, height: 900 });
      await lv.click('#fcGo'); await lv.waitForTimeout(300);
      t.push(['b288: …nothing is sent until each has a choice', await lv.evaluate(() => window.__sent.length === 1 && /Choose a version/.test($('#modalErr').textContent))]);
      await lv.click('#fcBoth [data-fcall="live"]'); await lv.evaluate(() => { document.querySelector('#fcBoth .fc-item input[value="practice"]').checked = true; });
      await lv.click('#fcGo'); await lv.waitForTimeout(500);
      t.push(['b288: …then her choices go over (practice for the first, live for the second)', await lv.evaluate(() => { const q = window.__sent[1]; return !!q && q.choices['Panel: Finance › Overview'] === 'practice' && q.choices['Sell'] === 'live' && /Done: 3 rewritten/.test($('#fcDone').innerText); })]);
      await lv.evaluate(() => { post = window.__post; localStorage.removeItem('practice:tbs_session'); closeModal(); });
    }
    await lv.evaluate(() => finGo('overview', '')); await lv.waitForTimeout(1500);
    t.push(['b274: Finance opens on the live app', await lv.evaluate(() => FINP.on && /Big Books Sold/.test(document.querySelector('#fpBody').innerText))]);
    const lspill = [];
    // b276 (Gita, 2026-10-21): Expenses & Reimbursements in the menu's Finance section.
    const finAct = await lv.evaluate(() => [...document.querySelectorAll('#sideNav .sn-group[data-sec="finance"] .sn-item')].map(b => b.dataset.act));
    t.push(['b284: the menu\'s Finance section has Expenses then Reimbursements, after Overview', finAct.indexOf('finexpenses') === finAct.indexOf('finoverview') + 1 && finAct.indexOf('finreimb') === finAct.indexOf('finexpenses') + 1]);
    await lv.evaluate(() => document.querySelector('#sideNav [data-act="finexpenses"]').click()); await lv.waitForTimeout(1500);
    t.push(['b284: …Expenses opens the Expenses screen', await lv.evaluate(() => FINP.on && FINP.sec === 'expenses' && !!document.querySelector('#finExS') && !document.querySelector('#finRbS'))]);
    await lv.evaluate(() => document.querySelector('#sideNav [data-act="finreimb"]').click()); await lv.waitForTimeout(1500);
    t.push(['b284: …and Reimbursements its own', await lv.evaluate(() => FINP.on && FINP.sec === 'reimb' && !!document.querySelector('#finRbS') && !document.querySelector('#finExS'))]);
    await lv.evaluate(() => finGo('overview', '', {reload:true})); await lv.waitForTimeout(1200);
    { // b281: a long note hidden in Finance stays hidden (the server keeps the first 300 characters of its key).
      const cap = () => lv.evaluate(() => { const e = [...document.querySelectorAll('#fpBody .muted-note')].find(x => /Consignment money/.test(x.textContent)); return e ? { key: e.getAttribute('data-key'), shown: !!e.offsetParent } : null; });
      await lv.evaluate(() => { EDIT_WORDING = true; lblBodyClass(); finRender(); applyLabels(); }); await lv.waitForTimeout(400);
      const c0 = await cap();
      await lv.evaluate(k => labelSave(k, '\u0000hide', '\u0001'), c0.key); await lv.waitForTimeout(800);
      await lv.evaluate(() => { EDIT_WORDING = false; lblBodyClass(); finRender(); applyLabels(); }); await lv.waitForTimeout(400);
      const sc = await lv.evaluate(() => FIN.D.seasons[0].id);
      await lv.evaluate(s => finGo('overview', s, {reload:true}), sc); await lv.waitForTimeout(1500);
      const c1 = await cap();
      await lv.reload(); await lv.waitForTimeout(3000); await lv.evaluate(() => finGo('overview', '', {reload:true})); await lv.waitForTimeout(1500);
      const c2 = await cap();
      t.push(['b282: the long Overview note, once hidden, stays hidden at another place and after a refresh', c0.key.length > 300 && c1 && !c1.shown && c2 && !c2.shown]);
      await lv.evaluate(k => labelSave(k, '', '\u0001'), c0.key); await lv.waitForTimeout(800);
      t.push(['b300: live: no Go to Sales Portal in the menu; the top bar has 🏠 Sales Portal while in Finance', await lv.evaluate(() => { const b = document.querySelector('#portalBtn'); return !document.querySelector('#sideNav [data-act="finleave"]') && !!b && getComputedStyle(b).display !== 'none' && /Sales Portal/.test(b.textContent); })]);
      await lv.evaluate(() => document.querySelector('#portalBtn').click()); await lv.waitForTimeout(800);
      t.push(['b300: …which takes you to the sales side, where it reads 📈 Finance Portal', await lv.evaluate(() => !document.body.classList.contains('fin-mode') && /Finance Portal/.test(document.querySelector('#portalBtn').textContent) && !!document.querySelector('#whoBtn') && getComputedStyle(document.querySelector('#whoBtn')).display !== 'none')]);
      await lv.evaluate(() => finGo('overview', '', {reload:true})); await lv.waitForTimeout(1500);
    }
    t.push(['b276: the Finance search reads "Search for Season, Region, or Event" when nothing is chosen', await lv.evaluate(() => {
      const i = document.querySelector('#finPP .pp-in'); return !!i && i.placeholder === 'Search for Season, Region, or Event' && i.value === ''; })]);
    await lv.evaluate(() => finGo('settings', '', {reload:true})); await lv.waitForTimeout(1500);
    t.push(['b284: currencies for paying back are checkboxes only, ticked as the place selected has them, ready to untick', await lv.evaluate(() => {
      const c = [...document.querySelectorAll('[data-rsc]')], lv0 = RS.d.levels.find(l => l.id === RS.id) || RS.d.levels[0], inh = rsInherited(lv0).curs, base = inh.length ? inh : RS.d.curs;
      return c.length > 0 && !document.querySelector('input[name="rsCurMode"]') && c.every(x => x.checked === base.includes(x.dataset.rsc) && !x.disabled); })]);
    // b277: kinds of expense, in Settings and on the form.
    t.push(['b278: no Finance To do in Settings or the menu on the live app', !(await lv.$('[data-act="fintodo"]'))]);
    t.push(['b278: Settings lists how expenses were paid, Other last', await lv.evaluate(() => { const g = [...document.querySelectorAll('.rs-cats')][1]; if (!g) return false;
      const c = [...g.querySelectorAll('.rs-cat')].map(x => x.textContent.replace(/🗑/g, '').trim()); return c.length > 1 && c[c.length - 1] === 'Other' && !c.some(x => /^gift$/i.test(x)); })]);
    t.push(['b277: Settings lists the kinds of expense, Other last with no 🗑', await lv.evaluate(() => { const g = document.querySelector('.rs-cats'), c = [...g.querySelectorAll('.rs-cat')].map(x => x.textContent.replace(/🗑/g, '').trim());
      return c[0] === 'Card machine fee' && c[c.length - 1] === 'Other' && !g.querySelector('.rs-cat:last-child [data-act="rscatgone"]'); })]);
    await lv.fill('#rsCatNew', 'Stall rent'); await lv.click('[data-act="rscatadd"]'); await lv.waitForTimeout(900);
    t.push(['b277: …adding one there puts it before Other', await lv.evaluate(() => [...document.querySelectorAll('.rs-cats')][0].querySelectorAll('.rs-cat').length && [...[...document.querySelectorAll('.rs-cats')][0].querySelectorAll('.rs-cat')].map(x => x.textContent.replace(/🗑/g, '').trim()).slice(-2).join('|') === 'Stall rent|Other')]);
    await lv.evaluate(() => { window.confirm = () => true; document.querySelector('[data-act="rscatgone"][data-c="Stall rent"]').click(); }); await lv.waitForTimeout(900);
    t.push(['b277: …and 🗑 removes it', await lv.evaluate(() => !document.querySelector('[data-c="Stall rent"]'))]);
    await lv.evaluate(() => expensesModal()); await lv.waitForTimeout(1500);
    await lv.click('#xCatC .pp-in'); await lv.fill('#xCatC .pp-in', 'Petrol'); await lv.waitForTimeout(200);
    t.push(['b277: on the form, Finance typing a new kind is offered "＋ Add"', await lv.evaluate(() => /Add “Petrol”/.test((document.querySelector('#xCatC .pp-add') || {}).textContent || ''))]);
    await lv.click('#xCatC .pp-add'); await lv.waitForTimeout(1200);
    t.push(['b277: …which adds it and chooses it', await lv.evaluate(() => EXP.form.category === 'Petrol' && EXP.opt.categories.includes('Petrol') && document.querySelector('#xCatC .pp-in').value === 'Petrol')]);
    // b278: Finance adds payment types on the form too.
    await lv.click('#xPayC .pp-in'); await lv.fill('#xPayC .pp-in', 'Petty cash'); await lv.waitForTimeout(200);
    await lv.click('#xPayC .pp-add'); await lv.waitForTimeout(1200);
    t.push(['b278: on the form, Finance adds a payment type with "＋ Add", and it is chosen', await lv.evaluate(() => EXP.form.payType === 'Petty cash' && EXP.opt.payTypes.includes('Petty cash'))]);
    // b278: windows stay put and only close when asked.
    const top0 = await lv.evaluate(() => document.querySelector('#modal').getBoundingClientRect().top);
    await lv.mouse.click(5, 300); await lv.waitForTimeout(300);
    t.push(['b278: a tap outside the expense form leaves it open', await lv.evaluate(() => $('#overlay').classList.contains('show') && !!document.querySelector('#modal .exp-form'))]);
    await lv.keyboard.press('Escape'); await lv.waitForTimeout(300);
    t.push(['b278: …so does Esc', await lv.evaluate(() => $('#overlay').classList.contains('show'))]);
    await lv.evaluate(() => { const r = document.querySelector('#xReimb'); if (r) r.click(); }); await lv.waitForTimeout(600);
    t.push(['b278: …and it stays where it is when its contents change', Math.abs(await lv.evaluate(() => document.querySelector('#modal').getBoundingClientRect().top) - top0) <= 1]);
    t.push(['b278: no Finance To do in the form on the live app', !(await lv.$('#modal [data-act="fintodo"]'))]);
    await lv.click('#modal h3 .x'); await lv.waitForTimeout(300);
    t.push(['b278: ✕ closes it', await lv.evaluate(() => !$('#overlay').classList.contains('show'))]);
    // b279: the form keeps the field just changed where it was (not where the last tap was).
    await lv.evaluate(() => expensesModal()); await lv.waitForTimeout(1500);
    await lv.evaluate(() => { const b = document.querySelector('#modal .m-body'); if (b) b.scrollTop = 200; $('#overlay').scrollTop = 100; });
    await lv.click('#xAmt'); await lv.keyboard.type('12'); await lv.click('#xDesc'); await lv.keyboard.type('Room');
    const curTop = () => lv.evaluate(() => { const e = document.querySelector('#xCur'); return e ? Math.round(e.getBoundingClientRect().top) : null; });
    const cur0 = await curTop();
    if (cur0 !== null) { await lv.selectOption('#xCur', { index: 1 }); await lv.waitForTimeout(500); }
    const cur1 = await curTop();
    t.push(['b279: changing the currency leaves that field where it was, not where the last tap was (' + cur0 + ' → ' + cur1 + ')', cur0 !== null && Math.abs(cur1 - cur0) <= 2]);
    // b279: Finance adds a place that is not in the system, for Finance only.
    await lv.click('#xLocC .pp-in'); await lv.fill('#xLocC .pp-in', 'Hotel Sunrise'); await lv.waitForTimeout(200);
    t.push(['b279: in Where, Finance typing a new place is offered "＋ Add"', await lv.evaluate(() => /Add “Hotel Sunrise”/.test((document.querySelector('#xLocC .pp-add') || {}).textContent || ''))]);
    await lv.click('#xLocC .pp-add'); await lv.waitForTimeout(1500);
    t.push(['b279: …which adds it and chooses it', await lv.evaluate(() => /^fp_/.test(EXP.form.location) && /Hotel Sunrise/.test(document.querySelector('#xLocC .pp-in').value))]);
    await lv.click('#modal h3 .x'); await lv.waitForTimeout(300);
    t.push(['b279: …and it is not added to the sales side', await lv.evaluate(() => !JSON.stringify(STATE.locations || []).includes('Hotel Sunrise') && !JSON.stringify(STATE.events || []).includes('Hotel Sunrise'))]);
    await lv.evaluate(() => finGo('overview', '', {reload:true})); await lv.waitForTimeout(1500);
    await lv.click('#finPP .pp-in'); await lv.fill('#finPP .pp-in', 'Sunrise'); await lv.waitForTimeout(300);
    t.push(['b279: the Finance search finds it, marked "Finance only"', await lv.evaluate(() => [...document.querySelectorAll('#finPP .pp-row')].some(x => /Hotel Sunrise/.test(x.textContent) && /Finance only/.test(x.textContent)))]);
    await lv.evaluate(() => finGo('expenses', '', {reload:true})); await lv.waitForTimeout(1500);
    t.push(['b279: Expenses single lines show the original amount in its own grey column, the dollars beside it, all lined up', await lv.evaluate(() => {
      const rows = [...document.querySelectorAll('#finExS .fx-row')]; if (rows.length < 2) return false;
      const edge = sel => { const v = rows.map(r => r.querySelector(sel).getBoundingClientRect().right); return Math.max(...v) - Math.min(...v) <= 2; };
      const o = [...document.querySelectorAll('#finExS .fx-item .fx-o')];
      return edge('.fx-o') && edge('.fx-a') && getComputedStyle(o[0]).color === getComputedStyle(document.querySelector('#finExS .fx-d')).color
        && rows.slice(1).every(r => !/\(/.test(r.querySelector('.fx-a').textContent)); })]);
    await lv.evaluate(() => finGo('reimb', '', {reload:true})); await lv.waitForTimeout(1500);
    t.push(['b279: Reimbursement lines show it the same way, lined up', await lv.evaluate(() => {
      const rows = [...document.querySelectorAll('#finRbS .rb-item .li-row')]; if (!rows.length) return true;
      const e = sel => { const v = rows.map(r => { const x = r.querySelector(sel); return x ? x.getBoundingClientRect().right : 0; }); return Math.max(...v) - Math.min(...v) <= 2; };
      return e('.li-orig') && e('.li-amt'); })]);
    await lv.evaluate(() => openModal('<h3>Plain</h3><div class="m-body">x</div>')); await lv.waitForTimeout(100);
    t.push(['b278: every window gets its ✕', await lv.evaluate(() => !!document.querySelector('#modal h3 .x'))]);
    await lv.evaluate(() => closeModal()); await lv.waitForTimeout(300);
    t.push(['b274: Finance on live has Overview, Expenses and Reimbursements, no To do', await lv.evaluate(() => !document.querySelector('[data-sec="todo"]') && !!document.querySelector('[data-sec="expenses"]') && !!document.querySelector('[data-sec="reimb"]'))]);
    for (const w of [1150, 390]) { await lv.setViewportSize({ width: w, height: 1000 });
      for (const sec of ['overview', 'expenses', 'reimb', 'settings']) { await lv.evaluate(s => finGo(s, '', {reload:true}), sec); await lv.waitForTimeout(900);
        (await spill(lv)).forEach(x => lspill.push(w + ' ' + sec + ': ' + x)); } }
    t.push(['b274: no overflow on the live app\'s Finance either' + (lspill.length ? ' — ' + lspill.slice(0, 3).join(' | ') : ''), !lspill.length]);
    await lv.evaluate(() => finLeave()); await lv.waitForTimeout(400);
    await lv.evaluate(() => document.querySelector('[data-act="fincarry"]').click()); await lv.waitForTimeout(400);
    await lv.click('#fcGo'); await lv.waitForTimeout(600);
    t.push(['b274: with no practice sign-in on this device, it says to open practice first', /Open the practice space on this device and sign in/.test(await lv.$eval('#modalErr', e => e.textContent))]);
  } catch (e) { errors.push('test: ' + e.stack); }
  await browser.close();
  let bad = 0;
  t.forEach(([n, ok]) => { if (!ok) bad++; console.log((ok ? '  ok   ' : '  FAIL ') + n); });
  errors.forEach(e => console.log('  ERROR ' + e));
  console.log(bad || errors.length ? `\n${bad} failed, ${errors.length} errors` : `\nall ${t.length} passed`);
  process.exit(bad || errors.length ? 1 : 0);
})();
