/* Optional, needs Playwright + Chromium: node test/browser-b312.js
   b312 (Live app changes): totals bar gifts layout; Stock Title Order apart
   from the shelf's; Change Prices without tick boxes, only titles sold there;
   the expense form's count and "Submit"; the "You will receive" wording;
   "Expenses and Reimbursements" back to "Expenses". */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){ return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
m.init();
const st = m.call({ action: 'getState' }).state, SA = st.activeSeason;
const c = (p, season) => { const r = m.call(Object.assign({ season: season || SA }, p)); if (!r.ok) throw new Error(p.action + ': ' + r.error); return r; };
const R0 = st.regions[0], R0name = R0.name;
const B = st.books.find(b => !b.partnerId && (b.cat || 'big') === 'big').id;
c({ action: 'adjustStockBulk', location: R0.whLoc, items: [{ bookId: B, delta: 10 }], override: true });
c({ action: 'createEvent', eventId: 'ev_b311', name: 'Book Fair', regionId: R0.regionId });
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1150, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.includes('script.google.com')) {
      let p = {}; try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(m.call(p)) });
    }
    if (url.startsWith('http://app.test/')) {
      const rel = new URL(url).pathname.replace(/^\/+/, '') || 'index.html';
      if (rel === 'config.js') return route.fulfill({ status: 200, contentType: 'text/javascript',
        body: fs.readFileSync(path.join(__dirname, 'config.test.js'), 'utf8').replace('CLASSIC_ADMIN: true', 'CLASSIC_ADMIN: false, PRACTICE_URL: "https://script.google.com/macros/s/TEST/exec"') });
      const f = path.join(ROOT, rel);
      if (fs.existsSync(f) && fs.statSync(f).isFile())
        return route.fulfill({ status: 200, body: fs.readFileSync(f),
          contentType: f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : undefined });
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  const t = [];
  const RATES = { USD: 1, EUR: 0.9, PLN: 4, GBP: 0.8, INR: 88, MKD: 55 };
  const rates = () => page.evaluate(R => { STATE.rates = Object.assign({}, STATE.rates, { perUsd: R }); }, RATES);
  const ovf = () => page.evaluate(() => { const W = document.documentElement.clientWidth, mb = document.querySelector('#modal .m-body');
    const r = mb ? mb.getBoundingClientRect().right : W;
    return [...document.querySelectorAll('#modal *')].filter(e => e.offsetParent && (e.getBoundingClientRect().right > W + 1 || e.getBoundingClientRect().right > r + 1)).length; });
  try {
    await page.goto('http://app.test/index.html'); await page.waitForTimeout(2500); await rates();
    const R0id = await page.evaluate(() => STATE.regions.find(r => r.regionId !== HQ_REGION).regionId);

    /* 1. Totals bar: "+2 gifts =" then "5 distributed"; other cards unchanged. */
    t.push(['totals bar gifts: "+2 gifts =" then "5 distributed"', await page.evaluate(() => giftNote({ gift: 2, sold: 3 }, true) === '+2 gifts =<br><b class="dist-n">5 distributed</b>' && giftNote({ gift: 2, sold: 3 }) === '+2 gifts = <b class="dist-n">5 distributed</b>')]);

    /* 2. Stock Title Order: its own order, not the shelf's. */
    const so = await page.evaluate(async R0id => {
      const ctx = () => Object.assign(makeStockCtx({kind:'region', seasonId:STATE.activeSeason, regionId:R0id, loc:STATE.regions.find(r=>r.regionId===R0id).whLoc}, ''), {staged:[]});
      const keys = () => stockTitles(ctx()).filter(x => !x.partnerId).map(x => x.key);
      const before = keys();
      await MY_ORDER.set(before.map(k => stockTitles(ctx()).find(x => x.key === k).books[0].id).reverse());
      const shelfOnly = keys();
      await MY_ORDER.set([]);
      goTo('region', R0id); const inMenu = !!document.querySelector('[data-act="stockorder"]');
      stockOrderModal(); await new Promise(r => setTimeout(r, 200));
      const rows = [...document.querySelectorAll('#soList .ro-row')].map(r => r.dataset.id);
      // Move the second Big Book title to the top with its arrow, then save.
      const up = document.querySelectorAll('#soList .so-grp[data-cat="big"] [data-so-up]')[1]; const moved = up.dataset.soUp; up.click();
      document.querySelector('#soSave').click(); await new Promise(r => setTimeout(r, 300));
      const after = keys();
      return { before, shelfOnly, inMenu, rows: rows.length, moved, after };
    }, R0id).catch(e => ({ err: e.message }));
    t.push(['the shelf\'s ⇅ Arrange order no longer changes the stock drop-downs' + (so.err ? ' — ' + so.err : ''), !so.err && so.shelfOnly.join() === so.before.join()]);
    t.push(['"⇅ Stock Title Order" in the menu, listing every title', !so.err && so.inMenu && so.rows > 2]);
    t.push(['moving a title there puts it first in Add Stock (' + (so.after || [])[0] + ')', !so.err && so.after[0] === so.moved]);
    t.push(['…at Earthly HQ too', await page.evaluate(async () => { await switchSeason(HQ_ID); goTo('region', HQ_REGION); const ok = !!document.querySelector('[data-act="stockorder"]'); await switchSeason(STATE.seasons.find(s => s.seasonId !== HQ_ID).seasonId); return ok; })]);
    await page.waitForTimeout(800); await rates();

    /* 3. Change Prices: no tick boxes, only the titles sold there. */
    const B2 = await page.evaluate(R0id => { const ids = STATE.books.filter(b => !b.partnerId).map(b => b.id); return ids.slice(0, 2); }, R0id);
    c({ action: 'editRegion', regionId: R0id, name: R0name, currencies: 'EUR,USD', books: B2.join(','), prices: {} });
    await page.evaluate(() => pull()); await page.waitForTimeout(1500); await rates();
    const cp = await page.evaluate(async R0id => { goTo('region', R0id); pricesModal(); await new Promise(r => setTimeout(r, 300));
      const o = { cb: document.querySelectorAll('#modal .bk-cb').length, rows: [...new Set([...document.querySelectorAll('#modal .rp[data-book]')].map(i => i.dataset.book))] }; return o; }, R0id);
    t.push(['Change Prices: no tick boxes, only the 2 titles sold there (' + cp.rows.length + ')', cp.cb === 0 && cp.rows.length === 2 && cp.rows.every(id => B2.includes(id))]);
    await page.evaluate(() => { const i = document.querySelector('#modal .rp[data-cur="EUR"][data-book]'); i.value = '21'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#ppSave').click(); });
    await page.waitForTimeout(1500);
    const sv = m.call({ action: 'getState', season: SA }).state, rr = sv.regions.find(r => r.regionId === R0id);
    t.push(['…saving keeps the titles it sells as they were', (Array.isArray(rr.books) ? rr.books : String(rr.books).split(',')).filter(Boolean).sort().join() === B2.slice().sort().join()]);
    for (const w of [390, 1150]) { await page.setViewportSize({ width: w, height: 900 }); await page.evaluate(R0id => { goTo('region', R0id); pricesModal(); }, R0id); await page.waitForTimeout(300);
      t.push(['no overflow in Change Prices at ' + w + 'px', (await ovf()) === 0]); await page.evaluate(() => closeModal()); }
    await page.setViewportSize({ width: 1150, height: 900 });

    /* 4. Expenses: the button counts what is really there, and says Submit. */
    t.push(['form button: "Submit", "Review all 2 expenses" with a blank third (not 3)', await page.evaluate(() => {
      const f = { amt: '', desc: '', receipts: [] }, was = EXP.batch; EXP.batch = [{}, {}];
      const two = expSaveLabel(f, false); EXP.batch = []; const one = expSaveLabel({ amt: '5', desc: 'x', receipts: [] }, false); EXP.batch = was;
      return two === 'Review all 2 expenses' && one === 'Submit'; })]);
    t.push(['the review page button says "Submit"', /id="xrGo">Submit</.test(await page.evaluate(() => expReview.toString()))]);
    t.push(['"You will receive … please fill out another form." is the wording, kept from Edit Wording', /You will receive <b>\$\{esc\(L\.method\)\}<\/b> in <b>\$\{esc\(L\.reimbCur\)\}<\/b>\. If you require re-payment by another method and\/or currency, please fill out another form\./.test(await page.evaluate(() => expDraw.toString()))]);

    /* 5. "Expenses and Reimbursements" goes back to "Expenses". */
    t.push(['"Expenses and Reimbursements" saved wording no longer applies', await page.evaluate(() => {
      STATE.labels = Object.assign({}, STATE.labels, { 'Dialog: Expenses › Expenses': 'Expenses and Reimbursements' });
      const d = document.createElement('div'); d.innerHTML = '<div class="m-head"><h3>Expenses</h3></div><label>Expenses</label>'; document.body.appendChild(d);
      applyLabels(d); const ok = !/Reimbursements/.test(d.innerText); d.remove();
      STATE.labels = Object.assign({}, STATE.labels, { 'Dialog: Expenses › Expenses': 'My costs' }); const d2 = document.createElement('div'); d2.innerHTML = '<div class="m-head"><h3>Expenses</h3></div><label>Expenses</label>'; document.body.appendChild(d2);
      applyLabels(d2); const still = /My costs/.test(d2.innerText); d2.remove(); delete STATE.labels['Dialog: Expenses › Expenses']; return ok && still; })]);
  } catch (e) { t.push(['STOPPED: ' + e.message, false]); }
  t.push(['no page errors' + (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''), !errors.length]);
  let bad = 0;
  t.forEach(([n, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; });
  console.log(bad ? bad + ' failed' : 'all ' + t.length + ' passed');
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('STOPPED ' + e.stack); process.exit(1); });
