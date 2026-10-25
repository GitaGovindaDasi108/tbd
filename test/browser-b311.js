/* Optional, needs Playwright + Chromium: node test/browser-b311.js
   b311 (Live app changes): Edit Location and Change Prices find the regions
   from every tab; Add Stock titles follow your own order; totals card
   colours and gift lines; stock added in the transfer log; event prices with
   a fill-all row and the calculator; the batch report button gone and the
   Books in Transit report, Edit Location and the Finance pieces live. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){ return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
m.init();
// b314: an empty title list no longer means every title, so the sample region ticks them all, as a new region does.
m.run("dbUpdate_('_regions', { regionId: 'rg_poland' }, { books: BOOKS.map(b => b.id).join(',') }); cacheClear_(); bumpRev_();");
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

    /* 1. Edit Location / Change Prices from the season page: the Region tab finds the region. */
    for (const fn of ['placeEditModal', 'pricesModal']) {
      const r = await page.evaluate(async fn => { goTo('season'); window[fn](); await new Promise(r => setTimeout(r, 300));
        const tab = document.querySelector('#ppTabs [data-pp-k="region"]'); if (tab) tab.click();   // Change Prices has drop-downs only (b313)
        await new Promise(r => setTimeout(r, 200));
        const o = { reg: (document.querySelector('#ppReg') || {}).value, body: document.querySelector('#ppBody').innerText.slice(0, 40) }; closeModal(); return o; }, fn);
      t.push([fn + ' from the season page, Region tab: ' + r.reg + ' — ' + r.body.replace(/\n/g, ' '), r.reg === R0id && !/No regions/.test(r.body)]);
    }
    t.push(['live: Edit Location in the menu, no Rename Event / Edit Region', await page.evaluate(() => { goTo('event', 'ev_b311');
      return !!document.querySelector('[data-act="placeedit"]') && !document.querySelector('[data-act="renameevent"]') && !document.querySelector('[data-act="editregion"]'); })]);

    /* 2. Add Stock's titles follow your own ⇅ Arrange order. */
    const order = await page.evaluate(async R0id => {
      const ids = () => { const ctx = makeStockCtx({kind:'region', seasonId:STATE.activeSeason, regionId:R0id, loc:STATE.regions.find(r=>r.regionId===R0id).whLoc}, ''); return stockBooks(Object.assign(ctx, {staged:[]})).map(b => b.id); };
      // b312: its own order (Stock Title Order), no longer the shelf's.
      const before = ids(); await STOCK_ORDER.set([...new Set(before.map(id => stockTitleKey(bookById(id))))].reverse()); const after = ids(); await STOCK_ORDER.set([]);
      return { before, after };
    }, R0id).catch(e => ({ err: e.message }));
    t.push(['Add Stock titles follow your own order (b312: Stock Title Order)' + (order.err ? ' — ' + order.err : ''), !order.err && order.before.length > 1 && order.after[0] === order.before[order.before.length - 1]]);

    /* 3. Totals cards: Big Books gold, AoTM blue; gifts and distributed on their own lines. */
    await page.evaluate(() => goTo('region', STATE.regions.find(r => r.regionId !== HQ_REGION).regionId)); await page.waitForTimeout(300);
    const col = await page.evaluate(() => { const v = s => { const e = document.querySelector(s); return e ? getComputedStyle(e).color : ''; };
      return { big: v('#totals .tc-book:not(.aotm):not(.other) .value'), aotm: v('#totals .tc-book.aotm .value') }; });
    t.push(['Big Books number gold (' + col.big + ')', col.big === 'rgb(184, 134, 47)']);
    t.push(['AoTM number blue (' + col.aotm + ')', col.aotm === 'rgb(47, 93, 138)']);
    t.push(['"+2 gifts =", then "5 distributed" on the next line (totals bar only, b312)', await page.evaluate(() => giftNote({ gift: 2, sold: 3 }, true).includes('gifts =<br><b class="dist-n">5 distributed') && !giftNote({ gift: 2, sold: 3 }).includes('<br>'))]);

    /* 4. The transfer log lists stock added. */
    await page.evaluate(() => { transferLogModal(); }); await page.waitForTimeout(300);
    const tl = await page.evaluate(() => document.querySelector('#modal .m-body').innerText);
    t.push(['transfer log lists "Stock added from outside the system"', /Stock added from outside the system/.test(tl) && /10 books/.test(tl)]);
    await page.evaluate(() => closeModal());

    /* 5. Change Prices for an event: a fill-all row and the calculator. */
    await page.evaluate(() => { goTo('event', 'ev_b311'); pricesModal(); }); await page.waitForTimeout(300);
    // b313: opened at the event, Change Prices is already on it.
    const ep = await page.evaluate(() => {
      const top = document.querySelector('#ppBody .ep-all[data-cat="big"]'); if (!top) return { err: 'no fill-all row' };
      const loc = top.dataset.cur; top.value = '20'; top.dispatchEvent(new Event('input', { bubbles: true }));
      const cells = [...document.querySelectorAll(`#ppBody .ep[data-cat="big"][data-cur="${loc}"]`)].map(i => i.value);
      const other = document.querySelector(`#ppBody .ep[data-cat="big"]:not([data-cur="${loc}"])`);
      const aotm = [...document.querySelectorAll('#ppBody .ep[data-cat="aotm"]')].map(i => i.value);
      return { loc, cells, other: other ? other.dataset.cur + ' ' + other.value : '', aotm };
    });
    t.push(['event fill-all row sets every Big Book (' + JSON.stringify(ep) + ')', !ep.err && ep.cells.length > 0 && ep.cells.every(v => v === '20') && ep.aotm.every(v => v === '')]);
    t.push(['…and works out the other currency', !ep.err && (!ep.other || /^\w{3} \d/.test(ep.other))]);
    const one = await page.evaluate(() => { const loc = document.querySelector('#ppBody .ep-all').dataset.cur;
      const c = document.querySelector(`#ppBody .ep[data-cat="aotm"][data-cur="${loc}"]`) || document.querySelector(`#ppBody .ep[data-cur="${loc}"]`);
      c.value = '9'; c.dispatchEvent(new Event('input', { bubbles: true }));
      return [...document.querySelectorAll(`#ppBody .ep[data-book="${c.dataset.book}"]`)].map(i => i.dataset.cur + ' ' + i.value); });
    t.push(['a title typed in local works out its other currencies (' + one.join(', ') + ')', one.length < 2 || one.slice(1).every(x => / \d/.test(x))]);
    for (const w of [390, 1150]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(200);
      t.push(['no overflow in event prices at ' + w + 'px', (await ovf()) === 0]); }
    await page.evaluate(() => closeModal()); await page.setViewportSize({ width: 1150, height: 900 });

    /* 6. In transit: no Remaining to Be Delivered button; the report is live. */
    t.push(['no "Remaining to Be Delivered" anywhere', await page.evaluate(() => !document.querySelector('[data-act="shremain"]') && typeof shipRemainReport === 'undefined')]);
    t.push(['live: Books in Transit report button', await page.evaluate(() => { goTo('region', STATE.regions.find(r => r.regionId !== HQ_REGION).regionId); return TRANSIT_REP_ON === true; })]);

    /* 7. Finance pieces are live: Dollars Received on the Overview and in WhatsApp, Hide table. */
    t.push(['live: Dollars Received section and Hide table not practice-gated', await page.evaluate(() => !/PRACTICE/.test(finWaDr.toString()) && !/PRACTICE/.test(finOverviewHTML ? finOverviewHTML.toString() : ''))]);
  } catch (e) { t.push(['STOPPED: ' + e.message, false]); }
  t.push(['no page errors' + (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''), !errors.length]);
  let bad = 0;
  t.forEach(([n, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; });
  console.log(bad ? bad + ' failed' : 'all ' + t.length + ' passed');
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('STOPPED ' + e.stack); process.exit(1); });
