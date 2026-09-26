/* Optional, needs Playwright + Chromium: node test/browser-round3.js
   b186 requests, in a real browser against the real Code.gs (via mini.js):
   admin panel layout, Edit Book Display, typing-only quantities, Stored At
   bubbles, choosing where a sale comes from, declined / refused pre-order
   requests, consignment kept to its region, closing a season, and one line
   per title in the activity log. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-r3-' + n + '.png');

m.init();
const ok = (r, what) => { if (!r.ok) throw new Error(what + ': ' + r.error); return r; };
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason;
const books = st.books.filter(b => !b.partnerId);
const [B0, B1, B2, B3] = books.map(b => b.id);
const pl = st.regions[0];
const c = (p, w, season) => ok(m.call(Object.assign({ season: season || SA }, p)), w || p.action);
c({ action: 'createEvent', eventId: 'ev_fest', name: 'Festival', regionId: pl.regionId });
c({ action: 'createRegion', regionId: 'rg_mk', whLoc: 'wh_mk', name: 'Macedonia', currencies: 'MKD,EUR,USD' });
const partner = { partnerId: c({ action: 'savePartner', regionId: 'rg_mk', name: 'Skopje Temple' }, 'partner').result };
c({ action: 'addBook', name: 'Gita (Macedonian)', cat: 'big', partnerId: partner.partnerId }, 'consign book');
c({ action: 'adjustStockBulk', location: pl.whLoc, items: [{ bookId: B0, delta: 10 }, { bookId: B1, delta: 6 }, { bookId: B2, delta: 20 }], override: true });
c({ action: 'saveHolder', newHolderId: 'hd_radha1', regionId: pl.regionId, name: 'Radha', phone: '+48 1' });
c({ action: 'saveHolder', newHolderId: 'hd_gopal1', regionId: pl.regionId, name: 'Gopal', phone: '+48 2' });
c({ action: 'adjustStockBulk', location: 'hd_radha1', items: [{ bookId: B0, delta: 4 }], override: true });
c({ action: 'adjustStockBulk', location: 'hd_gopal1', items: [{ bookId: B0, delta: 3 }], override: true });
ok(m.call({ action: 'saveSeason', name: 'Year-Round Sales' }), 'season 2');
st = m.call({ action: 'getState' }).state;
const SB = st.seasons.find(s => s.name === 'Year-Round Sales').seasonId;
c({ action: 'createRegion', regionId: 'rg_bcn', whLoc: 'wh_bcn', name: 'Barcelona', currencies: 'EUR,USD' }, 'bcn', SB);
c({ action: 'adjustStockBulk', location: 'wh_bcn', items: [{ bookId: B0, delta: 5 }], override: true }, 'bcn stock', SB);
ok(m.call({ action: 'saveSeason', name: 'Old Tour' }), 'season 3');
st = m.call({ action: 'getState' }).state;
const SC = st.seasons.find(s => s.name === 'Old Tour').seasonId;
c({ action: 'createRegion', regionId: 'rg_old', whLoc: 'wh_old', name: 'Old Region', currencies: 'EUR,USD' }, 'old', SC);
m.call({ action: 'setSeason', seasonId: SA });
const qty = (loc, b, season) => { const r = (m.call({ action: 'getState', season: season || SA }).state.inventory || [])
  .find(i => i.location === loc && i.bookId === b); return r ? Number(r.qty) : 0; };

(async () => {
  const browser = await chromium.launch();
  const t = [], errors = [];
  async function open(width) {
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
    await page.goto('http://app.test/index.html');
    await page.waitForTimeout(2000);
    return page;
  }
  const panel = page => page.evaluate(() => [...document.querySelectorAll('#adminActions .adm-col')].map(col => ({
    title: col.querySelector('.adm-lbl').textContent.trim(),
    buttons: [...col.querySelectorAll('button')].map(b => b.textContent.replace(/\s+/g, ' ').trim()) })));
  const has = (cols, title, re) => ((cols.find(c => c.title === title) || {}).buttons || []).some(b => re.test(b));
  let page;
  try {
    page = await open();

    // 1. Admin panel.
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(300);
    let cols = await panel(page);
    t.push(['columns: Admin · Money · Books · Location', cols.map(c => c.title).join(',') === 'Admin,Money,Books,Location']);
    t.push(['Admin: Activity Log, App and Sales Support, Spreadsheet Links, Edit Wording',
      ['Activity Log', 'App and Sales Support', 'Spreadsheet Links', 'Edit Wording'].every(n => has(cols, 'Admin', new RegExp(n)))]);
    t.push(['Money: Cash Tracker, Record Costs, Edit Payment Types',
      ['Cash Tracker', 'Record Costs', 'Edit Payment Types'].every(n => has(cols, 'Money', new RegExp(n)))]);
    t.push(['Books: Add New Stock, Transfer Existing Stock, Consignment Books, Edit Book Display',
      ['Add New Stock', 'Transfer Existing Stock', 'Consignment Books', 'Edit Book Display'].every(n => has(cols, 'Books', new RegExp(n)))]);
    t.push(['region: Change Event Order, Change Regional Order, Edit/Close/Delete Region',
      ['Change Event Order', 'Change Regional Order', 'Edit Region', 'Close Region', 'Delete Region'].every(n => has(cols, 'Location', new RegExp(n)))]);
    const all = cols.flatMap(c => c.buttons).join(' | ');
    t.push(['gone: Books in transit, Devotees storing books, Fulfill…for another region, Change book order, Titles offered here',
      !/Books in transit|Devotees storing|another region|Change book order|Titles offered here/.test(all)]);
    await page.evaluate(() => goTo('event', 'ev_fest')); await page.waitForTimeout(300);
    cols = await panel(page);
    t.push(['event: order buttons plus Rename/Close/Delete Event',
      ['Change Event Order', 'Change Regional Order', 'Rename Event', 'Close Event', 'Delete Event'].every(n => has(cols, 'Location', new RegExp(n)))]);
    await page.evaluate(() => goTo('season')); await page.waitForTimeout(300);
    cols = await panel(page);
    t.push(['season: order buttons plus Edit/Close/Delete Season',
      ['Change Event Order', 'Change Regional Order', 'Edit Season', 'Close Season', 'Delete Season'].every(n => has(cols, 'Location', new RegExp(n)))]);
    await (await page.$('#adminPanel')).screenshot({ path: shot('1-panel-season') });

    // 2. Edit Book Display.
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(300);
    await page.click('#adminActions button:has-text("Edit Book Display")'); await page.waitForTimeout(300);
    const howto = await page.textContent('#modal .how-to');
    t.push(['instructions: select which are displayed, and drag and drop to reorder',
      /Select which books should be displayed in the warehouse in this region/.test(howto) && /Drag and drop to change the order/.test(howto)]);
    await page.click(`#modal [data-bd="${B3}"]`);                      // hide one
    await page.click('#modal [data-bd-up="2"]');                          // move the third title up
    await page.screenshot({ path: shot('2-book-display') });
    await page.click('#bdSave'); await page.waitForTimeout(1200);
    const reg = m.call({ action: 'getState', season: SA }).state.regions.find(r => r.regionId === pl.regionId);
    t.push(['the hidden title is saved as hidden', String(reg.hidden || '').includes(B3)]);
    t.push(['the new order is saved', (reg.bookOrder || []).length > 0 && (Array.isArray(reg.bookOrder) ? reg.bookOrder : String(reg.bookOrder).split(','))[1] === B2]);

    // 3. Quantities only by typing.
    await page.evaluate(() => addStockModal()); await page.waitForTimeout(400);
    await page.selectOption('#spWhere', 'there'); await page.waitForTimeout(200);
    const box = `#spBody input.d-delta[data-book="${B0}"]`;
    await page.fill(box, '5'); await page.focus(box);
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowDown');
    await page.mouse.move(600, 500); await page.mouse.wheel(0, -300);
    t.push(['arrow keys and the mouse wheel do not change a count', (await page.inputValue(box)) === '5']);
    await page.evaluate(() => closeModal());

    // 4. Stored At, each sub-warehouse in its own color.
    const card = await page.evaluate(b => { const c = [...document.querySelectorAll('.book')].find(x => x.querySelector(`[data-book="${b}"]`));
      return { title: (c.querySelector('.sw-title') || {}).textContent || '',
               colors: [...c.querySelectorAll('.sw-bub')].map(x => getComputedStyle(x).backgroundColor) }; }, B0);
    t.push(['"Stored At:" above the sub-warehouse bubbles', /Stored At:/.test(card.title)]);
    t.push(['each sub-warehouse bubble has its own color', card.colors.length === 2 && card.colors[0] !== card.colors[1]]);
    await (await page.$(`.book:has([data-book="${B0}"])`)).screenshot({ path: shot('3-stored-at') });

    // 5. Selling: choose the warehouse or a sub-warehouse.
    await page.click(`.book:has([data-book="${B0}"]) .sell-btn`); await page.waitForTimeout(300);
    const opts = await page.evaluate(() => [...document.querySelectorAll('#modal [data-sellsw]')].map(b => b.querySelector('b').textContent));
    t.push(['Sell asks: Warehouse, SW1, SW2', JSON.stringify(opts) === JSON.stringify(['Warehouse', 'SW1 — Radha', 'SW2 — Gopal'])]);
    await page.click('#modal [data-sellsw="hd_gopal1"]'); await page.waitForTimeout(300);
    await page.click('#saveSale'); await page.waitForTimeout(1500);
    t.push(['selling from SW2 takes the copy from SW2', qty('hd_gopal1', B0) === 2 && qty(pl.whLoc, B0) === 10]);

    // 6/7. Pre-order requests: refused without stock; declined shows in red.
    await page.click(`.book:has([data-book="${B1}"]) .pre-btn`); await page.waitForTimeout(300);
    await page.fill('#cname', 'Hari');
    await page.selectOption('#fulSel', 'other');
    await page.click('#fulReg .pp-in'); await page.fill('#fulReg .pp-in', 'Barcelona');
    await page.click('#fulReg .pp-row:has-text("Barcelona")'); await page.waitForTimeout(200);
    await page.click('#saveSale'); await page.waitForTimeout(1500);
    const refusal = await page.evaluate(() => ({ open: document.querySelector('#overlay').classList.contains('show'),
      err: (document.querySelector('#modalErr') || {}).textContent || '' }));
    t.push(['asking a region without the book is refused, in the dialog', refusal.open && /Barcelona has no copies/.test(refusal.err)]);
    t.push(['…and nothing was recorded', !(m.call({ action: 'getState', season: SA }).state.sales || []).some(x => x.name === 'Hari')]);
    await page.evaluate(() => closeModal());
    c({ action: 'sell', saleId: 's_req1', location: pl.whLoc, bookId: B0, isPreorder: true, legs: [], name: 'Maria', fulfilBy: 'rg_bcn' });
    c({ action: 'setFulfilBy', remoteSaleId: 's_req1', fulfilBy: '', declined: true });
    await page.evaluate(() => pull()); await page.waitForTimeout(800);
    const pre = await page.evaluate(() => (document.querySelector('#prePanel') || {}).innerHTML || '');
    t.push(['declined: red "Pre-order fulfillment declined" on the pre-order', /class="badge declined">Pre-order fulfillment declined/.test(pre)]);

    // 8. Consignment stays in its own region.
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(200);
    await page.evaluate(() => regionModal(currentRegion())); await page.waitForTimeout(300);
    t.push(['Poland’s Edit Region does not list Macedonia’s consignment title', !/Gita \(Macedonian\)/.test(await page.textContent('#rgPrices'))]);
    await page.evaluate(() => closeModal());
    await page.evaluate(() => goTo('region', 'rg_mk')); await page.waitForTimeout(200);
    await page.evaluate(() => regionModal(currentRegion())); await page.waitForTimeout(300);
    t.push(['Macedonia’s Edit Region does list it', /Gita \(Macedonian\)/.test(await page.textContent('#rgPrices'))]);
    await page.evaluate(() => { closeModal(); goTo('season'); }); await page.waitForTimeout(300);
    t.push(['the season’s Warehouse Overview leaves it out', !/Gita \(Macedonian\)/.test(await page.textContent('#whOverview'))]);
    await page.evaluate(sb => switchSeason(sb), SB); await page.waitForTimeout(1500);
    await page.evaluate(() => { goTo('region', 'rg_bcn'); partnersModal(); }); await page.waitForTimeout(300);
    t.push(['another season’s Consignment Books does not show it as left over', !/Gita \(Macedonian\)/.test(await page.textContent('#modal'))]);
    await page.evaluate(() => closeModal());

    // 10. Activity log: one entry per Transfer click, one line per title.
    await page.evaluate(sa => switchSeason(sa), SA); await page.waitForTimeout(1500);
    c({ action: 'transferMulti', moves: [{ from: pl.whLoc, to: 'ev_fest', bookId: B0, qty: 2 }, { from: pl.whLoc, to: 'ev_fest', bookId: B1, qty: 3 },
      { from: pl.whLoc, to: 'ev_fest', bookId: B2, qty: 10 }], movePrefix: 'Mr3' });
    await page.evaluate(r => { goTo('region', r); activityModal(); }, pl.regionId); await page.waitForTimeout(1200);
    const entry = page.locator('#alList .al-row').filter({ hasText: '15 books transferred' }).first();
    t.push(['one entry: "15 books transferred"', (await entry.count()) === 1]);
    await entry.locator('.al-tog').click(); await page.waitForTimeout(200);
    const lines = (await entry.locator('.al-part').allTextContents()).map(x => x.replace(/\s+/g, ' '));
    t.push(['three lines, one per title', lines.length === 3 && lines.some(x => /×10 transferred/.test(x))]);
    await page.screenshot({ path: shot('4-activity') });
    await entry.locator('.al-part').filter({ hasText: '×10 transferred' }).locator('[data-alpart]').click(); await page.waitForTimeout(1800);
    t.push(['deleting just that title puts only those 10 back', qty('ev_fest', B2) === 0 && qty('ev_fest', B1) === 3 && qty('ev_fest', B0) === 2]);
    await page.evaluate(() => closeModal());

    // 9. Closing a season: checked against the records; rates then fixed.
    await page.evaluate(sc => switchSeason(sc), SC); await page.waitForTimeout(1500);
    await page.evaluate(() => goTo('season')); await page.waitForTimeout(300);
    await page.click('#adminActions button:has-text("Close Season")'); await page.waitForTimeout(300);
    const notYet = await page.evaluate(() => ({ text: document.querySelector('#modal').textContent,
      q1: document.querySelector('#csQ1').disabled, go: document.querySelector('#csGo').disabled }));
    t.push(['the checklist asks both questions', /Have all regions been closed\?/.test(notYet.text) && /relocated elsewhere and accounted for/.test(notYet.text)]);
    t.push(['with a region still open: says which, and Close stays off', /still open: Old Region/.test(notYet.text) && notYet.q1 && notYet.go]);
    await page.evaluate(() => closeModal());
    c({ action: 'closeLocation', kind: 'region', id: 'rg_old' }, 'close old', SC);
    await page.evaluate(() => pull()); await page.waitForTimeout(1000);
    await page.click('#adminActions button:has-text("Close Season")'); await page.waitForTimeout(300);
    await page.check('#csQ1'); await page.check('#csQ2');
    await page.screenshot({ path: shot('5-close-season') });
    await page.click('#csGo'); await page.waitForTimeout(1800);
    const closed = (m.call({ action: 'getState' }).state.seasons || []).find(s => s.seasonId === SC);
    t.push(['the season closes', !!closed && !!closed.closedAt]);
    const fr = await page.evaluate(() => ({ frozen: !!(STATE.rates || {}).frozen, note: rateNote() }));
    t.push(['its exchange rates are now fixed, and say so', fr.frozen && /fixed when the season closed/.test(fr.note)]);
    const reopen = await page.evaluate(() => [...document.querySelectorAll('#adminActions button')].some(b => /Reopen Season/.test(b.textContent)));
    t.push(['a closed season offers Reopen Season', reopen]);
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
