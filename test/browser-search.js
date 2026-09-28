/* Optional, needs Playwright + Chromium: node test/browser-search.js
   b215: "Seasonal HQ" heads the region picker (in place of the ⌂ button), and
   one search box finds any place — in any season — or any action, limited to
   what the person using the page may do. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-search-' + n + '.png');

m.init();
const ok = (r, what) => { if (!r.ok) throw new Error(what + ': ' + r.error); return r; };
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason;
const pl = st.regions[0];
const c = (p, w) => ok(m.call(Object.assign({ season: SA }, p)), w || p.action);
c({ action: 'createEvent', eventId: 'ev_fest', name: 'Festival', regionId: pl.regionId });
c({ action: 'createRegion', regionId: 'rg_it', whLoc: 'wh_it', name: 'Italy', currencies: 'EUR,USD' });
c({ action: 'createEvent', eventId: 'ev_yoga', name: 'Yoga Studio', regionId: 'rg_it' });
c({ action: 'createEvent', eventId: 'ev_rome', name: 'Rome Temple', regionId: 'rg_it' });
ok(m.call({ action: 'saveSeason', name: 'Year-Round Sales' }), 'season 2');
st = m.call({ action: 'getState' }).state;
const SB = st.seasons.find(s => s.name === 'Year-Round Sales').seasonId;
ok(m.call({ action: 'createRegion', regionId: 'rg_kr', whLoc: 'wh_kr', name: 'Krakow', currencies: 'PLN,USD', season: SB }), 'krakow');
ok(m.call({ action: 'createEvent', eventId: 'ev_fair', name: 'Book Fair', regionId: 'rg_kr', season: SB }), 'fair');
m.call({ action: 'setSeason', seasonId: SA });
const coordKey = ok(m.call({ action: 'setKey', kind: 'region', id: 'rg_it' }), 'coord key').result;
const sellKey = ok(m.call({ action: 'setKey', kind: 'event', id: 'ev_yoga' }), 'sales key').result;

(async () => {
  const browser = await chromium.launch();
  const t = [], errors = [];
  async function open(query, width) {
    const page = await browser.newPage({ viewport: { width: width || 1100, height: 900 }, hasTouch: !!width && width < 600 });
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
  const where = page => page.evaluate(() => ({ season: STATE.activeSeason, level: CUR_LEVEL, loc: CUR_LOC, region: CUR_REGION }));
  const search = async (page, text) => {
    await page.click('#gsIn'); await page.fill('#gsIn', text); await page.waitForTimeout(150);
    return page.evaluate(() => [...document.querySelectorAll('#gsList .gs-row')].map(r => r.querySelector('.gs-name').textContent.trim()));
  };
  const heads = page => page.evaluate(() => [...document.querySelectorAll('#gsList .gs-head')].map(h => h.textContent.trim()));
  const modalOpen = page => page.evaluate(() => { const m = document.querySelector('#modal'); return !!m && !!m.innerHTML.trim() && getComputedStyle(document.querySelector('#modalBg') || m).display !== 'none'; });

  let page;
  try {
    /* ---- 1. Seasonal HQ in the region picker ---- */
    page = await open('');
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(300);
    const opts = await page.$$eval('select[data-act="pickregion"] option', o => o.map(x => [x.value, x.textContent.trim()]));
    t.push(['region picker: "Seasonal HQ" is the first choice', opts[0] && opts[0][1] === 'Seasonal HQ']);
    t.push(['…the ⌂ button is gone', !(await page.$('button[data-act="goseason"]:has-text("⌂")'))]);
    await page.selectOption('select[data-act="pickregion"]', opts[0][0]); await page.waitForTimeout(300);
    t.push(['choosing Seasonal HQ opens the season overview', (await where(page)).level === 'season']);
    t.push(['…and the picker then reads "Seasonal HQ"', await page.$eval('select[data-act="pickregion"]',
      s => s.options[s.selectedIndex].textContent.trim() === 'Seasonal HQ')]);
    t.push(['no "Choose a region…" left', !opts.some(o => /Choose a region/.test(o[1]))]);
    await page.selectOption('select[data-act="pickregion"]', 'rg_it'); await page.waitForTimeout(300);
    t.push(['a region is still chosen the same way', (await where(page)).region === 'rg_it']);
    await page.screenshot({ path: shot('nav') });

    /* ---- 2. Search, as an admin ---- */
    t.push(['admin: the search box shows', await page.isVisible('#gsIn')]);
    let r = await search(page, 'Yoga studio in Italy');
    t.push(['"Yoga studio in Italy" → Yoga Studio first', r[0] === 'Yoga Studio']);
    await page.screenshot({ path: shot('yoga') });
    await page.keyboard.press('Enter'); await page.waitForTimeout(400);
    let w = await where(page);
    t.push(['…Enter opens that event', w.level === 'event' && w.loc === 'ev_yoga']);
    t.push(['…and the box empties and shuts', (await page.inputValue('#gsIn')) === '' && !(await page.isVisible('#gsList'))]);

    r = await search(page, 'yog ita');
    t.push(['beginnings of words are enough ("yog ita")', r[0] === 'Yoga Studio']);

    r = await search(page, 'transfer stock');
    t.push(['"transfer stock" → Transfer Existing Stock, under Actions', /Transfer Existing Stock/.test(r[0] || '') && (await heads(page))[0] === 'Actions']);
    await page.click('#gsList .gs-row >> nth=0'); await page.waitForTimeout(500);
    t.push(['…clicking it opens the Transfer dialog', await page.evaluate(() => /Transfer/i.test(document.querySelector('#modal').textContent || ''))]);
    await page.evaluate(() => closeModal()); await page.waitForTimeout(200);

    r = await search(page, 'expenses');
    t.push(['another word for a button ("expenses") finds Record Costs', r.some(x => /Record Costs/.test(x))]);
    await page.keyboard.press('Escape'); await page.waitForTimeout(100);
    t.push(['Escape shuts the list', !(await page.isVisible('#gsList'))]);

    r = await search(page, 'zzqx');
    t.push(['nothing matching says so', await page.evaluate(() => /Nothing matches/.test(document.querySelector('#gsList').textContent))]);

    // Another season's event: that season opens, then the event.
    r = await search(page, 'book fair');
    t.push(['another season\'s event is found ("book fair")', r[0] === 'Book Fair']);
    t.push(['…labelled with its region and season', await page.evaluate(() => /Krakow · Year-Round Sales/.test(document.querySelector('#gsList .gs-row .gs-tag').textContent))]);
    await page.click('#gsList .gs-row >> nth=0'); await page.waitForTimeout(1500);
    w = await where(page);
    t.push(['…choosing it opens that season at that event', w.season === SB && w.level === 'event' && w.loc === 'ev_fair']);

    // A season by name → its overview; Earthly HQ.
    r = await search(page, 'europe');
    const firstSeason = await page.evaluate(() => document.querySelector('#gsList .gs-row .gs-tag').textContent);
    t.push(['a season is found by name, as its Seasonal HQ', /Seasonal HQ/.test(firstSeason)]);
    await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
    w = await where(page);
    t.push(['…and opens at its overview', w.season === SA && w.level === 'season']);
    r = await search(page, 'earthly');
    t.push(['Earthly HQ is found', r[0] === 'Earthly HQ']);
    await page.keyboard.press('Escape');

    // "/" jumps to the box.
    await page.click('h1'); await page.keyboard.press('/'); await page.waitForTimeout(100);
    t.push(['"/" puts you in the search box', await page.evaluate(() => document.activeElement && document.activeElement.id === 'gsIn')]);
    await page.close();

    /* ---- 3. A regional link: only its own region, only its own buttons ---- */
    page = await open('?k=' + coordKey);
    t.push(['regional link: the search box shows', await page.isVisible('#gsIn')]);
    r = await search(page, 'yoga');
    t.push(['…finds its own event', r[0] === 'Yoga Studio']);
    r = await search(page, 'festival');
    t.push(['…not another region\'s event', !r.includes('Festival')]);
    r = await search(page, 'book fair');
    t.push(['…nor another season\'s', !r.includes('Book Fair')]);
    r = await search(page, 'transfer');
    t.push(['…finds Transfer Existing Stock (it may do that)', r.some(x => /Transfer Existing Stock/.test(x))]);
    r = await search(page, 'cash');
    t.push(['…but not Track Cash (admin only)', !r.some(x => /Track Cash/.test(x))]);
    r = await search(page, 'admins');
    t.push(['…nor Admins', !r.some(x => /Admins/.test(x))]);
    r = await search(page, 'europe');
    t.push(['…nor any Seasonal HQ or Earthly HQ', !(await page.evaluate(() => [...document.querySelectorAll('#gsList .gs-tag')].some(x => /Seasonal HQ|Every season/.test(x.textContent))))]);
    r = await search(page, 'rome');
    await page.keyboard.press('Enter'); await page.waitForTimeout(500);
    t.push(['…and goes to its own event', (await where(page)).loc === 'ev_rome']);
    await page.close();

    /* ---- 4. A sales link: no search ---- */
    page = await open('?k=' + sellKey);
    t.push(['sales link: no search box', !(await page.isVisible('#gsIn'))]);
    await page.close();

    /* ---- 5. Phone width ---- */
    page = await open('', 390);
    await page.evaluate(r => goTo('region', r), 'rg_it'); await page.waitForTimeout(300);
    r = await search(page, 'Yoga studio in Italy');
    await page.screenshot({ path: shot('phone') });
    const fits = await page.evaluate(() => {
      const a = document.querySelector('#gsIn').getBoundingClientRect(), b = document.querySelector('#gsList').getBoundingClientRect();
      return a.left >= 0 && a.right <= innerWidth && b.left >= 0 && b.right <= innerWidth + 0.5 &&
        document.documentElement.scrollWidth <= innerWidth;
    });
    t.push(['phone (390px): the box and its results fit the screen', fits]);
    await page.tap('#gsList .gs-row >> nth=0'); await page.waitForTimeout(400);
    t.push(['phone: tapping a result goes there', (await where(page)).loc === 'ev_yoga']);
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
