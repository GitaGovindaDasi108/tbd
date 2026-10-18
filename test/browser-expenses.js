/* Optional, needs Playwright + Chromium: node test/browser-expenses.js
   b238: expenses in the real page, against the real server code
   (server/src/core.js) in this process, with a stand-in Google sign-in.
   A Seller records one to be paid back by UPI, with a photo of the receipt;
   Finance (who cannot use the rest of the app yet) finds it in the Finance
   To do, opens the receipt, pays it back, records one on someone's behalf,
   and switches UPI off — after which the Seller is no longer offered it.
   All of it in the practice space, where expenses are tried first: Record
   Costs opens the same form, the Finance section adds everything up, and
   Universal can view the app as anyone (App Development › View as). */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });
const shot = n => path.join(os.tmpdir(), 'tbs-expenses-' + n + '.png');
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

  // Delhi, with the Chowpatty program; Sita sells there; Madhava is Finance.
  const owner = await sessionOf('owner@example.com', 'The Owner');
  const O = p => ask(Object.assign({ s: owner }, p));
  await O({ action: 'saveSeason', name: 'Kartika' });
  const SA = (await O({ action: 'getState' })).state.activeSeason;
  await O({ action: 'createRegion', regionId: 'rg_in', whLoc: 'wh_in', name: 'Delhi', currencies: 'INR,USD', season: SA });
  await O({ action: 'createEvent', eventId: 'ev_cp', name: 'Chowpatty Program', regionId: 'rg_in', season: SA });
  await O({ action: 'setPayTypes', kind: 'region', id: 'rg_in', types: ['Cash', 'UPI', 'Card'], season: SA });
  await O({ action: 'peopleAdd', email: 'sita@example.com', name: 'Sita', role: 'S', placeId: 'ev_cp' });
  await O({ action: 'peopleAdd', email: 'fin@example.com', name: 'Madhava', role: 'F', placeId: '' });
  const B = (await O({ action: 'getState' })).state.books.filter(b => !b.partnerId).map(b => b.id);
  await O({ action: 'adjustStockBulk', location: 'ev_cp', items: [{ bookId: B[0], delta: 10 }], override: true, season: SA });
  await O({ action: 'sell', saleId: 'sP1', location: 'ev_cp', bookId: B[0], pending: true, name: 'Arjuna', phone: '+91 22 1234',
    legs: [{ type: 'UPI', cur: 'INR', amt: 300 }], season: SA });

  // A receipt photo: a real PNG, drawn here.
  const png = path.join(os.tmpdir(), 'tbs-receipt.png');
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

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
  const modal = page => page.evaluate(() => document.querySelector('#modal').innerText);

  try {
    /* ---- A Seller records an expense to be paid back ---- */
    const sita = await open('sita@example.com', 'Sita');
    const menu = await sita.evaluate(() => [...document.querySelectorAll('#sideNav .sn-item')].map(b => b.innerText.trim()).join('|'));
    t.push(['a Seller has Expenses in the menu', /Expenses/.test(menu)]);
    t.push(['…but not the Finance To do', !/Finance To do/.test(menu)]);
    await sita.evaluate(() => document.querySelector('#sideNav [data-act="expenses"]').click());
    await sita.waitForTimeout(800);
    let m = await modal(sita);
    t.push(['the form asks record-keeping or reimbursement', /For record-keeping/.test(m) && /For reimbursement/.test(m)]);
    t.push(['…for her event', /Chowpatty Program · Delhi · Kartika/.test(m)]);
    t.push(['…the currency starts at rupees, the region\'s own', await sita.$eval('#xCur', s => s.value) === 'INR']);
    t.push(['…the date starts at today', await sita.$eval('#xDate', i => i.value) === new Date().toISOString().slice(0, 10)]);
    const methods = await sita.$$eval('#xMethod option', os => os.map(o => o.value).filter(Boolean));
    t.push(['…ways of paying back: cash, UPI, bank transfer; never card', methods.includes('Cash') && methods.includes('UPI') && methods.includes('Bank transfer') && !methods.includes('Card')]);
    await sita.fill('#xAmt', '450'); await sita.fill('#xDesc', 'Taxi with the book boxes');
    await sita.selectOption('#xMethod', 'Cash'); await sita.waitForTimeout(200);
    t.push(['choosing cash asks for a phone number', /Phone or WhatsApp number/i.test(await modal(sita))]);
    await sita.selectOption('#xMethod', 'UPI'); await sita.waitForTimeout(200);
    m = await modal(sita);
    t.push(['choosing UPI asks for the UPI ID instead', /UPI ID/i.test(m) && !/WhatsApp/i.test(m)]);
    t.push(['…what was typed is kept as the form changes', await sita.$eval('#xAmt', i => i.value) === '450' && await sita.$eval('#xDesc', i => i.value) === 'Taxi with the book boxes']);
    await sita.setInputFiles('#xFiles', png); await sita.waitForTimeout(1200);
    m = await modal(sita);
    t.push(['a receipt photo is added and sent', /tbs-receipt\.jpg/.test(m) && !/sending/.test(m)]);
    await sita.click('#xSave'); await sita.waitForTimeout(500);
    t.push(['saving without the UPI ID is refused, with the reason', /UPI ID is needed/.test(await sita.$eval('#modalErr', e => e.innerText))]);
    await sita.fill('[data-payto="upi"]', 'sita@okbank'); await sita.fill('#xNotes', 'Two trips');
    await sita.click('#xSave'); await sita.waitForTimeout(1200);
    m = await modal(sita);
    t.push(['saved: it is in her list, waiting to be paid back', /Your expenses/i.test(m) && /Taxi with the book boxes/.test(m) && /Waiting to be paid back/.test(m)]);
    t.push(['…with how to pay her and the receipt', /sita@okbank/.test(m) && /tbs-receipt\.jpg/.test(m)]);
    await sita.screenshot({ path: shot('seller') });
    // Record-keeping only: no way of paying back is asked.
    await sita.click('.exp-k:has(input[value="record"])'); await sita.waitForTimeout(200);
    t.push(['record-keeping asks no way of paying back', !(await sita.$('#xMethod'))]);
    await sita.fill('#xAmt', '40'); await sita.fill('#xDesc', 'Packing tape');
    await sita.click('#xSave'); await sita.waitForTimeout(1200);
    t.push(['…and is recorded', /Packing tape/.test(await modal(sita)) && /Recorded/.test(await modal(sita))]);
    // The next one remembers her UPI ID.
    await sita.selectOption('#xMethod', 'UPI'); await sita.waitForTimeout(200);
    t.push(['her UPI ID is remembered on this phone for next time', await sita.$eval('[data-payto="upi"]', i => i.value) === 'sita@okbank']);

    /* ---- Finance ---- */
    const fin = await open('fin@example.com', 'Madhava');
    let na = await fin.evaluate(() => (document.querySelector('#noAccess') || {}).innerText || '');
    t.push(['Finance (no rest-of-app view yet) gets Expenses and the Finance To do on its page', /Not quite yet/.test(na) && /Expenses/.test(na) && /Finance To do/.test(na) && /Reimbursement Settings/.test(na)]);
    await fin.click('#noAccess [data-act="fintodo"]'); await fin.waitForTimeout(1000);
    m = await modal(fin);
    t.push(['the Finance To do opens above that page', await fin.evaluate(() => { const o = document.querySelector('#overlay'); return o.classList.contains('show') && Number(getComputedStyle(o).zIndex) > 9999; })]);
    t.push(['…reimbursements pending: Sita\'s taxi, with her UPI ID', /Reimbursements pending\s*1/.test(m) && /Taxi with the book boxes/.test(m) && /sita@okbank/.test(m)]);
    t.push(['…the record-keeping one is not on it', !/Packing tape/.test(m)]);
    t.push(['…the amount to pay back is added up', /To pay back:\s*₹450/.test(m)]);
    await fin.click('.exp-rc [data-act="rcptopen"]'); await fin.waitForTimeout(800);
    t.push(['Finance opens the receipt', await fin.evaluate(() => { const v = document.querySelector('#rcptView'); return !!v && !v.hidden && !!v.querySelector('img') && v.querySelector('img').naturalWidth > 0; })]);
    await fin.click('#rcptView [data-rcclose]');
    await fin.click('[data-act="fintab"][data-tab="pay"]'); await fin.waitForTimeout(300);
    m = await modal(fin);
    t.push(['…payments pending across the system: Arjuna owes 300 rupees, with his phone', /Payments pending\s*1/.test(m) && /Arjuna/.test(m) && /300/.test(m) && /\+91 22 1234/.test(m) && /Chowpatty Program · Delhi · Kartika/.test(m)]);
    await fin.click('[data-act="fintab"][data-tab="reimb"]'); await fin.waitForTimeout(300);
    await fin.click('[data-act="exppaid"]'); await fin.waitForTimeout(1000);
    m = await modal(fin);
    t.push(['Finance marks it paid back: it leaves the list', /Nothing waiting to be paid back/.test(m)]);
    await fin.click('[data-act="fintab"][data-tab="all"]'); await fin.waitForTimeout(300);
    m = await modal(fin);
    t.push(['…and every expense shows it paid back, with the reference', /Paid back by Madhava/.test(m) && /UPI ref 4471/.test(m) && /Packing tape/.test(m)]);
    await fin.screenshot({ path: shot('finance') });

    // On Sita's behalf, found by typing part of her name.
    await fin.click('.m-foot [data-act="expenses"]'); await fin.waitForTimeout(1000);
    await fin.click('#xFor .pp-in'); await fin.fill('#xFor .pp-in', 'sit'); await fin.waitForTimeout(200);
    const rows = await fin.$$eval('#xFor .pp-row', rs => rs.map(r => r.innerText));
    t.push(['Finance\'s "Whose expense?" list narrows as a name is typed', rows.length === 1 && /Sita/.test(rows[0])]);
    await fin.click('#xFor .pp-row'); await fin.waitForTimeout(800);
    await fin.selectOption('#xLoc', 'ev_cp'); await fin.waitForTimeout(600);
    await fin.fill('#xAmt', '120'); await fin.fill('#xDesc', 'Chai for the helpers');
    await fin.selectOption('#xMethod', 'Cash'); await fin.waitForTimeout(200);
    await fin.fill('[data-payto="phone"]', '+91 98 0000');
    await fin.click('#xSave'); await fin.waitForTimeout(1200);
    const sitaList = (await ask({ s: await sessionOf('sita@example.com', 'Sita'), action: 'expList' })).result;
    t.push(['…the expense recorded for Sita is in her own list', sitaList.some(x => x.desc === 'Chai for the helpers' && x.forName === 'Sita' && x.byName === 'Madhava')]);

    // Settings: UPI off everywhere.
    await fin.evaluate(() => reimbSettingsModal()); await fin.waitForTimeout(800);
    m = await modal(fin);
    t.push(['Reimbursement Settings: by place and by person', /By place/.test(m) && /By person/.test(m) && /UPI/.test(m)]);
    await fin.selectOption('[data-rsm="UPI"]', 'off'); await fin.click('#rsSave'); await fin.waitForTimeout(800);
    await fin.selectOption('#rsPlace', 'rg_in'); await fin.waitForTimeout(200);
    t.push(['…a region below shows UPI off, from above', /As above \(off\)/.test(await fin.$eval('[data-rsm="UPI"] option', o => o.textContent))]);
    await fin.screenshot({ path: shot('settings') });
    await sita.evaluate(() => expensesModal()); await sita.waitForTimeout(1000);
    const methods2 = await sita.$$eval('#xMethod option', os => os.map(o => o.value).filter(Boolean));
    t.push(['the Seller is no longer offered UPI', !methods2.includes('UPI') && methods2.includes('Cash')]);

    /* ---- On a phone ---- */
    const phone = await open('sita@example.com', 'Sita', 390);
    await phone.evaluate(() => expensesModal()); await phone.waitForTimeout(1000);
    t.push(['on a phone the form fits (no sideways scroll)', await phone.evaluate(() => document.querySelector('#modal').scrollWidth <= document.querySelector('#modal').clientWidth + 1)]);
    await phone.screenshot({ path: shot('phone'), fullPage: true });

    /* ---- The owner ---- */
    const own = await open('owner@example.com', 'The Owner');
    const snText = () => own.evaluate(() => [...document.querySelectorAll('#sideNav [data-act]')].map(b => b.dataset.act).join('|'));
    const omenu = await snText();
    t.push(['Universal has Expenses, Finance To do and Reimbursement Settings', /\bexpenses\b/.test(omenu) && /fintodo/.test(omenu) && /reimbset/.test(omenu)]);
    t.push(['…a Finance section: Overview, Reports, Compare', /finoverview/.test(omenu) && /finreport/.test(omenu) && /fincompare/.test(omenu)]);
    t.push(['…View as in App Development', /viewas/.test(omenu)]);
    t.push(['…and no separate Record Costs (it is the Expenses form now)', !/\bcosts\b/.test(omenu)]);

    // Record Costs, merged: the same form, with the kind of expense and how it was paid.
    await own.evaluate(() => expensesModal()); await own.waitForTimeout(1000);
    const cats = await own.$$eval('#xCat option', os => os.map(o => o.value));
    t.push(['the form has the kinds of expense from Record Costs (card machine fee, venue…)', cats.includes('Card machine fee') && cats.includes('Venue')]);
    await own.selectOption('#xLoc', 'ev_cp'); await own.waitForTimeout(600);
    await own.click('.exp-k:has(input[value="record"])'); await own.waitForTimeout(200);
    t.push(['…and "Paid with" (the place\'s payment types), as Record Costs had', !!(await own.$('#xPay'))]);
    await own.selectOption('#xCat', 'Venue'); await own.fill('#xAmt', '800'); await own.fill('#xDesc', 'Hall hire');
    await own.click('#xSave'); await own.waitForTimeout(1500);
    const st = (await O({ action: 'getState', season: SA })).state;
    t.push(['…saved: the venue expense is also a cost at the event, so net totals take it off', (st.costs || []).some(c => c.location === 'ev_cp' && Number(c.amt) === 800 && c.category === 'Venue')]);

    // The Finance section.
    await own.evaluate(() => financeModal('overview')); await own.waitForTimeout(1500);
    m = await modal(own);
    t.push(['Finance › Overview: figures in dollars', /Gross sales/i.test(m) && /Collections/i.test(m) && /Net/i.test(m) && /Margin/i.test(m)]);
    t.push(['…pending payments: Arjuna\'s ₹300 is $3.75', /Pending payments\s*\$3\.75/i.test(m)]);
    t.push(['…expenses: ₹450 + ₹40 + ₹120 + ₹800 = $17.63', /Expenses\s*\$17\.63/i.test(m)]);
    t.push(['…pending reimbursements: the ₹120 chai, $1.50', /Pending reimbursements\s*\$1\.5/i.test(m)]);
    t.push(['…at every level: the season row', /Kartika/.test(m)]);
    await own.click('[data-act="finopen"][data-key^="s:"]'); await own.waitForTimeout(300);
    await own.click('[data-act="finopen"][data-key^="r:"]'); await own.waitForTimeout(300);
    m = await modal(own);
    t.push(['…opening the season and region shows Delhi and the Chowpatty Program', /Delhi/.test(m) && /Chowpatty Program/.test(m)]);
    t.push(['…the window is wide, and scrolls its table rather than the page', await own.evaluate(() => document.querySelector('#modal').classList.contains('fin-wide'))]);
    await own.screenshot({ path: shot('fin-overview') });
    await own.click('[data-act="fintab2"][data-tab="report"]'); await own.waitForTimeout(400);
    await own.selectOption('[data-rd="0"]', 'category'); await own.waitForTimeout(400);
    m = await modal(own);
    t.push(['Reports: rows by kind of expense', /Venue/.test(m) && /Total \(\d+ rows?\)/.test(m)]);
    await own.selectOption('[data-rd="0"]', 'title'); await own.waitForTimeout(400);
    m = await modal(own);
    t.push(['…by title, with books sold', /Books sold/i.test(m) && /\(English\)|\(no title\)|\w/.test(m)]);
    const [dl] = await Promise.all([own.waitForEvent('download'), own.click('[data-act="fincsv"]')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    t.push(['…downloads as a CSV for Excel or Sheets', /^﻿?Title,/.test(csv) && /Total/.test(csv)]);
    await own.screenshot({ path: shot('fin-report') });
    await own.click('[data-act="fintab2"][data-tab="compare"]'); await own.waitForTimeout(400);
    m = await modal(own);
    t.push(['Compare: seasons of the same name side by side, added up', /Kartika/.test(m) && /All together/i.test(m) && /Average/i.test(m)]);
    await own.evaluate(() => closeModal());

    // View as: a Seller at the Chowpatty Program.
    await own.evaluate(() => viewAsModal()); await own.waitForTimeout(800);
    m = await modal(own);
    t.push(['View as lists the people, with their roles', /Sita/.test(m) && /Madhava/.test(m)]);
    await own.selectOption('#vaRole', 'S'); await own.waitForTimeout(200);
    await own.selectOption('#vaPlace', 'ev_cp');
    await Promise.all([own.waitForNavigation(), own.click('#vaGo')]); await own.waitForTimeout(2500);
    const bar = await own.evaluate(() => (document.querySelector('#viewAsBar') || {}).innerText || '');
    t.push(['…viewing as a Seller: the bar says so', /Viewing the app as\s*Seller · Chowpatty Program/i.test(bar)]);
    const vmenu = await snText();
    t.push(['…and the menu is a Seller\'s: Expenses, no Finance, no View as', /\bexpenses\b/.test(vmenu) && !/fintodo|finoverview|viewas/.test(vmenu)]);
    await own.screenshot({ path: shot('viewas') });
    await Promise.all([own.waitForNavigation(), own.click('#viewAsBar [data-act="viewstop"]')]); await own.waitForTimeout(2500);
    t.push(['Stop viewing: back to Universal', !(await own.$('#viewAsBar')) && /finoverview/.test(await snText())]);
  } catch (e) { errors.push('test: ' + (e.stack || e.message)); }
  await browser.close();

  t.push(['no errors on the pages', !errors.length]);
  if (errors.length) console.log(errors.join('\n'));
  let bad = 0;
  t.forEach(([n, ok]) => { if (!ok) bad++; console.log((ok ? '  ok  ' : '  FAIL ') + n); });
  console.log(bad ? bad + ' of ' + t.length + ' failed' : 'browser-expenses: all ' + t.length + ' passed');
  console.log('Screenshots: ' + shot('*'));
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
