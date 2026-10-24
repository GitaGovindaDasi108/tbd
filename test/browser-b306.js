/* Optional, needs Playwright + Chromium: node test/browser-b306.js
   b306 (Live app changes): Earthly HQ's Net Sales by Season and its report,
   three title cards to a row there, Arrange one section at a time, books in
   transit on the warehouse that sent them, the price calculator keeping
   prices typed by hand, and in practice the Transfer log's sub-warehouse
   moves, Edit Location and Change Prices. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){ return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
m.init();
const st = m.call({ action: 'getState' }).state, SA = st.activeSeason;
const c = (p, season) => { const r = m.call(Object.assign({ season: season || SA }, p)); if (!r.ok) throw new Error(p.action + ': ' + r.error); return r; };
const R0 = st.regions[0], R0name = R0.name;
const B = st.books.find(b => !b.partnerId).id;
c({ action: 'createEvent', eventId: 'ev_one', name: 'First Fair', regionId: R0.regionId });
c({ action: 'adjustStockBulk', location: R0.whLoc, items: [{ bookId: B, delta: 10 }], override: true });
c({ action: 'saveHolder', regionId: R0.regionId, name: 'Bhakti', newHolderId: 'hd_bhak01' });
c({ action: 'transferMulti', moves: [{ from: R0.whLoc, to: 'hd_bhak01', bookId: B, qty: 2 }] });
c({ action: 'createRegion', regionId: 'rg_two', whLoc: 'wh_two', name: 'Second Region', currencies: 'EUR' });
const R1 = { regionId: 'rg_two', whLoc: 'wh_two' };
c({ action: 'sendShipment', shipId: 'sh_b306', mode: 'devotee', fromRegion: R0.regionId, toRegion: R1.regionId, toLoc: R1.whLoc, carrier: 'Narada', items: [{ bookId: B, qty: 3 }] });
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
  const spill = () => page.evaluate(() => { const W = document.documentElement.clientWidth;
    return [...document.querySelectorAll('#modal *')].filter(e => e.offsetParent && e.getBoundingClientRect().right > W + 1).length; });
  try {
    await page.goto('http://app.test/index.html'); await page.waitForTimeout(2500);
    await page.evaluate(() => document.querySelector('[data-act="gohq"]').click()); await page.waitForTimeout(1500);

    /* 1. Earthly HQ: Net Sales by Season, with Expenses, Donations and Net Sales. */
    const ns = await page.evaluate(() => { const p = document.querySelector('[data-fold="sumCollBy"]');
      return { h: p.querySelector('h2').innerText, th: [...p.querySelectorAll('thead th')].map(x => x.innerText.trim()), part: p.querySelector('.sec-rep').dataset.part,
        foot: [...p.querySelectorAll('tfoot td')].slice(-1)[0].innerText, card: (document.querySelector('.tc-hq .tc-net')||{}).innerText }; });
    t.push(['HQ: "Net Sales by Season" (' + ns.h.replace(/\s+/g, ' ') + ')', /^Net Sales by Season/.test(ns.h)]);
    t.push(['…columns end Gross Collections, Expenses, Donations, Net Sales (b307) (' + ns.th.slice(-4).join(', ') + ')', ns.th.slice(-4).join('|').toUpperCase() === 'GROSS COLLECTIONS|EXPENSES|DONATIONS|NET SALES']);
    t.push(['…all seasons\' Net Sales matches the totals card (' + ns.foot + ' / ' + ns.card + ')', Math.abs(parseFloat(ns.foot.replace(/[^\d.]/g, '')) - parseFloat(ns.card.replace(/[^\d.]/g, ''))) < 0.01]);
    const rep = await page.evaluate(() => { let out = ''; withRollup(() => { out = buildReport('netseason'); }); return out; });
    t.push(['…its WhatsApp report lists Net Sales by season', /NET SALES BY SEASON/.test(rep) && /Net Sales - /.test(rep)]);

    /* 2. HQ Distribution by Title: three to a row at 1400px. */
    await page.setViewportSize({ width: 1400, height: 900 }); await page.evaluate(() => renderAll()); await page.waitForTimeout(400);
    const per = await page.evaluate(() => { const cs = [...document.querySelectorAll('#hqTitleList .stat-grid > .qcard')];
      return cs.length < 3 ? 1 : new Set(cs.slice(0, 3).map(c => Math.round(c.getBoundingClientRect().top))).size; });
    t.push(['HQ Distribution by Title: three cards to a row (' + JSON.stringify(per) + ')', per === 1]);
    await page.setViewportSize({ width: 1150, height: 900 });

    /* 3. Arrange opens only its own section. */
    await page.evaluate(s => switchSeason(s), SA); await page.waitForTimeout(1500);
    await page.evaluate(r => goTo('region', r), R0.regionId); await page.waitForTimeout(500);
    await page.evaluate(() => document.querySelector('#invGrid').closest('.panel').querySelector('.arr-tg').click()); await page.waitForTimeout(300);
    t.push(['Arrange on the shelf opens only the shelf', await page.evaluate(() => !!document.querySelector('#invGrid.arranging, #invGrid .arranging') && document.querySelectorAll('.arranging').length === 1)]);
    await page.evaluate(() => document.querySelector('#arrDock [data-act="arrange"]').click()); await page.waitForTimeout(200);
    t.push(['…Done closes it', await page.evaluate(() => !document.querySelector('.arranging') && ARRANGE === '')]);

    /* 4. In transit shows on the warehouse that sent it too. */
    t.push(['the sending warehouse shows "In transit (sent): 3"', await page.evaluate(b => /In transit \(sent\): 3/.test(document.querySelector(`#invGrid [data-id="${b}"]`).innerText), B)]);

    /* 5. The region price calculator keeps prices typed by hand. */
    await page.evaluate(() => regionModal(currentRegion())); await page.waitForTimeout(300);
    const cal = await page.evaluate(b => { const cur = document.querySelector('#rgCur').value.split(',').map(x => x.trim());
      const box = c => document.querySelector(`#modal .rp[data-book="${b}"][data-cur="${c}"]`);
      const loc = box(cur[0]), oth = cur.slice(1).map(box).filter(Boolean)[0];
      if(!oth) return { skip: true };
      const fire = (el, ev) => el.dispatchEvent(new Event(ev, { bubbles: true }));
      oth.value = '77'; fire(oth, 'input');
      loc.value = '30'; fire(loc, 'input');
      const kept = oth.value === '77';
      oth.value = ''; fire(oth, 'input'); fire(oth, 'focusout');
      const refilled = oth.value !== '' && oth.classList.contains('rp-auto');
      loc.value = ''; fire(loc, 'input');
      const emptied = oth.value === '';
      loc.value = '40'; fire(loc, 'input');
      return { kept, refilled, emptied, back: oth.value !== '' }; }, B);
    t.push(['calculator: a price typed by hand is not changed by the local price', cal.skip || cal.kept]);
    t.push(['…emptied, it is filled back in from the local price', cal.skip || cal.refilled]);
    t.push(['…and follows the local price again, emptied and retyped', cal.skip || (cal.emptied && cal.back)]);
    await page.evaluate(() => closeModal());

    /* 6. The book estimator: the money left after the Big Books makes Adventures. (browser-b293 has the rest.) */

    /* 7. Refresh: who you are is kept on the device. */
    t.push(['who you are is kept for the next refresh', await page.evaluate(() => !signedInHere() || !!ME_CACHE.get())]);

    /* 8. Practice. */
    await page.goto('http://app.test/index.html?practice'); await page.waitForTimeout(2500);
    await page.evaluate(r => goTo('region', r), R0.regionId); await page.waitForTimeout(600);
    await page.click('#invHeading .tl-btn'); await page.waitForTimeout(300);
    const tl = await page.$$eval('#modal .tl-row', rs => rs.map(r => ({ cls: r.className, s: r.querySelector('summary').innerText.replace(/\s+/g, ' ') })));
    t.push(['practice Transfer log: the move to devotee storage is a sub-warehouse move (' + tl.map(r => r.s).join(' | ') + ')', tl.some(r => /sub/.test(r.cls) && /Bhakti/.test(r.s) && /2 books/.test(r.s))]);
    await page.evaluate(() => closeModal());
    const el = await page.evaluate(() => { const h = document.body.innerHTML; return { pe: /data-act="placeedit"/.test(h), er: (h.match(/.{80}data-act="editregion".{40}/g) || []) }; });
    t.push(['practice: Edit Location replaces Edit Region' + (el.er.length ? ' — ' + el.er.join(' | ') : ''), el.pe && !el.er.length]);
    t.push(['practice: Change Prices in Laksmi', await page.evaluate(() => /data-act="prices"/.test(document.body.innerHTML))]);
    await page.evaluate(() => placeEditModal()); await page.waitForTimeout(400);
    t.push(['Edit Location: Earthly HQ (b307), Season, Region and Event tabs', (await page.$$eval('#ppTabs [data-pp-k]', b => b.map(x => x.dataset.ppK))).join() === 'hq,season,region,event']);
    await page.evaluate(() => document.querySelector('#ppTabs [data-pp-k="region"]').click()); await page.waitForTimeout(200);
    await page.selectOption('#ppReg', R0.regionId); await page.waitForTimeout(200);
    t.push(['…a region is its name and dates only', await page.evaluate(() => !!document.querySelector('#ppName') && !document.querySelector('#modal #rgCur'))]);
    await page.fill('#ppName', R0.name + ' Renamed'); await page.click('#ppSave'); await page.waitForTimeout(1500);
    t.push(['…and saves the new name', state().regions.some(r => r.regionId === R0.regionId && r.name === R0.name + ' Renamed')]);
    await page.evaluate(() => pricesModal()); await page.waitForTimeout(400);
    t.push(['Change Prices: Earthly HQ (b307), Region and Event tabs', (await page.$$eval('#ppTabs [data-pp-k]', b => b.map(x => x.dataset.ppK))).join() === 'hq,region,event']);
    await page.evaluate(() => document.querySelector('#ppTabs [data-pp-k="region"]').click()); await page.waitForTimeout(200);
    await page.selectOption('#ppReg', R0.regionId); await page.waitForTimeout(200);
    const cur0 = await page.$eval('#rgCur', i => i.value.split(',')[0].trim());
    await page.fill(`#modal .rp[data-book="${B}"][data-cur="${cur0}"]`, '33'); await page.click('#ppSave'); await page.waitForTimeout(1500);
    t.push(['…a region\'s price saves', Number(((state().prices || {})[R0.regionId] || {})[B] && state().prices[R0.regionId][B][cur0]) === 33]);
    await page.evaluate(() => pricesModal()); await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('#ppTabs [data-pp-k="event"]').click()); await page.waitForTimeout(200);
    await page.selectOption('#ppReg', R0.regionId); await page.waitForTimeout(200);
    await page.selectOption('#ppEv', 'ev_one'); await page.waitForTimeout(200);
    await page.fill(`#modal .ep[data-book="${B}"][data-cur="${cur0}"]`, '29'); await page.click('#ppSave'); await page.waitForTimeout(1500);
    t.push(['…an event\'s own price saves', Number((((state().eventPrices || {}).ev_one || {})[B] || {})[cur0]) === 29]);
    for (const w of [390, 1150]) { await page.setViewportSize({ width: w, height: 900 }); await page.evaluate(() => pricesModal()); await page.waitForTimeout(400);
      t.push(['Change Prices: no overflow at ' + w + 'px', await spill() === 0]); await page.evaluate(() => closeModal()); }
  } catch (e) { t.push(['STOPPED: ' + e.message, false]); }

  t.push(['no page errors' + (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''), !errors.length]);
  let bad = 0;
  t.forEach(([n, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; });
  console.log(bad ? bad + ' failed' : 'all ' + t.length + ' passed');
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('STOPPED ' + e.stack); process.exit(1); });
