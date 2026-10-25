/* Optional, needs Playwright + Chromium: node test/browser-b307.js
   b307 (Live app changes): Earthly HQ's Net Sales by Season with its
   currencies folded away ("Show Currencies") and Gross Collections, the
   Warehouse Overview leaving out titles with none, the price calculator (the
   top row overwrites, a new currency is worked out, an empty box always holds
   the calculation), dates typed with one figure, one card order for the whole
   page, the Transfer log live, and in practice Earthly HQ in Edit Location
   and Change Prices. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){ return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
m.init();
const st = m.call({ action: 'getState' }).state, SA = st.activeSeason;
const c = (p, season) => { const r = m.call(Object.assign({ season: season || SA }, p)); if (!r.ok) throw new Error(p.action + ': ' + r.error); return r; };
const R0 = st.regions[0], R0name = R0.name;
const B = st.books.find(b => !b.partnerId).id;
const B2 = st.books.filter(b => !b.partnerId)[1].id, NONE = st.books.filter(b => !b.partnerId).slice(-1)[0].id;
c({ action: 'adjustStockBulk', location: R0.whLoc, items: [{ bookId: B, delta: 10 }, { bookId: B2, delta: 10 }], override: true });
c({ action: 'sell', location: R0.whLoc, bookId: B, legs: [{ type: 'Cash', cur: 'EUR', amt: 20 }] });
c({ action: 'sell', location: R0.whLoc, bookId: B2, legs: [{ type: 'Gift', cur: 'EUR', amt: 0 }] });
c({ action: 'createRegion', regionId: 'rg_two', whLoc: 'wh_two', name: 'Second Region', currencies: 'EUR', prices: { [B]: { EUR: 20 } } });
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
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  try {
    await page.goto('http://app.test/index.html'); await page.waitForTimeout(2500);
    await page.evaluate(() => document.querySelector('[data-act="gohq"]').click()); await page.waitForTimeout(1500);

    /* 1. Net Sales by Season: currencies folded away, then shown. */
    const head = () => page.evaluate(() => { const p = document.querySelector('[data-fold="sumCollBy"]'), th = [...p.querySelectorAll('thead th')];
      return { th: th.map(x => x.innerText.trim()), left: getComputedStyle(th[0]).textAlign, right: getComputedStyle(th[th.length - 1]).textAlign }; });
    let h = await head();
    t.push(['Net Sales by Season: "Show Currencies" closed, then Gross Collections first (' + h.th.join(' | ') + ')', /^SHOW CURRENCIES/i.test(h.th[1]) && /^GROSS COLLECTIONS$/i.test(h.th[2])]);
    t.push(['…"Seasons" on the left, the other titles as they were (' + h.left + ', ' + h.right + ')', h.left === 'left' && h.right === 'right']);
    let rep = await page.evaluate(() => { let out = ''; withRollup(() => { out = buildReport('netseason'); }); return out; });
    t.push(['…its report: Gross Collections, no currencies while they are folded away', /Gross Collections - /.test(rep) && !/Total Collections/.test(rep) && !/\bCollections - (?!.*\$)/.test(rep.replace(/Gross Collections - .*/g, ''))]);
    await page.click('[data-act="netcurs"]'); await page.waitForTimeout(200);
    h = await head();
    t.push(['…"Show Currencies" opens every currency beside it (' + h.th.join(' | ') + ')', /^HIDE CURRENCIES/i.test(h.th[1]) && h.th.length > 7 && /EUR/.test(h.th.join(' '))]);
    rep = await page.evaluate(() => { let out = ''; withRollup(() => { out = buildReport('netseason'); }); return out; });
    t.push(['…and the report then lists them', /\nCollections - /.test(rep) || /Collections - [^$\n]*€/.test(rep)]);
    for (const w of [390, 1150]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(300);
      t.push(['Earthly HQ: nothing wider than the page at ' + w + 'px, currencies open', await wide() <= 0]); }
    await page.click('[data-act="netcurs"]'); await page.waitForTimeout(200);
    await page.setViewportSize({ width: 1150, height: 900 });

    /* 2. Warehouse Overview: a title with none here and none on the way is left out. */
    await page.evaluate(s => switchSeason(s), SA); await page.waitForTimeout(1500);
    const wo = await page.evaluate(([b, n]) => ({ has: !!document.querySelector(`#whOverview [data-id="${b}"]`), none: !!document.querySelector(`#whOverview [data-id="${n}"]`) }), [B, NONE]);
    t.push(['Warehouse Overview: titles in stock show, a title with none does not', wo.has && !wo.none]);
    await page.evaluate(() => { const g = document.querySelector('#whOverview'); g.closest('.panel').querySelector('.arr-tg').click(); }); await page.waitForTimeout(300);
    t.push(['…while arranging that section every title shows, to be put in order', await page.evaluate(n => !!document.querySelector(`#whOverview [data-id="${n}"]`), NONE)]);
    await page.evaluate(() => { ARRANGE = ''; renderAll(); }); await page.waitForTimeout(200);

    /* 3. One card order for the whole page: the Sales by Region drop-down follows it too. */
    const order = await page.evaluate(async ([b1, b2]) => { await MY_ORDER.set([b2, b1]); renderAll();
      const ids = sel => [...document.querySelectorAll(sel)].map(e => e.dataset.id).filter(x => x === b1 || x === b2);
      const nm = id => STATE.books.find(b => b.id === id).name.replace(/\s*\([^()]*\)\s*$/, '');
      const sales = [...document.querySelectorAll('#salesByRegion .mc-name')].map(e => e.textContent).map(x => x.includes(nm(b1)) ? b1 : x.includes(nm(b2)) ? b2 : '').filter(Boolean);
      return { sales, titles: ids('#seasonTitleList [data-id], #titleList [data-id]'), wh: ids('#whOverview [data-id]') }; }, [B, B2]);
    t.push(['card order: Sales by Region follows the page\'s order (' + JSON.stringify(order) + ')', order.sales.join() === [B2, B].join() && order.wh.join() === [B2, B].join()]);
    await page.evaluate(() => MY_ORDER.set([])); await page.waitForTimeout(200);

    /* 4. The price calculator. */
    await page.evaluate(() => { goTo('region', 'rg_two'); }); await page.waitForTimeout(500);
    await page.evaluate(() => regionModal(currentRegion())); await page.waitForTimeout(300);
    const cal = await page.evaluate(([b, b2]) => {
      const fire = (el, ev) => el.dispatchEvent(new Event(ev, { bubbles: true }));
      const box = (id, c) => document.querySelector(`#modal .rp[data-book="${id}"][data-cur="${c}"]`);
      const out = { saved: box(b, 'EUR').value, wasU0: box(b, 'USD') ? box(b, 'USD').value : '' };
      const cur = document.querySelector('#rgCur'); cur.value = cur.value + ', PLN'; fire(cur, 'change');
      out.added = box(b, 'PLN').value; out.addedAuto = box(b, 'PLN').classList.contains('rp-auto');
      const u2 = box(b2, 'PLN'), e2 = box(b2, 'EUR'); e2.value = ''; fire(e2, 'input');
      u2.focus(); out.emptyStays = u2.value; u2.blur();   // no local price: worked out from another price it has (b310)
      e2.value = '10'; fire(e2, 'input');
      u2.value = ''; fire(u2, 'input'); u2.blur(); u2.focus(); out.onFocus = u2.value;
      const cat = document.querySelector(`#modal .rp[data-book="${b}"]`).closest('.bk-row');
      let top = cat.previousElementSibling; while (top && !top.classList.contains('rp-fill')) top = top.previousElementSibling;
      const tE = top.querySelector('.rp-all[data-cur="EUR"]'), tU = top.querySelector('.rp-all[data-cur="USD"]');
      tE.value = '25'; fire(tE, 'input');
      out.topU = tU.value; out.over = box(b, 'EUR').value; out.overU = box(b, 'USD').value; out.wasU = out.wasU0;
      tU.value = '30'; fire(tU, 'input'); out.topUhand = box(b, 'USD').value;
      return out; }, [B, B2]);
    t.push(['calculator: a saved price is kept on opening (' + cal.saved + ')', cal.saved === '20']);
    t.push(['…a currency added afterwards is worked out at once (' + cal.added + ')', Number(cal.added) > 0 && cal.addedAuto]);
    t.push(['…an empty box holds the calculation from the local price when you go to fill it (' + cal.onFocus + ')', Number(cal.onFocus) > 0]);
    t.push(['b310: with no local price, it is worked out from another price the title has (' + cal.emptyStays + ')', Number(cal.emptyStays) > 0]);
    t.push(['…the top row overwrites the prices below it, the saved one too (' + cal.over + ', ' + cal.overU + ')', cal.over === '25' && Number(cal.overU) > 0 && Number(cal.overU) !== Number(cal.wasU)]);
    t.push(['…its other currency follows the top row\'s local price (' + cal.topU + ')', Number(cal.topU) > 0]);
    t.push(['…and typed there, it overwrites that currency below (' + cal.topUhand + ')', cal.topUhand === '30']);
    await page.click('#rgSave'); await page.waitForTimeout(1500);
    const pr = (state().prices || {}).rg_two || {};
    t.push(['…and saves (' + JSON.stringify(pr[B]) + ')', pr[B] && Number(pr[B].EUR) === 25 && Number(pr[B].USD) === 30]);

    /* 5. Dates: one figure, then a slash. */
    const dt = await page.evaluate(() => { const i = document.createElement('input'); i.type = 'date'; i.id = 'dtTest'; document.body.appendChild(i); return true; });
    await page.waitForTimeout(200);
    const typed = async s => { await page.fill('#dtTest', '').catch(() => {}); await page.evaluate(() => { const x = document.querySelector('#dtTest')._dt; x.value = ''; x.focus(); });
      await page.keyboard.type(s); return page.evaluate(() => ({ shown: document.querySelector('#dtTest')._dt.value, real: document.querySelector('#dtTest').value })); };
    let d = await typed('3/5/2026');
    t.push(['date: 3/5/2026 types as 03/05/2026 (' + d.shown + ', ' + d.real + ')', d.shown === '03/05/2026' && d.real === '2026-03-05']);
    d = await typed('12');
    t.push(['…12 is not padded, and the slash follows (' + d.shown + ')', d.shown === '12/']);
    d = await typed('1');
    t.push(['…a single figure waits for the slash (' + d.shown + ')', d.shown === '1']);
    d = await typed('10/7-26'); await page.evaluate(() => document.querySelector('#dtTest')._dt.blur()); await page.waitForTimeout(100);
    d = await page.evaluate(() => ({ shown: document.querySelector('#dtTest')._dt.value, real: document.querySelector('#dtTest').value }));
    t.push(['…10/7-26 becomes 10/07/2026 when you leave the box (' + d.shown + ', ' + d.real + ')', d.shown === '10/07/2026' && d.real === '2026-10-07']);
    await page.evaluate(() => document.querySelector('#dtTest').closest('.dt-wrap').remove());

    /* 6. A list that drops down covers the form instead of pushing it down. */
    await page.evaluate(() => transferStockModal()); await page.waitForTimeout(400);
    const y0 = await page.evaluate(() => { const l = document.querySelector('#xfTo').parentElement.nextElementSibling || document.querySelector('#modal .m-foot'); return l.getBoundingClientRect().top; });
    await page.click('#xfTo .pp-in'); await page.waitForTimeout(200);
    const dd = await page.evaluate(() => { const l = document.querySelector('#xfTo .pp-list'), n = document.querySelector('#xfTo').parentElement.nextElementSibling || document.querySelector('#modal .m-foot');
      return { open: !l.hidden, abs: getComputedStyle(l).position, y: n.getBoundingClientRect().top }; });
    t.push(['drop-down lists open over the form; it stays still (' + dd.abs + ', ' + y0 + ' → ' + dd.y + ')', dd.open && dd.abs === 'absolute' && Math.abs(dd.y - y0) < 1]);
    await page.evaluate(() => closeModal());

    /* 7. The Transfer log is live. */
    await page.evaluate(r => goTo('region', r), R0.regionId); await page.waitForTimeout(500);
    t.push(['Transfer log: its button shows on the live app', await page.evaluate(() => { const b = document.querySelector('#invHeading .tl-btn'); return !!b && !b.hidden; })]);

    /* 8. Practice: Earthly HQ in Edit Location and Change Prices. */
    await page.goto('http://app.test/index.html?practice'); await page.waitForTimeout(2500);
    await page.evaluate(() => document.querySelector('[data-act="gohq"]').click()); await page.waitForTimeout(1500);
    t.push(['practice, Earthly HQ: Edit Location in place of Edit Earthly HQ', await page.evaluate(() => !!document.querySelector('[data-act="placeedit"]') && ![...document.querySelectorAll('button, a')].some(b => b.textContent.trim() === 'Edit Earthly HQ'))]);
    await page.evaluate(() => placeEditModal()); await page.waitForTimeout(500);
    const pe = await page.evaluate(() => ({ on: (document.querySelector('#ppTabs .on') || {}).dataset, name: (document.querySelector('#ppName') || {}).value, dates: !!document.querySelector('#modal .pm-dates, #modal [id^="pmStart"], #modal input[type="date"]') }));
    t.push(['Edit Location at Earthly HQ opens on Earthly HQ, its name, no dates (' + JSON.stringify(pe) + ')', pe.on && pe.on.ppK === 'hq' && !!pe.name && !pe.dates]);
    await page.fill('#ppName', 'Earthly HQ Two'); await page.click('#ppSave'); await page.waitForTimeout(1500);
    t.push(['…and renames it', (state('HQ').regions || []).some(r => r.regionId === 'rg_hq' && r.name === 'Earthly HQ Two')]);
    await page.evaluate(() => pricesModal()); await page.waitForTimeout(500);
    t.push(['Change Prices at Earthly HQ opens on Earthly HQ, with its currencies and prices', await page.evaluate(() => (document.querySelector('#ppTabs .on') || {}).dataset.ppK === 'hq' && !!document.querySelector('#modal #rgCur') && !!document.querySelector('#modal .rp[data-book]'))]);
    const hc = await page.$eval('#rgCur', i => i.value.split(',')[0].trim());
    await page.fill(`#modal .rp[data-book="${B}"][data-cur="${hc}"]`, '44'); await page.click('#ppSave'); await page.waitForTimeout(1500);
    t.push(['…and saves Earthly HQ\'s price', Number((((state('HQ').prices || {}).rg_hq || {})[B] || {})[hc]) === 44]);
    // From a season, the Earthly HQ tab still opens Earthly HQ (and a season's region saves in its own season).
    await page.evaluate(s => switchSeason(s), SA); await page.waitForTimeout(1500);
    await page.evaluate(() => pricesModal()); await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('#ppTabs [data-pp-k="hq"]').click()); await page.waitForTimeout(1200);
    t.push(['…from a season too', await page.evaluate(b => !!document.querySelector('#modal #rgCur') && document.querySelector(`#modal .rp[data-book="${b}"]`) && [...document.querySelectorAll(`#modal .rp[data-book="${b}"]`)].some(i => i.value === '44'), B)]);
    for (const w of [390, 1150]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(200);
      t.push(['Change Prices (Earthly HQ): nothing sticks out at ' + w + 'px', await page.evaluate(() => { const W = document.documentElement.clientWidth;
        return [...document.querySelectorAll('#modal *')].filter(e => e.offsetParent && e.getBoundingClientRect().right > W + 1).length === 0; })]); }
    await page.evaluate(() => closeModal());
  } catch (e) { t.push(['STOPPED: ' + e.message, false]); }

  t.push(['no page errors' + (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''), !errors.length]);
  let bad = 0;
  t.forEach(([n, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; });
  console.log(bad ? bad + ' failed' : 'all ' + t.length + ' passed');
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('STOPPED ' + e.stack); process.exit(1); });
