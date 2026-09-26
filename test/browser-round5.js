/* Optional, needs Playwright + Chromium: node test/browser-round5.js
   b188 requests, in a real browser against the real Code.gs (via mini.js):
   pencils everywhere (dialog headings, "7 still coming"), rewording that keeps
   working parts (the spinner), numbers kept in reworded counts, errors brought
   into view, a delete that never comes back, editing where a shipment came
   from, and Share Links above Spreadsheet Links. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-r5-' + n + '.png');

m.init();
const ok = (r, what) => { if (!r.ok) throw new Error(what + ': ' + r.error); return r; };
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason;
const books = st.books.filter(b => !b.partnerId);
const [B0, B1, B2] = books.map(b => b.id);
const pl = st.regions[0];
const c = (p, w) => ok(m.call(Object.assign({ season: SA }, p)), w || p.action);
c({ action: 'createEvent', eventId: 'ev_fest', name: 'Festival', regionId: pl.regionId });
c({ action: 'adjustStockBulk', location: pl.whLoc, items: [{ bookId: B0, delta: 20 }, { bookId: B1, delta: 10 }, { bookId: B2, delta: 20 }], override: true });
c({ action: 'sendShipment', mode: 'devotee', fromRegion: 'OUTSIDE', toRegion: pl.regionId, toLoc: pl.whLoc, shipId: 'sh_out1',
  carrier: 'Narada', origin: 'the prnter', items: [{ bookId: B0, qty: 7 }] });
const state = () => m.call({ action: 'getState', season: SA }).state;
const qty = (loc, b) => { const r = (state().inventory || []).find(i => i.location === loc && i.bookId === b); return r ? Number(r.qty) : 0; };

(async () => {
  const browser = await chromium.launch();
  const t = [], errors = [];
  async function open(width) {
    const page = await browser.newPage({ viewport: { width: width || 1100, height: 700 } });
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => { page.__dialogs = (page.__dialogs || []).concat(d.message()); d.accept(); });
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.includes('script.google.com')) {
        let p = {}; try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
        // The log's first fetch leaves before a delete and arrives after it.
        if (page.__slowLog && p.action === 'activity') {
          const body = JSON.stringify(m.call(p));
          await new Promise(r => setTimeout(r, 2500));
          return route.fulfill({ status: 200, contentType: 'application/json', body });
        }
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
  let page;
  try {
    page = await open();
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(300);

    // 1. Share Links above Spreadsheet Links.
    const adm = await page.evaluate(() => [...document.querySelectorAll('#adminActions .adm-col')][0].innerText);
    t.push(['Admin: Share Links comes before Spreadsheet Links', adm.indexOf('Share Links') >= 0 && adm.indexOf('Share Links') < adm.indexOf('Spreadsheet Links')]);

    // 2. A delete made before the log's first fetch returns stays deleted.
    c({ action: 'transferMulti', moves: [{ from: pl.whLoc, to: 'ev_fest', bookId: B0, qty: 2 }, { from: pl.whLoc, to: 'ev_fest', bookId: B1, qty: 3 }], movePrefix: 'Mr5' });
    await page.evaluate(() => pull()); await page.waitForTimeout(600);
    await page.evaluate(() => activityModal()); await page.waitForTimeout(1300);   // first look, cached
    await page.evaluate(() => closeModal());
    page.__slowLog = true;
    await page.evaluate(() => activityModal()); await page.waitForTimeout(300);
    const row = page.locator('#alList .al-row').filter({ hasText: '5 books transferred' }).first();
    await row.locator('[data-alundo]').click(); await page.waitForTimeout(3500);
    const kept = await page.evaluate(() => { const r = [...document.querySelectorAll('#alList .al-row')].find(x => /5 books transferred/.test(x.textContent) && !/^Undid/.test(x.querySelector('.al-text').textContent));
      return r ? r.classList.contains('undone') : null; });
    t.push(['a Delete made while the log was still loading does not come back', kept === true]);
    t.push(['…and the books are back', qty('ev_fest', B0) === 0 && qty('ev_fest', B1) === 0]);
    page.__slowLog = false;
    await page.evaluate(() => closeModal());

    // 3. Errors are brought into view.
    await page.evaluate(() => bundleModal()); await page.waitForTimeout(300);
    await page.evaluate(() => { document.querySelector('#modal .m-body').scrollTop = 0; });
    await page.click('#saveBundle'); await page.waitForTimeout(900);
    const vis = await page.evaluate(() => { const e = document.querySelector('#modalErr').getBoundingClientRect();
      const b = document.querySelector('#modal .m-body').getBoundingClientRect();
      return { text: document.querySelector('#modalErr').textContent, inView: e.top >= b.top && e.bottom <= b.bottom }; });
    t.push(['Multiple Books: the error is scrolled into view', /at least two books/.test(vis.text) && vis.inView]);
    await page.screenshot({ path: shot('1-error') });
    await page.evaluate(() => closeModal());

    // 4. Pencils everywhere.
    await page.evaluate(() => { EDIT_WORDING = true; renderAll(); }); await page.waitForTimeout(300);
    await page.evaluate(b => saleModal({ bookId: b, isPreorder: false, loc: CUR_LOC }), B0); await page.waitForTimeout(400);
    t.push(['a dialog heading has a pencil', await page.evaluate(() => !!document.querySelector('#modal > h3 > .pencil'))]);
    await page.evaluate(() => closeModal());
    await page.evaluate(() => shipReceiveModal('sh_out1')); await page.waitForTimeout(400);
    const coming = await page.evaluate(() => { const e = [...document.querySelectorAll('#modal .cl-exp')].find(x => /still coming/.test(x.textContent));
      return e ? { pencil: !!e.querySelector('.pencil'), key: e.getAttribute('data-key') } : null; });
    t.push(['"7 still coming" has a pencil', !!coming && coming.pencil]);
    t.push(['…and is known as "# still coming"', !!coming && / › # still coming$/.test(coming.key)]);
    await page.evaluate(k => commit({ action: 'saveLabel', key: normLabelKey(k), text: '# on the way' },
      st => { st.labels = st.labels || {}; st.labels[normLabelKey(k)] = '# on the way'; }, null, { keepOpen: true }), coming.key);
    await page.waitForTimeout(300);
    const reworded = await page.evaluate(() => [...document.querySelectorAll('#modal .cl-exp')].map(x => labelTextOf(x)).join('|'));
    t.push(['rewording keeps the number: "7 on the way"', /7 on the way/.test(reworded)]);
    await page.screenshot({ path: shot('2-pencils') });
    await page.evaluate(() => closeModal());

    // 5. Rewording keeps a working part: the spinner in the Activity Log.
    page.__slowLog = true;
    await page.evaluate(() => activityModal()); await page.waitForTimeout(300);
    const spinKey = await page.evaluate(() => document.querySelector('#alState').getAttribute('data-key'));
    await page.evaluate(k => commit({ action: 'saveLabel', key: normLabelKey(k), text: 'Looking for anything new' },
      st => { st.labels = st.labels || {}; st.labels[normLabelKey(k)] = 'Looking for anything new'; }, null, { keepOpen: true }), spinKey);
    await page.waitForTimeout(300);
    const spin = await page.evaluate(() => { const e = document.querySelector('#alState'); return { spinner: !!e.querySelector('.spin-d'), text: labelTextOf(e) }; });
    t.push(['reworded "Checking for the latest…" keeps its spinner', spin.spinner && /Looking for anything new/.test(spin.text)]);
    await page.screenshot({ path: shot('3-spinner') });
    await page.waitForTimeout(2600);
    page.__slowLog = false;
    await page.evaluate(() => { closeModal(); EDIT_WORDING = false; renderAll(); });

    // 6. Where outside books came from can be corrected.
    await page.evaluate(() => shipEditModal('sh_out1')); await page.waitForTimeout(300);
    t.push(['Shipment details shows "Coming From"', (await page.inputValue('#seOrigin')) === 'the prnter']);
    await page.fill('#seOrigin', 'the printer');
    await page.click('#seSave'); await page.waitForTimeout(1500);
    t.push(['…and the correction is saved', (state().shipments || []).find(x => x.shipId === 'sh_out1').origin === 'the printer']);
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
