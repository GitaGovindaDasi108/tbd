/* Optional, needs Playwright + Chromium: node test/browser-transit.js
   The Books in Transit section on the main screen, and its two arrival buttons,
   in a real browser against the real Code.gs (via mini.js). */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-transit-' + n + '.png');

m.init();
const ok = (r, what) => { if (!r.ok) throw new Error(what + ': ' + r.error); return r; };
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason;
const books = st.books.filter(b => !b.partnerId);
const pl = st.regions[0];
ok(m.call({ action: 'createEvent', eventId: 'ev_fest', name: 'Festival', regionId: pl.regionId, season: SA }), 'event');
ok(m.call({ action: 'createRegion', regionId: 'rg_it', whLoc: 'wh_it', name: 'Italy', currencies: 'EUR,USD', season: SA }), 'italy');
const send = (id, toRegion, toLoc, carrier, items) => ok(m.call({ action: 'sendShipment', shipId: id, mode: 'devotee',
  fromRegion: 'OUTSIDE', toRegion, toLoc, carrier, items, season: SA }), 'ship ' + id);
send('sh_alpha1', pl.regionId, pl.whLoc, 'Alpha', [{ bookId: books[0].id, qty: 5 }, { bookId: books[1].id, qty: 3 }]);
send('sh_beta22', pl.regionId, 'ev_fest', 'Beta', [{ bookId: books[0].id, qty: 2 }]);
send('sh_gamma3', 'rg_it', 'wh_it', 'Gamma', [{ bookId: books[2].id, qty: 4 }]);
const coordKey = ok(m.call({ action: 'setKey', kind: 'region', id: 'rg_it' }), 'key').result;
const sellerKey = ok(m.call({ action: 'sellerLink', regionId: 'rg_it' }), 'seller').result;
const qty = (loc, bookId) => { const r = (m.call({ action: 'getState', season: SA }).state.inventory || [])
  .find(i => i.location === loc && i.bookId === bookId); return r ? Number(r.qty) : 0; };
const ship = id => (m.call({ action: 'getState', season: SA }).state.shipments || []).find(x => x.shipId === id);

(async () => {
  const browser = await chromium.launch();
  const t = [], errors = [];
  async function open(query, width) {
    const page = await browser.newPage({ viewport: { width: width || 1100, height: 1000 } });
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
  const cards = page => page.evaluate(() => [...document.querySelectorAll('#transitPanel .sh-card')]
    .filter(c => c.offsetParent).map(c => c.textContent.replace(/\s+/g, ' ').trim()));
  let page;
  try {
    page = await open('');
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(400);
    let c = await cards(page);
    t.push(['region screen: Books in Transit section shows both batches', c.length === 2 && c.some(x => /Alpha/.test(x)) && c.some(x => /Beta/.test(x))]);
    t.push(['each card has "Full Delivery Arrived" and "Partial Delivery Arrived"',
      c.every(x => /Full Delivery Arrived/.test(x) && /Partial Delivery Arrived/.test(x))]);
    t.push(['the other region\'s batch is not shown here', !c.some(x => /Gamma/.test(x))]);
    await (await page.$('#bottomRow')).screenshot({ path: shot('1-region') });

    page.__dialogs = [];
    await page.click('#transitPanel .sh-card:has-text("Alpha") [data-act="sharriveall"]'); await page.waitForTimeout(1500);
    t.push(['Full Delivery asks "are you sure" first', (page.__dialogs || []).some(x => /Mark all 8 books as arrived/.test(x))]);
    t.push(['Full Delivery puts all 5 + 3 on the warehouse shelf', qty(pl.whLoc, books[0].id) === 5 && qty(pl.whLoc, books[1].id) === 3]);
    t.push(['…and the batch is marked arrived', ship('sh_alpha1').status === 'ARRIVED']);
    c = await cards(page);
    t.push(['…and it leaves the section', c.length === 1 && !c.some(x => /Alpha/.test(x))]);

    await page.click('#transitPanel .sh-card:has-text("Beta") [data-act="shreceive"]'); await page.waitForTimeout(400);
    const head = await page.textContent('#modal h3');
    t.push(['Partial Delivery opens the "what arrived" screen', /Partial Delivery Arrived/.test(head)]);
    t.push(['…pointing at the Festival, where it was sent', (await page.inputValue('#rcTo')) === 'ev_fest']);
    await page.fill('#modal .rc-q', '1'); await page.click('#rcGo'); await page.waitForTimeout(1500);
    t.push(['1 of 2 lands at the Festival', qty('ev_fest', books[0].id) === 1]);
    t.push(['the rest stays in transit (partly delivered)', ship('sh_beta22').status === 'PARTIAL']);
    t.push(['back on the main screen, not a dialog', !(await page.evaluate(() => document.querySelector('#overlay').classList.contains('show')))]);
    c = await cards(page);
    t.push(['the card now reads "1 of 2" still coming', c.length === 1 && /1 still coming/.test(c[0]) && /partly delivered/.test(c[0])]);

    await page.evaluate(() => goTo('season')); await page.waitForTimeout(400);
    c = await cards(page);
    t.push(['season screen shows every batch on the road', c.length === 2 && c.some(x => /Beta/.test(x)) && c.some(x => /Gamma/.test(x))]);
    await page.evaluate(r => { goTo('region', r); goTo('event', 'ev_fest'); }, pl.regionId); await page.waitForTimeout(400);
    c = await cards(page);
    t.push(['event screen shows the batch heading for it', c.length === 1 && /Beta/.test(c[0])]);
    await page.close();

    const phone = await open('', 390);
    await phone.evaluate(() => goTo('season')); await phone.waitForTimeout(400);
    const el = await phone.$('#transitPanel');
    await el.screenshot({ path: shot('2-phone') });
    const over = await phone.evaluate(() => { const p = document.querySelector('#transitPanel'); return p.scrollWidth - p.clientWidth; });
    t.push(['phone: section fits the screen', over <= 0]);
    await phone.close();

    const coord = await open('?k=' + coordKey);
    c = await cards(coord);
    t.push(['regional link sees its own region\'s batch', c.length === 1 && /Gamma/.test(c[0])]);
    t.push(['regional link: no Edit / Delete on it', !/Edit details|Delete/.test(c[0])]);
    const cb = await coord.evaluate(() => [...document.querySelectorAll('#adminActions button')].map(b => b.textContent.trim()));
    t.push(['regional link: no separate "Books in transit" button (it is on the main screen)', !cb.includes('🚚 Books in transit')]);
    await coord.click('#transitPanel [data-act="sharriveall"]'); await coord.waitForTimeout(1500);
    t.push(['regional link can mark a full delivery', qty('wh_it', books[2].id) === 4 && ship('sh_gamma3').status === 'ARRIVED']);
    await coord.close();
    const refused = m.call({ action: 'receiveShipment', k: coordKey, shipId: 'sh_beta22', toLoc: 'ev_fest',
      items: [{ bookId: books[0].id, qty: 1 }] });
    t.push(['regional link cannot receive another region\'s batch (server refuses)', !refused.ok]);

    const seller = await open('?k=' + sellerKey);
    t.push(['sales link does not see Books in Transit', (await cards(seller)).length === 0]);
    await seller.close();
  } catch (e) {
    console.log('STOPPED:', e.message.split('\n')[0]);
    t.push(['test ran to the end', false]);
  }
  t.push(['no errors in the page', errors.length === 0]);
  if (errors.length) console.log('page errors:', errors);
  t.forEach(([n, okk]) => console.log((okk ? 'PASS' : 'FAIL'), n));
  console.log('screenshots:', shot('*'));
  await browser.close();
})();
