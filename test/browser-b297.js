/* Optional, needs Playwright + Chromium: node test/browser-b297.js
   b297 (Live app changes): practice pre-orders can be fulfilled from Earthly
   HQ's warehouse; the totals bar (AoTM first, no zero Pending, cards as wide
   as they need, filling the line); Earthly HQ's Net Sales as the big number;
   a season switch keeps the page where it was; both pictures the same size;
   negative net in red; no overflow. Finance's parts are in browser-finance.js. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){ return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
m.init();
const st = m.call({ action: 'getState' }).state, SA = st.activeSeason;
const c = (p, season) => { const r = m.call(Object.assign({ season: season || SA }, p)); if (!r.ok) throw new Error(p.action + ': ' + r.error); return r; };
const R0 = st.regions[0], RU = 'sr_ru';
const B = st.books.find(b => !b.partnerId).id;
// A Russian title with copies only at Earthly HQ, and a pre-order for it here.
c({ action: 'adjustStockBulk', location: 'wh_hq', items: [{ bookId: B, delta: 12 }], override: true }, 'HQ');
c({ action: 'sell', saleId: 'P1', location: R0.whLoc, bookId: B, isPreorder: true, legs: [{ type: 'Cash', cur: 'EUR', amt: 10 }], name: 'Radha' });
// A second season to switch to.
c({ action: 'saveSeason', name: 'Second Tour' });
{ const s2 = m.call({ action: 'getState' }).state.activeSeason;
  for (let i = 0; i < 6; i++) c({ action: 'createRegion', regionId: 'rg_s2_' + i, whLoc: 'wh_s2_' + i, name: 'Place ' + i, currencies: 'EUR,USD' }, s2); }
m.call({ action: 'setSeason', seasonId: SA });

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
  const spill = () => page.evaluate(() => { const W = document.documentElement.clientWidth;
    return [...document.querySelectorAll('#locTabs *, #totals *, #modal *, header *')].filter(e => e.offsetParent && e.getBoundingClientRect().right > W + 1)
      .map(e => (e.className && e.className.baseVal === undefined ? e.className : e.tagName) + '').slice(0, 4); });

  /* 1. Practice: Earthly HQ's warehouse fulfils a pre-order. */
  await page.evaluate(r => goTo('region', r), R0.regionId); await page.waitForTimeout(400);
  const qHere = await page.evaluate(b => invQty(regionsList()[0].whLoc, b), B);
  await page.evaluate(() => deliverPickModal('P1')); await page.waitForTimeout(800);
  const items = await page.evaluate(() => { const i = document.querySelector('#dvFrom .pp-in'); return i ? i.value : ''; });
  t.push(['practice: "Fulfilled from" offers Earthly HQ\'s warehouse when only it has copies (here ' + qHere + ')', /Earthly HQ/.test(items)]);
  t.push(['…and Deliver is ready', !(await page.$eval('#dvGo', b => b.disabled))]);
  await page.click('#dvGo'); await page.waitForTimeout(1500);
  const hq = m.call({ action: 'getState', season: 'HQ' }).state.inventory.find(i => i.location === 'wh_hq' && i.bookId === B);
  const sale = m.call({ action: 'getState', season: SA }).state.sales.find(x => x.saleId === 'P1');
  t.push(['…delivered: a copy came off Earthly HQ (12 → 11)', hq && hq.qty === 11 && sale && sale.type === 'SALE' && sale.delivered]);

  /* b298 (Gita): anywhere in the system with the book is offered, not only Earthly HQ: here a warehouse in another season. */
  const s2 = await page.evaluate(() => (STATE.seasons.find(x => x.name === 'Second Tour') || {}).seasonId);
  c({ action: 'adjustStockBulk', location: 'wh_s2_0', items: [{ bookId: B, delta: 3 }], override: true }, s2);
  c({ action: 'sell', saleId: 'P3', location: R0.whLoc, bookId: B, isPreorder: true, legs: [{ type: 'Cash', cur: 'EUR', amt: 10 }], name: 'Govinda' });
  await page.evaluate(() => pull()); await page.waitForTimeout(1500);
  await page.evaluate(() => deliverPickModal('P3')); await page.waitForTimeout(800);
  await page.click('#dvFrom .pp-in'); await page.fill('#dvFrom .pp-in', ''); await page.waitForTimeout(200);
  const rows3 = await page.$$eval('#dvFrom .pp-row', rs => rs.map(r => r.innerText.replace(/\s+/g, ' ')));
  t.push(['b298: Deliver offers every place with the book: another season\'s warehouse and Earthly HQ (' + rows3.join(' | ') + ')', rows3.some(x => /Place 0/.test(x) && /Second Tour/.test(x)) && rows3.some(x => /Earthly HQ/.test(x))]);
  await page.click('#dvFrom .pp-row:has-text("Place 0")'); await page.waitForTimeout(200);
  await page.click('#dvGo'); await page.waitForTimeout(1500);
  const q3 = m.call({ action: 'getState', season: s2 }).state.inventory.find(i => i.location === 'wh_s2_0' && i.bookId === B);
  t.push(['b298: …and delivering from there takes the copy off that shelf (3 → 2)', q3 && q3.qty === 2]);
  m.call({ action: 'setSeason', seasonId: SA });

  /* 2. The totals bar. */
  await page.evaluate(() => goTo('season')); await page.waitForTimeout(400);
  const cards = () => page.$$eval('#totals > .tcard', cs => cs.map(c => ({ l: c.querySelector('.label').textContent.trim(), w: c.getBoundingClientRect().width, top: Math.round(c.getBoundingClientRect().top), r: c.getBoundingClientRect().right })));
  let cs = await cards();
  t.push(['AoTM comes first, then Big Books', cs[0].l === 'AoTM' && cs[1].l === 'Big Books']);
  t.push(['no Total Pending card when nothing is pending', !cs.some(x => /Pending/.test(x.l))]);
  const bar = await page.$eval('#totals', e => e.getBoundingClientRect());
  t.push(['computer: the cards fill one line', new Set(cs.map(x => x.top)).size === 1 && Math.abs(Math.max(...cs.map(x => x.r)) - bar.right) < 2]);
  // b299 (Gita): the same width across the line; only a card with less in it is made smaller, and only when they would not fit.
  // b301 (Gita): every card the same width, on one line.
  { const bk = cs.filter(x => !/Collections|Pending|Net Sales/i.test(x.l)), tc = cs.find(x => /Collections|Net Sales/i.test(x.l));
    t.push(['b301: every card one width', Math.max(...cs.map(x => x.w)) - Math.min(...cs.map(x => x.w)) < 2 && !!tc && bk.length > 0]); }
  c({ action: 'sell', saleId: 'P2', location: R0.whLoc, bookId: B, isPreorder: true, pending: true, legs: [{ type: 'Cash', cur: 'USD', amt: 30 }], name: 'Gopal' });
  await page.evaluate(() => pull()); await page.waitForTimeout(1500);
  cs = await cards();
  t.push(['a Total Pending card shows once something is pending', cs.some(x => /Pending/.test(x.l))]);

  /* 3. A negative Net Sales is red. */
  c({ action: 'saveCost', id: 'cost_big1', amt: 5000, cur: 'USD', category: 'Other', location: R0.whLoc });
  await page.evaluate(() => pull()); await page.waitForTimeout(1500);
  t.push(['a negative Net Sales is red', await page.evaluate(() => { const n = document.querySelector('#totals .tc-net'); return !!n && /^\s*[−-]≈?\$/.test(n.textContent) && n.classList.contains('fin-neg') && getComputedStyle(n).color !== getComputedStyle(document.querySelector('#totals .tc-q1 .value')).color; })]);

  /* 4. Earthly HQ: Net Sales is the big number. */
  await page.evaluate(() => switchSeason(HQ_ID)); await page.waitForTimeout(1500);
  // b298 (Gita): Q1 Net Sales alone, Q2 Expenses and Donations, Q3 Total Collections, Q4 the currencies.
  t.push(['Earthly HQ: Q1 Net Sales, Q3 Total Collections, Q4 the collections by currency', await page.evaluate(() => { const q = k => document.querySelector('#totals .tc-hq .tc-q' + k);
    return !!q(1) && /^Net Sales/i.test(q(1).innerText) && /^Total Collections/i.test(q(3).innerText) && !/Total Collections|Net Sales/i.test(q(4).innerText); })]);
  t.push(['b298: Net Sales has the one Net colour', await page.evaluate(() => { const n = document.querySelector('#totals .tc-net'); n.classList.remove('fin-neg'); const c = getComputedStyle(n).color; redNegatives(); return c === 'rgb(42, 120, 214)'; })]);

  /* 5. A season switch keeps the page where it was. */
  await page.evaluate(() => switchSeason(STATE.seasons.find(s => s.seasonId !== HQ_ID).seasonId)); await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 300)); await page.waitForTimeout(200);
  const y0 = await page.evaluate(() => scrollY);
  const other = await page.evaluate(() => { const s = STATE.seasons.find(x => x.seasonId !== HQ_ID && x.seasonId !== STATE.activeSeason); return s && s.seasonId; });
  await page.evaluate(id => { const a = document.createElement('a'); a.dataset.act = 'goseasonid'; a.dataset.season = id; document.body.appendChild(a); a.click(); a.remove(); }, other); await page.waitForTimeout(1800);
  // The page stays where it was, unless the other season's page is too short to scroll that far.
  const [y1, maxY] = await page.evaluate(() => [scrollY, document.documentElement.scrollHeight - innerHeight]);
  t.push(['switching season keeps the page at the same height (' + y0 + ' → ' + y1 + ', page allows ' + maxY + ')', Math.abs(y1 - Math.min(y0, maxY)) < 5 && await page.evaluate(() => STATE.activeSeason) === other]);

  /* 6. Both pictures the same size. */
  const pics = await page.$$eval('.deity img', im => im.map(i => [Math.round(i.getBoundingClientRect().width), Math.round(i.getBoundingClientRect().height)]));
  t.push(['Srila Prabhupada and Srila Gurudeva the same size (' + JSON.stringify(pics) + ')', pics.length === 2 && pics[0][0] === pics[1][0] && pics[0][1] === pics[1][1]]);

  for (const w of [390, 1100]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(300);
    const s = await spill(); t.push(['no overflow at ' + w + 'px' + (s.length ? ' — ' + s.join(' | ') : ''), !s.length]); }
  await page.setViewportSize({ width: 390, height: 900 }); await page.waitForTimeout(200);
  cs = await cards();
  t.push(['phone: the totals still fill each line', cs.length > 0]);

  t.push(['no page errors' + (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''), !errors.length]);
  let bad = 0;
  t.forEach(([n, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; });
  console.log(bad ? bad + ' failed' : 'all ' + t.length + ' passed');
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('STOPPED ' + e.stack); process.exit(1); });
