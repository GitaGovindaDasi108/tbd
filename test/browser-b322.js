/* Optional, needs Playwright + Chromium: node test/browser-b322.js
   b322 (Gita, 2026-11-02): at a closed place the sales and money stay locked,
   but Edit still opens the name, phone and notes of a sale (practice). */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){ return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
m.init();
const st = m.call({ action: 'getState' }).state, SA = st.activeSeason;
const c = (p, season) => { const r = m.call(Object.assign({ season: season || SA }, p)); if (!r.ok) throw new Error(p.action + ': ' + r.error); return r; };
const R0 = st.regions[0];
const B = st.books.find(b => !b.partnerId).id;
c({ action: 'createRegion', regionId: 'rg_old', whLoc: 'wh_old', name: 'Old Region', currencies: 'EUR' });
c({ action: 'adjustStockBulk', location: 'wh_old', items: [{ bookId: B, delta: 3 }], override: true });
c({ action: 'sell', saleId: 'sl_owed', location: 'wh_old', bookId: B, legs: [{ type: 'Cash', cur: 'EUR', amt: 5 }], dueamt: 15, duecur: 'EUR',
    name: 'Syamasundara Dasa from a very long village name', phone: '+48111222333', comments: 'Will pay at the next programme', override: true });
c({ action: 'sell', saleId: 'sl_pre', location: 'wh_old', bookId: B, isPreorder: true, legs: [{ type: 'Cash', cur: 'EUR', amt: 20 }], name: 'Lalita', override: true });
c({ action: 'closeLocation', kind: 'region', id: 'rg_old' });
let bad = 0;
(async () => {
  const browser = await chromium.launch();
  for (const W of [390, 1150]) {
  const page = await browser.newPage({ viewport: { width: W, height: 900 } });
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
  const sale = id => m.call({ action: 'getState', season: SA }).state.sales.find(s => s.saleId === id) || {};
  try {
    await page.goto('http://app.test/index.html?practice'); await page.waitForTimeout(2500);
    await page.evaluate(() => goTo('region', 'rg_old')); await page.waitForTimeout(600);
    t.push(['the closed note says notes can still be edited', /names, phones and notes/.test(await page.textContent('.closed-note'))]);
    await page.evaluate(() => document.querySelector('[data-act="editsale"][data-id="sl_owed"]').click()); await page.waitForTimeout(400);
    const mo = await page.evaluate(() => { const m = document.querySelector('#modal');
      const over = [...m.querySelectorAll('*')].filter(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'auto' && e.tagName !== 'TEXTAREA' && e.tagName !== 'INPUT').map(e => e.className || e.tagName);
      return { title: m.querySelector('h3').textContent, name: (m.querySelector('#snName')||{}).value, money: !!m.querySelector('#pamt, #ptype, #dueamt'),
               over, page: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    });
    t.push(['Edit at a closed region opens "Edit notes" (' + mo.title + ')', /^Edit notes/.test(mo.title) && /Syamasundara/.test(mo.name)]);
    t.push(['…with no money boxes in it', !mo.money]);
    t.push(['…and nothing overflows (' + mo.over.join() + ')', !mo.over.length && !mo.page]);
    await page.screenshot({ path: path.join(require('os').tmpdir(), 'tbs-b322-notes-' + W + '.png') });
    await page.fill('#snCom', 'Paying on Sunday ' + W); await page.click('#snSave'); await page.waitForTimeout(1200);
    const s = sale('sl_owed');
    t.push(['saving changes the notes on the server', s.comments === 'Paying on Sunday ' + W]);
    t.push(['…and leaves the money as it was', Number(s.p1amt) === 5 && Number(s.dueamt) === 15]);
    // A pre-order's name can't be emptied: it has to be traced to the person.
    await page.evaluate(() => document.querySelector('[data-act="editsale"][data-id="sl_pre"]').click()); await page.waitForTimeout(400);
    await page.fill('#snName', ''); await page.click('#snSave'); await page.waitForTimeout(300);
    t.push(['a pre-order still needs a name', /name/.test(await page.textContent('#modalErr'))]);
    await page.evaluate(() => closeModal());
    // Delete is still refused.
    await page.evaluate(() => document.querySelector('[data-act="delsale"][data-id="sl_owed"]').click()); await page.waitForTimeout(300);
    t.push(['Delete is still refused at a closed place', !!sale('sl_owed').saleId]);
    // The live app is unchanged: Edit there still says the place is closed.
    await page.goto('http://app.test/index.html'); await page.waitForTimeout(2500);
    await page.evaluate(() => goTo('region', 'rg_old')); await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector('[data-act="editsale"][data-id="sl_owed"]').click()); await page.waitForTimeout(400);
    t.push(['live: Edit at a closed place is still refused (no change there yet)', !(await page.$('#snCom'))]);
  } catch (e) { t.push(['ran without error: ' + e.message, false]); }
  t.push(['no page errors (' + errors.join(' | ') + ')', !errors.length]);
  t.forEach(([w, ok]) => { if (!ok) bad++; console.log((ok ? 'PASS ' : 'FAIL ') + W + 'px ' + w); });
  await page.close();
  }
  await browser.close();
  console.log(bad ? bad + ' failed' : 'all passed');
  process.exit(bad ? 1 : 0);
})();
