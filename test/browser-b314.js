/* Optional, needs Playwright + Chromium: node test/browser-b314.js
   b314 (Live app changes): a region with no chosen title list shows only
   the titles it has had, not every title added at Earthly HQ (Gita: Italy);
   Reorganize Menu names items as the menu shows them. */
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
// The region never had a list ticked (as Italy), and a new title arrives elsewhere.
c({ action: 'editRegion', regionId: R0.regionId, name: R0.name, currencies: (R0.currencies || ['USD']).join(','), books: '' });
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
  const B0 = B;
  try {
    await page.goto('http://app.test/index.html'); await page.waitForTimeout(2500);
    const R0id = await page.evaluate(() => STATE.regions.find(r => r.regionId !== HQ_REGION).regionId);
    await page.evaluate(R0id => goTo('region', R0id), R0id); await page.waitForTimeout(800);
    const shelf = await page.evaluate(() => shelfBooks().map(b => b.id));
    const all = await page.evaluate(() => STATE.books.filter(b => !b.partnerId).length);
    t.push(['a region with no list shows the titles it has had (' + shelf.length + ' of ' + all + ')', shelf.includes(B0) && shelf.length < all]);
    // A brand-new region with nothing yet still offers every title.
    const fresh = await page.evaluate(() => { const r = { regionId: 'rg_new', books: [], whLoc: 'wh_new' }; return carriedIds(r) === null; });
    t.push(['a region with nothing yet still offers every title', fresh]);
    t.push(['Earthly HQ still holds every title', await page.evaluate(() => carriedIds(regionById(HQ_REGION) || { regionId: HQ_REGION }) === null)]);
    // Add Stock and Change Prices follow the same list.
    const ps = await page.evaluate(async () => { pricesModal(); await new Promise(r => setTimeout(r, 600)); const n = new Set([...document.querySelectorAll('#modal .rp[data-book]')].map(i => i.dataset.book)); closeModal(); return [...n]; });
    t.push(['Change Prices lists the same titles (' + ps.length + ')', ps.includes(B0) && ps.length < all]);
    /* Reorganize Menu: the names the menu shows. */
    const mo = await page.evaluate(async () => { menuOrderModal(); await new Promise(r => setTimeout(r, 300));
      const x = [...document.querySelectorAll('#moList .mo-row')].map(r => r.innerText.replace(/⠿\s*/, '').trim()); closeModal(); return x; });
    t.push(['Reorganize Menu says "Edit Location", not "Edit / Rename"', mo.some(x => /Edit Location/.test(x)) && !mo.some(x => /Rename/.test(x))]);
    const menu = await page.evaluate(() => [...document.querySelectorAll('#sideNav .sn-group .sn-item .sn-t')].map(x => x.textContent.trim()));
    const odd = menu.filter(n => !mo.some(x => x.endsWith(n)) && !/^(Close|Reopen|Delete) /.test(n));
    t.push(['every menu item at this level is in Reorganize Menu by the same name' + (odd.length ? ' (missing: ' + odd.join(', ') + ')' : ''), !odd.length]);
  } catch (e) { t.push(['STOPPED: ' + e.message, false]); }
  t.push(['no page errors' + (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''), !errors.length]);
  let bad = 0;
  t.forEach(([n, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; });
  console.log(bad ? bad + ' failed' : 'all ' + t.length + ' passed');
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('STOPPED ' + e.stack); process.exit(1); });
