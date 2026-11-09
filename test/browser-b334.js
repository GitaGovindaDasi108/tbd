/* Optional, needs Playwright + Chromium: node test/browser-b334.js
   b334: Transfer Existing Stock takes a pasted list or a CSV (practice), as
   mini.js): all four kinds of transfer, sub-warehouse columns and bubbles,
   Add Stock does; Add Stock keeps both. Real Code.gs via mini.js. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-b334-' + n + '.png');

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
    // b304: a batch in transit is one line with a drop-down; these tests work inside it, so it opens.
    await page.addInitScript(() => new MutationObserver(() => document.querySelectorAll('details.sh-line:not([open])').forEach(d => { d.open = true; })).observe(document, { subtree: true, childList: true }));
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => { page.__dialogs = (page.__dialogs || []).concat(d.message()); d.accept(); });
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.includes('script.google.com')) {
        let p = {}; try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(m.call(p)) });
      }
      if (url.startsWith('http://app.test/')) {
        const rel0 = new URL(url).pathname.replace(/^\/+/, '') || 'index.html';
        // The practice space talks to the same fake server here.
        if (rel0 === 'config.js') return route.fulfill({ status: 200, contentType: 'text/javascript',
          body: fs.readFileSync(path.join(__dirname, 'config.test.js'), 'utf8').replace(/\}\s*;?\s*$/, ', PRACTICE_URL: "https://script.google.com/macros/s/TEST/exec"};') });
        const f = path.join(ROOT, rel0);
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
  // b304: the form opens with From and To blank; ⬆ Transfer Out puts this warehouse in From.
  const openXfer = async page => { await page.click('#adminActions button:has-text("Transfer Existing Stock")'); await page.waitForTimeout(300);
    page.__blank = !(await page.inputValue('#xfFrom .pp-in')) && !(await page.inputValue('#xfTo .pp-in'));
    await page.click('#xfOut'); await page.waitForTimeout(300); };
  const head = page => page.evaluate(() => [...document.querySelectorAll('#xfBody .xf-head span')].map(s => s.textContent.trim()));
  const setMove = (page, src, book, n) => page.fill(`#xfBody .xf-in[data-src="${src}"][data-book="${book}"]`, String(n));
  const go = async page => { page.__dialogs = []; await page.click('#xfGo'); await page.waitForTimeout(1500); return page.__dialogs || []; };
  const over = page => page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('#modal, #modal *').forEach(el => {
      if (el.offsetParent === null && el.id !== 'modal') return;
      if (el.closest('.xf-scroll')) return;                       // the table may scroll left-right on purpose
      // The table's scroll area bleeds 2px each side on purpose (focus rings not clipped); it is inside the window's padding.
      if (el.id === 'xfBody' && el.scrollWidth - el.clientWidth <= 2 && el.querySelector(':scope > .xf-scroll')) return;
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'auto') bad.push((el.id || el.className || el.tagName) + ' ' + el.scrollWidth + '>' + el.clientWidth);
    });
    const m = document.querySelector('#modal').getBoundingClientRect();
    if (m.right > innerWidth + 1) bad.push('modal off screen');
    return bad;
  });
  const openBox = async page => { await page.click('[data-xfbulkopen]'); await page.waitForTimeout(200); };

  let page;
  try {
    // 1. Practice: warehouse spread over sub-warehouses -> event, pasted list.
    page = await open('?practice');
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(400);
    await openXfer(page);
    await pick(page, 'xfTo', 'Temple', 'Temple');
    t.push(['practice: "Add several titles at once" is in Transfer', !!(await page.$('#xfBody [data-xfbulkopen]'))]);
    t.push(['…closed to start', await page.evaluate(() => document.querySelector('#xfBody .sp-bulkbox').hidden)]);
    await openBox(page);
    t.push(['…opens to a paste box and an Upload CSV button', !!(await page.$('#xfPaste')) && !!(await page.$('#xfCsv'))]);
    await page.fill('#xfPaste', 'Sri Radha (English) 25\nWestern (English), 3\nEastern (English)\t4\nNo Such Book 2');
    await page.click('[data-xfbulkuse]'); await page.waitForTimeout(300);
    const mv = (src, b) => page.inputValue(`#xfBody .xf-in[data-src="${src}"][data-book="${b}"]`);
    t.push(['25 Sri Radha: 10 off the warehouse shelf, 15 off SW1', await mv(pl.whLoc, B0) === '10' && await mv('hd_radha1', B0) === '15' && await mv('hd_gopal1', B0) === '']);
    t.push(['3 Western off SW2 (the only shelf with any)', await mv('hd_gopal1', B1) === '3']);
    const msg = await page.textContent('#xfBulkMsg');
    t.push(['says 2 titles were put in the table', /2 titles put in the table/.test(msg)]);
    t.push(['says Eastern is not at this place', /None of these at[\s\S]*Eastern/.test(msg)]);
    t.push(['says the unknown line was not recognised', /Not recognised[\s\S]*No Such Book/.test(msg)]);
    t.push(['Left shows 40 − 25 = 15', (await page.textContent(`#xfBody [data-left="${B0}"]`)).trim() === '15']);
    for (const w of [390, 1150]) {
      await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(300);
      const o = await over(page);
      t.push([`nothing overflows at ${w}px` + (o.length ? ' (' + o.join(', ') + ')' : ''), o.length === 0]);
      await (await page.$('#modal')).screenshot({ path: shot('paste-' + w) });
    }
    await page.setViewportSize({ width: 1100, height: 950 });
    await go(page);
    t.push(['transfer done: WH 0, SW1 5, SW2 10 + 2 Western left', qty(pl.whLoc, B0) === 0 && qty('hd_radha1', B0) === 5 && qty('hd_gopal1', B1) === 2]);
    t.push(['Temple received 25 Sri Radha and 3 Western', qty('ev_tmp', B0) === 25 && qty('ev_tmp', B1) === 3]);

    // 2. Practice: one shelf, a CSV file, and more asked than there is.
    await page.evaluate(() => goTo('region', 'rg_it')); await page.waitForTimeout(400);
    await openXfer(page);
    await pick(page, 'xfTo', 'Yoga', 'Yoga Studio');
    await openBox(page);
    const csv = path.join(os.tmpdir(), 'tbs-b334.csv');
    fs.writeFileSync(csv, 'Title,Quantity\r\n"Sri Radha (English)",4\r\n');
    await page.setInputFiles('#xfCsv', csv); await page.waitForTimeout(500);
    t.push(['CSV: 4 Sri Radha in the Move column', await mv('wh_it', B0) === '4']);
    t.push(['…the heading line is skipped, 1 title put in', /1 title put in the table/.test(await page.textContent('#xfBulkMsg'))]);
    fs.writeFileSync(csv, 'Sri Radha (English),9\n');
    await page.setInputFiles('#xfCsv', csv); await page.waitForTimeout(500);
    t.push(['asking for 9 of 6: says so', /More than there is[\s\S]*9 asked, 6 there/.test(await page.textContent('#xfBulkMsg'))]);
    t.push(['…and Transfer stays off', await page.isDisabled('#xfGo')]);
    await page.click('#xfClear'); await page.waitForTimeout(200);
    await page.fill('#xfPaste', 'Sri Radha (English) 2'); await page.click('[data-xfbulkuse]'); await page.waitForTimeout(300);
    await go(page);
    t.push(['transfer done: Yoga Studio 2, Italy 4', qty('ev_yoga', B0) === 2 && qty('wh_it', B0) === 4]);
    await page.close();

    // 3. Live: Transfer has no box yet; Add Stock keeps paste + CSV.
    page = await open('');
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(400);
    await openXfer(page);
    await pick(page, 'xfTo', 'Festival', 'Festival');
    t.push(['live: Transfer has no bulk box (practice first)', !(await page.$('#xfBody [data-xfbulkopen]'))]);
    await page.click('#modal .m-foot button:has-text("Cancel")'); await page.waitForTimeout(300);
    await page.click('#adminActions button:has-text("Add New Stock")'); await page.waitForTimeout(300);
    await page.click('#spPlace .pp-in'); await page.fill('#spPlace .pp-in', 'Poland'); await page.click('#spPlace .pp-row >> nth=0'); await page.waitForTimeout(500);
    await page.selectOption('#spWhere', 'there'); await page.waitForTimeout(400);
    await page.click('[data-bulkopen]'); await page.waitForTimeout(200);
    t.push(['live Add Stock: paste box and Upload CSV both there', !!(await page.$('#spPaste')) && !!(await page.$('#spCsv'))]);
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
