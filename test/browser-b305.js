/* Optional, needs Playwright + Chromium: node test/browser-b305.js
   b305 (Live app changes): names found without their accents; Earthly HQ's
   Summaries above Sales and Change Location Order there, season by season and
   region by region; Return all at a region goes back to Earthly HQ; Add Stock
   asks the kind of book first (Adventures needs only a language); Correct
   Contents can add a title the app does not have yet; "coming" gone from
   books in transit; long lists of figures balanced; and in practice the
   Transfer log on the shelf. Finance's parts are in browser-finance.js. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){ return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
m.init();
const st = m.call({ action: 'getState' }).state, SA = st.activeSeason;
const c = (p, season) => { const r = m.call(Object.assign({ season: season || SA }, p)); if (!r.ok) throw new Error(p.action + ': ' + r.error); return r; };
const R0 = st.regions[0], R0name = R0.name;
const B = st.books.find(b => !b.partnerId).id;
c({ action: 'createEvent', eventId: 'ev_sri', name: 'Śrī Vṛndāvana Fair', regionId: R0.regionId });
c({ action: 'createEvent', eventId: 'ev_two', name: 'Second Fair', regionId: R0.regionId });
c({ action: 'adjustStockBulk', location: R0.whLoc, items: [{ bookId: B, delta: 10 }], override: true });
c({ action: 'sendShipment', shipId: 'sh_b305', mode: 'devotee', fromRegion: 'OUTSIDE', origin: 'the printer',
  toRegion: R0.regionId, toLoc: R0.whLoc, carrier: 'Narada', items: [{ bookId: B, qty: 3 }] });
const S2 = c({ action: 'saveSeason', name: 'Year-Round' }).result;
c({ action: 'createRegion', regionId: 'rg_b1', whLoc: 'wh_b1', name: 'Barcelona', currencies: 'EUR' }, S2);
c({ action: 'createRegion', regionId: 'rg_b2', whLoc: 'wh_b2', name: 'Bilbao', currencies: 'EUR' }, S2);
c({ action: 'setSeason', seasonId: SA });
const SHIP = m.call({ action: 'getState', season: SA }).state.shipments.find(x => x.carrier === 'Narada').shipId;

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
    return [...document.querySelectorAll('#modal *, #totals *')].filter(e => e.offsetParent && e.getBoundingClientRect().right > W + 1).length; });
  try {
    await page.goto('http://app.test/index.html');
    await page.waitForTimeout(2500);

    /* 1. Accents: typing "sri vrndavana" finds "Śrī Vṛndāvana Fair". (Earthly HQ is opened
       once first: its warehouse is made the first time it is opened, as on the live app.) */
    await page.evaluate(() => document.querySelector('[data-act="gohq"]').click()); await page.waitForTimeout(1500);
    await page.evaluate(s => switchSeason(s), SA); await page.waitForTimeout(1500);
    await page.evaluate(r => goTo('region', r), R0.regionId); await page.waitForTimeout(400);
    await page.evaluate(() => transferStockModal()); await page.waitForTimeout(400);
    await page.click('#xfTo .pp-in'); await page.fill('#xfTo .pp-in', 'sri vrndavana'); await page.waitForTimeout(200);
    const hits = await page.$$eval('#xfTo .pp-row', rs => rs.filter(r => r.offsetParent).map(r => r.textContent));
    t.push(['accents: "sri vrndavana" finds Śrī Vṛndāvana Fair (' + hits.join(' | ') + ')', hits.some(h => /Śrī Vṛndāvana Fair/.test(h))]);
    t.push(['b307: the Transfer log button is live too', await page.evaluate(() => { const b = document.querySelector('#invHeading .tl-btn'); return !!b && !b.hidden; })]);
    t.push(['accents: the shared search folds them too', await page.evaluate(() => fold('Śrī Vṛndāvana') === 'sri vrndavana')]);

    /* 2. Return all at a region: from its warehouse back to Earthly HQ's. */
    await page.click('#xfReturn'); await page.waitForTimeout(600);
    const rv = await page.evaluate(() => ({ from: document.querySelector('#xfFrom .pp-in').value, to: document.querySelector('#xfTo .pp-in').value, err: document.querySelector('#modalErr').textContent }));
    t.push(['region Return all: From is the region\'s warehouse, To is Earthly HQ (' + rv.from + ' → ' + rv.to + ')', new RegExp(R0name).test(rv.from) && /Earthly HQ/i.test(rv.to) && !rv.err]);
    t.push(['…the hint says regions go back to Earthly HQ', /at a region back to Earthly HQ/.test(await page.textContent('#modal'))]);
    await page.evaluate(() => closeModal());

    /* 3. Books in transit: the number, no "coming". */
    const tr = await page.evaluate(() => { const s = document.querySelector('#transitBar, .transit, #invGrid'); return document.body.innerText; });
    t.push(['books in transit: no word "coming"', !/\d+\s+coming/.test(tr)]);

    /* 4. Add Stock: the kind of book first; Adventures asks only the language. */
    await page.evaluate(() => addStockModal()); await page.waitForTimeout(400);
    await page.click('#spPlace .pp-in'); await page.fill('#spPlace .pp-in', R0name);
    await page.click(`#spPlace .pp-row:has-text("${R0name}")`); await page.waitForTimeout(600);
    await page.selectOption('#spWhere', 'there'); await page.waitForTimeout(200);
    await page.evaluate(() => { const s = [...document.querySelectorAll('#spBody .ln-title')].pop(); s.value = '__new'; s.dispatchEvent(new Event('change', { bubbles: true })); }); await page.waitForTimeout(200);
    const order = await page.evaluate(() => { const k = document.querySelector('#spBody .ln-nbcat'), ti = document.querySelector('#spBody .ln-nbname');
      return { kind: !!k, first: !!(k && (!ti || (k.compareDocumentPosition(ti) & Node.DOCUMENT_POSITION_FOLLOWING))) }; });
    t.push(['Add Stock: "the kind of book" comes first', order.kind && order.first]);
    await page.selectOption('#spBody .ln-nbcat', 'aotm'); await page.waitForTimeout(200);
    const av = await page.evaluate(() => ({ title: !!document.querySelector('#spBody .ln-nbname'), lang: !!document.querySelector('#spBody .ln-nblang') }));
    t.push(['…Adventures: no title box, only the language', !av.title && av.lang]);
    await page.evaluate(() => closeModal());

    /* 5. Correct Contents: a title the app does not have yet. */
    await page.evaluate(() => pull()); await page.waitForTimeout(1200);
    await page.evaluate(id => shipCountModal(id), SHIP); await page.waitForTimeout(400);
    await page.click('#scNew'); await page.waitForTimeout(150);
    await page.selectOption('#scNcat', 'big'); await page.fill('#scNname', 'Gita Mahatmya'); await page.fill('#scNlang', 'Hindi');
    await page.click('#scNadd'); await page.waitForTimeout(200);
    const newRow = await page.$('#scNewRows .sc-q');
    t.push(['Correct Contents: "＋ A new book…" adds its line', !!newRow]);
    if (newRow) await newRow.fill('2');
    t.push(['…no overflow in the window', await spill() === 0]);
    await page.click('#scGo'); await page.waitForTimeout(2000);
    const s5 = state(), nb = s5.books.find(b => b.name === 'Gita Mahatmya (Hindi)');
    const sh5 = (s5.shipments || []).find(x => x.shipId === SHIP);
    t.push(['…saving adds the title to the catalogue', !!nb]);
    t.push(['…and 2 of it to the batch', !!nb && !!sh5 && Number((sh5.manifest || {})[nb.id]) === 2]);

    /* 6. Earthly HQ: Summaries above Sales, and Change Location Order. */
    await page.evaluate(() => document.querySelector('[data-act="gohq"]').click()); await page.waitForTimeout(1500);
    t.push(['Earthly HQ: Summaries come above Sales', await page.evaluate(() => { const a = document.querySelector('#summaryPortal'), b = document.querySelector('#salesPortal');
      return !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); })]);
    t.push(['Earthly HQ: the menu has Change Location Order', await page.evaluate(() => !!document.querySelector('[data-act="reorder"]'))]);
    await page.evaluate(() => reorderModal('region')); await page.waitForTimeout(500);
    const snOpts = await page.$$eval('#roSnSel option', o => o.map(x => x.textContent));
    t.push(['…a Season menu (' + snOpts.join(', ') + ')', snOpts.length >= 2 && snOpts.includes('Year-Round')]);
    await page.selectOption('#roSnSel', S2); await page.waitForTimeout(1200);
    const rnames = await page.$$eval('#roList .ro-name', r => r.map(x => x.textContent.trim()));
    t.push(['…choosing Year-Round lists its regions (' + rnames.join(', ') + ')', rnames.join() === 'Barcelona,Bilbao']);
    await page.click('#roList [data-ro-dn="0"]'); await page.click('#roSave'); await page.waitForTimeout(1500);
    t.push(['…and its new order is saved', state(S2).regions.filter(r => /^rg_b/.test(r.regionId)).map(r => r.name).join() === 'Bilbao,Barcelona']);
    await page.evaluate(() => reorderModal('event')); await page.waitForTimeout(500);
    await page.selectOption('#roSnSel', SA); await page.waitForTimeout(300);
    t.push(['…the Event tab has Season and Region menus', !!(await page.$('#roSnSel')) && !!(await page.$('#roRegSel'))]);
    await page.selectOption('#roRegSel', R0.regionId); await page.waitForTimeout(200);
    const evs = await page.$$eval('#roList .ro-name', r => r.map(x => x.textContent.trim()));
    t.push(['…picking a region lists its events (' + evs.join(', ') + ')', evs.includes('Second Fair') && evs.some(e => /Vṛndāvana/.test(e))]);
    await page.evaluate(() => closeModal());

    /* 7. Long lists of figures: each item whole, the lines balanced. */
    const bal = await page.evaluate(async () => { const d = document.createElement('div'); d.style.width = '120px'; d.textContent = '1,099 € · £2,290 · ₹80,400 · 6,250 ден';
      document.querySelector('#app, main, body').appendChild(d); await new Promise(r => setTimeout(r, 50));
      const r = { n: d.querySelectorAll('.bal-i').length, cls: d.classList.contains('bal'), text: d.textContent === '1,099 € · £2,290 · ₹80,400 · 6,250 ден' }; d.remove(); return r; });
    t.push(['balance: "a · b · c" lists keep each figure whole, on balanced lines, words unchanged', bal.n === 4 && bal.cls && bal.text]);

    /* 8. Practice: the Transfer log. */
    c({ action: 'transferMulti', moves: [{ from: R0.whLoc, to: 'ev_two', bookId: B, qty: 2 }] });
    await page.goto('http://app.test/index.html?practice'); await page.waitForTimeout(2500);
    await page.evaluate(r => goTo('region', r), R0.regionId); await page.waitForTimeout(600);
    t.push(['practice: a small "Transfer log" button by the shelf\'s title', await page.evaluate(() => { const b = document.querySelector('#invHeading .tl-btn'); return !!b && !b.hidden; })]);
    await page.click('#invHeading .tl-btn'); await page.waitForTimeout(300);
    const rows = await page.$$eval('#modal .tl-row', rs => rs.map(r => ({ cls: r.className, s: r.querySelector('summary').innerText.replace(/\s+/g, ' ') })));
    t.push(['…one line per transfer: date, where to, how many (' + rows.map(r => r.s).join(' | ') + ')', rows.some(r => /out/.test(r.cls) && /To Second Fair/.test(r.s) && /2 books/.test(r.s))]);
    const cols = await page.evaluate(() => { const o = document.querySelector('#modal .tl-row.out'), i = document.querySelector('#modal .tl-row.in');
      return [o && getComputedStyle(o).borderLeftColor, i && getComputedStyle(i).borderLeftColor]; });
    t.push(['…in and out in different colours', !!cols[0] && (!cols[1] || cols[0] !== cols[1])]);
    await page.click('#modal .tl-row.out summary'); await page.waitForTimeout(150);
    t.push(['…the drop-down shows the titles', await page.evaluate(() => document.querySelector('#modal .tl-row.out').open && /2/.test(document.querySelector('#modal .tl-row.out .tl-det').innerText))]);
    await page.setViewportSize({ width: 390, height: 900 }); await page.waitForTimeout(200);
    t.push(['…no overflow on a phone', await spill() === 0]);
    await page.evaluate(() => closeModal());
  } catch (e) { t.push(['STOPPED: ' + e.message, false]); }

  t.push(['no page errors' + (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''), !errors.length]);
  let bad = 0;
  t.forEach(([n, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; });
  console.log(bad ? bad + ' failed' : 'all ' + t.length + ' passed');
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('STOPPED ' + e.stack); process.exit(1); });
