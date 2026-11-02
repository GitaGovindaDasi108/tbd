/* Optional, needs Playwright + Chromium: node test/browser-b325.js
   b325 (Make over Earthly HQ, Gita 2 Nov): in practice the Summaries Portal
   starts Warehouse Overview (so named at HQ), Distribution by Title, To Do
   Summary; and the payment table's Type column stays in view while it
   scrolls sideways (every payment table, live too). */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-b325-' + n + '.png');

m.init();
const st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason, pl = st.regions[0], B = st.books[0].id;
const c = p => { const r = m.call(p); if (!r.ok) throw new Error(p.action + ': ' + r.error); return r; };
c({ action: 'setStockBulk', season: SA, location: pl.whLoc, items: [{ bookId: B, qty: 9 }], override: true });
c({ action: 'sell', season: SA, saleId: 'S1', location: pl.whLoc, bookId: B, legs: [{ type: 'Cash', cur: 'PLN', amt: 150 }], pending: true, name: 'Arjuna' });
const S2 = c({ action: 'saveSeason', name: 'Year-Round' }).result;
c({ action: 'createRegion', season: S2, regionId: 'rg_bcn', whLoc: 'wh_bcn', name: 'Barcelona', currencies: 'EUR,GBP,CHF,SEK,NOK,DKK' });
c({ action: 'setStockBulk', season: S2, location: 'wh_bcn', items: [{ bookId: B, qty: 6 }], override: true });
['EUR','GBP','CHF','SEK','NOK','DKK'].forEach((cur, i) => c({ action: 'sell', season: S2, saleId: 'X' + i, location: 'wh_bcn', bookId: B, legs: [{ type: 'Cash', cur, amt: 35 }], override: true }));
c({ action: 'setSeason', seasonId: SA });

(async () => {
  const browser = await chromium.launch();
  const t = [], errors = [];
  async function open(width, practice) {
    const page = await (await browser.newContext({ viewport: { width, height: 1000 } })).newPage();
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
          body: fs.readFileSync(path.join(__dirname, 'config.test.js'), 'utf8').replace('CLASSIC_ADMIN: true', 'CLASSIC_ADMIN: true, PRACTICE_URL: "https://script.google.com/macros/s/TEST/exec"') });
        const f = path.join(ROOT, rel);
        if (fs.existsSync(f) && fs.statSync(f).isFile())
          return route.fulfill({ status: 200, body: fs.readFileSync(f),
            contentType: f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : undefined });
        return route.fulfill({ status: 404, body: '' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    await page.goto('http://app.test/index.html' + (practice ? '?practice' : '')); await page.waitForTimeout(2200);
    await page.click('[data-act="gohq"]'); await page.waitForTimeout(1500);
    return page;
  }
  const heads = page => page.evaluate(() => [...document.querySelectorAll('#summaryFlow .panel')].filter(p => p.offsetParent)
    .map(p => p.querySelector('h2').childNodes[0].textContent.trim()));
  // Scroll the table fully right: is "Type" / "Cash" still where it started?
  const frozen = (page, sel) => page.evaluate(sel => {
    const sc = document.querySelector(sel + ' .ptg-scroll'); if (!sc) return 'no table';
    if (sc.scrollWidth <= sc.clientWidth + 1) return 'fits (no scroll)';
    const cell = sc.querySelector('.ptg-r.ptg-first') || sc.querySelector('.ptg-first');
    const x0 = cell.getBoundingClientRect().left; sc.scrollLeft = sc.scrollWidth;
    const x1 = cell.getBoundingClientRect().left;
    return Math.abs(x1 - x0) < 1 ? 'frozen' : 'moved ' + (x0 - x1);
  }, sel);
  try {
    const live = await open(1150, false);
    const lh = await heads(live);
    t.push(['live keeps its order and the "Seasonal Warehouse Overview" name', lh[0] === 'Distribution by Title' && lh.includes('Seasonal Warehouse Overview')]);
    await live.close();
    for (const w of [1150, 390]) {
      const page = await open(w, true);
      const h = await heads(page);
      console.log('   ' + w + ': ' + h.join(' | '));
      t.push([w + ': Warehouse Overview, Distribution by Title, To Do Summary first', h[0] === 'Warehouse Overview' && h[1] === 'Distribution by Title' && h[2] === 'To Do Summary']);
      t.push([w + ': then the others', h.slice(3).join('|') === 'Net Sales by Season|Sales by Season|Total Collections by Payment']);
      const fz = await frozen(page, '#hqPayBody');
      console.log('   ' + w + ' payments: ' + fz);
      if (w === 390) t.push(['390: Total Collections by Payment scrolls with Type frozen', fz === 'frozen']);
      t.push([w + ': nothing overflows the page', !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1))]);
      await page.screenshot({ path: shot('hq-' + w), fullPage: true });
      if (w === 390) {
        await page.evaluate(() => { const sc = document.querySelector('#hqPayBody .ptg-scroll'); sc.scrollLeft = sc.scrollWidth; sc.scrollIntoView(); });
        await page.waitForTimeout(300);
        await (await page.$('#hqPayBody')).screenshot({ path: shot('pay-390') });
      }
      await page.close();
    }
  } catch (e) { errors.push('test: ' + e.message); }
  await browser.close();
  t.push(['no errors in the page', !errors.length]);
  if (errors.length) console.log(errors.join('\n'));
  let bad = 0; t.forEach(([n, ok]) => { if (!ok) bad++; console.log((ok ? 'PASS ' : 'FAIL ') + n); });
  console.log('screenshots: ' + shot('*'));
  process.exit(bad ? 1 : 0);
})();
