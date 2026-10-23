/* Optional, needs Playwright + Chromium: node test/browser-b300.js
   b300 (Live app changes): one font size in the navigation drop-downs; the
   totals bar (book cards one width, the rest to the totals, all five on one
   line with Pending Payments, whole numbers, ≈, "Estimated: N"); Earthly HQ's
   Exp: and Don:; the portal button in the top bar and no Go to Sales Portal in
   the menu; and in practice WhatsApp Reports and an Uncategorized calculator
   that keeps working when a number is erased. Finance's tab names are in
   browser-finance.js. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){ return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
m.init();
const st = m.call({ action: 'getState' }).state, SA = st.activeSeason;
const c = (p, season) => { const r = m.call(Object.assign({ season: season || SA }, p)); if (!r.ok) throw new Error(p.action + ': ' + r.error); return r; };
const R0 = st.regions[0];
const B = st.books.find(b => !b.partnerId).id;
c({ action: 'createEvent', eventId: 'ev_b300', name: 'Harinam Fair', regionId: R0.regionId });
c({ action: 'adjustStockBulk', location: R0.whLoc, items: [{ bookId: B, delta: 10 }], override: true });
c({ action: 'adjustStockBulk', location: 'ev_b300', items: [{ bookId: B, delta: 5 }], override: true });
c({ action: 'sell', saleId: 'S1', location: R0.whLoc, bookId: B, legs: [{ type: 'Cash', cur: 'EUR', amt: 10.6 }], name: 'Radha' });
c({ action: 'sell', saleId: 'S2', location: 'ev_b300', bookId: B, legs: [{ type: 'Cash', cur: 'USD', amt: 20 }], name: 'Gopal' });
c({ action: 'sell', saleId: 'P2', location: R0.whLoc, bookId: B, isPreorder: true, pending: true, legs: [{ type: 'Cash', cur: 'USD', amt: 30.4 }], name: 'Govinda' });
// Estimated books: 5 Big Books estimated, 2 Adventures confirmed.
c({ action: 'uncatSale', saleId: 'U1', location: R0.whLoc, qty: 5, aqty: 2, est: true, aest: false, legs: [{ type: 'Cash', cur: 'USD', amt: 240 }] });
c({ action: 'saveCost', id: 'cost_b300', amt: 12.3, cur: 'USD', category: 'Other', location: R0.whLoc });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1150, height: 900 } });
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
      if (rel === 'config.js') return route.fulfill({ status: 200, contentType: 'text/javascript',
        body: fs.readFileSync(path.join(__dirname, 'config.test.js'), 'utf8').replace('CLASSIC_ADMIN: true', 'CLASSIC_ADMIN: false, PRACTICE_URL: "https://script.google.com/macros/s/TEST/exec"') });
      const f = path.join(ROOT, rel);
      if (fs.existsSync(f) && fs.statSync(f).isFile())
        return route.fulfill({ status: 200, body: fs.readFileSync(f),
          contentType: f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : undefined });
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto('http://app.test/index.html?practice');
  await page.waitForTimeout(2500);
  const t = [];
  const spill = () => page.evaluate(() => { const W = document.documentElement.clientWidth;
    return [...document.querySelectorAll('#locTabs *, #totals *, #modal *, header *')].filter(e => e.offsetParent && e.getBoundingClientRect().right > W + 1)
      .map(e => (e.className && e.className.baseVal === undefined ? e.className : e.tagName) + '').slice(0, 4); });
  const cards = () => page.$$eval('#totals > .tcard', cs => cs.map(c => { const r = c.getBoundingClientRect();
    return { l: c.querySelector('.label').textContent.trim(), cls: c.className, w: Math.round(r.width), top: Math.round(r.top), r: r.right, txt: c.innerText }; }));

  /* 1. One font size in the navigation drop-downs. */
  await page.evaluate(() => { document.documentElement.classList.remove('fin-boot'); goTo('season'); }); await page.waitForTimeout(400);
  t.push(['the page is not left hidden after loading', await page.evaluate(() => !document.documentElement.classList.contains('fin-boot'))]);
  const fonts = await page.evaluate(() => [...document.querySelectorAll('#locTabs select')].map(s => getComputedStyle(s).fontSize));
  t.push(['every navigation drop-down at the Events… size, 13px (' + fonts.join(', ') + ')', fonts.length > 0 && fonts.every(f => f === '13px')]);

  /* 2. The totals bar on a computer. */
  await page.evaluate(r => goTo('region', r), R0.regionId); await page.waitForTimeout(500);
  let cs = await cards();
  const books = cs.filter(x => !/usd|pend/.test(x.cls)), coll = cs.find(x => /tc-coll/.test(x.cls));
  t.push(['a Pending Payments card shows', cs.some(x => /Pending/.test(x.l))]);
  t.push(['computer: every card on one line, Pending Payments included (' + cs.map(x => x.l + ' ' + x.w).join(', ') + ')', new Set(cs.map(x => x.top)).size === 1]);
  t.push(['the book cards are all one width', books.length >= 2 && Math.max(...books.map(x => x.w)) - Math.min(...books.map(x => x.w)) <= 1]);
  t.push(['the totals card takes the rest: wider than any other', coll && cs.every(x => x === coll || x.w < coll.w)]);
  const tot = await page.$eval('#totals', e => e.innerText);
  t.push(['whole numbers only on the totals cards (no cents)', !/\d\.\d\d\b/.test(tot) && /\$\d/.test(tot)]);
  t.push(['≈ marks estimated dollars, not ~', /≈\$/.test(tot) && !/~/.test(tot)]);
  const big = books.find(x => /Big Books/i.test(x.l)), av = books.find(x => /AoTM/i.test(x.l));
  t.push(['Big Books: "Estimated: 5" top right', /Estimated: 5/.test(big.txt) && await page.evaluate(() => { const e = document.querySelector('#totals .tcard.has-est .tc-est'), v = e && e.closest('.tcard').querySelector('.value');
    return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().left > v.getBoundingClientRect().left && e.getBoundingClientRect().top <= v.getBoundingClientRect().top; })]);
  t.push(['Adventures confirmed: no Estimated on the AoTM card', !/Estimated/.test(av.txt)]);
  for (const w of [1150, 1400, 1700]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(350);
    const c2 = await cards(); t.push(['one line at ' + w + 'px too', new Set(c2.map(x => x.top)).size === 1]);
    const s = await spill(); t.push(['no overflow at ' + w + 'px' + (s.length ? ' — ' + s.join(' | ') : ''), !s.length]); }

  /* 3. On a phone. */
  await page.setViewportSize({ width: 390, height: 900 }); await page.waitForTimeout(400);
  cs = await cards();
  const pb = cs.filter(x => !/usd|pend/.test(x.cls));
  t.push(['phone: the book cards share one width (' + cs.map(x => x.l + ' ' + x.w + '@' + x.top).join(', ') + ')', Math.max(...pb.map(x => x.w)) - Math.min(...pb.map(x => x.w)) <= 1]);
  t.push(['phone: "(5 Estimated)" in small print under the sold figure, not top right', await page.evaluate(() => { const e = document.querySelector('#totals .value-est'), q = document.querySelector('#totals .tc-est');
    return !!e && getComputedStyle(e).display === 'block' && /\(5 Estimated\)/.test(e.textContent) && getComputedStyle(q).display === 'none' && parseFloat(getComputedStyle(e).fontSize) <= 11; })]);
  { const s = await spill(); t.push(['no overflow at 390px' + (s.length ? ' — ' + s.join(' | ') : ''), !s.length]); }

  /* 4. Earthly HQ: Exp: and Don: in Q2, top right, on a phone too. */
  c({ action: 'donate', saleId: 'H1', location: 'wh_hq', legs: [{ type: 'Cash', cur: 'USD', amt: 7 }], name: 'Donor' }, 'HQ');
  c({ action: 'saveCost', id: 'cost_hq', amt: 3, cur: 'USD', category: 'Other', location: 'wh_hq' }, 'HQ');
  await page.evaluate(() => switchSeason(HQ_ID)); await page.waitForTimeout(1500);
  for (const w of [390, 1150]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(350);
    t.push(['Earthly HQ at ' + w + 'px: Q2 reads Exp: and Don:, beside Net Sales on its right', await page.evaluate(() => { const q1 = document.querySelector('#totals .tc-hq .tc-q1'), q2 = document.querySelector('#totals .tc-hq .tc-q2');
      if(!q1 || !q2) return false; const a = q1.getBoundingClientRect(), b = q2.getBoundingClientRect();
      return /Exp:/.test(q2.innerText) && /Don:/.test(q2.innerText) && b.left >= a.right - 1 && b.top < a.bottom; })]);
    const s = await spill(); t.push(['no overflow at Earthly HQ at ' + w + 'px' + (s.length ? ' — ' + s.join(' | ') : ''), !s.length]); }
  await page.evaluate(id => switchSeason(id), SA); await page.waitForTimeout(1500);
  await page.setViewportSize({ width: 1150, height: 900 }); await page.waitForTimeout(200);

  /* 5. The menu: WhatsApp Reports in practice; no Go to Sales Portal. */
  await page.evaluate(() => { ME = { universal: true, grants: [] }; renderAll(); }); await page.waitForTimeout(300);
  const menu = await page.evaluate(() => [...document.querySelectorAll('#sideNav .sn-item')].map(b => b.dataset.act));
  t.push(['practice menu: WhatsApp Reports, and no separate Specialty Reports or Report', menu.includes('wareports') && !menu.includes('specreport') && !menu.includes('report')]);
  t.push(['no Go to Sales Portal row in the menu', !menu.includes('finleave')]);

  /* 6. WhatsApp Reports. */
  await page.evaluate(() => document.querySelector('#sideNav [data-act="wareports"]').click()); await page.waitForTimeout(300);
  t.push(['WhatsApp Reports: three numbered sections and Generate Report', await page.evaluate(() => { const h = [...document.querySelectorAll('#modal .wa-h')].map(e => e.textContent);
    return /^1\. Choose Location/.test(h[0]) && /^2\. Add Two or More Locations Totals/.test(h[1]) && /^3\. Data To Include/.test(h[2]) && /Generate Report/.test(document.querySelector('#waGo').textContent); })]);
  await page.click('#waLoc .pp-in'); await page.fill('#waLoc .pp-in', 'Harinam'); await page.waitForTimeout(150);
  t.push(['1. the location search finds an event', (await page.$$eval('#waLoc .pp-row[data-v]', rs => rs.map(r => r.textContent))).some(x => /Harinam Fair/.test(x))]);
  await page.click('#waLoc .pp-row[data-v="e:ev_b300"]'); await page.waitForTimeout(100);
  await page.click('#waGo'); await page.waitForTimeout(200);
  let rep = await page.$eval('#repText', e => e.value);
  t.push(['one place: its own report ("Harinam Fair Totals")', /^\*Harinam Fair Totals\*/.test(rep)]);
  await page.click('#waAdd'); await page.waitForTimeout(150);
  await page.fill('#waMore .wa-row:last-child .pp-in', R0.name); await page.waitForTimeout(150);
  await page.click('#waMore .wa-row:last-child .pp-row[data-v="r:' + R0.regionId + '"]'); await page.waitForTimeout(100);
  await page.uncheck('#modal [data-wr="books"]');
  await page.click('#waGo'); await page.waitForTimeout(200);
  rep = await page.$eval('#repText', e => e.value);
  t.push(['2. a second place added: one report of both together', new RegExp('^\\*Harinam Fair \\+ ' + R0.name + ' Totals\\*').test(rep)]);
  t.push(['3. Sales by title unticked: left out', !/SALES BY TITLE/.test(rep) && /COLLECTIONS BY PAYMENT/.test(rep)]);
  for (const w of [390, 1150]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(200);
    const s = await spill(); t.push(['no overflow in WhatsApp Reports at ' + w + 'px' + (s.length ? ' — ' + s.join(' | ') : ''), !s.length]); }
  await page.evaluate(() => closeModal());

  /* 7. The Uncategorized calculator keeps working when a number is erased. */
  await page.evaluate(r => goTo('region', r), R0.regionId); await page.waitForTimeout(300);
  await page.click('[data-act="uncat"]'); await page.waitForTimeout(300);
  const ma = await page.evaluate(() => uncatMsrp('USD', 'aotm'));
  const val = k => page.$eval(k, i => i.value);
  await page.selectOption('#ucCur', 'USD'); await page.fill('#ucAmt', '1111'); await page.waitForTimeout(100);
  t.push(['1111 fills in 27 Big Books', await val('#ucN') === '27']);
  await page.fill('#ucN', '20'); await page.waitForTimeout(100);
  const a20 = Math.floor((1111 - 20 * 40) / ma);
  t.push(['20 Big Books typed: ' + a20 + ' Adventures worked out', await val('#ucA') === String(a20)]);
  await page.fill('#ucN', ''); await page.waitForTimeout(100);
  t.push(['Big Books erased: left empty while you are in it', await val('#ucN') === '']);
  await page.click('#ucCom'); await page.waitForTimeout(150);
  t.push(['…and once you leave it, worked out again from the money (27), the Adventures cleared', await val('#ucN') === '27' && await val('#ucA') === '']);
  await page.fill('#ucA', '3'); await page.waitForTimeout(100);
  const n3 = Math.floor((1111 - 3 * ma) / 40);
  t.push(['3 Adventures typed: ' + n3 + ' Big Books worked out', await val('#ucN') === String(n3)]);
  await page.fill('#ucN', '10'); await page.waitForTimeout(100);
  const a10 = Math.floor((1111 - 400) / ma);
  t.push(['then 10 Big Books typed: the Adventures follow the last one typed (' + a10 + ')', await val('#ucA') === String(a10)]);
  await page.fill('#ucAmt', '2000'); await page.waitForTimeout(100);
  const a10b = Math.floor((2000 - 400) / ma);
  t.push(['the total changed: still worked out (' + a10b + ' Adventures)', await val('#ucA') === String(a10b)]);
  await page.fill('#ucA', ''); await page.click('#ucCom'); await page.fill('#ucN', ''); await page.click('#ucCom'); await page.waitForTimeout(150);
  t.push(['both erased: back to the money as Big Books (50)', await val('#ucN') === '50']);
  await page.check('input[name="ucEstB"][value="0"]'); await page.fill('#ucN', '30'); await page.waitForTimeout(100);
  await page.fill('#ucN', ''); await page.click('#ucCom'); await page.fill('#ucN', '35'); await page.waitForTimeout(100);
  t.push(['Confirmed Big Books erased and retyped: the Adventures follow (' + Math.floor((2000 - 35 * 40) / ma) + ')', await val('#ucA') === String(Math.floor((2000 - 35 * 40) / ma))]);
  await page.evaluate(() => closeModal());

  t.push(['no page errors' + (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''), !errors.length]);
  let bad = 0;
  t.forEach(([n, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; });
  console.log(bad ? bad + ' failed' : 'all ' + t.length + ' passed');
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('STOPPED ' + e.stack); process.exit(1); });
