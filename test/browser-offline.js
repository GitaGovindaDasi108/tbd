/* Optional, needs Playwright + Chromium: node test/browser-offline.js
   b241: nothing entered without a signal is ever lost.

   Stock is added while the server cannot be reached (Wi-Fi with no internet
   behind it), the page is refreshed with no connection at all, and then the
   signal returns. The page is served from localhost so its service worker
   runs, as it does on the real site; every server request is answered by the
   fake server (mini.js) running the real Code.gs. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), http = require('http');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');

m.init();
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason;
const books = st.books.filter(b => !b.partnerId);
const WH = st.regions[0].whLoc;
const qty = (loc, bookId) => { const r = (m.call({ action: 'getState', season: SA }).state.inventory || [])
  .find(i => i.location === loc && i.bookId === bookId); return r ? Number(r.qty) : 0; };

// The site, as GitHub Pages serves it — with the tests' own config.js.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const f = rel === 'config.js' ? path.join(__dirname, 'config.test.js') : path.join(ROOT, rel);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(fs.readFileSync(f));
});

(async () => {
  await new Promise(r => server.listen(0, 'localhost', r));
  const BASEURL = 'http://localhost:' + server.address().port + '/';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 1100, height: 900 } });
  const t = [], errors = [];
  let serverDown = false;
  await ctx.route('**/*', async route => {
    const url = route.request().url();
    if (url.includes('script.google.com')) {
      if (serverDown) return route.abort('internetdisconnected');
      let p = {}; try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(m.call(p)) });
    }
    if (url.startsWith(BASEURL)) return route.continue();
    return route.fulfill({ status: 204, body: '' });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  const shown = (loc, id) => page.evaluate(([l, b]) => { const r = (STATE.inventory || []).find(i => i.location === l && i.bookId === b); return r ? r.qty : 0; }, [loc, id]);
  const badge = () => page.evaluate(() => { const b = document.getElementById('pendBadge'); return b && b.style.display !== 'none' ? b.textContent : ''; });
  const addStock = (bookId, delta) => page.evaluate(([loc, b, d, season]) => {
    const movePrefix = 'M' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    commit({ action: 'adjustStockBulk', location: loc, items: [{ bookId: b, delta: d }], note: 'offline test', override: true, movePrefix, season },
      st => invAdd(st, loc, b, d), null);
  }, [WH, bookId, delta, SA]);

  try {
    await page.goto(BASEURL + 'index.html');
    await page.waitForTimeout(2500);
    await page.evaluate(() => navigator.serviceWorker.ready); await page.waitForTimeout(500);
    t.push(['the page is kept on the device (service worker running)', await page.evaluate(() => !!navigator.serviceWorker.controller) ||
      (await page.reload(), await page.waitForTimeout(2000), await page.evaluate(() => !!navigator.serviceWorker.controller))]);
    const a = books[0].id, b = books[1].id;
    const startA = qty(WH, a), startB = qty(WH, b);

    // Wi-Fi with no internet behind it: the server cannot be reached.
    serverDown = true;
    await addStock(a, 5); await page.waitForTimeout(1500);
    await addStock(b, 3); await page.waitForTimeout(1500);
    t.push(['offline: the new stock shows on screen at once', await shown(WH, a) === startA + 5 && await shown(WH, b) === startB + 3]);
    t.push(['…the server has none of it yet', qty(WH, a) === startA && qty(WH, b) === startB]);
    // Many failed tries used to throw a change away ("please redo it").
    for (let i = 0; i < 10; i++) { await page.evaluate(() => flushPending()); await page.waitForTimeout(150); }
    t.push(['ten failed sends later, both changes are still kept', await page.evaluate(() => PENDING.length) === 2]);
    t.push(['the corner notice says 2 changes are kept on this device', /2 changes kept on this device/.test(await badge())]);

    // No connection at all, and a refresh.
    await ctx.setOffline(true);
    await page.reload(); await page.waitForTimeout(2500);
    t.push(['refreshed with no internet, the app still opens', await page.evaluate(() => typeof STATE !== 'undefined' && !!STATE)]);
    t.push(['…and still shows the stock entered offline', await shown(WH, a) === startA + 5 && await shown(WH, b) === startB + 3]);
    t.push(['…with the notice still saying they are waiting', /2 changes kept on this device/.test(await badge())]);
    await page.screenshot({ path: path.join(require('os').tmpdir(), 'tbs-offline-1-refreshed.png') });

    // The signal returns.
    await ctx.setOffline(false); serverDown = false;
    await page.evaluate(() => { window.dispatchEvent(new Event('online')); });
    await page.waitForTimeout(3500);
    await page.evaluate(() => pull()); await page.waitForTimeout(800);
    t.push(['back online: the server has both, exactly once', qty(WH, a) === startA + 5 && qty(WH, b) === startB + 3]);
    t.push(['…the screen agrees, with nothing counted twice', await shown(WH, a) === startA + 5 && await shown(WH, b) === startB + 3]);
    t.push(['…the queue is empty and the notice gone', await page.evaluate(() => PENDING.length) === 0 && !(await badge())]);
    t.push(['…and nothing is left to redraw on the next opening', await page.evaluate(() => Object.keys(fxAll()).length) === 0]);
    await page.reload(); await page.waitForTimeout(2500);
    t.push(['a later refresh shows the same, once', await shown(WH, a) === startA + 5 && await shown(WH, b) === startB + 3]);

    // A change the server refuses is not drawn for ever.
    await page.evaluate(([loc, bk]) => {
      PENDING.push({ payload: { action: 'noSuchAction', location: loc, items: [{ bookId: bk, delta: 1 }], opId: 'bad1' }, at: Date.now(), held: true });
      pendingSave();
    }, [WH, a]);
    await page.evaluate(() => flushPending()); await page.waitForTimeout(1200);
    t.push(['a refused change leaves the queue…', await page.evaluate(() => !PENDING.some(x => x.payload.opId === 'bad1'))]);
    t.push(['…but is kept on the device, not deleted', await page.evaluate(() => notSavedLoad().some(x => x.payload.opId === 'bad1'))]);
    t.push(['…and the corner notice says so', /1 change not saved/.test(await badge())]);
    await page.click('#pendBadge'); await page.waitForTimeout(300);
    t.push(['tapping it lists the change, with Try again and Remove', await page.evaluate(() =>
      !!document.querySelector('#modal [data-ns-retry]') && !!document.querySelector('#modal [data-ns-drop]'))]);
    await page.click('#modal [data-ns-drop]'); await page.waitForTimeout(400);
    t.push(['Remove (after a yes) lets it go, and the notice clears', await page.evaluate(() => notSavedLoad().length) === 0 && !(await badge())]);
    // A busy server is not a refusal: the change stays queued.
    const busy = await page.evaluate(() => isBusy(new Error('The system was busy with another save. Please try again in a moment.')));
    t.push(['"busy, try again in a moment" counts as wait, not as no', busy]);
  } catch (e) { t.push(['ran to the end: ' + e.message, false]); }
  t.push(['no page errors', !errors.length]);
  if (errors.length) console.log(errors);
  await browser.close(); server.close();
  let bad = 0;
  t.forEach(([n, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; });
  console.log(bad ? bad + ' FAILED' : 'all ' + t.length + ' passed');
  process.exit(bad ? 1 : 0);
})();
