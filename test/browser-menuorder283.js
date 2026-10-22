/* Optional, needs Playwright + Chromium: node test/browser-menuorder283.js
   b283: App Development › Reorganize Menu (b292: by dragging). Sections and items move,
   an item moves to another section, the menu follows after a refresh, and
   "Back to the original order" undoes it; no overflow on a phone. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){ return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
m.init();
const st = m.call({ action: 'getState' }).state;
const R0 = st.regions[0], BK = st.books.map(b => b.id);
m.call({ season: st.activeSeason, action: 'adjustStockBulk', location: R0.whLoc, items: BK.slice(0, 3).map(b => ({ bookId: b, delta: 5 })), override: true });
m.call({ season: st.activeSeason, action: 'sell', location: R0.whLoc, bookId: BK[0], legs: [{ type: 'Cash', cur: R0.currencies[0], amt: 10 }], override: true });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.includes('script.google.com')) {
      let p = {}; try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(m.call(p)) });
    }
    if (url.startsWith('http://app.test/')) {
      const rel = new URL(url).pathname.replace(/^\/+/, '') || 'index.html';
      // The left-hand menu, not the old App Admin panel.
      if (rel === 'config.js') return route.fulfill({ status: 200, contentType: 'text/javascript',
        body: fs.readFileSync(path.join(__dirname, 'config.test.js'), 'utf8').replace('CLASSIC_ADMIN: true', 'CLASSIC_ADMIN: false') });
      const f = path.join(ROOT, rel);
      if (fs.existsSync(f) && fs.statSync(f).isFile())
        return route.fulfill({ status: 200, body: fs.readFileSync(f),
          contentType: f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : undefined });
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto('http://app.test/index.html');
  await page.waitForTimeout(2500);
  const t = [];
  const secs = () => page.evaluate(() => [...document.querySelectorAll('#sideNav .sn-group')].map(g => g.dataset.sec));
  const itemsOf = k => page.evaluate(k => [...document.querySelectorAll('#sideNav .sn-group[data-sec="' + k + '"] .sn-item')].map(x => x.dataset.act), k);
  t.push(['App Development has Reorganize Menu', (await itemsOf('dev')).includes('menuorder')]);
  const s0 = await secs();
  await page.evaluate(() => document.querySelector('#sideNav .sn-item[data-act="menuorder"]').click()); await page.waitForTimeout(300);
  t.push(['it opens the Reorganize Menu window', await page.isVisible('#moList')]);
  // b292: every item is listed, the place's own actions too.
  const listed = await page.evaluate(() => [...document.querySelectorAll('#moList .mo-row')].map(r => r.dataset.a));
  t.push(['b292: the window lists every item, including the place\'s own (Change Event Order, Close / Reopen)', listed.includes('reorderevent') && listed.includes('closeplace') && listed.includes('editplace') && !listed.includes('fintodo')]);
  t.push(['b292: no ▲ ▼ or section drop-downs: it is all dragging', !(await page.$('#moList [data-mo]')) && !(await page.$('#moList select'))]);
  // Real drags with the mouse: a point inside an element, then move in steps and let go.
  const box = (sel) => page.evaluate(sel => { const r = (typeof sel === 'string' ? document.querySelector(sel) : null).getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2, top: r.top, bottom: r.bottom }; }, sel);
  const drag = async (from, to, after) => {
    await page.evaluate(sel => document.querySelector(sel).scrollIntoView({ block: 'center' }), from);
    const a = await box(from); await page.mouse.move(a.x, a.y); await page.mouse.down();
    const b = await box(to); const ty = after ? b.bottom - 3 : b.top + 3;
    for (let i = 1; i <= 12; i++) await page.mouse.move(a.x, a.y + (ty - a.y) * i / 12);
    await page.waitForTimeout(80);
    t.push(['b292: while dragging, a gap shows where it will land', !!(await page.$('#moList .mo-gap'))]);
    await page.mouse.up(); await page.waitForTimeout(150);
  };
  await page.evaluate(() => { const S = [...document.querySelectorAll('#moList .mo-sec')]; S[0].id = 'moS0'; S[1].id = 'moS1'; S[0].querySelector('.mo-sh').id = 'moS0h'; S[1].querySelector('.mo-sh').id = 'moS1h'; });
  await drag('#moS1h', '#moS0h', false);   // second section above the first
  t.push(['b292: dragging the second section\'s heading above the first swaps them', await page.evaluate(() => document.querySelector('#moList .mo-sec').id === 'moS1') && !(await page.$('#moList .mo-gap'))]);
  await page.evaluate(() => { const rows = [...document.querySelectorAll('#moList .mo-sec[data-sec="dev"] .mo-row')]; rows[0].id = 'moD0'; rows[1].id = 'moD1'; });
  await drag('#moD1', '#moD0', false);    // Reorganize Menu above Edit Wording
  await page.evaluate(() => { [...document.querySelectorAll('#moList .mo-row')].find(x => x.dataset.a === 'cash').id = 'moCash'; document.querySelector('#moList .mo-sec[data-sec="books"] .mo-row').id = 'moB0'; });
  await drag('#moCash', '#moB0', true);   // Track Cash into Books
  t.push(['b292: a dragged item lands in the other section, in place', await page.evaluate(() => [...document.querySelectorAll('#moList .mo-sec[data-sec="books"] .mo-row')].map(r => r.dataset.a)[1] === 'cash')]);
  for (const w of [390, 1100]) {
    await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(300);
    const over = await page.evaluate(() => { const m = document.querySelector('#modal'); return [...m.querySelectorAll('*')].filter(e => e.offsetParent && e.getBoundingClientRect().right > m.getBoundingClientRect().right + 1).map(e => e.className || e.tagName).slice(0, 3); });
    t.push(['no overflow in the window at ' + w + 'px' + (over.length ? ' — ' + over.join(' | ') : ''), !over.length]);
  }
  await page.click('#moSave'); await page.waitForTimeout(1200);
  const s1 = await secs();
  t.push(['the second section is now first (' + s1.slice(0, 3).join(', ') + ')', s1[0] === s0[1] && s1[1] === s0[0]]);
  t.push(['Edit Wording and Reorganize Menu swapped', (await itemsOf('dev')).slice(0, 2).join(',') === 'menuorder,editwording']);
  t.push(['Track Cash moved into Books', (await itemsOf('books')).includes('cash') && !(await itemsOf('money')).includes('cash')]);
  await page.reload(); await page.waitForTimeout(3000);
  t.push(['…and it stays after a refresh', (await secs())[0] === s0[1] && (await itemsOf('books')).includes('cash')]);
  await page.evaluate(() => { window.confirm = () => true; menuOrderModal(); }); await page.waitForTimeout(300);
  await page.click('#moReset'); await page.waitForTimeout(1200);
  t.push(['"Back to the original order" puts it back', JSON.stringify(await secs()) === JSON.stringify(s0) && (await itemsOf('money')).includes('cash')]);
  t.push(['no errors in the page' + (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''), !errors.length]);
  await browser.close();
  let bad = 0;
  t.forEach(([n, ok]) => { if (!ok) bad++; console.log((ok ? '  ok   ' : '  FAIL ') + n); });
  console.log(bad ? `\n${bad} failed` : `\nall ${t.length} passed`);
  process.exit(bad ? 1 : 0);
})();
