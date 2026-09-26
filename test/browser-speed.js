/* Optional, needs Playwright + Chromium: node test/browser-speed.js
   Does each step of Add Stock appear at once, even when the server takes two
   seconds to answer (typical for Apps Script)? Uses the same tour as
   browser-addstock.js. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-addstock-' + n + '.png');

// ---- The tour: two seasons, regions with events, one closed region. ----
m.init();
const ok = (r, what) => { if (!r.ok) throw new Error(what + ': ' + r.error); return r; };
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason;
const books = st.books.filter(b => !b.partnerId);
const pl = st.regions[0];
ok(m.call({ action: 'createEvent', eventId: 'ev_fest', name: 'Festival', regionId: pl.regionId, season: SA }), 'event');
ok(m.call({ action: 'createRegion', regionId: 'rg_it', whLoc: 'wh_it', name: 'Italy', currencies: 'EUR,USD',
  books: books.slice(0, 2).map(b => b.id).join(','), season: SA }), 'italy');
ok(m.call({ action: 'createEvent', eventId: 'ev_yoga', name: 'Yoga Studio', regionId: 'rg_it', season: SA }), 'yoga');
ok(m.call({ action: 'createRegion', regionId: 'rg_es', whLoc: 'wh_es', name: 'Spain', currencies: 'EUR,USD', season: SA }), 'spain');
ok(m.call({ action: 'closeLocation', kind: 'region', id: 'rg_es', season: SA }), 'close spain');
ok(m.call({ action: 'saveSeason', name: 'Year-Round Sales' }), 'season 2');
st = m.call({ action: 'getState' }).state;
const SB = st.seasons.find(s => s.name === 'Year-Round Sales').seasonId;
ok(m.call({ action: 'createRegion', regionId: 'rg_kr', whLoc: 'wh_kr', name: 'Krakow', currencies: 'PLN,USD', season: SB }), 'krakow');
m.call({ action: 'setSeason', seasonId: SA });
const coordKey = ok(m.call({ action: 'setKey', kind: 'region', id: 'rg_it' }), 'key').result;
const qty = (loc, bookId) => { const r = (m.call({ action: 'getState', season: SA }).state.inventory || [])
  .concat(m.call({ action: 'getState', season: SB }).state.inventory || [])
  .find(i => i.location === loc && i.bookId === bookId); return r ? Number(r.qty) : 0; };


const LAG = 2000;   // a typical Apps Script round trip
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.on('dialog', d => d.accept());
  const log = [];
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.includes('script.google.com')) {
      let p = {}; try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      log.push((Date.now()%100000)+' '+p.action+(p.season?' season='+p.season:''));
      await new Promise(r => setTimeout(r, LAG));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(m.call(p)) });
    }
    if (url.startsWith('http://app.test/')) {
      const f = path.join(ROOT, new URL(url).pathname.replace(/^\/+/, '') || 'index.html');
      if (fs.existsSync(f) && fs.statSync(f).isFile())
        return route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : 'text/javascript' });
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto('http://app.test/index.html'); await page.waitForTimeout(12000);
  const time = async (what, act, ready) => {
    const t0 = Date.now(); await act();
    await page.waitForFunction(ready, null, { timeout: 30000, polling: 20 });
    const ms = Date.now()-t0;
    results.push([what.trim(), ms]);
  };
  const results = [];
  await page.evaluate(() => addStockModal()); await page.waitForTimeout(300);
  // same season region -> not there yet
  await page.click('#spPlace .pp-in'); await page.fill('#spPlace .pp-in', 'Italy');
  await time('pick Italy (this season)', () => page.click('#spPlace .pp-row.pp-region:has-text("Italy")'),
    () => !document.querySelector('#spWhereWrap').hidden && !/Opening/.test(document.querySelector('#spBody').textContent));
  await time('choose "Not there yet" (this season)', () => page.selectOption('#spWhere','transit'),
    () => !!document.querySelector('#spBody .sp-q'));
  // other season
  await page.click('#spPlace .pp-in'); await page.fill('#spPlace .pp-in', 'Krakow');
  await time('pick Krakow (other season) until form usable', async () => { await page.click('#spPlace .pp-row:has-text("Krakow")'); },
    () => !!document.querySelector('#spBody .sp-q'));
  await time('...until its latest counts are in, in the background', async () => {},
    () => !document.querySelector('#spSave').disabled);
  // add new -> region (this season)
  await page.click('#modal .linkish'); await page.waitForTimeout(200);
  await page.click('#modal .opt[data-new="region"]');
  await time('Add new > Region > Continue (this season)', () => page.click('#anGo'),
    () => /New region/.test((document.querySelector('#modal h3')||{}).textContent||''));
  await page.evaluate(() => addNewPlaceModal('stock')); await page.waitForTimeout(200);
  await page.click('#modal .opt[data-new="region"]');
  await page.selectOption('#anSeasonPick', {label:'Year-Round Sales'});
  await time('Add new > Region > Continue (other season)', () => page.click('#anGo'),
    () => /New region/.test((document.querySelector('#modal h3')||{}).textContent||'') && document.querySelector('#overlay').classList.contains('show'));
  // Instant means well under the 2-second server round trip.
  results.forEach(([what, ms]) => {
    const limit = /latest counts/.test(what) ? 4000 : 600;
    console.log((ms < limit ? 'PASS' : 'FAIL'), what, '—', ms + ' ms');
  });
  await browser.close();
})();
