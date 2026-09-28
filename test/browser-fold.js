/* Optional, needs Playwright + Chromium: node test/browser-fold.js
   Folding panels from their headings (b195), and the season's order:
   Total Sales by Title, Collections by Region, Sales by Region, Total
   Collections by Payment, then the Warehouse Overview.
   b216: a folded panel stands on a line of its own — no empty, stretched box.
   b217: the open panels after it pair up afresh, two by two, across what used
   to be separate rows, instead of the neighbour taking the whole width. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-fold-' + n + '.png');

m.init();
const st = m.call({ action: 'getState' }).state;
const pl = st.regions[0];
m.call({ action: 'setStockBulk', season: st.activeSeason, location: pl.whLoc, items: [{ bookId: st.books[0].id, qty: 40 }], override: true });
// Enough sales that the log is taller than a folded shelf would ever be.
for (let i = 0; i < 25; i++) m.call({ action: 'sell', season: st.activeSeason, saleId: 'sf' + i, location: pl.whLoc,
  bookId: st.books[0].id, legs: [{ type: 'Cash', cur: 'PLN', amt: 10 }] });

(async () => {
  const browser = await chromium.launch();
  const t = [], errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 950 } });
  const page = await ctx.newPage();
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
        return route.fulfill({ status: 200, body: fs.readFileSync(f),
          contentType: f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : undefined });
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  const load = async () => { await page.goto('http://app.test/index.html'); await page.waitForTimeout(2000); };
  const headings = () => page.evaluate(() => [...document.querySelectorAll('.panel[data-fold]')]
    .filter(p => p.offsetParent !== null).map(p => p.querySelector('h2').childNodes[0].textContent.trim()));
  const folded = name => page.evaluate(n => [...document.querySelectorAll(`.panel[data-fold="${n}"]`)]
    .filter(p => p.offsetParent !== null).every(p => p.classList.contains('folded')), name);
  // Where a panel sits on the page (its wrapper, for the sales log).
  const box = name => page.evaluate(n => { const p = [...document.querySelectorAll(`.panel[data-fold="${n}"]`)].find(x => x.offsetParent !== null);
    const r = p.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height }; }, name);
  const rowW = sel => page.evaluate(s => document.querySelector(s).getBoundingClientRect().width, sel);
  const tap = name => page.click(`.panel[data-fold="${name}"] > h2`, { position: { x: 40, y: 15 } }).then(() => page.waitForTimeout(200));
  const bodyShown = name => page.evaluate(n => { const p = [...document.querySelectorAll(`.panel[data-fold="${n}"]`)].find(x => x.offsetParent !== null);
    const b = p && p.querySelector('.body'); return !!b && b.offsetHeight > 0; }, name);

  try {
    await load();
    t.push(['a new device opens at the season', await page.evaluate(() => CUR_LEVEL) === 'season']);
    const order = (await headings()).slice(0, 5);
    console.log('   season order: ' + order.join(' | '));
    t.push(['season order: titles, collections by region, sales by region, payments, warehouses',
      JSON.stringify(order) === JSON.stringify(['Distribution by Title', 'Collections by Region', 'Sales by Region',
        'Total Collections by Payment', 'Warehouse Overview'])]);
    t.push(['everything starts open', !(await folded('payments')) && await bodyShown('payments')]);

    await page.click('.panel[data-fold="payments"] > h2', { position: { x: 60, y: 15 } }); await page.waitForTimeout(200);
    t.push(['a tap on the heading folds it', await folded('payments') && !(await bodyShown('payments'))]);
    await page.screenshot({ path: shot('1-season-folded') });
    await page.click('.panel[data-fold="titles"] > h2 .sec-rep'); await page.waitForTimeout(300);
    t.push(['the 📋 button in a heading does not fold it', !(await folded('titles'))]);

    await load();
    t.push(['folded stays folded after a reload (this device)', await folded('payments')]);

    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(300);
    t.push(['the same panel in a region is folded separately (still open)', !(await folded('payments')) && await bodyShown('payments')]);
    await page.click('.panel[data-fold="inventory"] > h2', { position: { x: 40, y: 15 } }); await page.waitForTimeout(200);
    const logH = await page.evaluate(() => document.querySelector('.panel[data-fold="log"]').offsetHeight);
    t.push(['with the shelf folded, the sales log still has room', await folded('inventory') && logH > 150]);
    await page.click('.panel[data-fold="inventory"] > h2', { position: { x: 40, y: 15 } }); await page.waitForTimeout(200);
    t.push(['a second tap opens it again', !(await folded('inventory'))]);

    // b216/b217: a folded panel is a bar; the panels after it pair up afresh.
    let full = await rowW('#salesFlow');
    const same = (a, b) => Math.abs(a - b) < 2;
    let inv = await box('inventory'), log = await box('log');
    t.push(['both open: shelf and sales log side by side', log.left >= inv.right - 1]);
    t.push(['…the shelf the wider of the two, as before', inv.w > log.w * 1.2]);
    await tap('inventory');
    inv = await box('inventory'); log = await box('log');
    await page.screenshot({ path: shot('2-shelf-folded') });
    t.push(['shelf folded: its box is just the heading (no stretched empty box)', inv.h < 70]);
    t.push(['…the bar spans the page', inv.w > full * 0.95]);
    t.push(['…the sales log moves underneath it', log.top >= inv.bottom - 1]);
    let ttl = await box('titles');
    t.push(['…and pairs with the next panel (Distribution by Title) beside it',
      same(ttl.top, log.top) && ttl.left >= log.right - 1 && log.w < full * 0.55 && ttl.w < full * 0.55]);
    t.push(['…the sales log is at most about a screen tall',
      log.h <= await page.evaluate(() => innerHeight * 0.85 + 1)]);
    await tap('inventory');
    await tap('log');
    inv = await box('inventory'); log = await box('log');
    await page.screenshot({ path: shot('3-log-folded') });
    ttl = await box('titles');
    t.push(['sales log folded: just its heading, underneath the shelf', log.h < 70 && log.top >= inv.bottom - 1]);
    t.push(['…the shelf, now without a partner, takes the whole width', inv.w > full * 0.95]);
    t.push(['…and the panels below still pair up', ttl.top >= log.bottom - 1 && ttl.w < full * 0.55]);
    await tap('log');
    inv = await box('inventory'); log = await box('log');
    t.push(['both open again: side by side as before', log.left >= inv.right - 1 && log.top < inv.top + 5]);

    await page.evaluate(() => goTo('season')); await page.waitForTimeout(300);
    await page.click('.panel[data-fold="payments"] > h2', { position: { x: 60, y: 15 } }); await page.waitForTimeout(200);
    t.push(['back at the season: open it again', !(await folded('payments')) && await bodyShown('payments')]);

    // The season's two-column rows behave the same.
    full = await rowW('#seasonFlow');
    await tap('titles');
    let ti = await box('titles'), cb = await box('collBy');
    await page.screenshot({ path: shot('4-season-titles-folded') });
    t.push(['season: Distribution by Title folded is a bar across the page', ti.h < 70 && ti.w > full * 0.95]);
    let sb0 = await box('salesBy'), py0 = await box('payments');
    t.push(['…Collections by Region moves under it, beside Sales by Region',
      cb.top >= ti.bottom - 1 && same(cb.top, sb0.top) && sb0.left >= cb.right - 1 && cb.w < full * 0.55]);
    t.push(['…and Collections by Payment, left without a partner, takes the line', py0.w > full * 0.95 && py0.top >= sb0.bottom - 1]);
    await tap('titles');
    ti = await box('titles'); cb = await box('collBy');
    t.push(['…opened again: side by side', cb.left >= ti.right - 1]);
    await tap('payments');
    const sb = await box('salesBy'), py = await box('payments');
    t.push(['season: folding the right-hand panel moves it under the left one, which widens',
      py.h < 70 && py.top >= sb.bottom - 1 && sb.w > full * 0.95]);
    await tap('payments');

    // A phone shows one panel per line, folded or not.
    await page.setViewportSize({ width: 390, height: 850 });
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(300);
    await tap('inventory');
    const lg = await box('log'), tt = await box('titles');
    full = await rowW('#salesFlow');
    t.push(['phone: one panel per line, full width', lg.w > full * 0.95 && tt.w > full * 0.95 && tt.top >= lg.bottom - 1]);
    await page.screenshot({ path: shot('5-phone'), fullPage: false });
    await tap('inventory');
    t.push(['no errors in the page', !errors.length]);
    if (errors.length) console.log(errors);
  } catch (e) { t.push(['ran to the end: ' + e.message, false]); }
  t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
  console.log('screenshots: ' + path.join(os.tmpdir(), 'tbs-fold-*.png'));
  await browser.close();
})();
