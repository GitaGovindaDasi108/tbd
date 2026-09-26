/* Optional, needs Playwright + Chromium: node test/browser-addstock.js
   The Add Stock dialog in a real browser. Every Apps Script request is answered
   by the fake server (mini.js) running the real Code.gs; nothing leaves the
   machine. Screenshots go to the system temp folder. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-addstock-' + n + '.png');

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

  let page;
  try{
  // ---- Owner, standing at the season ----
  page = await open('');
  const btns = await page.evaluate(() => [...document.querySelectorAll('#adminActions button')].map(b => b.textContent.trim()));
  t.push(['"＋ Add Stock" is on the admin panel', btns.includes('＋ Add Stock')]);
  t.push(['old "Add / subtract stock" button is gone', !btns.some(x => /Add \/ subtract/.test(x))]);

  await page.click('#adminActions button:has-text("Add Stock")'); await page.waitForTimeout(300);
  await page.click('#spPlace .pp-in'); await page.waitForTimeout(200);
  const all = await listText(page);
  console.log('   list:', all.join(' | '));
  t.push(['list shows seasons, regions and events, indented', all.includes('S:Year-Round Sales') && all.includes('R:Italy') && all.includes('E:Yoga Studio') && all.includes('R:Krakow')]);
  t.push(['closed region (Spain) is not offered', !all.some(x => /Spain/.test(x))]);
  await page.fill('#spPlace .pp-in', 'yoga'); await page.waitForTimeout(150);
  const yoga = await listText(page);
  t.push(['searching "yoga" narrows to Yoga Studio under Italy', JSON.stringify(yoga) === JSON.stringify(['S:' + st.seasons.find(s => s.seasonId === SA).name, 'R:Italy', 'E:Yoga Studio'])]);
  await page.screenshot({ path: shot('1-picker') });

  // Already at the destination, Italy's warehouse.
  await page.fill('#spPlace .pp-in', 'Italy'); await page.click('#spPlace .pp-row.pp-region:has-text("Italy")'); await page.waitForTimeout(500);
  await page.selectOption('#spWhere', 'there'); await page.waitForTimeout(200);
  const rows = await page.evaluate(() => [...document.querySelectorAll('#spBody .bulk-row .bn')].map(x => x.childNodes[0].textContent.trim()));
  t.push(['only Italy\'s own two titles are listed', rows.length === 2]);
  const other = books[3];
  await page.selectOption('#spOther', other.id); await page.waitForTimeout(200);
  const rows2 = await page.evaluate(() => [...document.querySelectorAll('#spBody .bulk-row .bn')].map(x => x.textContent));
  t.push(['a title picked from Other Books joins the list, marked "new here"', rows2.length === 3 && rows2.some(x => /new here/.test(x))]);
  await page.fill(`#spBody input.d-delta[data-book="${books[0].id}"]`, '5');
  await page.fill(`#spBody input.d-set[data-book], #spBody input[data-set="${other.id}"]`, '7');
  const foot = await page.textContent('#footValue');
  t.push(['totals bar counts the updated stock (12)', foot.trim() === '12']);
  await page.screenshot({ path: shot('2-there') });
  await page.click('#spSave'); await page.waitForTimeout(1500);
  t.push(['+5 landed on Italy\'s shelf', qty('wh_it', books[0].id) === 5]);
  t.push(['Set 7 of the other title landed', qty('wh_it', other.id) === 7]);
  const itBooks = m.call({ action: 'getState', season: SA }).state.regions.find(r => r.regionId === 'rg_it').books;
  t.push(['that title is now switched on for Italy (as in Edit region)', itBooks.includes(other.id)]);

  // Subtracting warns, twice: on screen and in a pop-up.
  await page.click('#adminActions button:has-text("Add Stock")'); await page.waitForTimeout(300);
  await pickPlace(page, 'Italy', 'Italy');
  await page.selectOption('#spWhere', 'there'); await page.waitForTimeout(200);
  await page.click(`#spBody .sign-btn[data-sign="${books[0].id}"]`);
  await page.fill(`#spBody input.d-delta[data-book="${books[0].id}"]`, '2');
  const warn = await page.textContent('#spSubWarn');
  t.push(['subtracting shows the "use Transfer instead" warning', /Transfer Existing Stock/.test(warn)]);
  page.__dialogs = [];
  await page.click('#spSave'); await page.waitForTimeout(1200);
  t.push(['saving a subtraction asks for confirmation first', (page.__dialogs || []).some(x => /Transfer Existing Stock/.test(x))]);
  t.push(['after confirming, 2 were taken off (5 → 3)', qty('wh_it', books[0].id) === 3]);

  // Not there yet, heading for an event.
  await page.click('#adminActions button:has-text("Add Stock")'); await page.waitForTimeout(300);
  await pickPlace(page, 'Festival', 'Festival');
  await page.selectOption('#spWhere', 'transit'); await page.waitForTimeout(200);
  const hasOrigin = await page.$('#soOrigin');
  t.push(['"Where are they coming from" is gone', !hasOrigin]);
  await page.fill('#spBody input[data-k="carrier"]', 'Narada Muni');
  await page.fill('#spBody input[data-k="phone"]', '+11081728108');
  await page.fill(`#spBody input.sp-q[data-book="${books[1].id}"]`, '3');
  await page.screenshot({ path: shot('3-transit') });
  await page.click('#spSave'); await page.waitForTimeout(1500);
  const ship = (m.call({ action: 'getState', season: SA }).state.shipments || []).find(x => x.carrier === 'Narada Muni');
  t.push(['books are in transit, aimed at the Festival', !!ship && ship.toLoc === 'ev_fest' && ship.status === 'IN_TRANSIT']);
  t.push(['nothing added to the shelf yet', qty('ev_fest', books[1].id) === 0]);
  // Marking them arrived: the batch names the event, and lands there by default.
  await page.evaluate(() => { goTo('region', STATE.regions[0].regionId); });
  await page.waitForTimeout(300);
  await page.evaluate(() => shipmentsModal()); await page.waitForTimeout(300);
  const route = await page.evaluate(() => [...document.querySelectorAll('#modal .sh-route')].map(x => x.textContent));
  t.push(['"Books in transit" shows it heading for Poland › Festival', route.some(r => /Poland › Festival/.test(r))]);
  await page.click('#modal .sh-card:has-text("Narada") button[data-act="shreceive"]'); await page.waitForTimeout(300);
  t.push(['"Mark as arrived" already points at the Festival', (await page.inputValue('#rcTo')) === 'ev_fest']);
  await page.click('#rcGo'); await page.waitForTimeout(1500);
  t.push(['after arrival the 3 books are on the Festival shelf', qty('ev_fest', books[1].id) === 3]);
  await page.evaluate(() => closeModal());

  // Another season.
  await page.click('#adminActions button:has-text("Add Stock")'); await page.waitForTimeout(300);
  await pickPlace(page, 'Krakow', 'Krakow');
  await page.waitForTimeout(800);
  await page.selectOption('#spWhere', 'there'); await page.waitForTimeout(200);
  await page.fill(`#spBody input.d-delta[data-book="${books[0].id}"]`, '4');
  await page.click('#spSave'); await page.waitForTimeout(1500);
  t.push(['stock can be added in another season (Krakow, Year-Round Sales)', qty('wh_kr', books[0].id) === 4]);

  // "Add a new one": an event, then straight back with it chosen.
  await page.click('#adminActions button:has-text("Add Stock")'); await page.waitForTimeout(300);
  await page.click('#modal .linkish'); await page.waitForTimeout(300);
  const optTitles = await page.evaluate(() => [...document.querySelectorAll('#modal .opt b')].map(b => b.textContent));
  t.push(['"Add something new" offers Season, Region, Event', optTitles.join(',') === 'Season,Region,Event']);
  await page.click('#modal .opt[data-new="event"]'); await page.waitForTimeout(200);
  await page.click('#anRegion .pp-in'); await page.fill('#anRegion .pp-in', 'Italy');
  await page.click('#anRegion .pp-row:has-text("Italy")'); await page.click('#anGo'); await page.waitForTimeout(600);
  page.__dialogs = [];
  await page.fill('#evname', 'Temple Event'); await page.click('#saveEv'); await page.waitForTimeout(1500);
  const back = await page.evaluate(() => ({ title: (document.querySelector('#modal h3') || {}).textContent || '',
    place: (document.querySelector('#spPlace .pp-in') || {}).value || '' }));
  t.push(['after creating it: the "return" pop-up appears', (page.__dialogs || []).some(x => /return to adding or transferring stock/.test(x))]);
  t.push(['…and Add Stock reopens with the new event chosen', /Add Stock/.test(back.title) && /Temple Event/.test(back.place)]);
  await page.click('#modal .m-foot .btn-ghost');

  // Standing at an event: that event is chosen already.
  await page.evaluate(() => { goTo('region', 'rg_it'); goTo('event', 'ev_yoga'); });
  await page.waitForTimeout(400);
  await page.click('#adminActions button:has-text("Add Stock")'); await page.waitForTimeout(400);
  const pre = await page.inputValue('#spPlace .pp-in');
  t.push(['at an event, that event is already chosen', /Yoga Studio/.test(pre)]);
  await page.close();

  // ---- Phone width: nothing hangs off the edge ----
  const phone = await open('', 390);
  await phone.click('#adminActions button:has-text("Add Stock")'); await phone.waitForTimeout(300);
  await pickPlace(phone, 'Italy', 'Italy');
  await phone.selectOption('#spWhere', 'there'); await phone.waitForTimeout(300);
  await phone.screenshot({ path: shot('4-phone-there'), fullPage: false });
  const overflow = await phone.evaluate(() => {
    const m = document.querySelector('#modal .m-body'); return m.scrollWidth - m.clientWidth; });
  t.push(['phone: dialog has no sideways overflow (there)', overflow <= 0]);
  await phone.selectOption('#spWhere', 'transit'); await phone.waitForTimeout(300);
  await phone.screenshot({ path: shot('5-phone-transit') });
  const overflow2 = await phone.evaluate(() => {
    const m = document.querySelector('#modal .m-body'); return m.scrollWidth - m.clientWidth; });
  t.push(['phone: dialog has no sideways overflow (in transit)', overflow2 <= 0]);
  await phone.close();

  // ---- Regional link (Italy): its own region only, no new titles ----
  const coord = await open('?k=' + coordKey);
  const cbtns = await coord.evaluate(() => [...document.querySelectorAll('#adminActions button')].map(b => b.textContent.trim()));
  t.push(['regional link sees "＋ Add Stock"', cbtns.includes('＋ Add Stock')]);
  await coord.click('#adminActions button:has-text("Add Stock")'); await coord.waitForTimeout(300);
  await coord.click('#spPlace .pp-in'); await coord.waitForTimeout(200);
  const clist = await listText(coord);
  t.push(['regional link: only Italy and its events', clist.every(x => /^S:|Italy|Yoga|Temple/.test(x)) && clist.includes('R:Italy')]);
  await coord.click('#spPlace .pp-row:has-text("Italy")'); await coord.waitForTimeout(400);
  await coord.selectOption('#spWhere', 'transit'); await coord.waitForTimeout(200);
  t.push(['regional link: "My Book Is Not Listed" is not offered', !(await coord.$('.sp-notlisted'))]);
  t.push(['regional link: "Other Books" is offered', !!(await coord.$('#spOther'))]);
  await coord.fill('#spBody input[data-k="carrier"]', 'Sukadeva');
  await coord.fill(`#spBody input.sp-q[data-book="${books[0].id}"]`, '2');
  await coord.click('#spSave'); await coord.waitForTimeout(1500);
  const cship = (m.call({ action: 'getState', season: SA }).state.shipments || []).find(x => x.carrier === 'Sukadeva');
  t.push(['regional link can bring books into its region', !!cship && cship.toRegion === 'rg_it']);
  const refused = m.call({ action: 'sendShipment', k: coordKey, mode: 'devotee', fromRegion: 'OUTSIDE', toRegion: pl.regionId,
    carrier: 'x', items: [{ bookId: books[0].id, qty: 1 }] });
  t.push(['regional link cannot send books into another region (server refuses)', !refused.ok]);
  await coord.close();

  const sellerKey = ok(m.call({ action: 'sellerLink', regionId: 'rg_it' }), 'seller').result;
  const seller = await open('?k=' + sellerKey);
  const sbtns = await seller.evaluate(() => [...document.querySelectorAll('#adminActions button')].map(b => b.textContent.trim()));
  t.push(['sales link does not see Add Stock', !sbtns.some(x => /Add Stock/.test(x))]);
  await seller.close();

  }catch(e){
    console.log('STOPPED:', e.message.split('\n')[0]);
    t.push(['test ran to the end', false]);
    try{ console.log('   dialog:', await page.evaluate(()=>document.querySelector('#modal').innerText.slice(0,400)));
         await page.screenshot({ path: shot('stopped') }); }catch(e2){}
  }
  t.push(['no errors in the page', errors.length === 0]);
  if (errors.length) console.log('page errors:', errors);
  t.forEach(([n, okk]) => console.log((okk ? 'PASS' : 'FAIL'), n));
  console.log('screenshots:', shot('*'));
  await browser.close();
})();
