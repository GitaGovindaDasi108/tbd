/* Optional, needs Playwright + Chromium: node test/browser-round2.js
   b184 requests, in a real browser against the real Code.gs (via mini.js):
   version warning, transfer pop-ups, place order, activity-log lines, # Arrived,
   currency labels, Add-new spacing, going to what you create, the pencil
   returning to its dialog, pre-orders fulfilled by another region, list view. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-r2-' + n + '.png');

m.init();
const ok = (r, what) => { if (!r.ok) throw new Error(what + ': ' + r.error); return r; };
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason;
const books = st.books.filter(b => !b.partnerId);
const B0 = books[0].id, B1 = books[1].id;
const pl = st.regions[0];
const c = (p, w, season) => ok(m.call(Object.assign({ season: season || SA }, p)), w || p.action);
c({ action: 'createEvent', eventId: 'ev_fest', name: 'Festival', regionId: pl.regionId });
c({ action: 'createRegion', regionId: 'rg_it', whLoc: 'wh_it', name: 'Italy', currencies: 'EUR,USD' });
c({ action: 'createEvent', eventId: 'ev_mela2', name: 'Mela — Day 2', regionId: 'rg_it' });
c({ action: 'adjustStockBulk', location: pl.whLoc, items: [{ bookId: B0, delta: 20 }, { bookId: B1, delta: 10 }], override: true });
c({ action: 'adjustStockBulk', location: 'wh_it', items: [{ bookId: B0, delta: 4 }], override: true });
ok(m.call({ action: 'saveSeason', name: 'Year-Round Sales' }), 'season 2');
st = m.call({ action: 'getState' }).state;
const SB = st.seasons.find(s => s.name === 'Year-Round Sales').seasonId;
c({ action: 'createRegion', regionId: 'rg_bcn', whLoc: 'wh_bcn', name: 'Barcelona', currencies: 'EUR,USD' }, 'bcn', SB);
c({ action: 'adjustStockBulk', location: 'wh_bcn', items: [{ bookId: B0, delta: 5 }], override: true }, 'bcn stock', SB);
m.call({ action: 'setSeason', seasonId: SA });
c({ action: 'sendShipment', mode: 'devotee', fromRegion: 'OUTSIDE', toRegion: pl.regionId, toLoc: pl.whLoc, carrier: 'Gopal', shipId: 'sh_r2ship', items: [{ bookId: B1, qty: 3 }] });
const qty = (loc, b, season) => { const r = (m.call({ action: 'getState', season: season || SA }).state.inventory || [])
  .find(i => i.location === loc && i.bookId === b); return r ? Number(r.qty) : 0; };

(async () => {
  const browser = await chromium.launch();
  const t = [], errors = [];
  async function open(query, width, tweak) {
    const page = await browser.newPage({ viewport: { width: width || 1100, height: 950 } });
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => { page.__dialogs = (page.__dialogs || []).concat(d.message()); d.accept(); });
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.includes('script.google.com')) {
        let p = {}; try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
        const out = m.call(p);
        if (tweak) tweak(out);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
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
    return page;
  }
  const pick = async (page, which, search, text) => {
    await page.click(`#${which} .pp-in`); await page.fill(`#${which} .pp-in`, search);
    await page.click(`#${which} .pp-row:has-text("${text}")`); await page.waitForTimeout(400);
  };
  let page;
  try {
    // 1. Version warning.
    // A genuinely older Apps Script: it has no version stamp of its own, and its data says b180.
    const old = await open('', 1100, out => { if (out && out.state) { out.state.serverBuild = 'b180'; delete out.build; } });
    const warn = await old.evaluate(() => (document.getElementById('buildWarn') || {}).textContent || '');
    const pageBuild = await old.evaluate(() => document.getElementById('bld').textContent);
    t.push(['older Apps Script: a red warning names both versions and what to do', /running b180/.test(warn) && warn.includes(pageBuild) && /New version/.test(warn)]);
    await old.close();
    // Today's case: the new Apps Script is running, but hands out a copy saved by the old one.
    const stale = await open('', 1100, out => { if (out && out.state) out.state.serverBuild = 'b180'; });
    t.push(['new Apps Script with an old saved copy: no false warning', !(await stale.$('#buildWarn'))]);
    await stale.close();
    page = await open('');
    t.push(['matching versions: no warning', !(await page.$('#buildWarn'))]);

    // 3. Place list: where you are first.
    await page.evaluate(() => { goTo('region', 'rg_it'); goTo('event', 'ev_mela2'); }); await page.waitForTimeout(300);
    await page.evaluate(() => addStockModal()); await page.waitForTimeout(300);
    await page.click('#spPlace .pp-in'); await page.fill('#spPlace .pp-in', ''); await page.waitForTimeout(200);
    const order = await page.evaluate(() => [...document.querySelectorAll('#spPlace .pp-list > div')].slice(0, 3).map(d => d.childNodes[0].textContent.trim()));
    t.push(['at an Italy event: this season first, Italy first within it', order[1] === 'Italy' && order[0] !== 'Year-Round Sales']);
    await page.evaluate(() => closeModal());

    // 2. Transfer pop-ups.
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(300);
    await page.evaluate(() => transferStockModal()); await page.waitForTimeout(300);
    await pick(page, 'xfTo', 'Festival', 'Festival');
    page.__dialogs = [];
    await page.click('#xfAll'); await page.waitForTimeout(200);
    t.push(['"Transfer everything": the count reminder', (page.__dialogs || []).length === 1 && /did not count the physical stock/.test(page.__dialogs[0])]);
    await page.fill(`#xfBody .xf-in[data-book="${B0}"]`, '4'); await page.fill(`#xfBody .xf-in[data-book="${B1}"]`, '2');
    page.__dialogs = [];
    await page.click('#xfGo'); await page.waitForTimeout(1500);
    t.push(['"Transfer": only "Are you 108% sure…", not the count reminder again',
      (page.__dialogs || []).length === 1 && /108% sure you’ve counted everything correctly/.test(page.__dialogs[0]) && !/did not count/.test(page.__dialogs[0])]);
    t.push(['the transfer saved (Festival 4 + 2)', qty('ev_fest', B0) === 4 && qty('ev_fest', B1) === 2]);

    // 4. Activity log: one entry, its lines in a dropdown, each undoable.
    await page.evaluate(() => activityModal()); await page.waitForTimeout(1000);
    const entry = '#alList .al-row:has-text("Moved 6 books")';
    t.push(['the transfer is one entry with "▸ 2 lines"', /2 lines/.test(await page.textContent(`${entry} .al-tog`))]);
    await page.click(`${entry} .al-tog`); await page.waitForTimeout(200);
    const lines = (await page.locator(entry + ' .al-part').allTextContents()).map(x => x.replace(/\s+/g, ' ').trim());
    t.push(['the dropdown lists each line', lines.length === 2 && lines.some(x => /4 × /.test(x)) && lines.some(x => /2 × /.test(x))]);
    await page.screenshot({ path: shot('1-activity-lines') });
    await page.locator(entry + ' .al-part').filter({ hasText: '2 × ' }).locator('[data-alpart]').click(); await page.waitForTimeout(1800);
    t.push(['deleting one line undoes just that line', qty('ev_fest', B1) === 0 && qty('ev_fest', B0) === 4]);
    const row = page.locator('#alList .al-row').filter({ hasText: 'Moved 6 books' }).filter({ hasNotText: 'Undid' }).first();
    const after = { meta: await row.locator('.al-meta').textContent(),
      gone: await row.locator('.al-part.undone').count(), all: (await row.locator('[data-alundo]').count()) > 0 };
    t.push(['…the entry reads "Partly undone", that line crossed out', /Partly undone/.test(after.meta) && after.gone === 1 && after.all]);
    await row.locator('[data-alundo]').click(); await page.waitForTimeout(1800);
    t.push(['"Delete all" undoes what is left', qty('ev_fest', B0) === 0]);
    await page.evaluate(() => closeModal());

    // 5. # Arrived.
    await page.evaluate(() => shipReceiveModal('sh_r2ship')); await page.waitForTimeout(300);
    t.push(['Partial Delivery: "# Arrived" over the boxes', /# Arrived/.test(await page.textContent('#modal .cl-head'))]);
    await page.evaluate(() => closeModal());

    // 6. Currencies: each box carries its own label when there are more than three.
    await page.evaluate(() => regionModal()); await page.waitForTimeout(300);
    await page.fill('#rgCur', 'EUR, PLN, MKD, HRK'); await page.dispatchEvent('#rgCur', 'change'); await page.waitForTimeout(300);
    const cells = await page.evaluate(() => ({ head: !!document.querySelector('#rgPrices .rp-head'),
      paired: [...document.querySelectorAll('#rgPrices .bk-row')][0].querySelectorAll('.rp-cell .rp-cur-m + input').length }));
    t.push(['4+ currencies: no separate title row; each box has its own title above it', !cells.head && cells.paired === 5]);
    await page.setViewportSize({ width: 390, height: 900 }); await page.waitForTimeout(200);
    await page.screenshot({ path: shot('2-currencies-phone') });
    await page.setViewportSize({ width: 1100, height: 950 });
    await page.evaluate(() => closeModal());

    // 7. Add new: room above Continue.
    await page.evaluate(() => addNewPlaceModal('stock')); await page.waitForTimeout(200);
    await page.click('#modal .opt[data-new="region"]'); await page.waitForTimeout(200);
    const gap = await page.evaluate(() => document.querySelector('#anGo').getBoundingClientRect().top - document.querySelector('#anSeasonPick').getBoundingClientRect().bottom);
    t.push(['"Continue" has room above it (≥ 12px)', gap >= 12]);
    await page.evaluate(() => closeModal());

    // 8. Creating something takes you there.
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(200);
    await page.evaluate(() => eventModal()); await page.fill('#evname', 'Temple Day'); await page.click('#saveEv'); await page.waitForTimeout(800);
    const at = await page.evaluate(() => ({ lvl: CUR_LEVEL, name: locName(CUR_LOC) }));
    t.push(['a new event opens straight away', at.lvl === 'event' && at.name === 'Temple Day']);

    // 9. The pencil returns to the dialog it was tapped in.
    await page.evaluate(r => goTo('region', r), pl.regionId);
    await page.evaluate(() => { EDIT_WORDING = true; addStockModal(); }); await page.waitForTimeout(400);
    await page.click('#modal .field label .pencil >> nth=0'); await page.waitForTimeout(300);
    await page.fill('#lblText', 'Where are these books going?'); await page.click('#lblSave'); await page.waitForTimeout(500);
    const back = await page.evaluate(() => ({ title: document.querySelector('#modal h3').textContent,
      label: document.querySelector('#modal .field label').textContent }));
    t.push(['after saving, you are back in Add Stock, with the new wording', /Add Stock/.test(back.title) && /Where are these books going/.test(back.label)]);
    await page.evaluate(() => { EDIT_WORDING = false; closeModal(); renderAll(); });

    // 10. Pre-order fulfilled by another region.
    await page.evaluate(() => { goTo('region', 'rg_it'); goTo('event', 'ev_mela2'); }); await page.waitForTimeout(300);
    await page.click(`.book:has([data-book="${B0}"]) .pre-btn`); await page.waitForTimeout(300);
    await page.fill('#cname', 'Maria'); await page.fill('#cphone', '+34 600 111');
    await page.fill('#ccomments', 'Spanish edition please');
    await page.selectOption('#fulSel', 'other'); await page.waitForTimeout(100);
    await pick(page, 'fulReg', 'Barcelona', 'Barcelona');
    await page.screenshot({ path: shot('3-preorder-ask') });
    await page.click('#saveSale'); await page.waitForTimeout(1500);
    const pre = (m.call({ action: 'getState', season: SA }).state.sales || []).find(x => x.name === 'Maria');
    t.push(['the pre-order asks Barcelona (Year-Round) to fulfil it', !!pre && pre.fulfilBy === 'rg_bcn' && pre.type === 'PREORDER']);
    const tag = await page.evaluate(() => document.querySelector('#prePanel') && document.querySelector('#prePanel').textContent);
    t.push(['in Italy it reads "For Barcelona"', /For Barcelona/.test(tag || '')]);

    await page.evaluate(sb => switchSeason(sb), SB); await page.waitForTimeout(1500);
    await page.evaluate(() => goTo('region', 'rg_bcn')); await page.waitForTimeout(500);
    const card = await page.evaluate(() => { const p = document.querySelector('#remotePanel');
      return p && p.style.display !== 'none' ? p.textContent.replace(/\s+/g, ' ') : ''; });
    t.push(['Barcelona sees the request with name, place and comments',
      /Maria/.test(card) && /Europe Tour › Italy › Mela — Day 2/.test(card) && /Spanish edition please/.test(card)]);
    await (await page.$('#remotePanel')).screenshot({ path: shot('4-request') });
    const salesBefore = await page.evaluate(() => (STATE.sales || []).length);
    await page.click('#remotePanel [data-act="rqfulfil"]'); await page.waitForTimeout(300);
    await page.click('#modal [data-rqfrom="wh_bcn"]'); await page.waitForTimeout(1600);
    t.push(['fulfilling takes the copy off Barcelona’s stock (5 → 4)', qty('wh_bcn', B0, SB) === 4]);
    t.push(['Barcelona records no sale (not counted in its sales or cash)', (await page.evaluate(() => (STATE.sales || []).length)) === salesBefore]);
    const note = await page.evaluate(() => { const n = document.querySelector('#log .rq-log'); return n ? n.textContent.replace(/\s+/g, ' ') : ''; });
    t.push(['Barcelona’s sales log has a note saying what happened', /Fulfilled a pre-order for another region/.test(note) && /Maria/.test(note) && /not counted/.test(note)]);
    const done = (m.call({ action: 'getState', season: SA }).state.sales || []).find(x => x.name === 'Maria');
    t.push(['in Italy the pre-order is now delivered', done.type === 'SALE' && done.delivered && done.dsource === 'Another region']);

    // 11. Fulfil one nobody flagged.
    c({ action: 'sell', saleId: 's_open2', location: 'wh_it', bookId: B0, isPreorder: true, legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }], name: 'Jaya' });
    await page.click('#adminActions button:has-text("Fulfil a pre-order for another region")'); await page.waitForTimeout(1200);
    const listed = await page.textContent('#foList');
    t.push(['"Fulfil a pre-order for another region" lists open pre-orders elsewhere', /Jaya/.test(listed) && /Europe Tour › Italy/.test(listed)]);
    await page.click('#foList [data-fo="s_open2"]'); await page.waitForTimeout(300);
    await page.click('#modal [data-rqfrom="wh_bcn"]'); await page.waitForTimeout(1600);
    const jaya = (m.call({ action: 'getState', season: SA }).state.sales || []).find(x => x.saleId === 's_open2');
    t.push(['…and fulfils it from here', jaya.delivered && jaya.fulfilBy === 'rg_bcn' && qty('wh_bcn', B0, SB) === 3]);

    // 12. Deliver screen offers "Another region".
    await page.evaluate(sa => switchSeason(sa), SA); await page.waitForTimeout(1500);
    c({ action: 'sell', saleId: 's_open3', location: 'wh_it', bookId: B0, isPreorder: true, legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }], name: 'Ravi' });
    await page.evaluate(() => pull()); await page.waitForTimeout(800);
    await page.evaluate(() => { goTo('region', 'rg_it'); deliverModal('s_open3'); }); await page.waitForTimeout(300);
    t.push(['Deliver offers "Another region will fulfil it"', /Another region will fulfil it/.test(await page.textContent('#modal .opts'))]);
    await page.evaluate(() => closeModal());

    // 13. List view.
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(300);
    await page.click('#viewBtn'); await page.waitForTimeout(300);
    t.push(['"List view" turns the cards into rows', await page.evaluate(() => document.body.classList.contains('list-view')
      && getComputedStyle(document.querySelector('.inv-grid')).gridTemplateColumns.split(' ').length === 1)]);
    t.push(['…and the button now offers "Card view"', /Card view/.test(await page.textContent('#viewBtn'))]);
    await page.screenshot({ path: shot('5-list-desktop') });
    await page.reload(); await page.waitForTimeout(2000);
    t.push(['list view is remembered on the device (after a reload)', await page.evaluate(() => document.body.classList.contains('list-view'))]);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(400);
    await page.screenshot({ path: shot('6-list-phone') });
    t.push(['phone: list view fits the screen', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)]);
    await page.click('#viewBtn'); await page.waitForTimeout(200);
    t.push(['"Card view" goes back to cards', !(await page.evaluate(() => document.body.classList.contains('list-view')))]);
    await page.close();
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
