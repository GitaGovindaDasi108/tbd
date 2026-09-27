/* Optional, needs Playwright + Chromium: node test/browser-round7.js
   b191: totals honor dollars received, SOLD OUT clear of the title, green Sell,
   saving closing progress, edits that keep everything, Speciality Reports, and
   titles never brought to an event hiding themselves. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-r7-' + n + '.png');

m.init();
const ok = (r, what) => { if (!r.ok) throw new Error(what + ': ' + r.error); return r; };
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason;
const books = st.books.filter(b => !b.partnerId);
const [B0, B1, B2] = books.map(b => b.id);
const pl = st.regions[0];
const c = (p, w) => ok(m.call(Object.assign({ season: SA }, p)), w || p.action);
c({ action: 'createEvent', eventId: 'ev_mad', name: 'Madrid', regionId: pl.regionId });
c({ action: 'createEvent', eventId: 'ev_bcn', name: 'Barcelona', regionId: pl.regionId });
c({ action: 'createEvent', eventId: 'ev_new', name: 'Kirtan Mela', regionId: pl.regionId });
c({ action: 'adjustStockBulk', location: pl.whLoc, items: [{ bookId: B0, delta: 30 }, { bookId: B1, delta: 10 }], override: true });
c({ action: 'transferMulti', moves: [{ from: pl.whLoc, to: 'ev_mad', bookId: B0, qty: 5 }, { from: pl.whLoc, to: 'ev_bcn', bookId: B0, qty: 5 },
  { from: pl.whLoc, to: 'ev_new', bookId: B0, qty: 2 }], movePrefix: 'Mr7' });
c({ action: 'sell', saleId: 's_mad1', location: 'ev_mad', bookId: B0, legs: [{ type: 'Cash', cur: 'PLN', amt: 150 }] });
c({ action: 'sell', saleId: 's_mad2', location: 'ev_mad', bookId: B0, legs: [{ type: 'Cash', cur: 'PLN', amt: 150 }] });
c({ action: 'sell', saleId: 's_bcn1', location: 'ev_bcn', bookId: B0, legs: [{ type: 'Cash', cur: 'PLN', amt: 150 }] });
c({ action: 'sell', saleId: 's_card', location: pl.whLoc, bookId: B1, legs: [{ type: 'Card', cur: 'PLN', amt: 150 }] });
c({ action: 'setUsdActual', saleId: 's_card', usd: 30 });
c({ action: 'sell', saleId: 's_odd', location: pl.whLoc, bookId: B1, legs: [{ type: 'Zelle', cur: 'GBP', amt: 10 }], name: 'Odd One' });
const state = () => m.call({ action: 'getState', season: SA }).state;

(async () => {
  const browser = await chromium.launch();
  const t = [], errors = [];
  const page = await browser.newPage({ viewport: { width: 1100, height: 950 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.includes('script.google.com')) {
      let p = {}; try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(m.call(p)) });
    }
    if (url.startsWith('http://app.test/')) {
      const f = path.join(ROOT, new URL(url).pathname.replace(/^\/+/, '') || 'index.html');
      if (fs.existsSync(f) && fs.statSync(f).isFile())
        return route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : undefined });
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto('http://app.test/index.html'); await page.waitForTimeout(2000);
  try {
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(300);

    // 1. The totals bar uses the dollars received.
    const tot = await page.evaluate(() => {
      const shown = Number(document.querySelector('#totals .tcard.usd .value').textContent.replace(/[^0-9.]/g, ''));
      const want = tourSales().filter(received).reduce((a, x) => a + saleUsd(x), 0);
      const est = tourSales().filter(received).reduce((a, x) => a + legsUSD(x), 0);
      return { shown, want: Math.round(want * 100) / 100, est: Math.round(est * 100) / 100 };
    });
    console.log('   totals:', tot);
    t.push(['Total Collections uses the $30 received, not the estimate', Math.abs(tot.shown - tot.want) < 0.02 && Math.abs(tot.shown - tot.est) > 0.5]);

    // 2/3. SOLD OUT clear of the title; Sell is Deliver's green.
    const card = await page.evaluate(() => {
      const tag = document.querySelector('.book .sold-tag'); if (!tag) return null;
      const bk = tag.closest('.book'), a = tag.getBoundingClientRect(), b = bk.querySelector('.bname').getBoundingClientRect();
      const overlap = !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
      const green = getComputedStyle(document.documentElement).getPropertyValue('--green').trim();
      const probe = document.createElement('div'); probe.style.background = green; document.body.appendChild(probe);
      const g = getComputedStyle(probe).backgroundColor; probe.remove();
      return { overlap, sell: getComputedStyle(document.querySelector('.sell-btn:not([disabled])')).backgroundColor, green: g };
    });
    t.push(['SOLD OUT no longer covers the title', !!card && !card.overlap]);
    t.push(['Sell is the same green as Deliver', !!card && card.sell === card.green]);
    await (await page.$('.book:has(.sold-tag)')).screenshot({ path: shot('1-soldout') });

    // 4. Closing checklist: save progress, and it comes back.
    await page.evaluate(() => goTo('event', 'ev_new')); await page.waitForTimeout(300);
    await page.evaluate(() => closeModalFor('event')); await page.waitForTimeout(300);
    await page.check('#modal .cl-q[data-i="0"]');
    await page.fill(`#modal .cl-in[data-key="ev_new|${B0}"]`, '1');
    await page.fill('#clNote', 'half done');
    await page.click('#clSave'); await page.waitForTimeout(1200);
    const d = (state().closeDrafts || {})['event:ev_new'];
    t.push(['Save progress stores the ticks, counts and note', !!d && d.checks.includes(0) && d.counts[`ev_new|${B0}`] === 1 && d.note === 'half done']);
    await page.evaluate(() => closeModal());
    await page.evaluate(() => closeModalFor('event')); await page.waitForTimeout(300);
    const back = await page.evaluate(b => ({ q: document.querySelector('#modal .cl-q[data-i="0"]').checked,
      n: document.querySelector(`#modal .cl-in[data-key="ev_new|${b}"]`).value, note: document.querySelector('#clNote').value,
      saved: document.querySelector('#clSaved').textContent }), B0);
    t.push(['reopened: everything is as it was left', back.q && back.n === '1' && back.note === 'half done' && /Progress saved/.test(back.saved)]);
    await page.screenshot({ path: shot('2-close') });
    await page.evaluate(() => closeModal());

    // 5. Editing keeps everything, even a payment type or currency this place does not list.
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(300);
    await page.evaluate(() => { const x = STATE.sales.find(v => v.saleId === 's_odd'); saleModal({ bookId: x.bookId, edit: x }); });
    await page.waitForTimeout(300);
    const ed = await page.evaluate(() => ({ type: $('#ptype').value, cur: $('#pcur').value, amt: $('#pamt').value, name: $('#cname').value,
      open: document.querySelector('#specBox').open }));
    t.push(['Edit shows the sale’s own payment type and currency (Zelle, GBP)', ed.type === 'Zelle' && ed.cur === 'GBP' && ed.amt === '10']);
    t.push(['Edit opens Specialized Sales with the name', ed.open && ed.name === 'Odd One']);
    await page.click('#saveSale'); await page.waitForTimeout(1200);
    const odd = state().sales.find(v => v.saleId === 's_odd');
    t.push(['saving without changes keeps it exactly', odd.p1type === 'Zelle' && odd.p1cur === 'GBP' && Number(odd.p1amt) === 10]);
    await page.evaluate(() => closeModal());

    // 6. Speciality Reports.
    const admBtns = await page.evaluate(() => [...document.querySelectorAll('#adminActions button')].map(b => b.textContent.trim()));
    t.push(['App Admin has "Speciality Reports"', admBtns.some(x => /Speciality Reports/.test(x))]);
    await page.click('#adminActions button:has-text("Speciality Reports")'); await page.waitForTimeout(300);
    await page.click('#spMode [data-mode="events"]');
    await page.check('#spPlaces [data-sp="ev_mad"]'); await page.check('#spPlaces [data-sp="ev_bcn"]'); await page.waitForTimeout(100);
    let rep = await page.inputValue('#repText');
    console.log('   report:\n' + rep.split('\n').map(x => '     ' + x).join('\n'));
    t.push(['the report is titled "Madrid + Barcelona Totals"', /^\*Madrid \+ Barcelona Totals\*/.test(rep)]);
    t.push(['…and adds them together (3 sold)', /- 3\b/.test(rep) && /450 zł|450/.test(rep)]);
    t.push(['…with each place listed', /BY PLACE/.test(rep) && /Madrid - /.test(rep) && /Barcelona - /.test(rep)]);
    await page.uncheck('#modal [data-sr="cash"]'); await page.waitForTimeout(100);
    rep = await page.inputValue('#repText');
    t.push(['unticking a section takes it out', !/COLLECTIONS/.test(rep) && /SALES BY TITLE/.test(rep)]);
    await page.screenshot({ path: shot('3-speciality') });
    await page.click('#spMode [data-mode="regions"]'); await page.check(`#spPlaces [data-sp="${pl.regionId}"]`); await page.waitForTimeout(100);
    t.push(['regions can be chosen too', new RegExp('^\\*' + pl.name + ' Totals\\*').test(await page.inputValue('#repText'))]);
    await page.evaluate(() => closeModal());

    // 7. Auto-hide at an event.
    await page.evaluate(() => goTo('event', 'ev_new')); await page.waitForTimeout(300);
    const shelf = await page.evaluate(() => shelfBooks().map(b => b.id));
    t.push(['at an event, only titles brought in are on the shelf', shelf.length === 1 && shelf[0] === B0]);
    t.push(['the rest are one tap away to pre-order', await page.evaluate(() => /Pre-Orders \(Unlisted Titles\)/.test(document.querySelector('#invMulti').textContent))]);
    await page.evaluate(() => bookDisplayModal()); await page.waitForTimeout(300);
    t.push(['Edit Book Display marks them "no copies here yet"', /no copies here yet/.test(await page.textContent('#bdList'))]);
    await page.check(`#modal [data-bd="${B1}"]`); await page.click('#bdSave'); await page.waitForTimeout(1200);
    t.push(['ticking one shows it anyway', await page.evaluate(b => shelfBooks().some(x => x.id === b), B1)]);
    await page.screenshot({ path: shot('4-event') });
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
