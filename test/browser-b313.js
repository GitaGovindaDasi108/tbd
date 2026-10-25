/* Optional, needs Playwright + Chromium: node test/browser-b313.js
   b313 (Live app changes): Change Prices picks the place with drop-downs
   only (Gita chose on a card): Season with Earthly HQ first, Region, Event
   with "Whole region", the same at Earthly HQ, a season, a region and an event. */
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
  const RATES = { USD: 1, EUR: 0.9, PLN: 4, GBP: 0.8, INR: 88, MKD: 55 };
  const rates = () => page.evaluate(R => { STATE.rates = Object.assign({}, STATE.rates, { perUsd: R }); }, RATES);
  const ovf = () => page.evaluate(() => { const W = document.documentElement.clientWidth, mb = document.querySelector('#modal .m-body');
    const r = mb ? mb.getBoundingClientRect().right : W;
    return [...document.querySelectorAll('#modal *')].filter(e => e.offsetParent && (e.getBoundingClientRect().right > W + 1 || e.getBoundingClientRect().right > r + 1)).length; });
  try {
    await page.goto('http://app.test/index.html'); await page.waitForTimeout(2500); await rates();
    const R0id = await page.evaluate(() => STATE.regions.find(r => r.regionId !== HQ_REGION).regionId);
    const look = () => page.evaluate(() => ({ tabs: document.querySelectorAll('#ppTabs [data-pp-k]').length,
      sn: (document.querySelector('#ppSn') || {}).value, snFirst: ((document.querySelector('#ppSn') || {}).options || [])[0] ? document.querySelector('#ppSn').options[0].textContent : '',
      reg: (document.querySelector('#ppReg') || {}).value, ev: (document.querySelector('#ppEv') || { value: null }).value,
      body: document.querySelector('#ppBody').innerText.slice(0, 50) }));
    const open = async js => { await page.evaluate(js); await page.waitForTimeout(800); await page.evaluate(() => pricesModal()); await page.waitForTimeout(500); return look(); };

    /* Change Prices: drop-downs only, the same at all four levels (Gita chose on a card). */
    const hq = await open(`(async()=>{ await switchSeason(HQ_ID); goTo('region', HQ_REGION); })()`);
    t.push(['at Earthly HQ: no tabs; Season drop-down on "Earthly HQ", first in the list (' + JSON.stringify(hq) + ')', hq.tabs === 0 && hq.sn === '__hq' && hq.snFirst === 'Earthly HQ' && hq.reg === undefined && /CURRENCIES/i.test(hq.body)]);
    await page.evaluate(() => { const s = document.querySelector('#ppSn'); s.value = s.options[1].value; s.onchange(); }); await page.waitForTimeout(1500);
    const hq2 = await look();
    t.push(['…choosing a season shows its Region and Event drop-downs, on the region (' + JSON.stringify(hq2) + ')', hq2.reg && hq2.ev === '' && /CURRENCIES/i.test(hq2.body)]);
    await page.evaluate(() => closeModal());
    const sn = await open(`(async()=>{ await switchSeason(STATE.seasons.find(s => s.seasonId !== HQ_ID).seasonId); goTo('season'); })()`);
    t.push(['at a season: no tabs; Season, Region and Event (Whole region) drop-downs (' + JSON.stringify(sn) + ')', sn.tabs === 0 && sn.sn && sn.sn !== '__hq' && sn.reg && sn.ev === '' && /CURRENCIES/i.test(sn.body)]);
    await page.evaluate(() => closeModal()); await rates();
    const rg = await open(`goTo('region', '${R0id}')`);
    t.push(['at a region: the same, on that region (' + rg.reg + ')', rg.tabs === 0 && rg.reg === R0id && rg.ev === '']);
    await page.evaluate(() => { const s = document.querySelector('#ppEv'); s.value = s.options[1].value; s.onchange(); }); await page.waitForTimeout(300);
    const pick = await look();
    t.push(['…choosing an event shows its prices', pick.ev && /Type a price only where this event/.test(await page.evaluate(() => document.querySelector('#ppBody').innerText))]);
    await page.evaluate(() => { const s = document.querySelector('#ppEv'); s.value = ''; s.onchange(); }); await page.waitForTimeout(300);
    t.push(['…and "Whole region" goes back to the region', /CURRENCIES/i.test((await look()).body)]);
    await page.evaluate(() => closeModal());
    const evId = await page.evaluate(R0id => (STATE.events.find(e => e.regionId === R0id && !/^wh_/.test(e.eventId) && !e.closedAt) || {}).eventId, R0id);
    const ev = await open(`goTo('event', '${evId}')`);
    t.push(['at an event: the same, on that event (' + ev.ev + ')', ev.tabs === 0 && ev.ev === evId && ev.reg === R0id]);
    await page.evaluate(() => { const s = document.querySelector('#ppSn'); s.value = '__hq'; s.onchange(); }); await page.waitForTimeout(800);
    const back = await look();
    t.push(['…and Earthly HQ can be picked from there', back.sn === '__hq' && back.reg === undefined && /CURRENCIES/i.test(back.body)]);
    for (const w of [390, 1150]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(200);
      t.push(['no overflow at ' + w + 'px', (await ovf()) === 0]); }
    await page.evaluate(() => closeModal());
    t.push(['Edit Location keeps its tabs (not asked to change)', await page.evaluate(async () => { placeEditModal(); await new Promise(r => setTimeout(r, 300)); const n = document.querySelectorAll('#ppTabs [data-pp-k]').length; closeModal(); return n > 1; })]);
  } catch (e) { t.push(['STOPPED: ' + e.message, false]); }
  t.push(['no page errors' + (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''), !errors.length]);
  let bad = 0;
  t.forEach(([n, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; });
  console.log(bad ? bad + ' failed' : 'all ' + t.length + ' passed');
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('STOPPED ' + e.stack); process.exit(1); });
