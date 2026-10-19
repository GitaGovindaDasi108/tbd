/* Optional, needs Playwright + Chromium: node test/browser-drag.js
   b241: drag to reorder, by mouse and by finger, in Edit Book Display and in
   Change the region order. It used to stack a second (third, ...) drag handler
   every time the list redrew, so after one arrow press or one drag the next
   drag left stray gaps or put the row in the wrong place; a finger on a row
   could not scroll the list; and a long list did not scroll while dragging. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-drag-' + n + '.png');

m.init();
const SA = m.call({ action: 'getState' }).state.activeSeason;
m.call({ action: 'createRegion', regionId: 'rg_it', whLoc: 'wh_it', name: 'Italy', currencies: 'EUR,USD', season: SA });
m.call({ action: 'createRegion', regionId: 'rg_es', whLoc: 'wh_es', name: 'Spain', currencies: 'EUR,USD', season: SA });

async function serve(page){
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
}

const order = (page, list) => page.$$eval(list + ' .ro-row', r => r.map(x => x.dataset.id));
const centre = async (page, sel) => { const b = await (await page.$(sel)).boundingBox(); return { x: b.x + b.width/2, y: b.y + b.height/2 }; };
const tidy = (page, list) => page.evaluate(l => !document.querySelector(l + ' .ro-gap') &&
  ![...document.querySelectorAll(l + ' .ro-row')].some(r => r.classList.contains('ro-lift') || r.style.transform || r.style.position), list);

// A finger, through the DevTools protocol (Playwright has no touch drag).
async function fingerDrag(cdp, from, to, steps = 12, holdMs = 0){
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i++)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x, y: from.y + (to.y - from.y) * i / steps }] });
  const end = Date.now() + holdMs;
  while (Date.now() < end){
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: to.x, y: to.y + (Date.now() % 2) }] });
    await new Promise(r => setTimeout(r, 40));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

(async () => {
  const browser = await chromium.launch();
  const t = [], errors = [];
  try {
    /* ---- Desktop, mouse ---- */
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
    await serve(page);
    await page.goto('http://app.test/index.html'); await page.waitForTimeout(2000);
    await page.click('#adminActions [data-act="bookdisplay"]'); await page.waitForTimeout(300);
    const L = '#bdList';
    let o = await order(page, L);
    t.push(['Edit Book Display has a few titles to drag', o.length >= 4]);
    // An arrow press redraws the list: the next drags must still behave.
    await page.click(`${L} [data-bd-dn="0"]`);
    o = await order(page, L);
    for (let round = 0; round < 3; round++){
      const n = o.length;
      const from = await centre(page, `${L} .ro-row:nth-child(${n}) .ro-grip`);
      const to = await centre(page, `${L} .ro-row:nth-child(1)`);
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      await page.mouse.move(from.x, to.y - 8, { steps: 15 });
      await page.mouse.up(); await page.waitForTimeout(100);
      const now = await order(page, L);
      t.push([`mouse drag ${round + 1}: last title lands on top, the rest keep their order`,
        JSON.stringify(now) === JSON.stringify([o[n - 1], ...o.slice(0, n - 1)])]);
      t.push([`mouse drag ${round + 1}: no stray gap or lifted row left behind`, await tidy(page, L)]);
      o = now;
    }
    // Mid-drag: one gap, and no blank left where the row was.
    {
      const before = await page.$eval(L, c => c.offsetHeight);
      const from = await centre(page, `${L} .ro-row:nth-child(2) .ro-grip`);
      const to = await centre(page, `${L} .ro-row:nth-child(5)`);
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      await page.mouse.move(from.x, to.y, { steps: 10 });
      t.push(['mid-drag: exactly one gap shows where the title will land', await page.$$eval(`${L} .ro-gap`, g => g.length) === 1]);
      t.push(['mid-drag: no extra blank space (the list is the same height as before)', Math.abs(await page.$eval(L, c => c.offsetHeight) - before) <= 2]);
      await page.screenshot({ path: shot('middrag') });
      await page.mouse.up(); await page.waitForTimeout(100);
      o = await order(page, L);
    }
    // Grab the row itself, not the handle (mouse only).
    {
      const from = await centre(page, `${L} .ro-row:nth-child(1) .ro-name`);
      const to = await centre(page, `${L} .ro-row:nth-child(3)`);
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      await page.mouse.move(from.x, to.y + 8, { steps: 15 });
      await page.mouse.up(); await page.waitForTimeout(100);
      const now = await order(page, L);
      t.push(['mouse: the whole row can be grabbed, not just the handle', JSON.stringify(now) === JSON.stringify([o[1], o[2], o[0], ...o.slice(3)])]);
      o = now;
    }
    // A plain click on a row's tickbox still just ticks it.
    {
      const before = await order(page, L);
      // Season level has no tickboxes; arrows must still work after drags.
      await page.click(`${L} [data-bd-up="1"]`);
      const now = await order(page, L);
      t.push(['arrows still work after dragging', now[0] === before[1] && now[1] === before[0]]);
    }
    await page.screenshot({ path: shot('desktop') });
    await page.click('#bdSave'); await page.waitForTimeout(500);
    // Where titles can be hidden (Earthly HQ), a click on a tickbox still ticks.
    await page.click('[data-act="gohq"]'); await page.waitForTimeout(2500);
    await page.click('#adminActions [data-act="bookdisplay"]'); await page.waitForTimeout(300);
    {
      const before = await order(page, L);
      const cb = `${L} .ro-row:nth-child(2) .bd-cb`;
      const was = await page.isChecked(cb);
      await page.click(cb);
      t.push(['a click on a tickbox still ticks or unticks it', (await page.isChecked(`${L} [data-bd="${before[1]}"]`)) === !was]);
      t.push(['…and does not move anything', JSON.stringify(await order(page, L)) === JSON.stringify(before)]);
    }
    await page.click('#modal .m-foot .btn-ghost');
    await page.close();

    /* ---- Phone, finger ---- */
    const ctx = await browser.newContext({ viewport: { width: 390, height: 600 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const ph = await ctx.newPage();
    ph.on('pageerror', e => errors.push(e.message)); ph.on('dialog', d => d.accept());
    await serve(ph);
    const cdp = await ctx.newCDPSession(ph);
    await ph.goto('http://app.test/index.html'); await ph.waitForTimeout(2000);
    await ph.evaluate(() => { const b = document.querySelector('#adminActions [data-act="bookdisplay"]'); b.click(); });
    await ph.waitForTimeout(300);
    o = await order(ph, L);
    t.push(['phone: a finger on a row can scroll the list (only the handle drags)',
      await ph.$eval(`${L} .ro-row`, r => getComputedStyle(r).touchAction !== 'none')]);
    t.push(['phone: the handle is big enough to hit with a finger (at least 36px)',
      await ph.$eval(`${L} .ro-grip`, g => { const b = g.getBoundingClientRect(); return b.width >= 36 && b.height >= 36; })]);
    await ph.tap(`${L} [data-bd-dn="0"]`);
    o = await order(ph, L);
    {
      const from = await centre(ph, `${L} .ro-row:nth-child(2) .ro-grip`);
      const to = await centre(ph, `${L} .ro-row:nth-child(4)`);
      await fingerDrag(cdp, from, { x: from.x, y: to.y + 8 });
      await ph.waitForTimeout(150);
      const now = await order(ph, L);
      t.push(['phone: dragging a title down two places by its handle', JSON.stringify(now) === JSON.stringify([o[0], o[2], o[3], o[1], ...o.slice(4)])]);
      t.push(['phone: nothing left behind', await tidy(ph, L)]);
      o = now;
    }
    // A long list: drag the bottom title up to the top edge and hold; the list scrolls.
    {
      const body = '#modal .m-body';
      await ph.$eval(body, b => { b.scrollTop = b.scrollHeight; });
      await ph.waitForTimeout(100);
      const scrolls = await ph.$eval(body, b => b.scrollHeight > b.clientHeight + 40);
      if (!scrolls) t.push(['phone: the list is long enough to need scrolling (test setup)', false]);
      const n = o.length;
      const from = await centre(ph, `${L} .ro-row:nth-child(${n}) .ro-grip`);
      const top = (await (await ph.$(body)).boundingBox()).y;
      await fingerDrag(cdp, from, { x: from.x, y: top + 6 }, 12, 2500);
      await ph.waitForTimeout(150);
      const now = await order(ph, L);
      t.push(['phone: holding a dragged title at the top edge scrolls the list up to the top', now[0] === o[n - 1]]);
      t.push(['phone: nothing left behind after the long drag', await tidy(ph, L)]);
    }
    await ph.screenshot({ path: shot('phone') });
    await ph.click('#modal .m-foot .btn-ghost');

    /* ---- Change the region order: same drag ---- */
    const has = await ph.evaluate(() => typeof reorderModal === 'function' && regionsList().length >= 2);
    t.push(['region order: there are regions to arrange (test setup)', has]);
    if (has){
      await ph.evaluate(() => reorderModal('region')); await ph.waitForTimeout(300);
      const R = '#roList';
      o = await order(ph, R);
      const from = await centre(ph, `${R} .ro-row:nth-child(2) .ro-grip`);
      const to = await centre(ph, `${R} .ro-row:nth-child(1)`);
      await fingerDrag(cdp, from, { x: from.x, y: to.y - 8 });
      await ph.waitForTimeout(150);
      const now = await order(ph, R);
      t.push(['region order: second region dragged to the top', now[0] === o[1] && now[1] === o[0]]);
      t.push(['region order: nothing left behind', await tidy(ph, R)]);
    }
    await ctx.close();
  } catch (e) {
    console.log('STOPPED:', e.message.split('\n').slice(0, 14).join('\n'));
    t.push(['test ran to the end', false]);
  }
  t.push(['no errors in the page', errors.length === 0]);
  if (errors.length) console.log('page errors:', errors);
  t.forEach(([n, okk]) => console.log((okk ? 'PASS' : 'FAIL'), n));
  console.log('screenshots:', shot('*'));
  await browser.close();
  if (t.some(x => !x[1])) process.exitCode = 1;
})();
