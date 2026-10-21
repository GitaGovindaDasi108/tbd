/* Optional, needs Playwright + Chromium: node test/browser-small258.js
   b258, Gita's small things: the language on its own line under the title, the
   seller kept (with an "Edited by" note) when someone else edits a sale, the ☰
   at the top on a phone, no "$ Received" for money already in dollars, a
   multiple-book sale listing each title once with its count, no numbers in the
   menu, and (practice) several titles at once in Add Stock and Subtract Stock
   under Advanced. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-small258-' + n + '.png');

m.init();
const ok = (r, what) => { if (!r.ok) throw new Error(what + ': ' + r.error); return r; };
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason;
const books = st.books.filter(b => !b.partnerId);
const [B0, B1] = books.map(b => b.id);
const pl = st.regions[0];
const c = (p, w) => ok(m.call(Object.assign({ season: SA }, p)), w || p.action);
c({ action: 'adjustStockBulk', location: pl.whLoc, items: [{ bookId: B0, delta: 20 }, { bookId: B1, delta: 10 }], override: true });
const state = () => m.call({ action: 'getState', season: SA }).state;
const qty = id => { const r = (state().inventory || []).find(i => i.location === pl.whLoc && i.bookId === id); return r ? Number(r.qty) : 0; };

const t = [];
// ---- The server: an edit by someone else keeps the seller, and notes the editor ----
c({ action: 'sellBundle', keepBundleId: 'Bsel1', location: pl.whLoc, by: 'Seller Sita',
  items: [{ bookId: B0 }, { bookId: B0 }, { bookId: B0 }, { bookId: B1 }],
  legs: [{ type: 'Cash', cur: 'PLN', amt: 200 }], override: true });
c({ action: 'editBundle', bundle: 'Bsel1', location: pl.whLoc, by: 'Admin Gita',
  items: [{ bookId: B0 }, { bookId: B0 }, { bookId: B0 }, { bookId: B1 }],
  legs: [{ type: 'Cash', cur: 'PLN', amt: 210 }], override: true });
let mem = state().sales.filter(x => x.bundle === 'Bsel1');
t.push(['an admin editing a multiple-book sale: it still credits the seller', mem.length === 4 && mem.every(x => x.soldBy === 'Seller Sita')]);
t.push(['…with a note of who edited it', mem.every(x => x.editedBy === 'Admin Gita')]);
c({ action: 'sell', location: pl.whLoc, bookId: B1, by: 'Seller Sita', legs: [{ type: 'Cash', cur: 'PLN', amt: 50 }], override: true });
const one = state().sales.find(x => !x.bundle && x.bookId === B1);
c({ action: 'editSale', saleId: one.saleId, type: 'SALE', location: pl.whLoc, bookId: B1, by: 'Admin Gita',
  legs: [{ type: 'Cash', cur: 'PLN', amt: 55 }] });
const one2 = state().sales.find(x => x.saleId === one.saleId);
t.push(['an admin editing a single sale: still the seller\'s, edited by the admin', one2.soldBy === 'Seller Sita' && one2.editedBy === 'Admin Gita']);
c({ action: 'sell', location: pl.whLoc, bookId: B1, legs: [{ type: 'Cash', cur: 'PLN', amt: 50 }], override: true });
c({ action: 'sellBundle', keepBundleId: 'Bold1', location: pl.whLoc, items: [{ bookId: B0 }, { bookId: B1 }],
  legs: [{ type: 'Cash', cur: 'PLN', amt: 100 }], override: true });
c({ action: 'editBundle', bundle: 'Bold1', location: pl.whLoc, by: 'Admin Gita', items: [{ bookId: B0 }, { bookId: B1 }],
  legs: [{ type: 'Cash', cur: 'PLN', amt: 90 }], override: true });
t.push(['a sale with no seller recorded does not become the editor\'s', state().sales.filter(x => x.bundle === 'Bold1').every(x => x.soldBy === '')]);
// A Zelle sale paid in dollars, and one paid in euros.
c({ action: 'sell', location: pl.whLoc, bookId: B1, legs: [{ type: 'Zelle', cur: 'USD', amt: 20 }], override: true });

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  async function open(query, width) {
    const page = await browser.newPage({ viewport: { width: width || 1100, height: 900 } });
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
          body: `window.TBS_CONFIG = { APPS_SCRIPT_URL: 'https://script.google.com/macros/s/TEST/exec', PRACTICE_URL: 'https://script.google.com/macros/s/TEST/exec', AUTO_REFRESH_SECONDS: 3600 };` });
        const f = path.join(ROOT, rel);
        if (fs.existsSync(f) && fs.statSync(f).isFile())
          return route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : undefined });
        return route.fulfill({ status: 404, body: '' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    await page.goto('http://app.test/index.html' + (query || '')); await page.waitForTimeout(2000);
    return page;
  }
  let page;
  try {
    page = await open('');
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(400);

    // 1. The language sits on its own line, under the title.
    const lang = await page.evaluate(() => {
      const tag = [...document.querySelectorAll('.lang-tag')].find(x => x.offsetParent); if (!tag) return null;
      const name = tag.parentElement.getBoundingClientRect(), r = tag.getBoundingClientRect();
      return { display: getComputedStyle(tag).display, below: r.top >= name.top + 8 };
    });
    t.push(['the language is on a line of its own, under the title', !!lang && lang.display === 'table' && lang.below]);

    // 4. "$ Received": Zelle in euros needs it; Zelle already in dollars does not.
    t.push(['Zelle paid in euros: "$ Received"', await page.evaluate(() => digitalSale({ p1type: 'Zelle', p1cur: 'EUR', p1amt: 20 }))]);
    t.push(['Zelle paid in dollars: no "$ Received"', await page.evaluate(() => !digitalSale({ p1type: 'Zelle', p1cur: 'USD', p1amt: 20 }))]);
    t.push(['…and the dollar sale\'s row in the log has no button', await page.evaluate(() => {
      const x = STATE.sales.find(s => s.p1type === 'Zelle' && s.p1cur === 'USD');
      return !!x && !/usd-btn/.test(logItemHTML(x, {}));
    })]);

    // 5. Each title once, with its count.
    const drawer = await page.evaluate(() => {
      const g = groupBundles(STATE.sales).find(x => x._bundle && x.bundle === 'Bsel1');
      const d = document.createElement('div'); d.innerHTML = logItemHTML(g, {}); return d.textContent;
    });
    const n0 = st.books.find(b => b.id === B0).name, n1 = st.books.find(b => b.id === B1).name;
    t.push(['a multiple-book sale lists "Title — 3", not the title three times', drawer.includes(n0 + ' — 3') && drawer.includes(n1 + ' — 1')]);
    t.push(['…and says who edited it', /Edited by\s*Admin Gita/.test(drawer) && /Recorded by\s*Seller Sita/.test(drawer)]);

    // 8. No numbers on the menu.
    t.push(['no numbers on any menu item', await page.evaluate(() => !!document.querySelector('#sideNav') && !document.querySelector('#sideNav .sn-count, #sideNav .req-badge'))]);
    // b275: Subtract Stock went live (Gita, 2026-10-21).
    t.push(['Subtract Stock is in the live menu too (b275)', await page.evaluate(() => !!document.querySelector('#sideNav [data-act="substock"]'))]);
    await page.close();

    // 3. The ☰ at the top left on a phone, and in a narrow window.
    for (const w of [390, 820]) {
      page = await open('', w);
      const fab = await page.evaluate(() => { const r = document.querySelector('#snFab').getBoundingClientRect(); return { top: r.top, left: r.left, w: r.width }; });
      t.push([`${w}px wide: the ☰ is at the top left, beside the top bar`, fab.w > 30 && fab.top < 160 && fab.left < 30]);
      const clear = await page.evaluate(() => { const f = document.querySelector('#snFab').getBoundingClientRect();
        return [...document.querySelectorAll('.util-bar > *')].filter(e => e.offsetParent).every(e => { const r = e.getBoundingClientRect();
          return r.left >= f.right || r.top >= f.bottom || r.bottom <= f.top; }); });
      t.push([`${w}px wide: …and covers none of the top bar's buttons`, clear]);
      await page.screenshot({ path: shot('fab-' + w) });
      await page.evaluate(() => scrollTo(0, 800)); await page.waitForTimeout(200);
      t.push([`${w}px wide: …and it stays at the top when the page scrolls`, await page.evaluate(() => {
        const r = document.querySelector('#snFab').getBoundingClientRect(); return r.top >= 0 && r.top <= 12; })]);
      await page.close();
    }

    // ---- Practice: several titles at once, and Subtract Stock ----
    page = await open('?practice');
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(400);
    const adv = await page.evaluate(() => [...document.querySelectorAll('#sideNav .sn-group[data-sec="advanced"] .sn-item .sn-t')].map(x => x.textContent));
    t.push(['practice: Subtract Stock heads Advanced', adv[0] === 'Subtract Stock']);

    t.push(['the list reader: title and number, any order, tabs or commas', await page.evaluate(([a, b]) => {
      const bk = Object.values(STATE.books);
      const r = parseStockList(`Title\tQty\n${bookById(a).name}\t4\n7, ${bookById(b).name}\n${bookById(a).name.toUpperCase()},1\nNo Such Book\t3`, bk);
      const f = Object.fromEntries(r.found.map(x => [x.book.id, x.qty]));
      return f[a] === 5 && f[b] === 7 && r.missing.length === 1 && /No Such Book/.test(r.missing[0]);
    }, [B0, B1])]);

    await page.evaluate(() => addStockModal()); await page.waitForTimeout(400);
    await page.selectOption('#spWhere', 'there'); await page.waitForTimeout(200);
    await page.click('#spBody [data-bulkopen]'); await page.waitForTimeout(150);
    await page.fill('#spPaste', `${n0}\t4\n${n1}\t2\nNo Such Book\t3`);
    await page.click('#spBody [data-bulkuse]'); await page.waitForTimeout(300);
    const filled = await page.evaluate(([a, b]) => [document.querySelector(`#spBody input.d-delta[data-book="${a}"]`)?.value,
      document.querySelector(`#spBody input.d-delta[data-book="${b}"]`)?.value, document.querySelector('#spBulkMsg').textContent], [B0, B1]);
    t.push(['Add Stock: a pasted list fills a line per title with its number', filled[0] === '4' && filled[1] === '2']);
    t.push(['…and names the line it did not recognise', /No Such Book/.test(filled[2])]);
    await page.screenshot({ path: shot('bulk') });
    const before0 = qty(B0), before1 = qty(B1);
    await page.click('#spSave'); await page.waitForTimeout(1500);
    t.push(['…and saving adds them to the shelf', qty(B0) === before0 + 4 && qty(B1) === before1 + 2]);

    await page.click('#snFab').catch(() => {});
    await page.evaluate(() => subtractStockModal()); await page.waitForTimeout(500);
    const ss = await page.evaluate(() => ({ place: document.querySelector('#ssPlace .pp-in').value,
      rows: [...document.querySelectorAll('#ssBody .bulk-row')].length, warn: !!document.querySelector('#modal .warn-pre') }));
    t.push(['Subtract Stock opens on the place it was opened from, with its titles in stock', ss.place.length > 0 && ss.rows === 2 && ss.warn]);
    await page.fill(`#ssBody input[data-book="${B0}"]`, '3'); await page.waitForTimeout(100);
    t.push(['…the updated count follows', (await page.textContent(`#ssBody [data-next="${B0}"]`)).trim() === String(qty(B0) - 3)]);
    await page.screenshot({ path: shot('subtract') });
    const b0 = qty(B0);
    await page.click('#ssSave'); await page.waitForTimeout(1500);
    t.push(['…and Subtract takes them off the shelf', qty(B0) === b0 - 3]);
    await page.close();

    page = await open('?practice', 390);
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(300);
    await page.evaluate(() => subtractStockModal()); await page.waitForTimeout(500);
    t.push(['phone: Subtract Stock fits the screen', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)]);
    await page.screenshot({ path: shot('subtract-phone') });
  } catch (e) { t.push(['ran without throwing: ' + e.message, false]); }
  t.push(['no errors in the page', errors.length === 0]);
  if (errors.length) console.log(errors);
  await browser.close();
  let bad = 0;
  t.forEach(([n, p]) => { console.log((p ? 'PASS ' : 'FAIL ') + n); if (!p) bad++; });
  console.log('screenshots: ' + path.join(os.tmpdir(), 'tbs-small258-*.png'));
  process.exit(bad ? 1 : 0);
})();
