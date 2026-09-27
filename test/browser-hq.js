/* Optional, needs Playwright + Chromium: node test/browser-hq.js
   Earthly HQ in a real browser (b196): reached from 🌍 in the breadcrumb; a
   Sales Portal that works like a region (its own warehouse, selling in its
   own currency) and a Summaries Portal adding up every season; both fold. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-hq-' + n + '.png');

m.init();
const st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason, pl = st.regions[0], B = st.books[0].id, B1 = st.books[1].id;
const c = p => { const r = m.call(p); if (!r.ok) throw new Error(p.action + ': ' + r.error); return r; };
c({ action: 'setStockBulk', season: SA, location: pl.whLoc, items: [{ bookId: B, qty: 4 }], override: true });
c({ action: 'sell', season: SA, saleId: 'S1', location: pl.whLoc, bookId: B, legs: [{ type: 'Cash', cur: 'PLN', amt: 150 }] });
const S2 = c({ action: 'saveSeason', name: 'Year-Round' }).result;
c({ action: 'createRegion', season: S2, regionId: 'rg_bcn', whLoc: 'wh_bcn', name: 'Barcelona', currencies: 'EUR' });
c({ action: 'setStockBulk', season: S2, location: 'wh_bcn', items: [{ bookId: B, qty: 6 }], override: true });
c({ action: 'sell', season: S2, saleId: 'S2', location: 'wh_bcn', bookId: B, legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] });
c({ action: 'setSeason', seasonId: SA });

(async () => {
  const browser = await chromium.launch();
  const t = [], errors = [];
  const page = await (await browser.newContext({ viewport: { width: 1150, height: 1000 } })).newPage();
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
  const load = async () => { await page.goto('http://app.test/index.html'); await page.waitForTimeout(2200); };
  const text = sel => page.evaluate(s => { const e = document.querySelector(s); return e ? e.innerText : ''; }, sel);
  const visible = sel => page.evaluate(s => { const e = document.querySelector(s); return !!e && e.offsetParent !== null && e.offsetHeight > 0; }, sel);

  try {
    await load();
    t.push(['the breadcrumb starts with 🌍 Earthly HQ', /Earthly HQ/.test(await text('#locTabs'))]);
    await page.click('[data-act="gohq"]'); await page.waitForTimeout(1500);
    t.push(['🌍 opens Earthly HQ', await page.evaluate(() => isHQ() && CUR_REGION === 'rg_hq') && /Earthly HQ/i.test(await text('#locTabs .lvl-chip'))]);
    t.push(['two portals: Sales and Summaries', await visible('#salesPortal .portal-h') && await visible('#summaryPortal .portal-h')]);
    t.push(['the shelf is the "Earthly HQ Warehouse"', /Earthly HQ Warehouse/.test(await text('#invHeading'))]);
    const heads = await page.evaluate(() => [...document.querySelectorAll('#summaryPortal .panel > h2')].map(h => h.childNodes[0].textContent.trim()));
    console.log('   summaries: ' + heads.join(' | '));
    t.push(['summaries: titles, collections by season, sales by season, payments, seasonal warehouses',
      JSON.stringify(heads) === JSON.stringify(['Distribution by Title', 'Collections by Season', 'Sales by Season',
        'Total Collections by Payment', 'Seasonal Warehouse Overview'])]);
    const coll = await text('#hqCollBy');
    t.push(['collections by season: one row per season, and HQ', /Europe Tour/.test(coll) && /Year-Round/.test(coll) && /Earthly HQ/.test(coll) && /All seasons/.test(coll)]);
    t.push(['…with each season\'s takings (150 PLN, 35 EUR)', /150/.test(coll) && /35/.test(coll)]);
    t.push(['sales by season lists the seasons', /Europe Tour/.test(await text('#hqSalesBy')) && /Year-Round/.test(await text('#hqSalesBy'))]);
    const wo = await text('#hqWhOverview');
    t.push(['seasonal warehouse overview: where books are, by season', /3\s*Europe Tour/.test(wo) && /5\s*Year-Round/.test(wo)]);
    t.push(['the top tiles add up every season (2 big books sold)', /2\s*SOLD/i.test(await text('#totals'))]);
    const adm = await text('#adminActions');
    t.push(['admin offers "Edit Earthly HQ", nothing to close or delete', /Edit Earthly HQ/.test(adm) && !/Delete Region|Close Region|Event Order/.test(adm)]);
    await page.screenshot({ path: shot('1-hq'), fullPage: true });

    // Books from the printer, then a sale at HQ in rupees, through the app.
    c({ action: 'adjustStockBulk', season: 'HQ', location: 'wh_hq', items: [{ bookId: B1, delta: 40 }], override: true });
    await page.click('[data-act="refresh"]'); await page.waitForTimeout(1500);
    t.push(['the HQ warehouse shows the printer\'s books', /40/.test(await text('#invGrid'))]);
    await page.click(`#invGrid .sell-btn[data-book="${B1}"]`); await page.waitForTimeout(400);
    const curs = await page.evaluate(() => [...document.querySelectorAll('#pcur option')].map(o => o.value));
    t.push(['an HQ sale is in HQ\'s own currencies', curs.includes('INR') && !curs.includes('PLN')]);
    await page.selectOption('#pcur', 'INR'); await page.fill('#pamt', '3000');
    await page.click('#saveSale'); await page.waitForTimeout(1800);
    const hqState = m.call({ action: 'getState', season: 'HQ' }).state;
    t.push(['the sale is recorded at HQ', hqState.sales.some(x => x.location === 'wh_hq' && x.p1cur === 'INR' && x.p1amt === 3000)]);
    t.push(['HQ\'s own row in the summaries shows it', /3,?000/.test(await text('#hqCollBy'))]);

    // WhatsApp from the Summaries Portal: every season, by season.
    await page.click('#summaryPortal [data-act="report"][data-part="cash"]'); await page.waitForTimeout(400);
    const rep = await page.evaluate(() => (document.querySelector('#repText') || {}).value || '');
    console.log('   report:\n     ' + rep.split('\n').join('\n     '));
    t.push(['📋 on the summaries reports every season, by season', /BY SEASON/.test(rep) && /Europe Tour/.test(rep) && /Year-Round/.test(rep)]);
    await page.evaluate(() => closeModal());

    // Rewritten wording can be copied out, to be built into the app.
    c({ action: 'saveLabel', key: 'Sales Portal', text: 'Selling at HQ' });
    await page.click('[data-act="refresh"]'); await page.waitForTimeout(1500);
    await page.click('#adminActions [data-act="copywording"]'); await page.waitForTimeout(300);
    const words = await page.evaluate(() => (document.querySelector('#wordText') || {}).value || '');
    t.push(['"Copy Saved Wording" shows what was rewritten', /Selling at HQ/.test(words)]);
    await page.evaluate(() => closeModal());
    c({ action: 'saveLabel', key: 'Sales Portal', text: '' });
    await page.click('[data-act="refresh"]'); await page.waitForTimeout(1500);

    // Folding the portals, remembered on this device.
    await page.click('#salesPortal > .portal-h', { position: { x: 30, y: 12 } }); await page.waitForTimeout(200);
    t.push(['the Sales Portal folds from its heading', !(await visible('#regionCols')) && await visible('#summaryPortal .panel')]);
    await page.click('#summaryPortal > .portal-h', { position: { x: 30, y: 12 } }); await page.waitForTimeout(200);
    t.push(['so does the Summaries Portal', !(await visible('#summaryPortal .panel'))]);
    await load();
    t.push(['both stay folded after a reload', await page.evaluate(() => isHQ()) && !(await visible('#regionCols')) && !(await visible('#summaryPortal .panel'))]);
    await page.click('#salesPortal > .portal-h', { position: { x: 30, y: 12 } });
    await page.click('#summaryPortal > .portal-h', { position: { x: 30, y: 12 } }); await page.waitForTimeout(200);
    t.push(['and open again', await visible('#regionCols') && await visible('#summaryPortal .panel')]);

    // Into a season from the summaries, and back.
    await page.click('#hqCollBy a:has-text("Year-Round")'); await page.waitForTimeout(1500);
    t.push(['a season\'s name in the summaries opens that season', await page.evaluate(() => !isHQ() && CUR_LEVEL === 'season' && STATE.seasonName === 'Year-Round')]);
    t.push(['…where the portals are not shown', !(await visible('#salesPortal .portal-h')) && !(await visible('#summaryPortal'))]);
    await page.click('[data-act="gohq"]'); await page.waitForTimeout(1200);
    t.push(['🌍 goes back up to HQ', await page.evaluate(() => isHQ())]);
    t.push(['no errors in the page', !errors.length]);
    if (errors.length) console.log(errors);
  } catch (e) { t.push(['ran to the end: ' + e.message, false]); }
  t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
  console.log('screenshots: ' + path.join(os.tmpdir(), 'tbs-hq-*.png'));
  await browser.close();
})();
