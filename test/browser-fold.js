/* Optional, needs Playwright + Chromium: node test/browser-fold.js
   Folding panels from their headings (b195), and the season's order:
   Total Sales by Title, Collections by Region, Sales by Region, Total
   Collections by Payment, then the Warehouse Overview. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-fold-' + n + '.png');

m.init();
const st = m.call({ action: 'getState' }).state;
const pl = st.regions[0];
m.call({ action: 'setStockBulk', season: st.activeSeason, location: pl.whLoc, items: [{ bookId: st.books[0].id, qty: 5 }], override: true });

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
      const f = path.join(ROOT, new URL(url).pathname.replace(/^\/+/, '') || 'index.html');
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

    await page.evaluate(() => goTo('season')); await page.waitForTimeout(300);
    await page.click('.panel[data-fold="payments"] > h2', { position: { x: 60, y: 15 } }); await page.waitForTimeout(200);
    t.push(['back at the season: open it again', !(await folded('payments')) && await bodyShown('payments')]);
    t.push(['no errors in the page', !errors.length]);
    if (errors.length) console.log(errors);
  } catch (e) { t.push(['ran to the end: ' + e.message, false]); }
  t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
  console.log('screenshots: ' + path.join(os.tmpdir(), 'tbs-fold-*.png'));
  await browser.close();
})();
