/* Optional, needs Playwright + Chromium: node test/browser-paytypes283.js
   b283: payment types. The sale form's payment type is a searchable dropdown;
   Universal can "＋ Add" a new type there, which joins the region's list before
   Other and stays; a type typed in Edit Payment Types but not added is kept on
   Save; no overflow on a phone. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){ return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
m.init();
const st = m.call({ action: 'getState' }).state;
const R0 = st.regions[0], BK = st.books.map(b => b.id);
m.call({ season: st.activeSeason, action: 'adjustStockBulk', location: R0.whLoc, items: BK.slice(0, 3).map(b => ({ bookId: b, delta: 5 })), override: true });
m.call({ season: st.activeSeason, action: 'sell', location: R0.whLoc, bookId: BK[0], legs: [{ type: 'Cash', cur: R0.currencies[0], amt: 10 }], override: true });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
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
      // The left-hand menu, not the old App Admin panel.
      if (rel === 'config.js') return route.fulfill({ status: 200, contentType: 'text/javascript',
        body: fs.readFileSync(path.join(__dirname, 'config.test.js'), 'utf8').replace('CLASSIC_ADMIN: true', 'CLASSIC_ADMIN: false') });
      const f = path.join(ROOT, rel);
      if (fs.existsSync(f) && fs.statSync(f).isFile())
        return route.fulfill({ status: 200, body: fs.readFileSync(f),
          contentType: f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : undefined });
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto('http://app.test/index.html');
  await page.waitForTimeout(2500);
  const t = [];
  const inp = '.field:has(#ptype) .pt-search .pp-in';
  await page.evaluate(r => goTo('region', r), R0.regionId); await page.waitForTimeout(400);
  const sale = () => page.evaluate(b => saleModal({ bookId: b, isPreorder: false, loc: CUR_LOC }), BK[1]);
  await sale(); await page.waitForTimeout(400);
  t.push(['the payment type is a search box (the list behind it hidden)', await page.isVisible(inp) && !(await page.isVisible('#ptype'))]);
  await page.click(inp); await page.fill(inp, 'pay'); await page.waitForTimeout(150);
  t.push(['typing narrows the list', await page.evaluate(() => { const r = [...document.querySelectorAll('.field:has(#ptype) .pt-search .pp-row:not(.pp-add):not(.pp-head)')].map(x => x.dataset.v); return r.length > 0 && r.every(v => /pay/i.test(v) || v === 'Mixed'); })]);
  await page.fill(inp, 'Revolut'); await page.waitForTimeout(150);
  t.push(['Universal is offered "＋ Add “Revolut”"', /Add “Revolut”/.test(await page.textContent('.field:has(#ptype) .pt-search .pp-add'))]);
  await page.click('.field:has(#ptype) .pt-search .pp-add'); await page.waitForTimeout(1200);
  t.push(['…which chooses it on the sale', await page.evaluate(() => $('#ptype').value === 'Revolut' && document.querySelector('.field:has(#ptype) .pt-search .pp-in').value === 'Revolut')]);
  const regTypes = () => m.call({ action: 'getState', season: st.activeSeason }).state.regions.find(r => r.regionId === R0.regionId).payTypes;
  const rt = regTypes();
  t.push(['…and the region keeps it, before Other (' + rt.join(', ') + ')', rt.includes('Revolut') && rt.indexOf('Revolut') < rt.indexOf('Other')]);
  await page.evaluate(() => closeModal()); await page.evaluate(() => pull()); await page.waitForTimeout(1200);
  await sale(); await page.waitForTimeout(400);
  t.push(['…and it is there on the next sale', await page.evaluate(() => [...$('#ptype').options].some(o => o.value === 'Revolut'))]);
  await page.evaluate(() => { const s = $('#ptype'); s.value = 'Mixed'; }); await page.waitForTimeout(50);
  t.push(['setting the type by code shows in the search', await page.evaluate(() => /Mixed/.test(document.querySelector('.field:has(#ptype) .pt-search .pp-in').value))]);
  for (const w of [390, 1100]) {
    await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(300);
    const over = await page.evaluate(() => { const m = document.querySelector('#modal'); return [...m.querySelectorAll('*')].filter(e => e.offsetParent && e.getBoundingClientRect().right > m.getBoundingClientRect().right + 1).map(e => e.className || e.tagName).slice(0, 3); });
    t.push(['no overflow in the sale window at ' + w + 'px' + (over.length ? ' — ' + over.join(' | ') : ''), !over.length]);
  }
  await page.evaluate(() => closeModal()); await page.waitForTimeout(300);
  // Edit Payment Types: typed in "Add another", then Save without pressing Add.
  await page.evaluate(() => payTypesModal()); await page.waitForTimeout(300);
  await page.fill('#ptNew', 'Bizum'); await page.click('#ptSave'); await page.waitForTimeout(1200);
  t.push(['a type typed but not added is kept on Save', regTypes().includes('Bizum')]);
  await page.evaluate(() => payTypesModal()); await page.waitForTimeout(300);
  await page.fill('#ptNew', 'Twint'); await page.press('#ptNew', 'Enter'); await page.waitForTimeout(150);
  t.push(['Enter adds it to the list', await page.evaluate(() => [...document.querySelectorAll('#modal .pt-box')].some(b => b.value === 'Twint' && b.checked))]);
  await page.evaluate(() => closeModal());
  t.push(['no errors in the page' + (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''), !errors.length]);
  await browser.close();
  let bad = 0;
  t.forEach(([n, ok]) => { if (!ok) bad++; console.log((ok ? '  ok   ' : '  FAIL ') + n); });
  console.log(bad ? `\n${bad} failed` : `\nall ${t.length} passed`);
  process.exit(bad ? 1 : 0);
})();
