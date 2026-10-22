/* Optional, needs Playwright + Chromium: node test/browser-round284.js
   b285 (Gita, 2026-10-22): payment types in groups (Cash, Digital Payments
   with its accounts indented, Card, Other, Mixed; a coordinator can bring one
   out and put it first); the Activity Log shows everything the person may see,
   wherever it is opened, every season included; no vertical lines in the menu;
   pencils on drop-down menus; selling cards (room under gifts/distributed on a
   phone, "N distributed" bold, the consignment bubble placed like the language
   one); no overflow on a phone or a computer. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){ return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
m.init();
const st = m.call({ action: 'getState' }).state;
const S1 = st.activeSeason, R0 = st.regions[0], BK = st.books.map(b => b.id);
m.call({ season: S1, action: 'setPayTypes', kind: 'region', id: R0.regionId, types: ['Cash', 'Card', 'Wise', 'Zelle', 'Rasika GPay', 'Other'] });
m.call({ season: S1, action: 'adjustStockBulk', location: R0.whLoc, items: BK.slice(0, 3).map(b => ({ bookId: b, delta: 5 })), override: true });
m.call({ season: S1, action: 'sell', location: R0.whLoc, bookId: BK[0], legs: [{ type: 'Cash', cur: R0.currencies[0], amt: 10 }], override: true });
m.call({ season: S1, action: 'donate', location: R0.whLoc, bookId: BK[0], qty: 1, legs: [] });
// A change made in another season: it belongs in Universal's log too.
m.call({ action: 'saveSeason', name: 'Second Season' });
const S2 = m.call({ action: 'getState' }).state.seasons.find(s => s.name === 'Second Season').seasonId;
m.call({ season: S2, action: 'createRegion', regionId: 'rg_far', whLoc: 'wh_far', name: 'Far Region', currencies: 'USD' });
m.call({ action: 'setSeason', seasonId: S1 });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
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
        body: fs.readFileSync(path.join(__dirname, 'config.test.js'), 'utf8').replace('CLASSIC_ADMIN: true', 'CLASSIC_ADMIN: false') });
      const f = path.join(ROOT, rel);
      if (fs.existsSync(f) && fs.statSync(f).isFile())
        return route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : undefined });
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto('http://app.test/index.html');
  await page.waitForTimeout(2500);
  const t = [];
  const overflow = () => page.evaluate(() => { const v = innerWidth; return document.documentElement.scrollWidth > v + 1 ||
    [...document.querySelectorAll('#modal *, #main *')].some(e => e.offsetParent && e.getBoundingClientRect().right > v + 1); });

  // ---- Payment types in groups ----
  await page.evaluate(r => goTo('region', r), R0.regionId); await page.waitForTimeout(400);
  const sale = () => page.evaluate(b => saleModal({ bookId: b, isPreorder: false, loc: CUR_LOC }), BK[1]);
  await sale(); await page.waitForTimeout(400);
  const shape = () => page.evaluate(() => [...$('#ptype').children].map(c => c.tagName === 'OPTGROUP' ? c.label + '[' + [...c.children].map(o => o.value).join(',') + ']' : c.value).join(' | '));
  t.push(['the sale form lists Cash, Digital Payments [its accounts], Card, Other, Gift, Mixed', /^Cash \| Digital Payments\[Wise,Zelle,Rasika GPay\] \| Card \| Other( \| Gift)? \| Mixed$/.test(await shape())]);
  t.push(['Mixed reads "Mixed (two or more forms of payment)"', await page.evaluate(() => [...$('#ptype').options].some(o => o.value === 'Mixed' && /two or more forms of payment/.test(o.textContent)))]);
  const inp = '.field:has(#ptype) .pt-search .pp-in';
  await page.click(inp); await page.waitForTimeout(200);
  const rows = await page.evaluate(() => [...document.querySelectorAll('.field:has(#ptype) .pt-search .pp-row')].map(r => (r.classList.contains('pp-head') ? 'H:' : r.classList.contains('pp-sub') ? '  ' : '') + r.textContent.trim()));
  t.push(['the search list shows the Digital Payments heading with its accounts indented beneath', rows[0] === 'Cash' && rows[1] === 'H:Digital Payments' && rows[2] === '  Wise' && rows.includes('Card')]);
  t.push(['…the heading is not a choice, and indented rows sit further in', await page.evaluate(() => { const h = document.querySelector('.pt-search .pp-head'), s = document.querySelector('.pt-search .pp-sub');
    return !h.dataset.v && parseFloat(getComputedStyle(s).paddingLeft) > parseFloat(getComputedStyle(document.querySelector('.pt-search .pp-row:not(.pp-head):not(.pp-sub)')).paddingLeft); })]);
  await page.fill(inp, 'zel'); await page.waitForTimeout(150);
  t.push(['typing "zel" finds Zelle, its heading kept above it', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.pt-search .pp-row:not(.pp-add)')].map(r => r.textContent.trim()))) === JSON.stringify(['Digital Payments', 'Zelle'])]);
  await page.click('.pt-search .pp-row[data-v="Zelle"]'); await page.waitForTimeout(150);
  t.push(['…and choosing it sets the payment type', await page.evaluate(() => $('#ptype').value === 'Zelle')]);
  await page.evaluate(() => closeModal());
  // A coordinator brings Rasika GPay out and puts it first.
  await page.evaluate(() => payTypesModal()); await page.waitForTimeout(300);
  const ed = () => page.evaluate(() => [...document.querySelectorAll('#ptList > *')].map(r => (r.classList.contains('pt-head') ? 'H' : r.classList.contains('pt-sub') ? '>' + (r.dataset.t || '') : r.dataset.t)).join(','));
  t.push(['Payments taken here shows the same groups, accounts indented under Digital Payments', (await ed()) === 'Cash,H,>Wise,>Zelle,>Rasika GPay,>PayPal,Card,Other,Gift']);
  await page.click('.pt-row[data-t="Rasika GPay"] .pt-ind'); await page.waitForTimeout(100);
  t.push(['⇤ brings Rasika GPay out, just after the group', (await ed()) === 'Cash,H,>Wise,>Zelle,>PayPal,Rasika GPay,Card,Other,Gift']);
  for (let i = 0; i < 3; i++) { await page.click('.pt-row[data-t="Rasika GPay"] [data-mv="up"]'); await page.waitForTimeout(60); }
  t.push(['▲ moves it past the whole group, to the top', (await ed()) === 'Rasika GPay,Cash,H,>Wise,>Zelle,>PayPal,Card,Other,Gift']);
  await page.click('.pt-row.pt-head [data-mv="down"]'); await page.waitForTimeout(60);
  t.push(['the group moves as one', (await ed()) === 'Rasika GPay,Cash,Card,H,>Wise,>Zelle,>PayPal,Other,Gift']);
  await page.click('.pt-row.pt-head [data-mv="up"]'); await page.waitForTimeout(60);
  await page.click('#ptSave'); await page.waitForTimeout(1200);
  await page.evaluate(() => pull()); await page.waitForTimeout(1200);
  await sale(); await page.waitForTimeout(400);
  t.push(['saved: the sale form now starts with Rasika GPay, then Cash, then Digital Payments', /^Rasika GPay \| Cash \| Digital Payments\[Wise,Zelle\] \| Card \| Other/.test(await shape())]);
  t.push(['…and it is kept on the server', JSON.stringify((m.call({ action: 'getState', season: S1 }).state.payTop || {})[R0.regionId]) === JSON.stringify(['Rasika GPay', 'Cash', 'Card', 'Other'])]);
  await page.fill(inp, 'Revolut'); await page.waitForTimeout(150);
  await page.click('.field:has(#ptype) .pt-search .pp-add'); await page.waitForTimeout(1000);
  t.push(['a type added from the sale form joins Digital Payments', await page.evaluate(() => [...$('#ptype').querySelector('optgroup').children].some(o => o.value === 'Revolut'))]);
  for (const w of [390, 1100]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(250);
    await page.click(inp); await page.waitForTimeout(150);
    t.push(['no overflow in the sale window, list open, at ' + w + 'px', !(await overflow())]); }
  await page.evaluate(() => closeModal());
  await page.setViewportSize({ width: 1100, height: 900 });

  // ---- Activity Log: everything Universal may see, wherever it is opened ----
  await page.evaluate(r => goTo('region', r), R0.regionId); await page.waitForTimeout(300);
  await page.evaluate(() => activityModal()); await page.waitForTimeout(1500);
  let log = await page.$eval('#alList', e => e.innerText);
  t.push(['opened in a region, the log still shows the other season\'s change, tagged with its season', /Far Region/.test(log) && /Second Season/.test(log)]);
  t.push(['…and this season\'s', /payment types/i.test(log)]);
  await page.evaluate(() => closeModal());
  t.push(['the whole log is kept on the device for next time', await page.evaluate(() => (activityCacheLoad('all') || []).length > 1)]);

  // ---- The menu: no vertical lines ----
  await page.evaluate(() => document.body.classList.add('sn-open')); await page.waitForTimeout(200);
  t.push(['no vertical line beside a menu section\'s items', await page.evaluate(() => [...document.querySelectorAll('.sn-items')].every(e => getComputedStyle(e).borderLeftStyle === 'none' || parseFloat(getComputedStyle(e).borderLeftWidth) === 0))]);

  // ---- Pencils on drop-down menus ----
  await page.evaluate(() => { EDIT_WORDING = true; payTypesModal(); applyLabels(); }); await page.waitForTimeout(300);
  t.push(['in Edit Wording a drop-down menu gets a ✏️ beside it', await page.evaluate(() => !!document.querySelector('#modal select.pt-cur + .sel-pencil'))]);
  await page.click('#modal select.pt-cur + .sel-pencil'); await page.waitForTimeout(200);
  t.push(['…which lists the menu\'s choices', await page.evaluate(() => !!document.querySelector('#lblPop') && document.querySelectorAll('#lblPop .lbl-pop-row').length > 2)]);
  await page.evaluate(() => [...document.querySelectorAll('#lblPop .lbl-pop-row')].find(b => /USD/.test(b.textContent)).click()); await page.waitForTimeout(300);
  t.push(['…and a choice opens the usual window', /Rewrite these words/.test(await page.evaluate(() => document.querySelector('#modal').innerText))]);
  await page.fill('#lblText', 'US dollars'); await page.click('#lblSave'); await page.waitForTimeout(1200);
  await page.evaluate(() => { closeModal(); EDIT_WORDING = false; payTypesModal(); applyLabels(); }); await page.waitForTimeout(400);
  t.push(['the menu then reads the new wording, and its value is unchanged', await page.evaluate(() => [...document.querySelector('#modal select.pt-cur').options].some(o => o.value === 'USD' && o.textContent === 'US dollars'))]);
  t.push(['…with no pencil once Edit Wording is off', await page.evaluate(() => !document.querySelector('.sel-pencil'))]);
  await page.evaluate(() => closeModal());

  // ---- Selling cards ----
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(() => goTo('season')); await page.waitForTimeout(600);
  t.push(['on a phone, a card with no Sell button has 8px under its gifts/distributed line (b287: half of b286)', await page.evaluate(() => { const c = [...document.querySelectorAll('.stat-grid > .qcard')].find(x => !x.querySelector('.q-full:not(:empty)') && x.querySelector('.q-br'));
    return !!c && getComputedStyle(c).paddingBottom === '8px'; })]);
  t.push(['"N distributed" is bold as a whole', await page.evaluate(() => { const d = document.querySelector('.q-dist'); if(!d) return true;
    return getComputedStyle(d.querySelector('b')).fontWeight === getComputedStyle(d.querySelector('.q-word')).fontWeight && Number(getComputedStyle(d.querySelector('.q-word')).fontWeight) >= 700; })]);
  t.push(['the consignment bubble sits on its own line under the title, the size of the language bubble', await page.evaluate(() => {
    const host = document.createElement('div'); host.className = 'bname'; host.innerHTML = 'X <span class="lang-tag">English</span><span class="con-tag">consignment</span>'; document.body.appendChild(host);
    const l = getComputedStyle(host.querySelector('.lang-tag')), c = getComputedStyle(host.querySelector('.con-tag'));
    const ok = c.display === 'table' && c.marginLeft === l.marginLeft && c.lineHeight === l.lineHeight && c.fontSize === l.fontSize; host.remove(); return ok; })]);
  t.push(['b287: with nothing in stock (a closed place), the consignment bubble greys out like the language bubble', await page.evaluate(() => {
    const host = document.createElement('div'); host.className = 'book out'; host.innerHTML = '<div class="bname">X <span class="lang-tag">English</span><span class="con-tag">consignment</span></div>'; document.body.appendChild(host);
    const l = getComputedStyle(host.querySelector('.lang-tag')), c = getComputedStyle(host.querySelector('.con-tag'));
    const ok = /grayscale/.test(c.filter) && c.filter === l.filter && c.opacity === l.opacity; host.remove(); return ok; })]);
  t.push(['no overflow on the season page on a phone', !(await overflow())]);
  t.push(['no errors in the page' + (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''), !errors.length]);
  await browser.close();
  let bad = 0;
  t.forEach(([n, ok]) => { if (!ok) bad++; console.log((ok ? '  ok   ' : '  FAIL ') + n); });
  console.log(bad ? `\n${bad} failed` : `\nall ${t.length} passed`);
  process.exit(bad ? 1 : 0);
})();
