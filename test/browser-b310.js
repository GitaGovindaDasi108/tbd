/* Optional, needs Playwright + Chromium: node test/browser-b310.js
   b310 (Live app changes): the transfer log says where books went from and
   to ("Earthly HQ to Vrindavana"), "Outside the system" for the rest; a Books
   in Transit WhatsApp report (practice) with a choice of batches and, for a
   partly delivered one, of what arrived and what is still coming; Donations
   not bold in Net Sales; a sub-region's old warehouse not listed twice in the
   WhatsApp place search; the price calculator works from another currency
   when a title has no local price; currency codes that don't exist are
   refused; Reorganize Menu lists no section or item the menu doesn't have;
   Change Prices is live (Gita chose on a card), with Event Prices inside it. */
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
c({ action: 'createRegion', regionId: 'rg_two', whLoc: 'wh_two', name: 'Second Region', currencies: 'EUR,USD' });
c({ action: 'sendShipment', shipId: 'sh_b310', mode: 'devotee', fromRegion: R0.regionId, toRegion: 'rg_two', toLoc: 'wh_two', carrier: 'Narada', items: [{ bookId: B, qty: 5 }] });
c({ action: 'receiveShipment', shipId: 'sh_b310', toLoc: 'wh_two', items: [{ bookId: B, qty: 2 }] });
c({ action: 'sendShipment', shipId: 'sh_outx', mode: 'shipping', fromRegion: 'OUTSIDE', toRegion: 'rg_two', toLoc: 'wh_two', items: [{ bookId: B, qty: 3 }] });
c({ action: 'receiveShipment', shipId: 'sh_outx', toLoc: 'wh_two', items: [{ bookId: B, qty: 3 }] });
c({ action: 'createEvent', eventId: 'wh_subold', name: 'Bcn (warehouse)', regionId: R0.regionId });
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
  const RATES = { USD: 1, EUR: 0.9, PLN: 4, GBP: 0.8, INR: 88 };
  'AUD CAD CHF CZK DKK HUF JPY MKD NOK NZD RON SEK SGD THB TRY ZAR AED BRL MXN'.split(' ').forEach((k, i) => RATES[k] = 1 + i);
  const rates = () => page.evaluate(R => { STATE.rates = Object.assign({}, STATE.rates, { perUsd: R }); }, RATES);
  try {
    await page.goto('http://app.test/index.html'); await page.waitForTimeout(2500);

    /* 1. The transfer log: from and to, and "Outside the system". */
    await page.evaluate(() => goTo('region', 'rg_two')); await page.waitForTimeout(400);
    await page.evaluate(() => transferLogModal()); await page.waitForTimeout(300);
    let log = await page.$$eval('#modal .tl-w', a => a.map(x => x.textContent.trim()));
    t.push(['arrivals read "' + R0name + ' to Second Region" (' + log.join(' | ') + ')', log.includes('⬇ ' + R0name + ' to Second Region')]);
    t.push(['a batch from beyond the tour reads "Outside the system to Second Region"', log.includes('⬇ Outside the system to Second Region')]);
    await page.evaluate(r => { closeModal(); goTo('region', r); transferLogModal(); }, R0.regionId); await page.waitForTimeout(300);
    log = await page.$$eval('#modal .tl-w', a => a.map(x => x.textContent.trim()));
    t.push(['sent: "' + R0name + ' to Second Region (sent in transit)" (' + log.join(' | ') + ')', log.includes('⬆ ' + R0name + ' to Second Region (sent in transit)')]);
    await page.evaluate(() => closeModal());

    /* 2. Books in Transit for WhatsApp (practice only). */
    await page.evaluate(() => goTo('region', 'rg_two')); await page.waitForTimeout(400);
    t.push(['live (b311): the Books in Transit report button shows', await page.evaluate(() => !document.querySelector('#transitPanel [data-act="transitrep"]').hidden)]);
    await page.evaluate(() => transitReportModal()); await page.waitForTimeout(300);
    const nb = await page.$$eval('#modal [data-trs]', a => a.length), ns = await page.$$eval('#modal [data-trp]', a => a.length);
    t.push(['one batch to choose, with Books That Arrived / Books Still in Transit under it', nb === 1 && ns === 2]);
    let rep = await page.$eval('#repText', b => b.value);
    t.push(['the report names who brings it and both lists', /\*Narada\*/.test(rep) && /Books That Arrived:\n.* - 2 of 5/.test(rep) && /Books Still in Transit:\n.* - 3/.test(rep)]);
    await page.uncheck('#modal [data-trp][data-k="arr"]'); await page.waitForTimeout(100);
    rep = await page.$eval('#repText', b => b.value);
    t.push(['Books That Arrived unticked: left out', !/Books That Arrived/.test(rep) && /Books Still in Transit/.test(rep)]);
    await page.uncheck('#modal [data-trs]'); await page.waitForTimeout(100);
    t.push(['the batch unticked: nothing chosen, and its two choices fold away', await page.$eval('#repText', b => b.value) === '(nothing chosen)' && await page.$eval('#modal .tr-sub', d => d.hidden)]);
    await page.evaluate(() => closeModal());

    /* 3. Donations are not bold in Net Sales by Season. */
    const fw = await page.evaluate(() => { const d = document.createElement('div'); document.body.appendChild(d); renderNetBySeason(d);
      const don = d.querySelector('td.cbr-don'), net = d.querySelector('td.cbr-net'); const r = [getComputedStyle(don).fontWeight, getComputedStyle(net).fontWeight]; d.remove(); return r; });
    t.push(['Donations not bold (' + fw.join(' / ') + '), Net Sales still bold', fw[0] === '400' && Number(fw[1]) >= 700]);

    /* 4. A sub-region's old warehouse is the sub-region in the WhatsApp place search. */
    const wp = await page.evaluate(r => { STATE.subRegions = { regions: { [r]: [{ id: 'sr_b', name: 'Bcn' }] }, events: { wh_subold: 'sr_b' } };
      const o = {}; o[STATE.activeSeason] = STATE; return waPlaces(o).filter(p => /Bcn/.test(p.l)).map(p => p.l + (p.tag ? ' [' + p.tag + ']' : '')); }, R0.regionId);
    t.push(['"Bcn" listed once, as a Sub-region (' + wp.join(', ') + ')', wp.length === 1 && wp[0] === 'Bcn [Sub-region]']);
    await page.evaluate(() => { STATE.subRegions = null; });

    /* 5. The calculator works from another currency, and made-up currencies are refused. */
    c({ action: 'editRegion', regionId: 'rg_two', name: 'Second Region', currencies: 'EUR,USD', books: '', prices: { [B]: { USD: 40, EUR: 0 } } });
    await page.evaluate(() => pull()); await page.waitForTimeout(1500); await rates();
    await page.evaluate(() => { goTo('region', 'rg_two'); pricesModal(); }); await page.waitForTimeout(400);
    const eur = await page.$eval(`#modal .rp[data-book="${B}"][data-cur="EUR"]`, i => i.value);
    t.push(['priced only in dollars (EUR saved as 0): the local EUR box worked out (' + eur + ')', eur === '36']);
    await page.click('#rgCur'); await page.keyboard.press('End'); await page.keyboard.type(', GBP, LGB');
    await page.click(`#modal .rp[data-book="${B}"][data-cur="USD"]`); await page.waitForTimeout(200);
    const cv = await page.evaluate(B => ({ v: document.querySelector('#rgCur').value, err: document.querySelector('#modalErr').textContent,
      gbp: (document.querySelector(`#modal .rp[data-book="${B}"][data-cur="GBP"]`) || {}).value, lgb: !!document.querySelector('#modal .rp[data-cur="LGB"]') }), B);
    t.push(['"LGB" refused with a note, GBP kept (' + cv.v + ' · ' + cv.err + ')', !/LGB/.test(cv.v) && /GBP/.test(cv.v) && /"LGB" is not a currency/.test(cv.err) && !cv.lgb]);
    t.push(['the new GBP column is worked out (' + cv.gbp + ')', cv.gbp === '32']);
    await page.evaluate(() => closeModal());

    /* 6. Reorganize Menu: only what the menu has. */
    await page.evaluate(() => menuOrderModal()); await page.waitForTimeout(300);
    const mo = await page.evaluate(() => ({ secs: [...document.querySelectorAll('#moList .mo-sec')].map(s => s.dataset.sec), rows: [...document.querySelectorAll('#moList .mo-row')].map(r => r.dataset.a) }));
    t.push(['no Settings section (Profile is at the foot of the menu): ' + mo.secs.join(', '), !mo.secs.includes('settings') && !mo.rows.includes('whoami')]);
    t.push(['Change Prices listed, Event Prices (now inside it) not', mo.rows.includes('prices') && !mo.rows.includes('eventprices')]);
    await page.evaluate(() => closeModal());
    /* Change Prices on live (Gita chose on a card): opens where you are, with the tabs. */
    await page.evaluate(() => { goTo('region', 'rg_two'); pricesModal(); }); await page.waitForTimeout(400);
    const cp = await page.evaluate(() => ({ tabs: [...document.querySelectorAll('#ppTabs .seg-b')].map(b => b.textContent), on: (document.querySelector('#ppTabs .on') || {}).textContent, reg: (document.querySelector('#ppReg') || {}).value }));
    t.push(['live Change Prices: tabs ' + cp.tabs.join('/') + ', opened at the region you are in', cp.tabs.includes('Region') && cp.on === 'Region' && cp.reg === 'rg_two']);
    t.push(['live: the menu has Change Prices and no separate Event Prices', await page.evaluate(() => { goTo('event', (STATE.events.find(e => !e.closedAt) || {}).eventId); return !!document.querySelector('#sideNav [data-act="prices"]') && !document.querySelector('#sideNav [data-act="eventprices"]'); })]);
    await page.evaluate(() => closeModal());

    /* 7. Practice: the report button by the title. */
    await page.goto('http://app.test/index.html?practice'); await page.waitForTimeout(2500);
    await page.evaluate(() => goTo('region', 'rg_two')); await page.waitForTimeout(400);
    t.push(['practice: 📋 by "Books in Transit"', await page.evaluate(() => !document.querySelector('#transitPanel [data-act="transitrep"]').hidden)]);
    await page.click('#transitPanel [data-act="transitrep"]'); await page.waitForTimeout(300);
    for (const w of [390, 1150]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(200);
      const o = await page.evaluate(() => { const W = document.documentElement.clientWidth, mb = document.querySelector('#modal .m-body').getBoundingClientRect();
        return [...document.querySelectorAll('#modal *')].filter(e => e.offsetParent && (e.getBoundingClientRect().right > W + 1 || e.getBoundingClientRect().right > mb.right + 1)).length; });
      t.push(['no overflow in the report at ' + w + 'px', o === 0]); }
  } catch (e) { t.push(['STOPPED: ' + e.message, false]); }
  t.push(['no page errors' + (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''), !errors.length]);
  let bad = 0;
  t.forEach(([n, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; });
  console.log(bad ? bad + ' failed' : 'all ' + t.length + ' passed');
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('STOPPED ' + e.stack); process.exit(1); });
