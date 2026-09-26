/* Optional, needs Playwright + Chromium: node test/browser-round4.js
   b187 requests, in a real browser against the real Code.gs (via mini.js):
   instant Reopen and activity Delete (and a deleted line stays deleted),
   mixed payments that fill themselves and can be more than two, stock refused
   before saving, "Selling from" in a multi-book sale, Coming From in Add Stock,
   Return all to warehouse, and wording that changes everywhere at once. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-r4-' + n + '.png');

m.init();
const ok = (r, what) => { if (!r.ok) throw new Error(what + ': ' + r.error); return r; };
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason;
const books = st.books.filter(b => !b.partnerId);
const [B0, B1, B2, B3] = books.map(b => b.id);
const pl = st.regions[0];
const c = (p, w) => ok(m.call(Object.assign({ season: SA }, p)), w || p.action);
c({ action: 'createEvent', eventId: 'ev_fest', name: 'Festival', regionId: pl.regionId });
c({ action: 'createEvent', eventId: 'ev_yoga', name: 'Yoga Day', regionId: pl.regionId });
c({ action: 'adjustStockBulk', location: pl.whLoc, items: [{ bookId: B0, delta: 20 }, { bookId: B1, delta: 10 }, { bookId: B2, delta: 20 }], override: true });
c({ action: 'saveHolder', newHolderId: 'hd_radha1', regionId: pl.regionId, name: 'Radha', phone: '+48 1' });
c({ action: 'adjustStockBulk', location: 'hd_radha1', items: [{ bookId: B0, delta: 4 }], override: true });
c({ action: 'transferMulti', moves: [{ from: pl.whLoc, to: 'ev_yoga', bookId: B0, qty: 3 }, { from: pl.whLoc, to: 'ev_yoga', bookId: B1, qty: 2 }], movePrefix: 'Myg' });
c({ action: 'closeLocation', kind: 'event', id: 'ev_fest', counts: {} });
const state = () => m.call({ action: 'getState', season: SA }).state;
const qty = (loc, b) => { const r = (state().inventory || []).find(i => i.location === loc && i.bookId === b); return r ? Number(r.qty) : 0; };

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
        // A slow server, so "instant" means shown before the reply comes back.
        if (page.__slow && p.action && !/^(ping|getState|activity|opStatus)$/.test(p.action)) await new Promise(r => setTimeout(r, 1500));
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

    // 1. Reopen an event: instant, with the server slow.
    page.__slow = true;
    await page.evaluate(() => goTo('event', 'ev_fest')); await page.waitForTimeout(300);
    await page.evaluate(() => reopenHere()); await page.waitForTimeout(150);
    t.push(['Reopen shows at once, before the server answers',
      await page.evaluate(() => !(STATE.events.find(e => e.eventId === 'ev_fest') || {}).closedAt)]);
    await page.waitForTimeout(2500);
    t.push(['…and the server has it', !(state().events.find(e => e.eventId === 'ev_fest') || {}).closedAt]);

    // 2. Activity log: Delete is instant, and the deleted line stays deleted.
    c({ action: 'transferMulti', moves: [{ from: pl.whLoc, to: 'ev_fest', bookId: B0, qty: 2 }, { from: pl.whLoc, to: 'ev_fest', bookId: B1, qty: 3 },
      { from: pl.whLoc, to: 'ev_fest', bookId: B2, qty: 10 }], movePrefix: 'Mr4' });
    await page.evaluate(() => pull()); await page.waitForTimeout(600);
    await page.evaluate(r => { goTo('region', r); activityModal(); }, pl.regionId); await page.waitForTimeout(1200);
    let entry = page.locator('#alList .al-row').filter({ hasText: '15 books transferred' }).first();
    await entry.locator('.al-tog').click(); await page.waitForTimeout(200);
    await entry.locator('.al-part').filter({ hasText: '×10 transferred' }).locator('[data-alpart]').click(); await page.waitForTimeout(200);
    const fast = await page.evaluate(b => ({ gone: !!document.querySelector('#alList .al-part.undone'), at: invQty('ev_fest', b) }), B2);
    t.push(['deleting a line shows at once: crossed out, books back on screen', fast.gone && fast.at === 0]);
    t.push(['the dialog stays open', await page.evaluate(() => !!document.querySelector('#alList'))]);
    await page.waitForTimeout(2500);
    t.push(['…and the server has it', qty('ev_fest', B2) === 0 && qty('ev_fest', B1) === 3]);
    await page.evaluate(() => { closeModal(); activityModal(); }); await page.waitForTimeout(1500);
    entry = page.locator('#alList .al-row').filter({ hasText: '15 books transferred' }).first();
    const lines = await entry.locator('.al-part').evaluateAll(els => els.map(e => ({ t: e.textContent.replace(/\s+/g, ' '), undone: e.classList.contains('undone') })));
    t.push(['reopened: the deleted line is still marked Undone', lines.some(x => /×10/.test(x.t) && x.undone) && lines.filter(x => !x.undone).length === 2]);
    await page.screenshot({ path: shot('1-activity') });
    await entry.locator('[data-alundo]').click(); await page.waitForTimeout(200);
    t.push(['Delete all is instant too', await page.evaluate(b => invQty('ev_fest', b) === 0, B0)]);
    await page.waitForTimeout(2500);
    t.push(['…and the server has it', qty('ev_fest', B0) === 0 && qty('ev_fest', B1) === 0]);
    // An older entry (lines rebuilt from the record): deleting one line keeps it gone.
    c({ action: 'transferMulti', moves: [{ from: pl.whLoc, to: 'ev_fest', bookId: B0, qty: 1 }, { from: pl.whLoc, to: 'ev_fest', bookId: B1, qty: 1 }], movePrefix: 'Mold' });
    const act = m.sheet('_activity').grid;
    const iParts = act[0].indexOf('parts');
    act[act.length - 1][iParts] = '';               // as written before b186
    m.clear();
    const list = m.call({ action: 'activity', season: SA }).result;
    const old = list.find(e => /2 books transferred/.test(e.text) && !e.undoneAt);
    ok(m.call({ action: 'undoActivityPart', season: SA, id: old.id, part: old.parts[0].id }), 'old part');
    const after = m.call({ action: 'activity', season: SA }).result.find(e => e.id === old.id);
    t.push(['older entry: the deleted line is marked Undone, not shown again', after.parts.length === 2 && after.parts[0].undone && !after.parts[1].undone]);
    page.__slow = false;
    await page.evaluate(() => { closeModal(); pull(); }); await page.waitForTimeout(800);

    // 3. Mixed payments.
    await page.evaluate(b => saleModal({ bookId: b, isPreorder: false, loc: CUR_LOC }), B0); await page.waitForTimeout(300);
    await page.selectOption('#ptype', 'Mixed');
    const legs = await page.$$eval('#mixLegs [data-mix="cur"]', s => s.map(x => x.value));
    await page.fill('#mixLegs [data-mix="amt"][data-i="0"]', '100'); await page.waitForTimeout(100);
    const fill = await page.evaluate(() => ({ second: document.querySelector('#mixLegs [data-mix="amt"][data-i="1"]').value,
      est: document.querySelector('#mixLegs [data-mixest="1"]').textContent, left: document.querySelector('#mixLeft').textContent,
      price: priceFor(bookById(document.querySelector('.mb-row, #modal') && STATE.books[0].id), 'PLN') }));
    console.log('   mixed:', legs.join('+'), '→ second', fill.second, '|', fill.est, '|', fill.left);
    t.push(['typing payment 1 fills payment 2 with what is left', Number(fill.second) > 0]);
    t.push(['a different currency is marked as an estimate', legs[0] !== legs[1] ? /estimated from today/.test(fill.est) : true]);
    t.push(['it adds up', /Adds up/.test(fill.left)]);
    await page.click('#mixAdd'); await page.waitForTimeout(100);
    await page.fill('#mixLegs [data-mix="amt"][data-i="1"]', '5'); await page.waitForTimeout(100);
    const third = await page.inputValue('#mixLegs [data-mix="amt"][data-i="2"]');
    t.push(['a third payment can be added, and it is the one that fills', Number(third) > 0]);
    await page.screenshot({ path: shot('2-mixed') });
    await page.fill('#cname', 'Three Ways');
    await page.click('#saveSale'); await page.waitForTimeout(1500);
    const sale = (state().sales || []).find(x => x.name === 'Three Ways');
    t.push(['saved with three payments', !!sale && sale.p1type && sale.p2type && (sale.pmore || []).length === 1]);
    await page.evaluate(id => saleModal({ bookId: STATE.sales.find(x => x.saleId === id).bookId, edit: STATE.sales.find(x => x.saleId === id) }), sale.saleId);
    await page.waitForTimeout(300);
    t.push(['editing it shows all three', (await page.$$('#mixLegs .leg-box')).length === 3]);
    await page.evaluate(() => closeModal());

    // 4. No stock: said before saving, and Save stays off.
    await page.evaluate(b => saleModal({ bookId: b, isPreorder: false, loc: CUR_LOC }), B3); await page.waitForTimeout(300);
    const ns = await page.evaluate(() => ({ msg: (document.querySelector('#noStock') || {}).textContent || '', off: document.querySelector('#saveSale').disabled }));
    t.push(['no copies: the dialog says so at once, and Save is off', /no copies/.test(ns.msg) && ns.off]);
    await page.screenshot({ path: shot('3-nostock') });
    await page.evaluate(() => closeModal());

    // 5. Multiple books: Selling from, and a warning at once for a title that is not there.
    await page.evaluate(() => bundleModal()); await page.waitForTimeout(300);
    const from = await page.$$eval('#mbFrom option', o => o.map(x => x.textContent.trim()));
    t.push(['"Selling from": Warehouse and SW1', from.join('|') === 'Warehouse|SW1 — Radha']);
    await page.selectOption('#mbFrom', 'hd_radha1'); await page.waitForTimeout(100);
    await page.click(`.mb-plus[data-book="${B1}"][data-kind="buy"]`); await page.waitForTimeout(100);
    const w = await page.evaluate(b => ({ warn: document.querySelector('#mbWarn').hidden ? '' : document.querySelector('#mbWarn').textContent,
      n: document.querySelector(`.mb-n[data-n="buy"][data-book="${b}"]`).textContent }), B1);
    t.push(['a title not at SW1 warns straight away and is not added', /No/.test(w.warn) && /Radha/.test(w.warn) && w.n === '0']);
    await page.screenshot({ path: shot('4-bundle') });
    await page.click(`.mb-plus[data-book="${B0}"][data-kind="buy"]`); await page.click(`.mb-plus[data-book="${B0}"][data-kind="buy"]`);
    await page.click('#saveBundle'); await page.waitForTimeout(1500);
    t.push(['the copies come off SW1', qty('hd_radha1', B0) === 2]);

    // 6. Add Stock: Coming From, then Destination; the add-it link.
    await page.evaluate(() => addStockModal()); await page.waitForTimeout(400);
    const labs = await page.$$eval('#modal .m-body > .field > label', l => l.map(x => x.textContent.trim()));
    t.push(['"Coming From" comes before "Destination for Books"', labs.indexOf('Coming From') === 0 && labs.indexOf('Destination for Books') === 1]);
    t.push(['"Can’t find your destination? Click here to add it."', /Can’t find your destination\?\s*Click here to add it\./.test(await page.textContent('#modal .sp-addnew'))]);
    await page.fill('#spSource', 'the printer');
    await page.selectOption('#spWhere', 'there'); await page.waitForTimeout(200);
    await page.fill(`#spBody input.d-delta[data-book="${B3}"]`, '7');
    await page.click('#spSave'); await page.waitForTimeout(1500);
    t.push(['the source goes into the record', (state().stockMoves || []).some(x => x.bookId === B3 && /^From the printer/.test(x.note || ''))]);

    // 7. Transfer: Return all to warehouse.
    await page.evaluate(() => goTo('event', 'ev_yoga')); await page.waitForTimeout(300);
    await page.evaluate(() => transferStockModal()); await page.waitForTimeout(400);
    await page.click('#xfReturn'); await page.waitForTimeout(700);
    const rt = await page.evaluate(() => ({ to: document.querySelector('#xfTo .pp-in').value,
      vals: [...document.querySelectorAll('#xfBody .xf-in')].map(i => i.value) }));
    console.log('   return all:', rt.to, rt.vals.join(','));
    t.push(['Return all: To is the warehouse, and every copy is filled in', /Warehouse|Poland/.test(rt.to) && rt.vals.join(',') === '3,2']);
    await page.screenshot({ path: shot('5-return') });
    await page.click('#xfGo'); await page.waitForTimeout(1500);
    t.push(['…and it transfers', qty('ev_yoga', B0) === 0 && qty('ev_yoga', B1) === 0]);

    // 8. Wording: the same words change everywhere, at once; the box opens with what it says now.
    await page.evaluate(() => closeModal());
    const words = await page.evaluate(() => {
      EDIT_WORDING = true;                       // pencils on, as when rewording
      const a = document.createElement('div'); a.className = 'hint'; a.id = 'wA'; a.textContent = 'Money kept in the box here';
      const b = document.createElement('div'); b.className = 'hint'; b.id = 'wB'; b.textContent = 'Money kept in the box here';
      document.querySelector('#adminPanel').appendChild(a); document.querySelector('main').prepend(b);
      applyLabels();
      const key = a.getAttribute('data-key');
      commit({ action: 'saveLabel', key: normLabelKey(key), text: 'Cash on hand' },
        st => { st.labels = st.labels || {}; st.labels[normLabelKey(key)] = 'Cash on hand'; }, null);
      return key;
    });
    await page.waitForTimeout(100);
    const both = await page.evaluate(() => [document.querySelector('#wA').textContent, document.querySelector('#wB').textContent]);
    t.push(['rewording one changes the same words elsewhere, at once', both.every(x => /^Cash on hand/.test(x))]);
    await page.evaluate(() => { goTo('region', CUR_REGION); addStockModal(); }); await page.waitForTimeout(300);
    await page.selectOption('#spWhere', 'there'); await page.waitForTimeout(200);
    const li = await page.evaluate(() => { applyLabels(); const el = document.querySelector('#modal .how-to li'); return el ? el.getAttribute('data-key') : ''; });
    t.push(['each instruction is one piece of wording', /To add stock to existing inventory/.test(li)]);
    await page.evaluate(k => editLabelModal(k), li); await page.waitForTimeout(200);
    t.push(['the box opens with the words as they read now', /^\*\*To add stock\*\* to existing inventory/.test(await page.inputValue('#lblText'))]);
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
