/* Optional, needs Playwright + Chromium: node test/browser-wording276.js
   b276: hiding wording really hides it (the Locations toggles, whole menu rows); hidden
   wording can be brought back; the grey words in boxes take a pencil. */
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
  const settle = () => page.waitForTimeout(500);
  const setEdit = on => page.evaluate(on => { EDIT_WORDING = on; lblBodyClass(); renderAll(); applyLabels(); }, on);
  // Saved the way the app saves it, so a refresh from the server keeps it.
  const saveLabel = async (key, text) => { await page.evaluate(([k, x]) => { labelSave(k, x === null ? '' : x, '\u0001'); }, [key, text]); await page.waitForTimeout(600);
    await page.evaluate(() => { renderAll(); applyLabels(); }); };

  await page.evaluate(r => goTo('region', r), R0.regionId); await settle();

  // 2. Hiding "Locations" keeps it hidden after the page redraws.
  await setEdit(true);
  const locKey = await page.evaluate(() => { const b = [...document.querySelectorAll('.wo-toggle')].find(x => x.offsetParent); return b ? b.getAttribute('data-key') : ''; });
  t.push(['the Locations toggle is keyed as wording, not by its card', /› Locations$/.test(locKey)]);
  await setEdit(false);
  await saveLabel(locKey, '\u0000hide');
  await page.evaluate(() => renderAll()); await settle();
  t.push(['hidden "Locations" stays hidden after a redraw', await page.evaluate(k => { const b = [...document.querySelectorAll('.wo-toggle')].filter(x => x.getAttribute('data-key') === k); return b.length > 0 && b.every(x => !x.offsetParent); }, locKey)]);
  await saveLabel(locKey, null); await settle();
  t.push(['…and the Locations toggles still open their places when shown', await page.evaluate(() => {
    const b = [...document.querySelectorAll('.wo-toggle')].find(x => x.offsetParent); if (!b) return false;
    b.click(); return b.getAttribute('aria-expanded') === 'true' || WO_OPEN.size > 0; })]);

  // 3. Hidden words show faded while editing, and ✓ brings them back.
  await setEdit(true);
  const h = await page.evaluate(() => { const el = [...document.querySelectorAll('main .hint[data-key], main .muted-note[data-key]')].find(e => e.offsetParent); return el ? { key: el.getAttribute('data-key') } : null; });
  await saveLabel(h.key, '\u0000hide'); await settle();
  t.push(['while editing, hidden words stay on screen, faded', await page.evaluate(k => { const el = document.querySelector('[data-key="' + CSS.escape(k) + '"]'); return !!el && !!el.offsetParent && el.classList.contains('lbl-hidden'); }, h.key)]);
  await page.evaluate(k => labelInline(k), h.key); await page.waitForTimeout(200);
  t.push(['…the box says ✓ brings them back', await page.evaluate(() => /brings it back/.test(document.querySelector('.lbl-in').textContent))]);
  await page.click('.lbl-in [data-li="ok"]'); await page.waitForTimeout(800);
  t.push(['…and ✓ brings them back', await page.evaluate(k => !(STATE.labels || {})[k] && !(STATE.labels || {})[normLabelKey(k)], h.key)]);
  await setEdit(false);
  t.push(['…shown again once editing is off', await page.evaluate(k => { const el = document.querySelector('[data-key="' + CSS.escape(k) + '"]'); return !!el && !!el.offsetParent && !el.classList.contains('lbl-hidden'); }, h.key)]);

  // 4. A menu row whose words are hidden goes altogether, icon and all.
  await setEdit(true);
  const snKey = await page.evaluate(() => { const s = document.querySelector('#sideNav .sn-item[data-act="cash"] .sn-t'); return s ? s.getAttribute('data-key') : ''; });
  t.push(['menu rows take a pencil', !!snKey && await page.evaluate(() => !!document.querySelector('#sideNav .sn-item[data-act="cash"] .sn-t > .pencil'))]);
  await setEdit(false);
  await saveLabel(snKey, '\u0000hide'); await settle();
  t.push(['hiding a menu row\'s words hides the whole row', await page.evaluate(() => getComputedStyle(document.querySelector('#sideNav .sn-item[data-act="cash"]')).display === 'none')]);
  await saveLabel(snKey, null); await settle();
  t.push(['…and it comes back', await page.evaluate(() => getComputedStyle(document.querySelector('#sideNav .sn-item[data-act="cash"]')).display !== 'none')]);

  // 5. The grey words in a box to type in take a pencil, and can be rewritten.
  await setEdit(true);
  const ph = await page.evaluate(() => { const i = document.querySelector('#sideNav input[placeholder], input[placeholder][data-key]');
    return i ? { key: i.getAttribute('data-key'), pen: !!(i.nextElementSibling && i.nextElementSibling.classList.contains('ph-pencil')) } : null; });
  t.push(['a box\'s grey words take a pencil', !!ph && !!ph.key && ph.pen]);
  await saveLabel(ph.key, 'Find anything'); await settle();
  t.push(['…rewriting them changes the grey words', await page.evaluate(k => document.querySelector('input[data-key="' + CSS.escape(k) + '"]').placeholder === 'Find anything', ph.key)]);
  await setEdit(false);
  t.push(['…and the pencil goes when editing is off', await page.evaluate(() => !document.querySelector('.ph-pencil'))]);
  await saveLabel(ph.key, '\u0000hide'); await settle();
  t.push(['…hiding them empties the box\'s grey words', await page.evaluate(k => document.querySelector('input[data-key="' + CSS.escape(k) + '"]').placeholder === '', ph.key)]);
  await saveLabel(ph.key, null);

  // No sideways scroll while editing, on a phone or a computer.
  await setEdit(true);
  for (const w of [390, 1100]) { await page.setViewportSize({ width: w, height: 844 }); await settle();
    t.push([`${w}px, editing wording: no sideways scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)]); }

  t.push(['no page errors', errors.length === 0]);
  if (errors.length) console.log(errors.slice(0, 5));
  let bad = 0;
  t.forEach(([n, ok]) => { if (!ok) bad++; console.log((ok ? '  ok   ' : '  FAIL ') + n); });
  console.log(bad ? `\n${bad} failed` : `\nall ${t.length} passed`);
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('STOPPED', e); process.exit(1); });
