/* Optional, needs Playwright + Chromium: node test/browser-newtitle.js
   b247: a new title or language typed in Add Stock is not added to the
   catalogue until Save, and a title added by mistake can be deleted from Edit
   Book Display. Every Apps Script request is answered by the fake server
   (mini.js) running the real Code.gs; nothing leaves the machine. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');

m.init();
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason;
const WH = st.regions[0].whLoc;
const SR = st.books.find(b => b.name === 'Sri Radha (English)');
const named = n => m.call({ action: 'getState', season: SA }).state.books.filter(b => b.name === n);
const qty = (loc, bookId) => { const r = (m.call({ action: 'getState', season: SA }).state.inventory || [])
  .find(i => i.location === loc && i.bookId === bookId); return r ? Number(r.qty) : 0; };

(async () => {
  const browser = await chromium.launch();
  const t = [], errors = [];
  let down = false;
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.includes('script.google.com')) {
      if (down) return route.abort('internetdisconnected');
      let p = {}; try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(m.call(p)) });
    }
    if (url.startsWith('http://app.test/')) {
      const rel = new URL(url).pathname.replace(/^\/+/, '') || 'index.html';
      const f = rel === 'config.js' ? path.join(__dirname, 'config.test.js') : path.join(ROOT, rel);
      if (fs.existsSync(f) && fs.statSync(f).isFile())
        return route.fulfill({ status: 200, body: fs.readFileSync(f),
          contentType: f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : undefined });
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto('http://app.test/index.html'); await page.waitForTimeout(2000);

  const openStock = async () => {
    await page.click('#adminActions button:has-text("Add New Stock")'); await page.waitForTimeout(300);
    const reg = st.regions[0].name;
    await page.click('#spPlace .pp-in'); await page.fill('#spPlace .pp-in', reg);
    await page.click(`#spPlace .pp-row:has-text("${reg}")`); await page.waitForTimeout(600);
    await page.selectOption('#spWhere', 'there'); await page.waitForTimeout(200);
  };
  const newLang = async lang => {
    const key = await page.evaluate(id => stockTitleKey(bookById(id)), SR.id);
    await page.locator('#spBody .ln-title').last().selectOption(key); await page.waitForTimeout(150);
    await page.locator('#spBody .ln-lang').last().selectOption('__newlang'); await page.waitForTimeout(150);
    await page.fill('#spBody .ln-nllang', lang); await page.click('#spBody .ln-add'); await page.waitForTimeout(500);
  };
  const lastInput = () => page.evaluate(() => { const i = [...document.querySelectorAll('#spBody input.d-delta')].pop(); return i && i.dataset.book; });

  try {
    // A slip, typed and then taken off: the catalogue never sees it.
    await openStock();
    await newLang('Hindii');
    t.push(['the new language is on the line, marked "added when you save"',
      !!(await lastInput()) && /added when you save/.test(await page.textContent('#spBody'))]);
    t.push(['…but it is not in the catalogue yet', named('Sri Radha (Hindii)').length === 0]);
    await page.click('#spBody [data-unline="0"]'); await page.waitForTimeout(200);
    await page.click('#modal .btn-ghost:has-text("Cancel")').catch(() => page.evaluate(() => closeModal()));
    await page.waitForTimeout(300);
    t.push(['taken off and closed: still not in the catalogue', named('Sri Radha (Hindii)').length === 0]);

    // A new book typed and the dialog closed without saving.
    await openStock();
    await page.locator('#spBody .ln-title').last().selectOption('__new'); await page.waitForTimeout(150);
    await page.fill('#spBody .ln-nbname', 'Test Book'); await page.fill('#spBody .ln-nblang', 'English');
    await page.click('#spBody .ln-add'); await page.waitForTimeout(400);
    await page.evaluate(() => closeModal()); await page.waitForTimeout(300);
    t.push(['a new book, closed without saving, is not added', named('Test Book (English)').length === 0]);

    // No connection at Save: nothing is added, the line stays to try again.
    await openStock();
    await newLang('Hindi');
    let id = await lastInput();
    await page.fill(`#spBody input.d-delta[data-book="${id}"]`, '3');
    down = true;
    await page.click('#spSave'); await page.waitForTimeout(2500);
    t.push(['no connection: Save says the title could not be added', /Could not add Sri Radha \(Hindi\)/.test(await page.textContent('#modalErr'))]);
    t.push(['…the line and its number are still there', await page.inputValue(`#spBody input.d-delta[data-book="${id}"]`).catch(() => '') === '3']);
    down = false;

    // Saved: added once, with its stock.
    await page.click('#spSave'); await page.waitForTimeout(2000);
    const hi = named('Sri Radha (Hindi)');
    t.push(['Save adds Sri Radha (Hindi) once', hi.length === 1]);
    t.push(['…with its 3 copies', hi.length === 1 && qty(WH, hi[0].id) === 3]);
    t.push(['…and the screen shows them', hi.length === 1 && await page.evaluate(([l, b]) => {
      const r = (STATE.inventory || []).find(i => i.location === l && i.bookId === b); return r ? r.qty : 0; }, [WH, hi[0].id]) === 3]);

    // Deleted from Edit Book Display.
    await page.evaluate(() => bookDisplayModal()); await page.waitForTimeout(400);
    t.push(['Edit Book Display offers 🗑 on the added title', !!(await page.$(`#modal [data-bd-del="${hi[0].id}"]`))]);
    t.push(['…and not on a standard title', !(await page.$(`#modal [data-bd-del="${SR.id}"]`))]);
    await page.click(`#modal [data-bd-del="${hi[0].id}"]`); await page.waitForTimeout(1500);
    t.push(['🗑 deletes it from the catalogue', named('Sri Radha (Hindi)').length === 0]);
    t.push(['…and from the screen', await page.evaluate(id => !(STATE.books || []).some(b => b.id === id), hi[0].id)]);
  } catch (e) { t.push(['ran to the end: ' + e.message, false]); }
  t.push(['no page errors', !errors.length]);
  if (errors.length) console.log(errors);
  await browser.close();
  let bad = 0;
  t.forEach(([n, ok]) => { console.log((ok ? '  ✓ ' : '  ✗ ') + n); if (!ok) bad++; });
  console.log(bad ? bad + ' FAILED' : 'all ' + t.length + ' passed');
  process.exit(bad ? 1 : 0);
})();
