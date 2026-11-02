/* Optional, needs Playwright + Chromium: node test/browser-b323.js
   b323 (Make over Earthly HQ, practice; Gita: "We will never actually sell
   directly from Earthly HQ ... remove the sales log ... Have it just be a
   summary, but with a to-do list summary that is usable"): in practice HQ has
   no Sales Portal, and a To Do Summary tops the Summaries Portal, one line per
   place, every season, opening to the items, with Go › to the place. The live
   app keeps its Sales Portal. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-b323-' + n + '.png');

m.init();
const st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason, pl = st.regions[0], B = st.books[0].id, B1 = st.books[1].id;
const c = p => { const r = m.call(p); if (!r.ok) throw new Error(p.action + ': ' + r.error); return r; };
c({ action: 'setStockBulk', season: SA, location: pl.whLoc, items: [{ bookId: B, qty: 9 }], override: true });
c({ action: 'sell', season: SA, saleId: 'S1', location: pl.whLoc, bookId: B, legs: [{ type: 'Cash', cur: 'PLN', amt: 150 }], pending: true, name: 'Arjuna', phone: '+48 1' });
c({ action: 'sell', season: SA, saleId: 'S3', location: pl.whLoc, bookId: B, legs: [{ type: 'Cash', cur: 'PLN', amt: 200 }], changeamt: 50, changecur: 'PLN', override: true });
const S2 = c({ action: 'saveSeason', name: 'Year-Round' }).result;
c({ action: 'createRegion', season: S2, regionId: 'rg_bcn', whLoc: 'wh_bcn', name: 'Barcelona', currencies: 'EUR' });
c({ action: 'createEvent', season: S2, eventId: 'ev_rath', regionId: 'rg_bcn', name: 'Ratha Yatra' });
c({ action: 'sell', season: S2, saleId: 'S2', location: 'ev_rath', bookId: B, isPreorder: true, legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }], name: 'Gopal' });
c({ action: 'sendShipment', season: S2, shipId: 'sh_bcn', mode: 'devotee', fromRegion: 'OUTSIDE', origin: 'the printer',
    toRegion: 'rg_bcn', toLoc: 'wh_bcn', carrier: 'Narada', items: [{ bookId: B, qty: 3 }] });
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
  const visible = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return !!e && e.offsetParent !== null && e.offsetHeight > 0; }, sel);
  const text = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return e ? e.innerText : ''; }, sel);
  const overflow = page => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1
    || [...document.querySelectorAll('#hqTodoPanel *')].some(e => e.offsetParent && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'auto' && getComputedStyle(e).overflowX !== 'scroll'));
  try {
    const live = await open(1150, false);
    t.push(['live: Sales Portal still there, no To Do Summary', await visible(live, '#salesPortal .portal-h') && !(await visible(live, '#hqTodoPanel'))]);
    await live.close();

    for (const w of [1150, 390]) {
      const page = await open(w, true);
      t.push([w + ': practice: no Sales Portal, no Sales Log at HQ', !(await visible(page, '#salesPortal')) && !(await visible(page, '#log'))]);
      t.push([w + ': To Do Summary is first in the Summaries Portal', await visible(page, '#hqTodoPanel')
        && await page.evaluate(() => document.querySelector('#summaryFlow .panel').id === 'hqTodoPanel')]);
      const tabs = await text(page, '#hqTodoBody .todo-tabs');
      console.log('   tabs: ' + tabs.replace(/\s+/g, ' '));
      t.push([w + ': four kinds with counts', /Pending Payments\s*1/.test(tabs) && /Pre-Orders\s*1/.test(tabs) && /Change We Owe\s*1/.test(tabs) && /Books in Transit\s*3/.test(tabs)]);
      const body = await text(page, '#hqTodoBody');
      t.push([w + ': lines name the place with its season', /Europe Tour ›/.test(body) && /Year-Round › Barcelona › Ratha Yatra/.test(body) && /Year-Round › Barcelona/.test(body)]);
      t.push([w + ': amounts owed shown (150 zł, 50 zł change)', /150/.test(body) && /50/.test(body)]);
      await page.click('#hqTodoBody .k-pending summary'); await page.waitForTimeout(200);
      t.push([w + ': a line opens to its items (Arjuna)', /Arjuna/.test(await text(page, '#hqTodoBody .k-pending .htd-items'))]);
      t.push([w + ': nothing overflows', !(await overflow(page))]);
      await page.screenshot({ path: shot('hq-' + w), fullPage: true });
      if (w === 1150) {
        await page.click('#hqTodoBody .todo-tab.tt-transit'); await page.waitForTimeout(300);
        t.push(['a kind hides from its chip', !(await page.$('#hqTodoBody .k-transit'))]);
        await page.click('#hqTodoBody .todo-tab.tt-transit'); await page.waitForTimeout(300);
        await page.click('[data-act="hqtodoreport"]'); await page.waitForTimeout(300);
        const rep = await page.evaluate(() => (document.querySelector('#repText') || {}).value || '');
        t.push(['📋 report lists every kind by place', /PAYMENTS PENDING/.test(rep) && /BOOKS IN TRANSIT/.test(rep) && /Ratha Yatra: 1/.test(rep)]);
        await page.evaluate(() => closeModal());
        await page.click('#hqTodoBody .k-pre .htd-go'); await page.waitForTimeout(2500);
        t.push(['Go › opens Ratha Yatra in its own season', await page.evaluate(() => CUR_LEVEL === 'event' && CUR_LOC === 'ev_rath')]);
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
