/* Optional, needs Playwright + Chromium: node test/browser-preunlisted.js
   b218: "+ Pre-Orders (Unlisted Titles)" offers the whole catalogue — titles
   hidden here and titles this region does not carry at all — and pre-ordering
   one this region does not carry switches it on for the region. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-preun-' + n + '.png');

m.init();
const ok = (r, what) => { if (!r.ok) throw new Error(what + ': ' + r.error); return r; };
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason;
const pl = st.regions[0];
const books = st.books.filter(b => !b.partnerId);
const [B0, B1, B2] = books.map(b => b.id);
const nameOf = id => books.find(b => b.id === id).name;
const c = (p, w) => ok(m.call(Object.assign({ season: SA }, p)), w || p.action);
// Poland carries only B0 and B1; B1 has stock; an event where only B1 ever arrived.
c({ action: 'editRegion', regionId: pl.regionId, name: pl.name, currencies: (pl.currencies || ['PLN']).join(','), books: [B0, B1].join(',') });
c({ action: 'createEvent', eventId: 'ev_fest', name: 'Festival', regionId: pl.regionId });
c({ action: 'adjustStockBulk', location: 'ev_fest', items: [{ bookId: B1, delta: 3 }], override: true });
const sellKey = ok(m.call({ action: 'setKey', kind: 'event', id: 'ev_fest' }), 'sales key').result;
const carried = () => (m.call({ action: 'getState', season: SA }).state.regions.find(r => r.regionId === pl.regionId).books || []);

(async () => {
  const browser = await chromium.launch();
  const t = [], errors = [];
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
    if (await page.$('#whoName')) { await page.fill('#whoName', 'Tester'); await page.click('#whoSave'); await page.waitForTimeout(400); }
    return page;
  }
  const choices = page => page.$$eval('#modal [data-act="hbpre"]', b => b.map(x => x.textContent.trim()));
  const subs = page => page.$$eval('#modal .cash-sub', b => b.map(x => x.textContent.trim()));
  const shelf = page => page.evaluate(() => shelfBooks().map(b => b.id));

  let page;
  try {
    /* ---- Admin, at the event ---- */
    page = await open('');
    await page.evaluate(() => goTo('event', 'ev_fest')); await page.waitForTimeout(300);
    t.push(['event shelf: only the title that came here', JSON.stringify(await shelf(page)) === JSON.stringify([B1])]);
    t.push(['the "+ Pre-Orders (Unlisted Titles)" button is there', await page.isVisible('[data-act="hiddenpre"]')]);
    await page.click('[data-act="hiddenpre"]'); await page.waitForTimeout(300);
    const list = await choices(page);
    t.push(['it lists the title hidden here (carried by the region)', list.includes(nameOf(B0))]);
    t.push(['…and titles the region does not carry', list.includes(nameOf(B2))]);
    t.push(['…every other catalogue title, none on the shelf', list.length === books.length - 1 && !list.includes(nameOf(B1))]);
    t.push(['…in two groups', JSON.stringify(await subs(page)) === JSON.stringify(['Hidden here', 'Not carried in this region yet'])]);
    await page.screenshot({ path: shot('1-list') });

    // Pre-order a title Poland does not carry.
    await page.click(`#modal [data-act="hbpre"][data-id="${B2}"]`); await page.waitForTimeout(400);
    t.push(['it opens the pre-order dialog for that title', await page.evaluate(n => /Pre-order/i.test(document.querySelector('#modal').textContent) &&
      document.querySelector('#modal').textContent.includes(n), nameOf(B2))]);
    await page.fill('#cname', 'Radha'); await page.fill('#pamt', '30');
    await page.click('#modal .m-foot .btn-primary'); await page.waitForTimeout(1500);
    t.push(['the pre-order is saved', m.call({ action: 'getState', season: SA }).state.sales.some(x => x.bookId === B2 && x.type === 'PREORDER' && x.location === 'ev_fest')]);
    t.push(['…and Poland now carries that title (server)', carried().includes(B2)]);
    t.push(['…it is on this event\'s shelf', (await shelf(page)).includes(B2)]);
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(300);
    t.push(['…and on the region\'s', (await shelf(page)).includes(B2)]);
    t.push(['…and in its Distribution by Title', await page.evaluate(n => document.querySelector('#titleList').textContent.includes(n), nameOf(B2))]);
    await page.close();

    /* ---- A sales link can do it too ---- */
    const B3 = books[3].id;
    page = await open('?k=' + sellKey);
    await page.click('[data-act="hiddenpre"]'); await page.waitForTimeout(300);
    t.push(['sales link: the list offers the whole catalogue too', (await choices(page)).includes(nameOf(B3))]);
    await page.click(`#modal [data-act="hbpre"][data-id="${B3}"]`); await page.waitForTimeout(400);
    await page.fill('#cname', 'Govinda'); await page.fill('#pamt', '30');
    await page.click('#modal .m-foot .btn-primary'); await page.waitForTimeout(1500);
    t.push(['sales link: pre-order saved, and the title switched on for Poland', carried().includes(B3) &&
      m.call({ action: 'getState', season: SA }).state.sales.some(x => x.bookId === B3 && x.type === 'PREORDER')]);
    await page.close();

    /* ---- Still quick with a long sales log ---- */
    for (let i = 0; i < 1500; i++) c({ action: 'sell', saleId: 'pz' + i, location: 'ev_fest', bookId: B1, isPreorder: true,
      name: 'P' + i, legs: [{ type: 'Cash', cur: 'PLN', amt: 10 }] });
    page = await open('');
    await page.evaluate(() => goTo('event', 'ev_fest')); await page.waitForTimeout(500);
    /* Working out a region's titles now looks at its pre-orders; done once per
       state, it must stay cheap however long the log (the redraw as a whole
       was already slow with this many — the same before b218). */
    const ms = await page.evaluate(() => { const a = performance.now(); for (let i = 0; i < 200; i++) curBooks(); return performance.now() - a; });
    console.log('   200 × the region\'s titles with 1,500 pre-orders: ' + ms.toFixed(1) + ' ms');
    t.push(['the region\'s titles stay quick with 1,500 pre-orders', ms < 100]);
    t.push(['…and the 1,500th pre-order\'s title still counts as carried', await page.evaluate(b => curBooks().some(x => x.id === b), B1)]);
    await page.close();
  } catch (e) {
    console.log('STOPPED:', e.message.split('\n').slice(0, 14).join('\n'));
    t.push(['test ran to the end', false]);
    try { await page.screenshot({ path: shot('stopped') }); } catch (e2) {}
  }
  t.push(['no errors in the page', errors.length === 0]);
  if (errors.length) console.log('page errors:', errors);
  t.forEach(([n, okk]) => console.log((okk ? 'PASS' : 'FAIL'), n));
  console.log('screenshots:', shot('*'));
  await browser.close();
  if (t.some(x => !x[1])) process.exitCode = 1;
})();
