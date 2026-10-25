/* Optional, needs Playwright + Chromium: node test/browser-b309.js
   b309 (Live app changes): the Uncategorized Sales calculator works where the
   shelf has no Adventures, or no books at all. The usual price comes from every
   title priced here, not only those in stock. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){ return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
m.init();
const st = m.call({ action: 'getState' }).state, SA = st.activeSeason;
const c = (p, season) => { const r = m.call(Object.assign({ season: season || SA }, p)); if (!r.ok) throw new Error(p.action + ': ' + r.error); return r; };
const R0 = st.regions[0];
const B = st.books.find(b => !b.partnerId && (b.cat || 'big') === 'big').id;
c({ action: 'createEvent', eventId: 'ev_b309', name: 'Book Table', regionId: R0.regionId });
c({ action: 'createEvent', eventId: 'ev_b309e', name: 'Empty Fair', regionId: R0.regionId });
c({ action: 'adjustStockBulk', location: R0.whLoc, items: [{ bookId: B, delta: 10 }], override: true });
c({ action: 'adjustStockBulk', location: 'ev_b309', items: [{ bookId: B, delta: 5 }], override: true });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1150, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
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
  // The live totals bar (every card one width); practice sizes each card to its contents (b305).
  await page.addInitScript(() => { window.TOT_EVEN = true; });
  await page.goto('http://app.test/index.html?practice');
  await page.waitForTimeout(2500);
  const t = [];
  const val = k => page.$eval(k, i => i.value);
  const open = async ev => { await page.evaluate(e => { closeModal(); goTo('event', e); }, ev); await page.waitForTimeout(400);
    await page.evaluate(() => uncatModal()); await page.waitForTimeout(300); await page.selectOption('#ucCur', 'USD'); };

  /* Only Big Books on the shelf. */
  await open('ev_b309');
  t.push(['only Big Books in stock: the Adventure price still found (15)', await page.evaluate(() => uncatMsrp('USD', 'aotm')) === 15]);
  await page.fill('#ucAmt', '500'); await page.waitForTimeout(100);
  t.push(['500: 12 Big Books and 1 Adventure', await val('#ucN') === '12' && await val('#ucA') === '1']);
  await page.fill('#ucA', '4'); await page.waitForTimeout(100);
  t.push(['4 Adventures typed: 11 Big Books, not emptied', await val('#ucN') === '11']);
  await page.fill('#ucN', '3'); await page.waitForTimeout(100);
  t.push(['3 Big Books typed: 25 Adventures', await val('#ucA') === '25']);

  /* No books at all. */
  await open('ev_b309e');
  t.push(['no books in stock: Big Book price 40, Adventure 15', await page.evaluate(() => uncatMsrp('USD') === 40 && uncatMsrp('USD', 'aotm') === 15)]);
  await page.fill('#ucAmt', '400'); await page.waitForTimeout(100);
  t.push(['400: 10 Big Books', await val('#ucN') === '10' && await val('#ucA') === '']);
  await page.fill('#ucA', '2'); await page.waitForTimeout(100);
  t.push(['2 Adventures typed: 9 Big Books', await val('#ucN') === '9']);

  /* A currency with no price here: the local price converted. */
  const conv = await page.evaluate(() => { STATE.rates = Object.assign({}, STATE.rates, { perUsd: Object.assign({}, (STATE.rates || {}).perUsd, { GBP: 0.5 }) });
    const home = defaultCur(), want = Math.round(convertCur(uncatMsrp(home), home, 'GBP') * 100) / 100; return [uncatMsrp('GBP'), want]; });
  t.push(['no GBP price: the local price converted (' + conv.join(' = ') + ')', conv[0] > 0 && conv[0] === conv[1]]);
  await page.evaluate(() => closeModal());

  t.push(['no page errors' + (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''), !errors.length]);
  let bad = 0;
  t.forEach(([n, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; });
  console.log(bad ? bad + ' failed' : 'all ' + t.length + ' passed');
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('STOPPED ' + e.stack); process.exit(1); });
