/* Optional, needs Playwright + Chromium: node test/browser-activity.js
   The Activity Log in a real browser, against the real Code.gs (via mini.js):
   what is recorded and how it reads, what is left out (sales), scope by place,
   search, Delete = undo, and what a regional link may do. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-activity-' + n + '.png');

m.init();
const ok = (r, what) => { if (!r.ok) throw new Error(what + ': ' + r.error); return r; };
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason;
const books = st.books.filter(b => !b.partnerId);
const B0 = books[0].id, B1 = books[1].id;
const pl = st.regions[0];
const c = (p, what) => ok(m.call(Object.assign({ season: SA }, p)), what || p.action);
c({ action: 'createEvent', eventId: 'ev_fest', name: 'Festival', regionId: pl.regionId });
c({ action: 'createRegion', regionId: 'rg_it', whLoc: 'wh_it', name: 'Italy', currencies: 'EUR,USD' });
c({ action: 'createEvent', eventId: 'ev_yoga', name: 'Yoga Studio', regionId: 'rg_it' });
c({ action: 'adjustStockBulk', location: pl.whLoc, items: [{ bookId: B0, delta: 20 }, { bookId: B1, delta: 5 }], override: true, note: 'carton from the printer' });
c({ action: 'adjustStockBulk', location: 'wh_it', items: [{ bookId: B0, delta: 8 }], override: true });
c({ action: 'saveCost', id: 'cost_ab12', amt: 12, cur: 'PLN', category: 'Bank fee', location: pl.whLoc });
c({ action: 'renameEvent', eventId: 'ev_fest', name: 'Summer Festival' });
c({ action: 'sell', location: pl.whLoc, bookId: B0, legs: [{ type: 'Cash', cur: 'PLN', amt: 150 }], override: true });
const coordKey = ok(m.call({ action: 'setKey', kind: 'region', id: 'rg_it' }), 'key').result;
const qty = (loc, b) => { const r = (m.call({ action: 'getState', season: SA }).state.inventory || [])
  .find(i => i.location === loc && i.bookId === b); return r ? Number(r.qty) : 0; };

(async () => {
  const browser = await chromium.launch();
  const t = [], errors = [];
  async function open(query, width) {
    const page = await browser.newPage({ viewport: { width: width || 1100, height: 950 } });
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => { page.__dialogs = (page.__dialogs || []).concat(d.message()); d.accept(); });
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.includes('script.google.com')) {
        let p = {}; try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
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
    await page.goto('http://app.test/index.html' + (query || ''));
    await page.waitForTimeout(2000);
    if (await page.$('#whoName')) { await page.fill('#whoName', 'Tester'); await page.click('#whoSave'); await page.waitForTimeout(400); }
    return page;
  }
  const rows = page => page.evaluate(() => [...document.querySelectorAll('#alList .al-row')].map(r => ({
    text: r.querySelector('.al-text').textContent, meta: r.querySelector('.al-meta').textContent,
    undo: !!r.querySelector('[data-alundo]'), undone: r.classList.contains('undone') })));
  const openLog = async page => { await page.click('#adminActions button:has-text("Activity Log")'); await page.waitForTimeout(900); };

  let page;
  try {
    page = await open('');
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(300);
    const btns = await page.evaluate(() => [...document.querySelectorAll('#adminActions button')].map(b => b.textContent.trim()));
    t.push(['"🗒 Activity Log" replaces "Transfer record"', btns.includes('🗒 Activity Log') && !btns.some(x => /Transfer record/.test(x))]);

    // A transfer made through the app, then look at the log.
    await page.click('#adminActions button:has-text("Transfer Existing Stock")'); await page.waitForTimeout(300);
    await page.click('#xfTo .pp-in'); await page.fill('#xfTo .pp-in', 'Summer');
    await page.click('#xfTo .pp-row:has-text("Summer Festival")'); await page.waitForTimeout(400);
    await page.fill(`#xfBody .xf-in[data-book="${B0}"]`, '6');
    await page.click('#xfGo'); await page.waitForTimeout(1500);

    await openLog(page);
    let r = await rows(page);
    console.log('   log:\n     ' + r.map(x => (x.undo ? '[Delete] ' : '         ') + x.text).join('\n     '));
    const moved = r.find(x => /6 books transferred/.test(x.text));
    t.push(['the transfer reads in plain words, with titles and places', !!moved && /Sri Radha|×6/.test(moved.text) && /Poland \(Warehouse\) → Summer Festival/.test(moved.text)]);
    t.push(['…with who did it', !!moved && /main app/.test(moved.meta)]);
    t.push(['stock added, with its note', r.some(x => /Added .*×20.*Poland \(Warehouse\).*carton from the printer/.test(x.text))]);
    t.push(['a cost is recorded', r.some(x => /Recorded a cost: 12 PLN/.test(x.text))]);
    t.push(['creating an event is recorded', r.some(x => /Created event “Festival”/.test(x.text))]);
    t.push(['sales are not in it (they keep their own log)', !r.some(x => /sale|Sold/i.test(x.text))]);
    t.push(['the region view leaves out Italy', !r.some(x => /Italy/.test(x.text))]);
    t.push(['a rename cannot be undone here, so it has no Delete', r.some(x => /Renamed an event/.test(x.text) && !x.undo)]);
    t.push(['a transfer can be undone, so it has Delete', !!moved && moved.undo]);
    await page.screenshot({ path: shot('1-log') });

    await page.fill('#alSearch', 'cost'); await page.waitForTimeout(150);
    r = await rows(page);
    t.push(['search narrows the list', r.length === 1 && /cost/.test(r[0].text)]);
    await page.fill('#alSearch', '');

    // Delete = undo.
    page.__dialogs = [];
    await page.click('#alList .al-row:has-text("6 books transferred") [data-alundo]'); await page.waitForTimeout(1800);
    t.push(['Delete asks first, naming what will be undone', (page.__dialogs || []).some(x => /This undoes it:[\s\S]*6 books transferred/.test(x))]);
    t.push(['the books went back (Festival 0, warehouse 19)', qty('ev_fest', B0) === 0 && qty(pl.whLoc, B0) === 19]);
    r = await rows(page);
    const und = r.find(x => /6 books transferred/.test(x.text) && !/^Undid/.test(x.text));
    t.push(['the entry stays, crossed out as "Undone", with no Delete', !!und && und.undone && /Undone by/.test(und.meta) && !und.undo]);
    t.push(['the undo is itself recorded', r.some(x => /^Undid: 6 books transferred/.test(x.text))]);

    // Undo a cost.
    await page.click('#alList .al-row:has-text("Recorded a cost") [data-alundo]'); await page.waitForTimeout(1800);
    const costs = m.call({ action: 'getState', season: SA }).state.costs || [];
    t.push(['undoing the cost removes it', !costs.some(x => x.id === 'cost_ab12')]);

    // At the event: only what touched it.
    await page.evaluate(() => { closeModal(); goTo('event', 'ev_fest'); }); await page.waitForTimeout(300);
    await openLog(page);
    r = await rows(page);
    t.push(['at an event, only what touched that event', r.length >= 1 && r.every(x => /Festival/.test(x.text))]);
    await page.evaluate(() => closeModal());

    // Opens at once the second time (what this device last saw), then refreshes.
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(300);
    await page.click('#adminActions button:has-text("Activity Log")');
    const instant = await page.evaluate(() => document.querySelectorAll('#alList .al-row').length);
    t.push(['opens straight away from what this device last saw', instant > 0]);
    await page.close();

    // Phone.
    const phone = await open('', 390);
    await phone.evaluate(r => goTo('region', r), pl.regionId); await phone.waitForTimeout(300);
    await openLog(phone);
    await phone.screenshot({ path: shot('2-phone') });
    const over = await phone.evaluate(() => { const b = document.querySelector('#modal .m-body'); return b.scrollWidth - b.clientWidth; });
    t.push(['phone: the log fits the screen', over <= 0]);
    await phone.close();

    // Regional link: its own region only; may undo its own stock changes, not the owner's money.
    const coord = await open('?k=' + coordKey);
    const cb = await coord.evaluate(() => [...document.querySelectorAll('#adminActions button')].map(b => b.textContent.trim()));
    t.push(['regional link has the Activity Log', cb.includes('🗒 Activity Log')]);
    await openLog(coord);
    r = await rows(coord);
    t.push(['regional link sees only its own region', r.length >= 1 && r.every(x => /Italy|Yoga/.test(x.text)) && !r.some(x => /Poland/.test(x.text))]);
    await coord.close();
    const list = m.call({ action: 'activity', season: SA }).result;
    const itAdd = list.find(e => /Added .*Italy/.test(e.text));
    const undoIt = m.call({ action: 'undoActivity', k: coordKey, id: itAdd.id });
    t.push(['regional link can undo its own region\'s stock change', undoIt.ok && qty('wh_it', B0) === 0]);
    const plAdd = list.find(e => /Added .*Poland/.test(e.text));
    t.push(['regional link cannot undo another region\'s change (server refuses)', !m.call({ action: 'undoActivity', k: coordKey, id: plAdd.id }).ok]);
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
