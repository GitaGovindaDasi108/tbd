/* Optional, needs Playwright + Chromium: node test/browser-transfer.js
   Transfer Existing Stock in a real browser, against the real Code.gs (via
   mini.js): all four kinds of transfer, sub-warehouse columns and bubbles,
   selling from a sub-warehouse, and what a regional link may do. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-transfer-' + n + '.png');

// ---- The tour ----
m.init();
const ok = (r, what) => { if (!r.ok) throw new Error(what + ': ' + r.error); return r; };
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason;
const books = st.books.filter(b => !b.partnerId);
const B0 = books[0].id, B1 = books[1].id;
const pl = st.regions[0];
ok(m.call({ action: 'createEvent', eventId: 'ev_fest', name: 'Festival', regionId: pl.regionId, season: SA }), 'fest');
ok(m.call({ action: 'createEvent', eventId: 'ev_tmp', name: 'Temple', regionId: pl.regionId, season: SA }), 'temple');
ok(m.call({ action: 'createRegion', regionId: 'rg_it', whLoc: 'wh_it', name: 'Italy', currencies: 'EUR,USD', season: SA }), 'italy');
ok(m.call({ action: 'createEvent', eventId: 'ev_yoga', name: 'Yoga Studio', regionId: 'rg_it', season: SA }), 'yoga');
ok(m.call({ action: 'saveHolder', newHolderId: 'hd_radha1', regionId: pl.regionId, name: 'Radha', phone: '+48 111' }), 'sw1');
ok(m.call({ action: 'saveHolder', newHolderId: 'hd_gopal1', regionId: pl.regionId, name: 'Gopal', phone: '+48 222' }), 'sw2');
const add = (loc, items) => ok(m.call({ action: 'adjustStockBulk', location: loc, items, override: true, season: SA }), 'stock ' + loc);
add(pl.whLoc, [{ bookId: B0, delta: 10 }]);
add('hd_radha1', [{ bookId: B0, delta: 20 }]);
add('hd_gopal1', [{ bookId: B0, delta: 10 }, { bookId: B1, delta: 5 }]);
add('wh_it', [{ bookId: B0, delta: 6 }]);
ok(m.call({ action: 'saveSeason', name: 'Year-Round Sales' }), 'season 2');
st = m.call({ action: 'getState' }).state;
const SB = st.seasons.find(s => s.name === 'Year-Round Sales').seasonId;
ok(m.call({ action: 'createRegion', regionId: 'rg_kr', whLoc: 'wh_kr', name: 'Krakow', currencies: 'PLN,USD', season: SB }), 'krakow');
m.call({ action: 'setSeason', seasonId: SA });
const coordKey = ok(m.call({ action: 'setKey', kind: 'region', id: 'rg_it' }), 'key').result;
const inv = () => (m.call({ action: 'getState', season: SA }).state.inventory || [])
  .concat(m.call({ action: 'getState', season: SB }).state.inventory || []);
const qty = (loc, b) => { const r = inv().find(i => i.location === loc && i.bookId === b); return r ? Number(r.qty) : 0; };

(async () => {
  const browser = await chromium.launch();
  const t = [], errors = [];
  async function open(query, width) {
    const page = await browser.newPage({ viewport: { width: width || 1100, height: 950 } });
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => { page.__dialogs = (page.__dialogs || []).concat(d.message()); d.accept(); });
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.includes('script.google.com')) {
        let p = {}; try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(m.call(p)) });
      }
      if (url.startsWith('http://app.test/')) {
        const f = path.join(ROOT, new URL(url).pathname.replace(/^\/+/, '') || 'index.html');
        if (fs.existsSync(f) && fs.statSync(f).isFile())
          return route.fulfill({ status: 200, body: fs.readFileSync(f),
            contentType: f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : undefined });
        return route.fulfill({ status: 404, body: '' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    await page.goto('http://app.test/index.html' + (query || ''));
    await page.waitForTimeout(2000);
    if (await page.$('#whoName')) { await page.fill('#whoName', 'Tester'); await page.click('#whoSave'); await page.waitForTimeout(400); }
    return page;
  }
  const pick = async (page, which, search, text) => {
    await page.click(`#${which} .pp-in`); await page.fill(`#${which} .pp-in`, search);
    await page.click(`#${which} .pp-row:has-text("${text}")`); await page.waitForTimeout(400);
  };
  const openXfer = async page => { await page.click('#adminActions button:has-text("Transfer Existing Stock")'); await page.waitForTimeout(300); };
  const head = page => page.evaluate(() => [...document.querySelectorAll('#xfBody .xf-head span')].map(s => s.textContent.trim()));
  const setMove = (page, src, book, n) => page.fill(`#xfBody .xf-in[data-src="${src}"][data-book="${book}"]`, String(n));
  const go = async page => { page.__dialogs = []; await page.click('#xfGo'); await page.waitForTimeout(1500); return page.__dialogs || []; };

  let page;
  try {
    page = await open('');
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(400);
    const btns = await page.evaluate(() => [...document.querySelectorAll('#adminActions button')].map(b => b.textContent.trim()));
    t.push(['"⇄ Transfer Existing Stock" is on the admin panel', btns.includes('⇄ Transfer Existing Stock')]);
    t.push(['the old transfer buttons are gone', !btns.some(x => /Transfer to event|Transfer to region|Transfer in|Return to warehouse|Hand stock/.test(x))]);

    // Warehouse card: counted in, with bubbles.
    const card = await page.evaluate(b => { const c = [...document.querySelectorAll('.book')].find(x => x.querySelector(`[data-book="${b}"]`));
      return { qty: c.querySelector('.qty-chip').textContent, bubs: [...c.querySelectorAll('.sw-bub')].map(x => x.textContent.trim()) }; }, B0);
    t.push(['warehouse card counts sub-warehouses in (10 + 20 + 10 = 40)', card.qty === '40']);
    t.push(['…with bubbles SW1 · 20 and SW2 · 10', JSON.stringify(card.bubs) === JSON.stringify(['SW1 · 20', 'SW2 · 10'])]);
    await page.click(`.book:has([data-book="${B0}"]) .sw-bub >> nth=0`); await page.waitForTimeout(200);
    const who = await page.evaluate(b => { const c = [...document.querySelectorAll('.book')].find(x => x.querySelector(`[data-book="${b}"]`));
      const w = c.querySelector('.sw-who'); return w.hidden ? '' : w.textContent; }, B0);
    t.push(['tapping a bubble shows the name and phone', /Radha/.test(who) && /\+48 111/.test(who)]);
    t.push(['…without opening a sale', !(await page.evaluate(() => document.querySelector('#overlay').classList.contains('show')))]);
    await (await page.$(`.book:has([data-book="${B0}"])`)).screenshot({ path: shot('1-card') });

    // 1. Warehouse (spread over sub-warehouses) -> event.
    await openXfer(page);
    t.push(['From is already this warehouse', /Poland/.test(await page.inputValue('#xfFrom .pp-in'))]);
    await pick(page, 'xfTo', 'Festival', 'Festival');
    const h1 = await head(page);
    t.push(['columns: Title · Total · WH · Move · SW1 · Move · SW2 · Move · Left',
      JSON.stringify(h1) === JSON.stringify(['Title', 'Total', 'WH', 'Move', 'SW1', 'Move', 'SW2', 'Move', 'Left'])]);
    await page.click('#xfAll'); await page.waitForTimeout(200);
    t.push(['"Transfer everything" first says to count the books', (page.__dialogs || []).some(x => /did not count the physical stock/.test(x))]);
    const leftAll = await page.textContent(`#xfBody [data-left="${B0}"]`);
    t.push(['…and fills every column (Left 0)', leftAll.trim() === '0']);
    await setMove(page, pl.whLoc, B0, 5); await setMove(page, 'hd_radha1', B0, 15); await setMove(page, 'hd_gopal1', B0, 5);
    await page.fill(`#xfBody .xf-in[data-src="hd_gopal1"][data-book="${B1}"]`, '');
    t.push(['Left shows 40 − 25 = 15', (await page.textContent(`#xfBody [data-left="${B0}"]`)).trim() === '15']);
    await page.screenshot({ path: shot('2-multisource') });
    let d = await go(page);
    t.push(['Transfer asks "Are you 108% sure…"', d.some(x => /108% sure you’ve counted everything correctly/.test(x))]);
    t.push(['each shelf gave its share (WH 5, SW1 5, SW2 5 left)', qty(pl.whLoc, B0) === 5 && qty('hd_radha1', B0) === 5 && qty('hd_gopal1', B0) === 5]);
    t.push(['Festival received 25', qty('ev_fest', B0) === 25]);

    // 1b. Event -> event.
    await openXfer(page);
    await pick(page, 'xfFrom', 'Festival', 'Festival'); await pick(page, 'xfTo', 'Temple', 'Temple');
    t.push(['event to event: plain Title · Avail · Move · Left', JSON.stringify(await head(page)) === JSON.stringify(['Title', 'Avail', 'Move', 'Left'])]);
    await setMove(page, 'ev_fest', B0, 5);
    d = await go(page);
    t.push(['event to event: no "leaving" message, just the count check', d.length === 1 && !/leaving/.test(d[0])]);
    t.push(['Temple has 5, Festival 20', qty('ev_tmp', B0) === 5 && qty('ev_fest', B0) === 20]);

    // 2. Event -> its warehouse, split between sub-warehouses (one new).
    await openXfer(page);
    await pick(page, 'xfFrom', 'Festival', 'Festival'); await pick(page, 'xfTo', 'Poland', 'Poland');
    await page.selectOption('#xfStorage', 'multi'); await page.waitForTimeout(200);
    await page.click('#xfAddSw'); await page.waitForTimeout(200);
    const newKey = await page.evaluate(() => { const i = document.querySelector('#xfBody [data-k^="swn:"]'); return i.dataset.k.slice(4); });
    await page.fill(`#xfBody [data-k="swn:${newKey}"]`, 'Madhava'); await page.fill(`#xfBody [data-k="swp:${newKey}"]`, '+48 333');
    const h2 = await head(page);
    t.push(['multiple destinations: Title · Avail · @SW1 · @SW2 · @SW3 · Left', JSON.stringify(h2) === JSON.stringify(['Title', 'Avail', '@SW1', '@SW2', '@SW3', 'Left'])]);
    const tinted = await page.evaluate(() => [...document.querySelectorAll('#xfBody .xf-in[data-dst]')].slice(0, 3).map(i => getComputedStyle(i).backgroundColor));
    t.push(['each SW column has its own background tint', new Set(tinted).size === 3 && !tinted.includes('rgb(255, 255, 255)')]);
    const w = await page.evaluate(() => document.querySelector('#xfBody .xf-in[data-dst]').getBoundingClientRect().width);
    t.push(['SW boxes are sized for 3 digits (≤ 56px)', w <= 56 && w >= 40]);
    await page.fill(`#xfBody .xf-in[data-dst="hd_radha1"][data-book="${B0}"]`, '8');
    await page.fill(`#xfBody .xf-in[data-dst="${newKey}"][data-book="${B0}"]`, '4');
    await page.screenshot({ path: shot('3-multidest') });
    d = await go(page);
    t.push(['message: "leaving this event"', d.some(x => /leaving this event\. They will no longer be available for sale at this event/.test(x))]);
    const madhava = (m.call({ action: 'getState', season: SA }).state.holders || []).find(h => h.name === 'Madhava');
    t.push(['a new sub-warehouse "Madhava" was created', !!madhava && madhava.phone === '+48 333']);
    t.push(['SW1 got 8, Madhava 4, Festival 8 left', qty('hd_radha1', B0) === 13 && madhava && qty(madhava.holderId, B0) === 4 && qty('ev_fest', B0) === 8]);
    await page.waitForTimeout(500);
    const card2 = await page.evaluate(b => { const c = [...document.querySelectorAll('.book')].find(x => x.querySelector(`[data-book="${b}"]`));
      return { qty: c.querySelector('.qty-chip').textContent, bubs: [...c.querySelectorAll('.sw-bub')].map(x => x.textContent.trim()) }; }, B0);
    t.push(['warehouse card: 5 + 13 + 5 + 4 = 27, bubbles SW1 · 13, SW2 · 5, SW3 · 4',
      card2.qty === '27' && JSON.stringify(card2.bubs) === JSON.stringify(['SW1 · 13', 'SW2 · 5', 'SW3 · 4'])]);

    // 2b. Event -> warehouse, one destination.
    await openXfer(page);
    await pick(page, 'xfFrom', 'Festival', 'Festival'); await pick(page, 'xfTo', 'Poland', 'Poland');
    await page.selectOption('#xfStorage', 'one'); await page.waitForTimeout(200);
    await page.click('#xfAll'); await page.waitForTimeout(200);
    d = await go(page);
    t.push(['one destination: everything back on the shelf (5 + 8)', qty(pl.whLoc, B0) === 13 && qty('ev_fest', B0) === 0]);
    t.push(['…with the "leaving this event" message', d.some(x => /leaving this event/.test(x))]);

    // 3. Region -> region, same season, arriving at once (from a sub-warehouse).
    await openXfer(page);
    await pick(page, 'xfTo', 'Italy', 'Italy');
    await page.selectOption('#xfTravel', 'now'); await page.waitForTimeout(200);
    await page.fill(`#xfBody .xf-in[data-src="hd_gopal1"][data-book="${B1}"]`, '2');
    d = await go(page);
    t.push(['region to region: "leaving this region" message', d.some(x => /leaving this region\. They will no longer be available to sell in this region or this region’s events/.test(x))]);
    t.push(['2 left SW2 and arrived in Italy', qty('hd_gopal1', B1) === 3 && qty('wh_it', B1) === 2]);

    // 3b. Region -> another region's event, travelling.
    await openXfer(page);
    await pick(page, 'xfTo', 'Yoga', 'Yoga Studio');
    await page.selectOption('#xfTravel', 'travel'); await page.waitForTimeout(200);
    t.push(['travel: courier fields appear', !!(await page.$('#xfBody [data-k="carrier"]')) && !!(await page.$('#xfCourier'))]);
    const listed = await page.evaluate(() => [...document.querySelectorAll('#xfBody .xf-row:not(.xf-head) .bn')].length);
    t.push(['travel: only titles in stock at the source are listed', listed === 2]);
    await page.fill('#xfBody [data-k="carrier"]', 'Narada Muni');
    await setMove(page, 'hd_radha1', B0, 3);
    await page.screenshot({ path: shot('4-travel') });
    d = await go(page);
    const sh = (m.call({ action: 'getState', season: SA }).state.shipments || []).find(x => x.carrier === 'Narada Muni');
    t.push(['a batch is in transit to Yoga Studio', !!sh && sh.toLoc === 'ev_yoga' && sh.fromRegion === pl.regionId]);
    t.push(['…and the 3 left SW1 straight away', qty('hd_radha1', B0) === 10]);

    // Correcting, then deleting, that batch: the copies go back to SW1, not the shelf.
    await page.evaluate(() => closeModal());
    await page.evaluate(id => shipCountModal(id), sh.shipId); await page.waitForTimeout(300);
    await page.fill(`#modal .sc-q[data-book="${B0}"]`, '1'); await page.click('#scGo'); await page.waitForTimeout(1500);
    t.push(['correcting the batch 3 → 1 returns 2 to SW1 (not the shelf)', qty('hd_radha1', B0) === 12 && qty(pl.whLoc, B0) === 13]);
    await page.evaluate(() => shipmentsModal()); await page.waitForTimeout(300);
    page.__dialogs = [];
    await page.click(`#modal .sh-card:has-text("Narada") [data-act="shdel"]`); await page.waitForTimeout(1500);
    t.push(['deleting the batch returns the last copy to SW1 too', qty('hd_radha1', B0) === 13 && qty(pl.whLoc, B0) === 13]);
    await page.evaluate(() => closeModal());
    // Send 3 again, for the rest of the test.
    await openXfer(page);
    await pick(page, 'xfTo', 'Yoga', 'Yoga Studio');
    await page.selectOption('#xfTravel', 'travel'); await page.waitForTimeout(200);
    await page.fill('#xfBody [data-k="carrier"]', 'Narada Muni');
    await setMove(page, 'hd_radha1', B0, 3);
    await go(page);

    // 4. Into another season.
    await openXfer(page);
    await pick(page, 'xfTo', 'Krakow', 'Krakow');
    await page.selectOption('#xfTravel', 'now'); await page.waitForTimeout(200);
    await setMove(page, pl.whLoc, B0, 4);
    d = await go(page);
    t.push(['another season: "leaving this season" warning', d.some(x => /leaving this season\. They will no longer be available for sale in this season, the region, or the region’s events/.test(x))]);
    t.push(['4 moved to Krakow (Year-Round Sales)', qty('wh_kr', B0) === 4 && qty(pl.whLoc, B0) === 9]);

    // Multiple books at the warehouse: one title only with SW2 — it asks which, once.
    await page.evaluate(() => pull()); await page.waitForTimeout(800);
    await page.evaluate(() => bundleModal()); await page.waitForTimeout(300);
    await page.click(`#modal .mb-plus[data-book="${B0}"][data-kind="buy"]`);
    await page.click(`#modal .mb-plus[data-book="${B1}"][data-kind="buy"]`);
    await page.click(`#modal .mb-plus[data-book="${B1}"][data-kind="buy"]`);
    await page.click('#saveBundle'); await page.waitForTimeout(300);
    const askSw = await page.evaluate(() => { const b = document.querySelector('#mbSw'); return b ? b.textContent.replace(/\s+/g, ' ') : ''; });
    t.push(['Multiple Books asks which sub-warehouse the short title comes from', /Which sub-warehouse/.test(askSw) && /SW2 — Gopal/.test(askSw)]);
    await page.screenshot({ path: shot('7-bundle-ask') });
    await page.click('#saveBundle'); await page.waitForTimeout(1500);
    t.push(['…then 2 leave SW2 and the 3-book sale is recorded', qty('hd_gopal1', B1) === 1 &&
      (m.call({ action: 'getState', season: SA }).state.sales || []).filter(x => x.bundle && x.location === pl.whLoc).length === 3]);

    // Selling when the shelf is empty but a sub-warehouse has copies.
    // (Title 2 was never on the warehouse shelf itself — only with SW2.)
    await page.evaluate(() => pull()); await page.waitForTimeout(800);
    await page.click(`.book:has([data-book="${B1}"]) .sell-btn`); await page.waitForTimeout(300);
    const ask = await page.evaluate(() => ({ h: (document.querySelector('#modal h3') || {}).textContent || '',
      opts: [...document.querySelectorAll('#modal [data-sellsw]')].map(b => b.textContent.replace(/\s+/g, ' ').trim()) }));
    t.push(['selling with an empty shelf asks "Which sub-warehouse?"', /Which sub-warehouse/.test(ask.h) && ask.opts.length === 1 && /SW2 — Gopal/.test(ask.opts[0])]);
    await page.click('#modal [data-sellsw]'); await page.waitForTimeout(300);
    t.push(['…then the sale opens for that copy', /Record sale/.test(await page.textContent('#modal h3'))]);
    await page.evaluate(() => closeModal());
    await page.close();

    // Phone width.
    const phone = await open('', 390);
    await phone.evaluate(r => goTo('region', r), pl.regionId); await phone.waitForTimeout(300);
    await openXfer(phone);
    await pick(phone, 'xfTo', 'Temple', 'Temple');
    await phone.screenshot({ path: shot('5-phone') });
    const over = await phone.evaluate(() => { const b = document.querySelector('#modal .m-body'); return b.scrollWidth - b.clientWidth; });
    t.push(['phone: the dialog itself never scrolls sideways', over <= 0]);
    t.push(['phone: several shelves become cards, one line per shelf', (await phone.$$('#xfBody .xf-card .xf-line')).length >= 3]);
    await phone.evaluate(() => closeModal());
    await openXfer(phone);
    await pick(phone, 'xfFrom', 'Temple', 'Temple'); await pick(phone, 'xfTo', 'Poland', 'Poland');
    await phone.selectOption('#xfStorage', 'multi'); await phone.waitForTimeout(300);
    await phone.screenshot({ path: shot('6-phone-split'), fullPage: false });
    const over2 = await phone.evaluate(() => { const b = document.querySelector('#modal .m-body'); return b.scrollWidth - b.clientWidth; });
    t.push(['phone: splitting between sub-warehouses fits too', over2 <= 0 && (await phone.$$('#xfBody .xf-card')).length >= 1]);
    await phone.close();

    // Regional link.
    const coord = await open('?k=' + coordKey);
    const cb = await coord.evaluate(() => [...document.querySelectorAll('#adminActions button')].map(b => b.textContent.trim()));
    t.push(['regional link sees "Transfer Existing Stock"', cb.includes('⇄ Transfer Existing Stock')]);
    await openXfer(coord);
    await coord.click('#xfTo .pp-in'); await coord.waitForTimeout(200);
    const places = await coord.evaluate(() => [...document.querySelectorAll('#xfTo .pp-row')].map(r => r.childNodes[0].textContent.trim()));
    t.push(['regional link: only Italy and its events', JSON.stringify(places) === JSON.stringify(['Italy', 'Yoga Studio'])]);
    await coord.click('#xfTo .pp-row:has-text("Yoga")'); await coord.waitForTimeout(300);
    await coord.fill(`#xfBody .xf-in[data-src="wh_it"][data-book="${B0}"]`, '2');
    await go(coord);
    t.push(['regional link can transfer within its region', qty('ev_yoga', B0) === 2 && qty('wh_it', B0) === 4]);
    await coord.close();
    const refused = m.call({ action: 'transferMulti', k: coordKey, moves: [{ from: pl.whLoc, to: 'wh_it', bookId: B0, qty: 1 }] });
    t.push(['regional link cannot move another region\'s books (server refuses)', !refused.ok]);
  } catch (e) {
    console.log('STOPPED:', e.message.split('\n')[0]);
    t.push(['test ran to the end', false]);
    try { await page.screenshot({ path: shot('stopped') }); } catch (e2) {}
  }
  t.push(['no errors in the page', errors.length === 0]);
  if (errors.length) console.log('page errors:', errors);
  t.forEach(([n, okk]) => console.log((okk ? 'PASS' : 'FAIL'), n));
  console.log('screenshots:', shot('*'));
  await browser.close();
})();
