/* Optional, needs Playwright + Chromium: node test/browser-b308.js
   b308 (Live app changes): a partial delivery's boxes start empty, and a
   partly delivered batch has a "Remaining to Be Delivered" WhatsApp report;
   Net Sales by Season keeps "Show Currencies ▸" on two lines, only Net Sales
   blue and the season names in view while it scrolls; a closed region's
   dollars (its closing-day rates) show as estimates (≈). */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){ return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
m.init();
const st = m.call({ action: 'getState' }).state, SA = st.activeSeason;
const c = (p, season) => { const r = m.call(Object.assign({ season: season || SA }, p)); if (!r.ok) throw new Error(p.action + ': ' + r.error); return r; };
const R0 = st.regions[0], R0name = R0.name;
const B = st.books.find(b => !b.partnerId).id;
c({ action: 'adjustStockBulk', location: R0.whLoc, items: [{ bookId: B, delta: 10 }], override: true });
c({ action: 'createRegion', regionId: 'rg_two', whLoc: 'wh_two', name: 'Second Region', currencies: 'EUR' });
c({ action: 'sendShipment', shipId: 'sh_b308', mode: 'devotee', fromRegion: R0.regionId, toRegion: 'rg_two', toLoc: 'wh_two', carrier: 'Narada', items: [{ bookId: B, qty: 5 }] });
c({ action: 'receiveShipment', shipId: 'sh_b308', toLoc: 'wh_two', items: [{ bookId: B, qty: 2 }] });
c({ action: 'createRegion', regionId: 'rg_old', whLoc: 'wh_old', name: 'Old Region', currencies: 'EUR' });
c({ action: 'adjustStockBulk', location: 'wh_old', items: [{ bookId: B, delta: 3 }], override: true });
c({ action: 'sell', location: 'wh_old', bookId: B, legs: [{ type: 'Cash', cur: 'EUR', amt: 20 }] });
c({ action: 'closeLocation', kind: 'region', id: 'rg_old' });
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
  const state = (s) => m.call({ action: 'getState', season: s || SA }).state;
  try {
    await page.goto('http://app.test/index.html'); await page.waitForTimeout(2500);

    /* 1. Partial delivery: the boxes start empty, and the batch has a report of what is still to come. */
    await page.evaluate(() => goTo('region', 'rg_two')); await page.waitForTimeout(500);
    await page.evaluate(() => shipReceiveModal('sh_b308', true)); await page.waitForTimeout(300);
    const pd = await page.$$eval('#modal .rc-q', a => a.map(i => i.value + '|' + i.placeholder));
    t.push(['partial delivery: the number boxes start empty (' + pd.join(', ') + ')', pd.length > 0 && pd.every(v => v === '|0')]);
    await page.evaluate(() => closeModal());
    await page.evaluate(() => shipmentsModal()); await page.waitForTimeout(400);
    const rb = await page.$('[data-act="shremain"][data-id="sh_b308"]');
    t.push(['a partly delivered batch has "📋 Remaining to Be Delivered"', !!rb]);
    if (rb) { await page.evaluate(() => document.querySelector('[data-act="shremain"][data-id="sh_b308"]').click()); await page.waitForTimeout(300); }
    const rep = await page.$eval('#repText', e => e.value).catch(() => '');
    t.push(['…its report lists what is still to come (' + rep.replace(/\n/g, ' / ') + ')', /REMAINING TO BE DELIVERED/.test(rep) && / - 3 \(2 of 5 arrived\)/.test(rep) && /Total - 3 of 5 still to come/.test(rep)]);
    await page.evaluate(() => closeModal());

    /* 2. Earthly HQ's Net Sales by Season. */
    await page.evaluate(() => document.querySelector('[data-act="gohq"]').click()); await page.waitForTimeout(1500);
    const ns = await page.evaluate(() => { const p = document.querySelector('[data-fold="sumCollBy"]'), b = p.querySelector('.cbr-tgb');
      const lh = parseFloat(getComputedStyle(b).lineHeight) || 13;
      const blue = [...p.querySelectorAll('tbody td.usd')].map(td => [td.classList.contains('cbr-net'), getComputedStyle(td).color]);
      const net = blue.filter(x => x[0]).map(x => x[1]), other = blue.filter(x => !x[0]).map(x => x[1]);
      const th = p.querySelector('tbody th');
      return { lines: Math.round(b.getBoundingClientRect().height / lh), net: [...new Set(net)], other: [...new Set(other)], sticky: getComputedStyle(th).position }; });
    t.push(['Show Currencies ▸ on two lines (' + ns.lines + ')', ns.lines <= 2]);
    t.push(['only Net Sales is blue (' + ns.net.join() + ' / ' + ns.other.join(' ') + ')', ns.net.length === 1 && !ns.other.includes(ns.net[0])]);
    t.push(['the season names stay in view as it scrolls (' + ns.sticky + ')', ns.sticky === 'sticky']);

    /* 3. A closed region's dollars are at its closing-day rates: an estimate. */
    await page.evaluate(s => switchSeason(s), SA); await page.waitForTimeout(1500);
    const ex = await page.evaluate(() => { const x = STATE.sales.find(s => s.location === 'wh_old'), r = regionById('rg_old');
      if (r && !r.rates) r.rates = { USD: 1, EUR: 0.9 };   // (this test server has no live rates to freeze)
      return { frozen: !!frozenAt('wh_old'), exact: usdExact(x) }; });
    t.push(['closed region: its closing-day rates count as an estimate (' + JSON.stringify(ex) + ')', ex.frozen && ex.exact === false]);
    const cbr = await page.evaluate(() => { const r = [...document.querySelectorAll('table.cbr tbody tr')].find(tr => /Old Region/.test(tr.textContent)); return r ? r.querySelector('td.usd').textContent : '(none)'; });
    t.push(['…and Collections by Region shows it with ≈ (' + cbr + ')', /≈/.test(cbr)]);
  } catch (e) { t.push(['STOPPED: ' + e.message, false]); }

  t.push(['no page errors' + (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''), !errors.length]);
  let bad = 0;
  t.forEach(([n, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; });
  console.log(bad ? bad + ' failed' : 'all ' + t.length + ' passed');
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('STOPPED ' + e.stack); process.exit(1); });
