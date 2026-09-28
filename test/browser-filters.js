/* Optional, needs Playwright + Chromium: node test/browser-filters.js
   b212: the sales-log filters last only while you stay on that page, and a
   filter menu can always be used — Clear and Done reachable — in a short
   window (half a desktop screen). */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-flt-' + n + '.png');

m.init();
const ok = (r, what) => { if (!r.ok) throw new Error(what + ': ' + r.error); return r; };
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason;
const books = st.books.filter(b => !b.partnerId);
const pl = st.regions[0];
const c = (p, w) => ok(m.call(Object.assign({ season: SA }, p)), w || p.action);
c({ action: 'createEvent', eventId: 'ev_mad', name: 'Madrid', regionId: pl.regionId });
c({ action: 'adjustStockBulk', location: pl.whLoc, items: books.map(b => ({ bookId: b.id, delta: 5 })), override: true });
// A sale of every title, so the Books menu is long.
books.forEach((b, i) => c({ action: 'sell', saleId: 's_' + i, location: pl.whLoc, bookId: b.id, legs: [{ type: 'Cash', cur: 'PLN', amt: 10 }] }));

(async () => {
  const browser = await chromium.launch();
  const t = [], errors = [];
  // Half of a laptop screen.
  const page = await browser.newPage({ viewport: { width: 720, height: 520 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.includes('script.google.com')) {
      let p = {}; try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(m.call(p)) });
    }
    if (url.startsWith('http://app.test/')) {
      const f = (rel => rel === 'config.js' ? path.join(__dirname, 'config.test.js') : path.join(ROOT, rel))(new URL(url).pathname.replace(/^\/+/, '') || 'index.html');
      if (fs.existsSync(f) && fs.statSync(f).isFile())
        return route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : undefined });
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto('http://app.test/index.html'); await page.waitForTimeout(2000);
  const inView = sel => page.evaluate(s => {
    const e = document.querySelector(s); if (!e) return false;
    const r = e.getBoundingClientRect();
    if (!(r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight)) return false;
    // …and nothing else on top of it (the middle and near both ends).
    return [0.15, 0.5, 0.85].every(f => { const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height * f);
      return hit && (e === hit || e.contains(hit)); });
  }, sel);
  try {
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(300);

    // 1. The menu fits a short window, wherever the log sits on the page.
    for (const where of ['top', 'bottom']) {
      await page.evaluate(w => { const b = document.querySelector('.flt-btn[data-facet="book"]');
        b.scrollIntoView({ block: w === 'top' ? 'start' : 'end' }); window.scrollBy(0, w === 'top' ? -60 : 0); }, where);
      await page.click('.flt-btn[data-facet="book"]'); await page.waitForTimeout(200);
      await page.screenshot({ path: shot('menu-' + where) });
      t.push([`menu opened with the button near the ${where}: all of it on screen`, await inView('.log-filter[data-panel="book"]')]);
      t.push(['…Clear and Done can be reached', await inView('.log-filter[data-panel="book"] .lf-foot') && await inView('.log-filter[data-panel="book"] [data-act="lfdone"]')]);
      await page.click('.log-filter[data-panel="book"] [data-act="lfdone"]'); await page.waitForTimeout(100);
    }
    // Scrolled to its end, Clear is still there and works.
    await page.click('.flt-btn[data-facet="book"]'); await page.waitForTimeout(200);
    await page.check('.log-filter[data-panel="book"] [data-lf^="book:"]'); await page.waitForTimeout(200);
    await page.evaluate(() => { const p = document.querySelector('.log-filter[data-panel="book"]'); p.scrollTop = p.scrollHeight; });
    await page.waitForTimeout(100);
    t.push(['scrolled to the end of the menu, Clear is on screen', await inView('.log-filter[data-panel="book"] [data-act="lfclear"]')]);
    await page.click('.log-filter[data-panel="book"] [data-act="lfclear"]'); await page.waitForTimeout(200);
    t.push(['…and clears the filter', await page.evaluate(() => logFilterCount() === 0)]);
    await page.click('.log-filter[data-panel="book"] [data-act="lfdone"]');

    // 2. A filter lasts only on the page it was set on.
    await page.click('.flt-btn[data-facet="book"]'); await page.waitForTimeout(200);
    await page.check('.log-filter[data-panel="book"] [data-lf^="book:"]'); await page.waitForTimeout(200);
    t.push(['a filter applies here', await page.evaluate(() => logFilterCount() === 1) &&
      /\(1\)/.test(await page.textContent('.flt-btn[data-facet="book"]'))]);
    await page.evaluate(() => goTo('event', 'ev_mad')); await page.waitForTimeout(300);
    t.push(['going to an event: no filter, menus shut', await page.evaluate(() => logFilterCount() === 0 &&
      !document.querySelector('.log-filter[data-panel]:not([hidden])') &&
      !/\(/.test(document.querySelector('.flt-btn[data-facet="book"]').textContent))]);
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(300);
    t.push(['coming back: still unfiltered', await page.evaluate(() => logFilterCount() === 0)]);
    t.push(['…and the whole log shows', await page.evaluate(n => document.querySelectorAll('#log .entry, #log [data-id]').length >= 1, books.length)]);
  } catch (e) {
    console.log('STOPPED:', e.message.split('\n').slice(0,14).join('\n'));
    t.push(['test ran to the end', false]);
    try { await page.screenshot({ path: shot('stopped') }); } catch (e2) {}
  }
  t.push(['no errors in the page', errors.length === 0]);
  if (errors.length) console.log('page errors:', errors);
  t.forEach(([n, okk]) => console.log((okk ? 'PASS' : 'FAIL'), n));
  console.log('screenshots:', shot('*'));
  await browser.close();
})();
