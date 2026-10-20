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
  await O({ action: 'expSave', id: 'Xvan001', kind: 'record', date: '2026-10-19', desc: 'Van hire', amt: 20, cur: 'USD', location: 'ev_z1', category: 'Travel' });
  await O({ action: 'expSave', id: 'Xlunch01', kind: 'reimburse', date: '2026-10-18', desc: 'Lunch for helpers', amt: 30, cur: 'USD', location: 'ev_z1', category: 'Food',
    method: 'Cash', reimbCur: 'USD', payTo: { phone: '+385 99 1' } });

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
  const repText = page => page.$eval('#repText', e => e.value);
  try {
    const own = await open('owner@example.com', 'The Owner');
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
    t.push(['b259: the title stays Gross, showing what is in hand ($145), with a blue Expected Gross $185 beneath', /^Gross \$145 Expected Gross \$185$/.test((await tile(5)).trim())]);
    t.push(['…the Expected line is blue', await own.$eval('.fin-tile:nth-child(5) .fin-ex-l', e => getComputedStyle(e).color) === 'rgb(47, 111, 176)']);
    t.push(['b259: Expenses shows what was spent ($20), Expected Expenses $50 while Lunch is owed', /^Expenses \$20 Expected Expenses \$50$/.test((await tile(6)).trim())]);
    t.push(['Net is what came in less what went out, margin beneath, then Expected Net', /^Net \$125 Margin 86\.2% Expected Net \$135$/.test((await tile(7)).trim())]);
    // Athens has nothing owed: plain Gross, no subtitle.
    await own.click('#fpBody [data-act="fingo"][data-scope="rg_at"]'); await own.waitForTimeout(600);
    t.push(['nothing pending: the title is Gross and the subtitle goes', /^Gross \$40$/.test((await tile(5)).trim())]);
    // Zagreb's events, in the app's order.
    await own.evaluate(() => finGo('overview', 'rg_zg')); await own.waitForTimeout(600);
    m = await fpage(own);
    t.push(['Zagreb\'s events in the app\'s order: Kirtan before Fair', m.indexOf('Zagreb Kirtan') < m.indexOf('Zagreb Fair')]);
    // The search, before the dates, on the same line.
    const line = await own.evaluate(() => { const f = document.querySelector('#fpBody .fin-filters'); return [...f.children].map(c => c.className || c.tagName); });
    t.push(['a search field comes first on the date line', /fin-search/.test(line[0]) && line.length === 3]);
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
    t.push(['the Overview\'s 📋: its figures, in the same words', /^Big Books Sold - \$80\n   3 Sold \+ 1 Gift = 4 Distributed\nAdventures Sold - \$15\n   1 Sold\nDonations - \$10\nPending Payments - \$40\nGross - \$105\n   Expected Gross - \$145\nExpenses - \$20\n   Expected Expenses - \$50\nNet - \$85\n   Margin 81%\n   Expected Net - \$95$/.test(r)]);
    await own.evaluate(() => closeModal());
    await own.click('.fin-h3 [data-act="finrep"]'); await own.waitForTimeout(400);
    r = await repText(own);
    t.push(['the By Event 📋: each event, as the table', /^\*Zagreb Kirtan\*\nBig Books Sold - \$80/.test(r) && /\*Zagreb Fair\*/.test(r) && !/\*Total\*/.test(r)]);
    await own.evaluate(() => closeModal());
    await own.click('#reportBtn'); await own.waitForTimeout(400);
    r = await repText(own);
    t.push(['📋 Report at the top: the whole section, with headings', /^\*Zagreb · Kartika — Finance Overview\*\n\n\*OVERVIEW\*\nBig Books Sold/.test(r) && /\*BY EVENT\*/.test(r) && !/SALES BY TITLE/.test(r)]);
    await own.evaluate(() => closeModal());
    await own.click('[data-act="finsec"][data-sec="todo"]'); await own.waitForTimeout(1200);
    await own.click('.fp-h [data-act="finrep"]'); await own.waitForTimeout(400);
    r = await repText(own);
    t.push(['the To do\'s 📋: what is owed and the expenses', /\*Pending Payments\*\nSri Radha \(English\) - \$40/.test(r) && /\*Every Expense\*/.test(r) && /Van hire/.test(r)]);
    await own.evaluate(() => closeModal());
    t.push(['To do tabs read Pending Reimbursements / Pending Payments', /Pending Reimbursements/.test(await fpage(own)) && /Pending Payments/.test(await fpage(own))]);
    await own.click('[data-act="finsec"][data-sec="report"]'); await own.waitForTimeout(1200);
    await own.click('#reportBtn'); await own.waitForTimeout(400);
    r = await repText(own);
    t.push(['the top 📋 on Reports: the choices and the answer', /^\*Zagreb · Kartika — Finance Reports\*/.test(r) && /^Show .* · At Zagreb · Kartika/m.test(r) && /Big Books \d+ Sold \+ \d+ Gifts? = \d+ Distributed/.test(r) && /^Net - /m.test(r)]);
    await own.evaluate(() => closeModal());
    // Pencils on the Finance page and in its windows.
    await own.click('[data-act="finsec"][data-sec="overview"]'); await own.waitForTimeout(1200);
    await own.evaluate(() => { const b = document.createElement('button'); b.dataset.act = 'editwording'; document.body.appendChild(b); b.click(); b.remove(); }); await own.waitForTimeout(800);
    const pens = await own.evaluate(() => [...document.querySelectorAll('#finPage .pencil')].map(p => p.parentElement.textContent.replace('✏️', '').trim()));
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
    await own.click('#fpSecs [data-sec="report"] .pencil'); await own.waitForTimeout(300);
    t.push(['a button\'s pencil opens the same box, and the button does not fire', !!(await own.$('.lbl-in-box')) && !/#finance\/report/.test(own.url())]);
    await own.keyboard.type('Nope'); await own.keyboard.press('Escape'); await own.waitForTimeout(400);
    t.push(['Esc leaves it as it was', /Reports/.test(await own.$eval('#fpSecs [data-sec="report"]', b => b.textContent)) && !(await own.$('.lbl-in'))]);
    await own.evaluate(() => { const b = document.createElement('button'); b.dataset.act = 'editwording'; document.body.appendChild(b); b.click(); b.remove(); }); await own.waitForTimeout(500);
    /* ---- b254 round two: Expenses, Reimbursements, Visualize, the link ---- */
    await own.evaluate(() => finGo('expenses', 'rg_zg', {reload:true})); await own.waitForTimeout(1500);
    m = await fpage(own);
    t.push(['Expenses: the bar says Expenses $20 with Expected Expenses $50, while Lunch is owed', /Expenses\s*\$20\s*Expected Expenses \$50/.test(m) && /Reimbursements Due\s*\$30/.test(m)]);
    t.push(['b259: the Reimbursements Due total sits over the Reimbursements section', await own.evaluate(() => !!document.querySelector('#finRbS') && /Reimbursements Due/.test(document.querySelector('#finRbS').innerText) && !/Reimbursements Due/.test(document.querySelector('#finExS').innerText))]);
    t.push(['b259: "Add an expense" and "Send Reimbursements Link" are small buttons on the right of each title row', await own.evaluate(() => {
      const ok = (sel, btn) => { const h = document.querySelector(sel + ' .fin-sh'), b = h && h.querySelector(btn); if(!b) return false;
        const hr = h.getBoundingClientRect(), br = b.getBoundingClientRect(); return Math.abs(hr.right - br.right) < 4 && br.top < hr.bottom && br.height < 34; };
      return ok('#finExS', '[data-act="expenses"]') && ok('#finRbS', '[data-act="finsendlink"]') && !document.querySelector('#fsName'); })]);
    t.push(['b259: no Add an expense or Edit Wording on the Finance bar; the way out says Go to Sales Portal', await own.evaluate(() => {
      const bar = document.querySelector('#fpSecs').innerText; return !/Add an expense|Edit Wording/.test(bar) && /Go to Sales Portal/.test(document.querySelector('#finPage').innerText) && !/Back to app/.test(document.querySelector('#finPage').innerText); })]);
    const order = () => own.$$eval('.fin-ex tbody tr td:nth-child(2)', ts => ts.map(x => x.firstChild.textContent.trim()));
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
    t.push(['b255: Expenses and Reimbursements are one page, one button on the bar', /Expenses & Reimbursements/.test(await own.$eval('#fpSecs', e => e.innerText)) && !(await own.$('#fpSecs [data-sec="reimb"]'))]);
    await own.click('[data-act="finrbtab"][data-tab="pending"]'); await own.waitForTimeout(800);
    m = await fpage(own);
    const rbs = await own.$eval('#finRbS', e => e.innerText);
    t.push(['Reimbursements: Lunch is pending, with the same bar', /Lunch for helpers/.test(rbs) && /Reimbursements Due\s*\$30/.test(m) && !/Van hire/.test(rbs)]);
    t.push(['b257: Expenses and Reimbursements are two sections side by side, Expenses on the left half', await own.evaluate(() => {
      const a = document.querySelector('#finExS').getBoundingClientRect(), b = document.querySelector('#finRbS').getBoundingClientRect();
      return a.right <= b.left && Math.abs(a.width - b.width) < 30 && /Van hire/.test(document.querySelector('#finExS').innerText); })]);
    t.push(['…Paid back and Declined are separate tabs', !!(await own.$('[data-act="finrbtab"][data-tab="paid"]')) && !!(await own.$('[data-act="finrbtab"][data-tab="declined"]'))]);
    t.push(['…the note for the record is written in the Pay back part of the card', !!(await own.$('#finRbS .exp-pb [data-pbnote="Xlunch01"]'))]);
    t.push(['…Reimbursement Settings is inside it, not on the bar', /⚙️ Settings/.test(m) && !/Reimbursement Settings/.test(await own.$eval('#fpSecs', e => e.innerText))]);
    await own.click('[data-act="finrbtab"][data-tab="settings"]'); await own.waitForTimeout(1200);
    t.push(['…its Where is a searchable drop-down', !!(await own.$('#rsPlaceC .pp-in')) && /By place/.test(await fpage(own))]);
    // b257: a way of paying back can be removed for good, and brought back.
    const ways = () => own.$$eval('.rs-row > span', ss => ss.map(x => x.textContent.trim()));
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
    t.push(['…and the Links tab lists it as sent to Bhima, not used yet', /Sent to Bhima · \+385 98 7654 · not used yet/.test(m)]);
    // Someone not in the app opens it: no sign-in, only the form.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const fxAsked = [];
    const pub = await ctx.newPage();
    pub.on('pageerror', e => errors.push('public: ' + e.message));
    await ctx.route('**/*', async route => {
      const req = route.request(), u = req.url();
      if (u.startsWith(API)) return route.fulfill({ status: 200, contentType: 'application/json', body: await srv.request({ postData: { contents: req.postData() || '{}' } }), headers: { 'Access-Control-Allow-Origin': '*' } });
      // b259: the day's exchange rate, as the European Central Bank gives it.
      if (/frankfurter\.dev\/v1\/\d{4}-\d\d-\d\d\?base=EUR&symbols=USD/.test(u)) { fxAsked.push(u); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ amount: 1, base: 'EUR', date: u.match(/v1\/([\d-]+)/)[1], rates: { USD: 1.1 } }), headers: { 'Access-Control-Allow-Origin': '*' } }); }
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
    await pub.check('[data-same="phone"]'); await pub.waitForTimeout(300);
    t.push(['…ticking it fills in the number from above, and it cannot be typed over', await pub.$eval('[data-payto="phone"]', i => i.value === '+385 98 7' && i.readOnly) && await pub.$eval('#xAmt', e => e.value) === '12']);
    // b255: a second one in the same form, then check them both before sending.
    await pub.click('#xMore'); await pub.waitForTimeout(400);
    m = await pub.evaluate(() => document.querySelector('#modal').innerText);
    t.push(['"Add another expense" keeps the first in a list and starts the next', /Added so far\s*1/i.test(m) && /Parking at the fair/.test(m) && await pub.$eval('#xAmt', e => e.value) === '']);
    t.push(['…keeping how to be paid back', await pub.$eval('#xMethod', e => e.value) === 'Cash']);
    await pub.fill('#xAmt', '8'); await pub.fill('#xDesc', 'Tea for the volunteers');
    // b259: spent in euros, to be paid back in dollars.
    await pub.selectOption('#xCur', 'EUR'); await pub.waitForTimeout(200);
    if (await pub.$('#xRCur')) await pub.selectOption('#xRCur', 'USD');
    t.push(['…and Save becomes "Review all 2 expenses"', /Review all 2 expenses/.test(await pub.$eval('#xSave', e => e.textContent))]);
    await pub.click('#xSave'); await pub.waitForTimeout(500);
    m = await pub.evaluate(() => document.querySelector('#modal').innerText);
    t.push(['the review shows both, with the total, before anything is sent', /Check your expenses/i.test(m) && /Parking at the fair/.test(m) && /Tea for the volunteers/.test(m) && /\$12/.test(m) && /8 €|€8/.test(m)]);
    t.push(['b259: euros paid back in dollars show what to pay at that day\'s rate', fxAsked.length > 0 && /To pay back: \$8\.80 \(1 EUR = 1\.1 USD on \d{4}-\d\d-\d\d\)/.test(m)]);
    await pub.screenshot({ path: shot('review') });
    await pub.click('#xrBack'); await pub.waitForTimeout(300);
    t.push(['…"Back" returns to the form as it was', await pub.$eval('#xDesc', e => e.value) === 'Tea for the volunteers']);
    await pub.click('#xSave'); await pub.waitForTimeout(400);
    await pub.click('#xrGo'); await pub.waitForTimeout(2500);
    m = await pub.evaluate(() => document.querySelector('#modal').innerText);
    t.push(['sent: "received and will be processed at the earliest convenience", both listed', /2 expenses have been received and will be processed at the earliest convenience/.test(m) && /Tea for the volunteers/.test(m)]);
    t.push(['b259: the confirmation shows the dollars too', /To pay back: \$8\.80/.test(m)]);
    t.push(['…with no "Send in another": the link was for one', !(await pub.$('#rpAnother'))]);
    t.push(['…and Done and × leave for travelingmonk.com', await pub.$eval('#modal .m-foot a', a => a.href).catch(() => '') === 'https://travelingmonk.com/' && !!(await pub.$('#modal h3 a.x'))]);
    await pub.screenshot({ path: shot('public') });
    await pub.goto(url); await pub.waitForTimeout(1500);
    t.push(['opened again, the link says it has been used', /already been used/.test(await pub.evaluate(() => document.querySelector('#modal').innerText))]);
    await ctx.close();
    await own.evaluate(() => { FIN.rb.tab = 'pending'; finGo('reimb', 'rg_zg', {reload:true}); }); await own.waitForTimeout(1500);
    m = await fpage(own);
    t.push(['…it lands in Pending, with Other: Parking and how to reach Bhima', /Parking at the fair/.test(m) && /Other: Parking/.test(m) && /\+385 98 7/.test(m)]);
    t.push(['b257: Bhima\'s two, paid back the same way, are one square with one total', await own.evaluate(() => {
      const g = [...document.querySelectorAll('#finRbS .exp-group')].find(e => /Bhima/.test(e.innerText));
      return !!g && /Parking at the fair/.test(g.innerText) && /Tea for the volunteers/.test(g.innerText) && /\$20\.80/.test(g.querySelector('.exp-top').innerText) && /Pay back all 2/.test(g.innerText) && /To pay back: \$8\.80/.test(g.innerText); })]);
    // b259: each line can be accepted or declined; the total follows.
    await own.evaluate(() => { const g = [...document.querySelectorAll('#finRbS .exp-group')].find(e => /Bhima/.test(e.innerText));
      const row = [...g.querySelectorAll('[data-act="rbline"][data-on=""]')].find(b => /Parking/.test(b.closest('.exp-line, .exp-li, div').parentElement.innerText)) || g.querySelector('[data-act="rbline"][data-on=""]'); row.click(); }); await own.waitForTimeout(500);
    t.push(['b259: declining one line takes it off the total', await own.evaluate(() => { const g = [...document.querySelectorAll('#finRbS .exp-group')].find(e => /Bhima/.test(e.innerText));
      return /2 expenses · 1 turned down/.test(g.innerText) && /Pay back 1 of 2 · \$8\.80/.test(g.innerText) && /^\$8\.80$/m.test(g.querySelector('.exp-top').innerText); })]);
    await own.evaluate(() => { FIN.rbNo.clear(); finReimbRender(); }); await own.waitForTimeout(300);
    t.push(['…with a one-tap WhatsApp confirmation, ready written', /received%20and%20will%20be%20processed/.test(await own.$eval('#fpBody a[href^="https://wa.me/385987"]', a => a.href))]);
    await own.click('[data-act="finsec"][data-sec="visual"]'); await own.waitForTimeout(1500);
    t.push(['Visualize: a pie of expenses by type, with the figures beside it', (await own.$$('.fin-pie path')).length === 3 && /Food/.test(await fpage(own)) && /Total Expenses/.test(await fpage(own))]);
    await own.click('[data-act="finviz"][data-form="bar"]'); await own.waitForTimeout(300);
    t.push(['…or as bars', (await own.$$('.fin-bar')).length === 3]);
    await own.screenshot({ path: shot('visual') });
    await own.click('#reportBtn'); await own.waitForTimeout(400);
    r = await repText(own);
    t.push(['the top 📋 on Visualize reports the types', /Food - \$30/.test(r) && /Total Expenses - \$62/.test(r)]);
    await own.evaluate(() => closeModal());
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
    const phone = await open('owner@example.com', 'The Owner', 390);
    await phone.evaluate(() => finGo('overview', 'rg_zg')); await phone.waitForTimeout(1500);
    t.push(['phone width: no sideways scroll on the page', await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)]);
    await phone.screenshot({ path: shot('fin-phone'), fullPage: true });
    await own.setViewportSize({ width: 1150, height: 1000 });
    await own.evaluate(() => finGo('overview', 'rg_zg')); await own.waitForTimeout(800);
    await own.screenshot({ path: shot('fin-overview'), fullPage: true });
  } catch (e) { errors.push('test: ' + e.stack); }
  await browser.close();
  let bad = 0;
  t.forEach(([n, ok]) => { if (!ok) bad++; console.log((ok ? '  ok   ' : '  FAIL ') + n); });
  errors.forEach(e => console.log('  ERROR ' + e));
  console.log(bad || errors.length ? `\n${bad} failed, ${errors.length} errors` : `\nall ${t.length} passed`);
  process.exit(bad || errors.length ? 1 : 0);
})();
