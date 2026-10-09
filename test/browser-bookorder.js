/* Optional, needs Playwright + Chromium: node test/browser-bookorder.js
   b219: the order set in Edit Book Display shows everywhere it should, the
   moment it is saved. At Earthly HQ it used to reach only HQ's own panels:
   the Summaries Portal kept the catalogue's order. And the Warehouse
   Overview never used any order at all, at the season either. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-order-' + n + '.png');

m.init();
const st = m.call({ action: 'getState' }).state;
const pl = st.regions[0];
const books = st.books.filter(b => !b.partnerId);
const first = books[0].name, last = books[books.length - 1].name;
m.call({ action: 'setStockBulk', season: st.activeSeason, location: pl.whLoc, items: [{ bookId: books[0].id, qty: 5 }], override: true });

(async () => {
  const browser = await chromium.launch();
  const t = [], errors = [];
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
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
  // The first title shown in each place.
  const firsts = () => page.evaluate(() => {
    const txt = e => e ? e.textContent.replace(/SOLD OUT|ALL PRE-ORDERED/g, '').trim().split('\n')[0].trim() : '(none)';
    const firstCard = sel => { const box = document.querySelector(sel); if (!box || !box.offsetParent) return '(hidden)';
      const kids = [...box.querySelectorAll(':scope > *, :scope > * > *')].filter(e => e.textContent.trim());
      return txt(kids.find(e => !e.classList.contains('don-card')) || null); };
    return { shelf: txt(document.querySelector('#invGrid .book:not(.don-card)')),
             titles: firstCard('#titleList'), sumTitles: firstCard('#hqTitleList'), sumWh: firstCard('#hqWhOverview'),
             seasonTitles: firstCard('#seasonTitleList'), seasonWh: firstCard('#whOverview') };
  });
  // Move the last title in Edit Book Display to the top, and save.
  const lastToTop = async () => {
    await page.click('#adminActions [data-act="bookdisplay"]'); await page.waitForTimeout(300);
    const n = await page.$$eval('#bdList .ro-row', r => r.length);
    for (let i = n - 1; i > 0; i--) await page.click(`#bdList [data-bd-up="${i}"]`);
    await page.click('#bdSave'); await page.waitForTimeout(250);
  };
  try {
    await page.goto('http://app.test/index.html'); await page.waitForTimeout(2000);

    /* ---- The season: its Warehouse Overview follows the season's order ---- */
    let f = await firsts();
    t.push(['season: catalogue order to start with', f.seasonTitles === first && f.seasonWh === first]);
    await lastToTop();
    f = await firsts();
    t.push(['season order saved: Distribution by Title follows at once', f.seasonTitles === last]);
    t.push(['…and so does the Warehouse Overview (it never did)', f.seasonWh === last]);

    /* ---- Earthly HQ: every panel follows HQ's order ---- */
    await page.click('[data-act="gohq"]'); await page.waitForTimeout(2500);
    f = await firsts();
    t.push(['HQ: catalogue order to start with (its own, not the season\'s)', f.shelf === first && f.sumTitles === first && f.sumWh === first]);
    await lastToTop();
    f = await firsts();
    await page.screenshot({ path: shot('hq'), fullPage: true });
    t.push(['HQ order saved: its warehouse shelf follows at once', f.shelf === last]);
    t.push(['…its own Distribution by Title', f.titles === last]);
    t.push(['…the Summaries Portal\'s Distribution by Title (it did not)', f.sumTitles === last]);
    t.push(['…and its Seasonal Warehouse Overview (it did not)', f.sumWh === last]);
    await page.waitForTimeout(2000);
    await page.reload(); await page.waitForTimeout(3000);
    f = await firsts();
    t.push(['after a reload, all four still follow it', f.shelf === last && f.titles === last && f.sumTitles === last && f.sumWh === last]);
    t.push(['the server kept it on Earthly HQ', (m.call({ action: 'getState', season: 'HQ' }).state.regions
      .find(r => r.regionId === 'rg_hq') || {}).bookOrder[0] === books[books.length - 1].id]);
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
