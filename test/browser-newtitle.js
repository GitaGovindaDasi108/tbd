/* Optional, needs Playwright + Chromium: node test/browser-newtitle.js
   b247: a new title or language typed in Add Stock is not added to the
   catalogue until Save, and a title added by mistake can be deleted from Edit
   Book Display (b247) or by deleting its "Added a new title" entry in the
   Activity log (b248). Every Apps Script request is answered by the fake server
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
    // b305 (Gita): the line shows just its category, in a drop-down that can change it.
    t.push(['the new language is on the line, with its category in a drop-down',
      !!(await lastInput()) && !/added when you save/.test(await page.textContent('#spBody')) && !!(await page.$('#spBody select.ln-cat'))]);
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

    // b304: Save is instant. With no connection the title and its stock show at
    // once and wait on the device, then go in when the connection is back.
    await openStock();
    await newLang('Hindi');
    let id = await lastInput();
    await page.fill(`#spBody input.d-delta[data-book="${id}"]`, '3');
    down = true;
    const t0 = Date.now();
    await page.click('#spSave'); await page.waitForTimeout(300);
    t.push(['b304: Save closes at once, even with no connection (' + (Date.now() - t0) + 'ms)', !(await page.evaluate(() => document.querySelector('#overlay').classList.contains('show')))]);
    t.push(['b304: …the new title and its 3 copies show straight away', await page.evaluate(([l]) => {
      const b = (STATE.books || []).find(x => x.name === 'Sri Radha (Hindi)'); const r = b && (STATE.inventory || []).find(i => i.location === l && i.bookId === b.id); return r ? r.qty : 0; }, [WH]) === 3]);
    t.push(['…not on the server yet', named('Sri Radha (Hindi)').length === 0]);
    down = false;
    await page.evaluate(() => flushPending()); await page.waitForTimeout(2500);

    // Saved: added once, with its stock.
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

    // b248: "Added a new title" in the Activity log is undone like any entry.
    await page.evaluate(() => closeModal()); await page.waitForTimeout(300);
    await openStock();
    await newLang('Bengali');
    id = await lastInput();
    await page.fill(`#spBody input.d-delta[data-book="${id}"]`, '2');
    await page.click('#spSave'); await page.waitForTimeout(2000);
    const bn = named('Sri Radha (Bengali)');
    t.push(['(Sri Radha (Bengali) saved, with 2 copies)', bn.length === 1 && qty(WH, bn[0].id) === 2]);
    const log = () => m.call({ action: 'activity' }).result;
    const entry = log().find(x => /Added a new title: “Sri Radha \(Bengali\)”/.test(x.text));
    t.push(['the Activity log has "Added a new title", with Delete', !!entry && entry.canUndo]);
    await page.evaluate(() => activityModal()); await page.waitForTimeout(1500);
    await page.click(`#modal [data-alundo="${entry.id}"]`); await page.waitForTimeout(2000);
    t.push(['Delete takes the title out of the catalogue', named('Sri Radha (Bengali)').length === 0]);
    t.push(['…and off the screen', await page.evaluate(id => !(STATE.books || []).some(b => b.id === id), bn[0].id)]);
    t.push(['…the entry shows as undone', log().some(x => x.id === entry.id && x.undoneAt)]);
    // Choosing a title that already exists is not "added", so it is not logged.
    const before = log().length;
    m.call({ action: 'addBook', name: 'Sri Radha (English)', cat: 'big', orExisting: true });
    t.push(['an existing title chosen again adds nothing to the log', log().length === before]);
    // Entries written before b248 carry no undo: found by the title's name.
    m.call({ action: 'addBook', name: 'Old Way (Bengali)', cat: 'big' });
    const sh = m.sheet('_activity'), v = sh.getDataRange().getValues(), c = v[0].indexOf('undo');
    const r = v.findIndex(x => /Old Way/.test(x.join('|'))); sh.getRange(r + 1, c + 1).setValue(''); m.clear();
    const old = log().find(x => /Old Way/.test(x.text));
    t.push(['an older "Added a new title" entry can be deleted too', !!old && old.canUndo]);
    m.call({ action: 'undoActivity', id: old.id });
    t.push(['…and deleting it takes the title out', named('Old Way (Bengali)').length === 0]);
  } catch (e) { t.push(['ran to the end: ' + e.message, false]); }
  t.push(['no page errors', !errors.length]);
  if (errors.length) console.log(errors);
  await browser.close();
  let bad = 0;
  t.forEach(([n, ok]) => { console.log((ok ? '  ✓ ' : '  ✗ ') + n); if (!ok) bad++; });
  console.log(bad ? bad + ' FAILED' : 'all ' + t.length + ' passed');
  process.exit(bad ? 1 : 0);
})();
