/* Optional, needs Playwright + Chromium: node test/browser-stalelang.js
   b240: a new language added while another season's copy of the catalogue is
   older than the screen's. Sri Radha (Hindi) must still be offered in that
   season's Add Stock, and typing it again must choose it, not refuse it. Every Apps Script request is answered
   by the fake server (mini.js) running the real Code.gs; nothing leaves the
   machine. Screenshots go to the system temp folder. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');

// ---- The tour: two seasons, regions with events, one closed region. ----
m.init();
const ok = (r, what) => { if (!r.ok) throw new Error(what + ': ' + r.error); return r; };
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason;
const books = st.books.filter(b => !b.partnerId);
const pl = st.regions[0];
ok(m.call({ action: 'createEvent', eventId: 'ev_fest', name: 'Festival', regionId: pl.regionId, season: SA }), 'event');
ok(m.call({ action: 'createRegion', regionId: 'rg_it', whLoc: 'wh_it', name: 'Italy', currencies: 'EUR,USD',
  books: books.slice(0, 2).map(b => b.id).join(','), season: SA }), 'italy');
ok(m.call({ action: 'createEvent', eventId: 'ev_yoga', name: 'Yoga Studio', regionId: 'rg_it', season: SA }), 'yoga');
ok(m.call({ action: 'createRegion', regionId: 'rg_es', whLoc: 'wh_es', name: 'Spain', currencies: 'EUR,USD', season: SA }), 'spain');
ok(m.call({ action: 'closeLocation', kind: 'region', id: 'rg_es', season: SA }), 'close spain');
ok(m.call({ action: 'saveSeason', name: 'Year-Round Sales' }), 'season 2');
st = m.call({ action: 'getState' }).state;
const SB = st.seasons.find(s => s.name === 'Year-Round Sales').seasonId;
ok(m.call({ action: 'createRegion', regionId: 'rg_kr', whLoc: 'wh_kr', name: 'Krakow', currencies: 'PLN,USD', season: SB }), 'krakow');
m.call({ action: 'setSeason', seasonId: SA });
const coordKey = ok(m.call({ action: 'setKey', kind: 'region', id: 'rg_it' }), 'key').result;
const qty = (loc, bookId) => { const r = (m.call({ action: 'getState', season: SA }).state.inventory || [])
  .concat(m.call({ action: 'getState', season: SB }).state.inventory || [])
  .find(i => i.location === loc && i.bookId === bookId); return r ? Number(r.qty) : 0; };

(async () => {
  const browser = await chromium.launch();
  const t = [];
  const errors = [];
  async function open(query, width) {
    const page = await browser.newPage({ viewport: { width: width || 1100, height: 900 } });
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => { page.__dialogs = (page.__dialogs || []).concat(d.message()); d.accept(); });
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.includes('script.google.com')) {
        let p = {}; try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(m.call(p)) });
      }
      if (url.startsWith('http://app.test/')) {
        const f = (rel => rel === 'config.js' ? path.join(__dirname, 'config.test.js') : path.join(ROOT, rel))(new URL(url).pathname.replace(/^\/+/, '') || 'index.html');
        if (fs.existsSync(f) && fs.statSync(f).isFile())
          return route.fulfill({ status: 200, body: fs.readFileSync(f),
            contentType: f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : undefined });
        return route.fulfill({ status: 404, body: '' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    await page.goto('http://app.test/index.html' + (query || ''));
    await page.waitForTimeout(2000);
    // A link asks who is using it, the first time.
    if (await page.$('#whoName')) { await page.fill('#whoName', 'Tester'); await page.click('#whoSave'); await page.waitForTimeout(400); }
    return page;
  }
  const listText = page => page.evaluate(() => [...document.querySelectorAll('#spPlace .pp-list > div')]
    .map(d => (d.classList.contains('pp-season') ? 'S:' : d.classList.contains('pp-region') ? 'R:' : d.classList.contains('pp-event') ? 'E:' : '?:')
      + d.childNodes[0].textContent.trim()));
  const pickPlace = async (page, search, text) => {
    await page.click('#spPlace .pp-in'); await page.fill('#spPlace .pp-in', search);
    await page.click(`#spPlace .pp-row:has-text("${text}")`); await page.waitForTimeout(600);
  };

  /* b227: a title is chosen, then its language, on the empty line at the bottom. */
  const pickBook = async (page, id) => {
    const key = await page.evaluate(id => stockTitleKey(bookById(id)), id);
    await page.locator('#spBody .ln-title').last().selectOption(key); await page.waitForTimeout(150);
    await page.locator('#spBody .ln-lang').last().selectOption(id); await page.waitForTimeout(150);
  };

  let page, hang = false;
  page = await open('');
  // Freeze Year-Round Sales' answer as it was before the new language existed.
  const oldSB = JSON.parse(JSON.stringify(m.call({ action: 'getState', season: SB })));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.includes('script.google.com')) {
      let p = {}; try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (hang && p.action === 'getState') return;           // never answered
      const r = (p.action === 'getState' && p.season === SB) ? oldSB : m.call(p);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(r) });
    }
    return route.fallback();
  });
  m.call({ action: 'addBook', name: 'Sri Radha (Hindi)', cat: 'big', opId: 'x1' });
  await page.evaluate(() => pull()); await page.waitForTimeout(800);
  const langs = async () => page.evaluate(() => [...document.querySelectorAll('#spBody .ln-lang')].pop().innerText.replace(/\s+/g,' '));
  try {
    await page.click('#adminActions button:has-text("Add New Stock")'); await page.waitForTimeout(300);
    await pickPlace(page, 'Krakow', 'Krakow'); await page.waitForTimeout(800);
    await page.selectOption('#spWhere', 'there'); await page.waitForTimeout(200);
    const srKey = await page.evaluate(id => stockTitleKey(bookById(id)), books[0].id);
    await page.locator('#spBody .ln-title').last().selectOption(srKey); await page.waitForTimeout(150);
    t.push(['Year-Round Sales offers Sri Radha (Hindi), though its own copy predates it', /Hindi/.test(await langs())]);
    await page.locator('#spBody .ln-lang').last().selectOption('__newlang'); await page.waitForTimeout(150);
    await page.fill('#spBody .ln-nllang', 'hindi'); await page.click('#spBody .ln-add'); await page.waitForTimeout(800);
    const hi = m.call({ action: 'getState', season: SB }).state.books.find(b => b.name === 'Sri Radha (Hindi)');
    t.push(['typing Hindi again chooses it, with no "already in the catalogue" stop',
      !(await page.textContent('#modalErr')).trim() && !!(await page.$(`#spBody input.d-delta[data-book="${hi.id}"]`))]);
    t.push(['the catalogue still holds one Sri Radha (Hindi)', m.call({ action: 'getState', season: SB }).state.books.filter(b => b.name === 'Sri Radha (Hindi)').length === 1]);
    await page.fill(`#spBody input.d-delta[data-book="${hi.id}"]`, '9');
    await page.click('#spSave'); await page.waitForTimeout(1500);
    t.push(['…and 9 are stocked in Krakow', qty('wh_kr', hi.id) === 9]);

    /* b244: the screen's own refresh never lands (a slow or stuck "Checking for
       changes"), and Govardhana (Hindi) was already added from another device.
       Adding Hindi again must still put it on the line, not "Could not open". */
    hang = true;
    m.call({ action: 'addBook', name: 'Govardhana (Hindi)', cat: 'big', opId: 'x2' });
    await page.click('#adminActions button:has-text("Add New Stock")'); await page.waitForTimeout(300);
    await pickPlace(page, 'Italy', 'Italy'); await page.waitForTimeout(500);
    await page.selectOption('#spWhere', 'there'); await page.waitForTimeout(200);
    const gvKey = await page.evaluate(() => stockTitleKey(STATE.books.find(b => /^Govardhana/.test(b.name))));
    await page.locator('#spBody .ln-title').last().selectOption(gvKey); await page.waitForTimeout(150);
    t.push(['(the screen has not caught up: Hindi is not offered for Govardhana)', !/Hindi/.test(await langs())]);
    await page.locator('#spBody .ln-lang').last().selectOption('__newlang'); await page.waitForTimeout(150);
    await page.fill('#spBody .ln-nllang', 'Hindi'); await page.click('#spBody .ln-add'); await page.waitForTimeout(1500);
    const gv = m.call({ action: 'getState', season: SA }).state.books.find(b => b.name === 'Govardhana (Hindi)');
    t.push(['adding Hindi again chooses the existing Govardhana (Hindi), no error',
      !(await page.textContent('#modalErr')).trim() && !!(await page.$(`#spBody input.d-delta[data-book="${gv.id}"]`))]);
    t.push(['…still one Govardhana (Hindi) in the catalogue', m.call({ action: 'getState', season: SA }).state.books.filter(b => b.name === 'Govardhana (Hindi)').length === 1]);
    await page.fill(`#spBody input.d-delta[data-book="${gv.id}"]`, '4');
    await page.click('#spSave'); await page.waitForTimeout(1500);
    t.push(['…and 4 are stocked in Italy', qty('wh_it', gv.id) === 4]);
  } catch(e){ t.push(['ran to the end: ' + e.message, false]); }
  t.push(['no page errors', !errors.length]);
  await browser.close();
  let bad = 0;
  t.forEach(([n, ok]) => { console.log((ok ? '  ✓ ' : '  ✗ ') + n); if (!ok) bad++; });
  console.log(bad ? bad + ' FAILED' : 'all ' + t.length + ' passed');
  process.exit(bad ? 1 : 0);
})();
