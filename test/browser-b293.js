/* Optional, needs Playwright + Chromium: node test/browser-b293.js
   b293 (Live app changes): the path at the top as links with a ▾ of the others
   at each level, closed places last A to Z, Finance's path the same as Sales',
   Uncategorized Sales (practice), Reimbursement Settings as squares, the short
   phone date, Spanish not green, Reorganize Menu without old items, and no
   overflow on a phone or a computer. Finance's path and the Settings squares
   are in browser-finance.js. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){ return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
m.init();
const st = m.call({ action: 'getState' }).state, SA = st.activeSeason;
const c = p => { const r = m.call(Object.assign({ season: SA }, p)); if (!r.ok) throw new Error(p.action + ': ' + r.error); return r; };
const R0 = st.regions[0];
// A second and third region (Zagreb closed, so it sorts last), and three events in Poland (Alpha closed).
c({ action: 'createRegion', regionId: 'rg_cro', whLoc: 'wh_cro', name: 'Croatia', currencies: 'EUR,USD' });
c({ action: 'createRegion', regionId: 'rg_ams', whLoc: 'wh_ams', name: 'Amsterdam', currencies: 'EUR,USD' });
c({ action: 'createEvent', eventId: 'ev_a', name: 'Alpha Fair', regionId: R0.regionId });
c({ action: 'createEvent', eventId: 'ev_z', name: 'Zeta Fest', regionId: R0.regionId });
c({ action: 'createEvent', eventId: 'ev_m', name: 'Mela', regionId: R0.regionId });
c({ action: 'closeLocation', kind: 'event', id: 'ev_a', counts: {} });
c({ action: 'closeLocation', kind: 'region', id: 'rg_ams' });

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
  await page.goto('http://app.test/index.html?practice');
  await page.waitForTimeout(2500);
  const t = [];
  const links = () => page.$$eval('#locTabs .crumb-link', l => l.map(x => x.textContent));
  const opts = sel => page.$$eval(sel + ' option', o => o.map(x => x.textContent.trim()));
  const spill = () => page.evaluate(() => { const W = document.documentElement.clientWidth;
    return [...document.querySelectorAll('#locTabs *, #fpNav *, #fpBody *, #totals *, #modal *')].filter(e => e.offsetParent && e.getBoundingClientRect().right > W + 1)
      .map(e => (e.className && e.className.baseVal === undefined ? e.className : e.tagName) + '').slice(0, 4); });

  /* 1. The path as links. */
  await page.evaluate(r => goTo('region', r), R0.regionId); await page.waitForTimeout(400);
  t.push(['region: the path reads Earthly HQ › Europe Tour › Poland, each a link', JSON.stringify(await links()) === JSON.stringify(['🌍 Earthly HQ', 'Europe Tour', 'Poland'])]);
  t.push(['…then an Events… drop-down', (await opts('#locTabs select.crumb-sel[data-act="pickloc"]'))[0] === 'Events…']);
  t.push(['…the ▾ beside Poland lists the other regions, closed Amsterdam last', JSON.stringify(await opts('#locTabs .crumb-more [data-act="pickregion"]')) === JSON.stringify(['Poland', 'Croatia', 'Amsterdam ✓', '＋ New region…'])]);
  t.push(['closed places last, then A to Z: Mela, Zeta Fest, then Alpha Fair', JSON.stringify(await opts('#locTabs select.crumb-sel[data-act="pickloc"]')) === JSON.stringify(['Events…', 'Zeta Fest', 'Mela', 'Alpha Fair ✓', '＋ New event…'])]);
  await page.selectOption('#locTabs select.crumb-sel[data-act="pickloc"]', 'ev_m'); await page.waitForTimeout(400);
  t.push(['an event: Mela is the last link, its ▾ listing the other events', (await links()).join(' › ') === '🌍 Earthly HQ › Europe Tour › Poland › Mela'
    && await page.$eval('#locTabs .crumb-more [data-act="pickloc"]', s => s.value) === 'ev_m']);
  await page.click('#locTabs .crumb-link[data-act="goregion"]'); await page.waitForTimeout(400);
  t.push(['Poland\'s link goes up to the region', await page.evaluate(() => CUR_LEVEL === 'region' && CUR_REGION === 'rg_poland')]);
  await page.click('#locTabs .crumb-link[data-act="goseason"]'); await page.waitForTimeout(400);
  t.push(['Europe Tour\'s link goes up to the season, even with it already chosen', await page.evaluate(() => CUR_LEVEL === 'season')]);
  t.push(['…where the path ends in a Regions… drop-down', (await opts('#locTabs select.crumb-sel[data-act="pickregion"]'))[0] === 'Regions…']);
  await page.selectOption('#locTabs select.crumb-sel[data-act="pickregion"]', 'rg_cro'); await page.waitForTimeout(400);
  t.push(['choosing Croatia there opens it', await page.evaluate(() => CUR_LEVEL === 'region' && CUR_REGION === 'rg_cro')]);
  for (const w of [390, 1100]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(250);
    const s = await spill(); t.push(['no overflow in the path at ' + w + 'px' + (s.length ? ' — ' + s.join(' | ') : ''), !s.length]); }
  await page.setViewportSize({ width: 390, height: 900 }); await page.mouse.move(380, 890);
  await page.evaluate(() => { document.body.classList.remove('sn-open'); goTo('event', 'ev_m'); }); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(require('os').tmpdir(), 'tbs-b293-path-phone.png') });
  await page.setViewportSize({ width: 1100, height: 900 });

  /* 2. Uncategorized Sales (practice). */
  await page.evaluate(r => goTo('region', r), R0.regionId); await page.waitForTimeout(400);
  const big0 = await page.evaluate(() => Number(document.querySelector('#totals .tcard .value').firstChild.textContent));
  t.push(['practice: "+ Uncategorized Sales" under the shelf', await page.isVisible('[data-act="uncat"]')]);
  await page.click('[data-act="uncat"]'); await page.waitForTimeout(300);
  await page.selectOption('#ucCur', 'USD'); await page.fill('#ucAmt', '1111'); await page.waitForTimeout(100);
  t.push(['1111 at $40 a Big Book fills in 27 books, ticked as an estimate', await page.$eval('#ucN', i => i.value) === '27' && await page.$eval('#ucEst', i => i.checked)]);
  t.push(['…and says how it was worked out', /\$40/.test(await page.textContent('#ucHow')) && /27 books/.test(await page.textContent('#ucHow'))]);
  for (const w of [390, 1100]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(200);
    const s = await spill(); t.push(['no overflow in the window at ' + w + 'px' + (s.length ? ' — ' + s.join(' | ') : ''), !s.length]); }
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.click('#ucSave'); await page.waitForTimeout(1500);
  const row = (m.call({ action: 'getState', season: SA }).state.sales || []).find(x => x.type === 'UNCAT');
  t.push(['saved on the server: 27 books, $1111, an estimate, nothing off a shelf', row && row.qty === 27 && row.p1amt === 1111 && row.est === true && row.bookId === '']);
  t.push(['Big Books sold goes up by 27', await page.evaluate(() => Number(document.querySelector('#totals .tcard .value').firstChild.textContent)) === big0 + 27]);
  const card = await page.evaluate(() => { const c = [...document.querySelectorAll('#totals .tcard')].find(x => /Uncategorized Sales/.test(x.textContent)); return c ? c.textContent.replace(/\s+/g, ' ') : ''; });
  t.push(['an Uncategorized Sales card shows 27 books, $1,111', /27\s*books/.test(card) && /\$1,111/.test(card) && /estimate/.test(card)]);
  t.push(['the sales log names it', /Uncategorized sales · 27 books \(estimate\)/.test(await page.textContent('#log'))]);
  const rep = await page.evaluate(() => buildReport(''));
  t.push(['the WhatsApp report counts it among the Big Books', /Uncategorized sales \(estimate\) - 27/.test(rep)]);
  await page.setViewportSize({ width: 390, height: 900 }); await page.waitForTimeout(250);
  { const s = await spill(); t.push(['no overflow in the totals at 390px' + (s.length ? ' — ' + s.join(' | ') : ''), !s.length]); }
  await page.mouse.move(380, 890); await page.evaluate(() => { document.body.classList.remove('sn-open'); document.querySelector('#totals').scrollIntoView(); });
  await page.screenshot({ path: path.join(require('os').tmpdir(), 'tbs-b293-uncat-phone.png'), fullPage: false });
  await page.setViewportSize({ width: 1100, height: 900 });

  /* 3. Finance's path and Reimbursement Settings are checked in browser-finance.js (they need sign-in). */
  t.push(['Dollars received is no longer practice-only', await page.evaluate(() => !/PRACTICE/.test(finEstMark.toString()))]);
  await page.setViewportSize({ width: 390, height: 900 }); await page.waitForTimeout(200);
  t.push(['phone: an expense date reads MM/DD/YY', await page.evaluate(() => { const d = document.createElement('div');
    d.innerHTML = '<span class="fx-d"><span class="fx-dl">2026-10-22</span><span class="fx-ds">' + finShortDate('2026-10-22') + '</span></span>'; document.body.appendChild(d);
    const ok = getComputedStyle(d.querySelector('.fx-dl')).display === 'none' && d.querySelector('.fx-ds').textContent === '10/22/26' && getComputedStyle(d.querySelector('.fx-ds')).display !== 'none'; d.remove(); return ok; })]);
  await page.setViewportSize({ width: 1100, height: 900 });

  /* 5. Small ones. */
  t.push(['Spanish is no longer green (deep rose)', await page.evaluate(() => LANG_HUES[2] === '#A33F6B')]);
  await page.evaluate(() => { closeModal(); menuOrderModal(); }); await page.waitForTimeout(400);
  const listed = await page.evaluate(() => [...document.querySelectorAll('#moList .mo-row')].map(r => r.dataset.a));
  t.push(['Reorganize Menu lists no items that are gone (Finance To do, Edit Book Display, Record Costs)', listed.length > 5 && !listed.some(a => ['fintodo', 'bookdisplay', 'costs'].includes(a))]);

  t.push(['no page errors' + (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''), !errors.length]);
  let bad = 0;
  t.forEach(([n, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; });
  console.log(bad ? bad + ' failed' : 'all ' + t.length + ' passed');
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('STOPPED ' + e.stack); process.exit(1); });
