/* Optional, needs Playwright + Chromium: node test/browser-b300.js
   b300 (Live app changes): one font size in the navigation drop-downs; the
   totals bar (book cards one width, the rest to the totals, all five on one
   line with Pending Payments, whole numbers, ≈, "Estimated: N"); Earthly HQ's
   Expenses and Donations (spelled out on a phone too since b302); the portal button in the top bar and no Go to Sales Portal in
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
  // The live totals bar (every card one width); practice sizes each card to its contents (b305).
  await page.addInitScript(() => { window.TOT_EVEN = true; });
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
  t.push(['b301: every card the same width', Math.max(...cs.map(x => x.w)) - Math.min(...cs.map(x => x.w)) <= 1]);
  const tot = await page.$eval('#totals', e => e.innerText);
  t.push(['b301: no .00 on the totals cards, real cents kept (10.60 € shows as 10.60 €)', !/\.00\b/.test(tot) && /10\.60/.test(tot)]);
  t.push(['≈ marks estimated dollars, not ~', /≈\$/.test(tot) && !/~/.test(tot)]);
  const big = books.find(x => /Big Books/i.test(x.l)), av = books.find(x => /AoTM/i.test(x.l));
  t.push(['Big Books: "Estimated: 5" then "Known: N" top right', /Estimated: 5\s*Known: \d+/.test(big.txt) && await page.evaluate(() => { const e = document.querySelector('#totals .tcard.has-est .tc-est'), v = e && e.closest('.tcard').querySelector('.value');
    return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().left > v.getBoundingClientRect().left && e.getBoundingClientRect().top <= v.getBoundingClientRect().top; })]);
  t.push(['Adventures confirmed: no Estimated on the AoTM card', !/Estimated/.test(av.txt)]);
  t.push(['b301: the pre-orders sit underneath the number sold', await page.evaluate(() => { const p = document.querySelector('#totals .value-pre'); return !!p && getComputedStyle(p).display === 'block'; })]);
  for (const w of [1150, 1400, 1700]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(350);
    const c2 = await cards(); t.push(['one line at ' + w + 'px too', new Set(c2.map(x => x.top)).size === 1]);
    const s = await spill(); t.push(['no overflow at ' + w + 'px' + (s.length ? ' — ' + s.join(' | ') : ''), !s.length]); }

  /* 3. On a phone. */
  await page.setViewportSize({ width: 390, height: 900 }); await page.waitForTimeout(400);
  cs = await cards();
  const pb = cs.filter(x => !/usd|pend/.test(x.cls));
  t.push(['phone: the book cards share one width (' + cs.map(x => x.l + ' ' + x.w + '@' + x.top).join(', ') + ')', Math.max(...pb.map(x => x.w)) - Math.min(...pb.map(x => x.w)) <= 1]);
  { const pd = cs.find(x => /Pending/.test(x.l)), last = pb[pb.length - 1], rows = new Set(pb.map(x => x.top)).size;
    t.push(['b301: phone: Pending Payments in the empty place beside the last book card, when there is one', pb.length % Math.ceil(pb.length / rows) === 0 || (pd && pd.top === last.top)]); }
  t.push(['phone: "(5 Estimated)" in small print under the sold figure, not top right', await page.evaluate(() => { const e = document.querySelector('#totals .value-est'), q = document.querySelector('#totals .tc-est');
    return !!e && getComputedStyle(e).display === 'block' && /\(5 Estimated\)\s*\(\d+ Known\)/.test(e.innerText) && getComputedStyle(q).display === 'none' && parseFloat(getComputedStyle(e).fontSize) <= 11; })]);
  { const s = await spill(); t.push(['no overflow at 390px' + (s.length ? ' — ' + s.join(' | ') : ''), !s.length]); }
  // b301: three book cards two to a line leave a place beside the third: Pending Payments goes there.
  await page.setViewportSize({ width: 330, height: 900 }); await page.waitForTimeout(300);
  t.push(['b301: phone, three book cards two to a line: Pending Payments beside the third, the totals card beneath', await page.evaluate(() => {
    const box = document.querySelector('#totals'), bk = box.querySelector('.tc-book.has-est') || box.querySelector('.tc-book'), x = bk.cloneNode(true), y = { remove(){} };
    x.querySelector('.label').textContent = 'Other'; box.insertBefore(x, bk); layoutTotals();
    const cs = [...box.querySelectorAll(':scope > .tcard')], r = c => c.getBoundingClientRect(), bks = cs.filter(c => c.classList.contains('tc-book'));
    const pend = box.querySelector('.pend'), coll = box.querySelector('.tc-coll'), lastB = bks[bks.length - 1];
    const ok = bks.length === 3 && new Set(bks.map(c => Math.round(r(c).top))).size === 2 && Math.abs(r(pend).top - r(lastB).top) < 2 && r(coll).top > r(pend).bottom - 1;
    const dbg = cs.map(c => c.querySelector('.label').textContent + '@' + Math.round(r(c).left) + ',' + Math.round(r(c).top) + ' w' + Math.round(r(c).width)).join(' | ');
    x.remove(); y.remove(); renderTotals(); return ok || dbg; }).then(v => { if (v !== true) console.log('   layout:', v); return v === true; })]);
  await page.setViewportSize({ width: 390, height: 900 }); await page.waitForTimeout(300);

  /* 4. Earthly HQ: Expenses and Donations in Q2, top right, on a phone too (words everywhere, b302). */
  c({ action: 'donate', saleId: 'H1', location: 'wh_hq', legs: [{ type: 'Cash', cur: 'USD', amt: 7 }], name: 'Donor' }, 'HQ');
  c({ action: 'saveCost', id: 'cost_hq', amt: 3, cur: 'USD', category: 'Other', location: 'wh_hq' }, 'HQ');
  await page.evaluate(() => switchSeason(HQ_ID)); await page.waitForTimeout(1500);
  for (const w of [390, 1150]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(350);
    t.push(['b302: Earthly HQ at ' + w + 'px: Q2 reads Expenses and Donations, spelled out, beside Net Sales on its right', await page.evaluate(() => { const q1 = document.querySelector('#totals .tc-hq .tc-q1'), q2 = document.querySelector('#totals .tc-hq .tc-q2');
      if(!q1 || !q2) return false; const a = q1.getBoundingClientRect(), b = q2.getBoundingClientRect(), x = q2.innerText;
      return /Expenses/.test(x) && /Donations/.test(x) && !/Exp:|Don:/.test(x) && b.left >= a.right - 1 && b.top < a.bottom; })]);
    const s = await spill(); t.push(['no overflow at Earthly HQ at ' + w + 'px' + (s.length ? ' — ' + s.join(' | ') : ''), !s.length]); }
  await page.evaluate(id => switchSeason(id), SA); await page.waitForTimeout(1500);
  await page.setViewportSize({ width: 1150, height: 900 }); await page.waitForTimeout(200);

  /* 5. The menu: WhatsApp Reports in practice; no Go to Sales Portal. */
  await page.evaluate(() => { ME = { universal: true, grants: [] }; renderAll(); }); await page.waitForTimeout(300);
  const menu = await page.evaluate(() => [...document.querySelectorAll('#sideNav .sn-item')].map(b => b.dataset.act));
  t.push(['menu: WhatsApp Reports, and no separate Specialty Reports or Report', menu.includes('wareports') && !menu.includes('specreport') && !menu.includes('report')]);
  t.push(['no Go to Sales Portal row in the menu', !menu.includes('finleave')]);

  /* 6. WhatsApp Reports. */
  await page.evaluate(() => document.querySelector('#sideNav [data-act="wareports"]').click()); await page.waitForTimeout(1200);
  // b302: every place you can see, in every season and Earthly HQ.
  await page.click('#waLoc .pp-in'); await page.fill('#waLoc .pp-in', 'Earthly'); await page.waitForTimeout(150);
  t.push(['b302: WhatsApp Reports lists Earthly HQ too', (await page.$$eval('#waLoc .pp-row[data-v]', rs => rs.map(r => r.dataset.v))).includes('HQ|season')]);
  t.push(['WhatsApp Reports: three numbered sections and Generate Report', await page.evaluate(() => { const h = [...document.querySelectorAll('#modal .wa-h')].map(e => e.textContent);
    return /^1\. Choose Location/.test(h[0]) && /^2\. Add Two or More Locations Totals/.test(h[1]) && /^3\. Data To Include/.test(h[2]) && /Generate Report/.test(document.querySelector('#waGo').textContent); })]);
  await page.click('#waLoc .pp-in'); await page.fill('#waLoc .pp-in', 'Harinam'); await page.waitForTimeout(150);
  t.push(['1. the location search finds an event', (await page.$$eval('#waLoc .pp-row[data-v]', rs => rs.map(r => r.textContent))).some(x => /Harinam Fair/.test(x))]);
  await page.click('#waLoc .pp-row[data-v="' + SA + '|e:ev_b300"]'); await page.waitForTimeout(100);
  t.push(['b301: every Data To Include box starts empty', await page.$$eval('#modal [data-wr]', cs => cs.length > 0 && cs.every(c => !c.checked))]);
  for (const k of ['books', 'cash', 'pending', 'preorders', 'prepeople', 'stock']) await page.check('#modal [data-wr="' + k + '"]').catch(() => {});
  await page.click('#waGo'); await page.waitForTimeout(200);
  let rep = await page.$eval('#repText', e => e.value);
  t.push(['one place: its own report ("Harinam Fair Totals")', /^\*Harinam Fair Totals\*/.test(rep)]);
  await page.click('#waAdd'); await page.waitForTimeout(150);
  await page.fill('#waMore .wa-row:last-child .pp-in', R0.name); await page.waitForTimeout(150);
  await page.click('#waMore .wa-row:last-child .pp-row[data-v="' + SA + '|r:' + R0.regionId + '"]'); await page.waitForTimeout(100);
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
  // b306 (Gita): the money left after those Big Books is worked out as Adventures.
  { const a27 = Math.floor((1111 - 27 * 40) / ma);
    t.push(['…and once you leave it, worked out again from the money (27), the rest as ' + a27 + ' Adventures', await val('#ucN') === '27' && await val('#ucA') === (a27 > 0 ? String(a27) : '')]); }
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
  // b301 (Gita): switching the buttons back and forth never stops it.
  const aOf = n => String(Math.floor((2000 - n * 40) / ma)), nOf = k => String(Math.floor((2000 - k * ma) / 40));
  const aNow = Number(await val('#ucA'));
  await page.check('input[name="ucEstB"][value="1"]'); await page.check('input[name="ucEstA"][value="0"]'); await page.waitForTimeout(100);
  t.push(['b301: Adventures now Confirmed, Big Books Estimated: the Big Books follow the Adventures (' + nOf(aNow) + ')', await val('#ucN') === nOf(aNow) && await val('#ucA') === String(aNow)]);
  const nNow = Number(await val('#ucN'));
  await page.check('input[name="ucEstA"][value="1"]'); await page.check('input[name="ucEstB"][value="0"]'); await page.waitForTimeout(100);
  t.push(['b301: and back again: the Adventures follow the Big Books (' + aOf(nNow) + ')', await val('#ucA') === aOf(nNow) && await val('#ucN') === String(nNow)]);
  await page.fill('#ucA', '1'); await page.click('#ucCom'); await page.fill('#ucAmt', '2400'); await page.waitForTimeout(100);
  t.push(['b301: even after typing in the Estimated one, a new total works it out again from the Confirmed one', await val('#ucA') === String(Math.floor((2400 - nNow * 40) / ma))]);
  await page.check('input[name="ucEstB"][value="1"]'); await page.fill('#ucN', ''); await page.click('#ucCom'); await page.fill('#ucA', ''); await page.click('#ucCom'); await page.waitForTimeout(100);
  t.push(['b301: no sum spelled out (only the two "Based on…" notes)', !/÷/.test(await page.textContent('#ucHow'))]);
  await page.evaluate(() => closeModal());

  /* b304 (Gita): every card one width on one line (b302/b303's set widths are gone;
     every screen width). */
  const three = async w => { await page.setViewportSize({ width: w, height: 900 }); await page.evaluate(() => goTo('season')); await page.waitForTimeout(400);
    return page.evaluate(() => { document.querySelectorAll('#totals > .pend, #totals > .other').forEach(e => e.remove()); layoutTotals();
      return [...document.querySelectorAll('#totals > .tcard')].map(c => c.getBoundingClientRect().width); }); };
  let ws = await three(1400);
  t.push(['b304: three cards at 1400px are one width, on one line (' + ws.map(Math.round).join(' / ') + ')', ws.length === 3 && Math.max(...ws) - Math.min(...ws) < 2]);
  // b304: four cards too.
  ws = await page.evaluate(() => { const b = document.querySelector('#totals'), x = b.querySelector('.tc-book').cloneNode(true); x.classList.add('other'); b.insertBefore(x, b.querySelector('.tc-coll')); layoutTotals();
    return [...b.querySelectorAll(':scope > .tcard')].map(c => c.getBoundingClientRect().width); });
  t.push(['b304: four cards at 1400px are one width, on one line (' + ws.map(Math.round).join(' / ') + ')', ws.length === 4 && Math.max(...ws) - Math.min(...ws) < 2]);
  ws = await three(1150);
  t.push(['b302: narrower (1150px), the three are one width again (' + ws.map(Math.round).join(' / ') + ')', ws.length === 3 && Math.max(...ws) - Math.min(...ws) < 2]);
  /* b305 (Gita, practice): each card only as wide as it needs; the room left over stays empty. */
  for (const w of [1400, 1150]) {
    await page.setViewportSize({ width: w, height: 900 }); await page.evaluate(() => { window.TOT_EVEN = false; goTo('season'); }); await page.waitForTimeout(400);
    const r = await page.evaluate(() => { layoutTotals(); const b = document.querySelector('#totals'), cs = [...b.querySelectorAll(':scope > .tcard')];
      const need = cs.map(c => { const was = c.style.width; c.style.width = 'max-content'; const v = c.getBoundingClientRect().width; c.style.width = was; return v; });
      const rr = cs.map(c => c.getBoundingClientRect());
      return { n: cs.length, tops: new Set(rr.map(x => Math.round(x.top))).size, right: Math.max(...rr.map(x => x.right)), bar: b.getBoundingClientRect().right,
        ws: rr.map(x => Math.round(x.width)), fit: cs.every((c, i) => rr[i].width <= need[i] + 2 && c.scrollWidth <= c.clientWidth + 1) }; });
    t.push(['b305/b306 (live too) ' + w + 'px: cards sized to what they hold, on one line, room left over (' + r.ws.join(' / ') + ')', r.n >= 3 && r.tops === 1 && r.fit && r.right < r.bar - 20]);
  }
  await page.evaluate(() => { window.TOT_EVEN = true; });
  await page.setViewportSize({ width: 1150, height: 900 }); await page.evaluate(() => renderAll()); await page.waitForTimeout(300);

  /* b304: Transfer Existing Stock opens with From and To blank; Transfer In and Out fill them. */
  await page.evaluate(() => goTo('event', 'ev_b300')); await page.waitForTimeout(400);
  await page.evaluate(() => transferStockModal()); await page.waitForTimeout(400);
  const xf = await page.$eval('#xfFrom .pp-in', e => e.value);
  t.push(['b304: Transfer opens with "Transfer From" blank (' + xf + ')', xf === '']);
  const xt = await page.$eval('#xfTo .pp-in', e => e.value);
  t.push(['b304: …and "Transfer To" blank (' + xt + ')', xt === '']);
  // b303: Transfer In and Transfer Out.
  await page.evaluate(() => { closeModal(); goTo('event', 'ev_b300'); transferStockModal(); }); await page.waitForTimeout(400);
  await page.click('#xfOut'); await page.waitForTimeout(300);
  const outV = [await page.$eval('#xfFrom .pp-in', e => e.value), await page.$eval('#xfTo .pp-in', e => e.value)];
  t.push(['b303: Transfer Out at an event: From is the event, To is blank (' + outV.join(' / ') + ')', /^Harinam Fair/.test(outV[0]) && outV[1] === '']);
  await page.click('#xfIn'); await page.waitForTimeout(300);
  const inV = [await page.$eval('#xfFrom .pp-in', e => e.value), await page.$eval('#xfTo .pp-in', e => e.value)];
  t.push(['b303: Transfer In at an event: From is ' + R0.name + ', To is the event (' + inV.join(' / ') + ')', inV[0].startsWith(R0.name) && /^Harinam Fair/.test(inV[1])]);
  await page.click('#xfReturn'); await page.waitForTimeout(300);
  const rtV = [await page.$eval('#xfFrom .pp-in', e => e.value), await page.$eval('#xfTo .pp-in', e => e.value)];
  t.push(['Return all to warehouse still: From the event, To ' + R0.name + ' (' + rtV.join(' / ') + ')', /^Harinam Fair/.test(rtV[0]) && rtV[1].startsWith(R0.name)]);
  for (const w of [390, 1150]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(200);
    const s2 = await spill(); t.push(['no overflow in Transfer at ' + w + 'px' + (s2.length ? ' — ' + s2.join(' | ') : ''), !s2.length]); }
  await page.evaluate(() => closeModal());
  // b303 (Gita): typed MM/DD/YYYY date boxes; a "2" stays a 2 until the next digit.
  await page.evaluate(() => regionModal()); await page.waitForTimeout(400);
  const dbox = '.dt-wrap:has(#pmFrom) .dt-txt';
  if (await page.$(dbox)) {
    await page.click(dbox); await page.keyboard.type('102', { delay: 120 });
    const mid = await page.$eval(dbox, e => e.value);
    await page.keyboard.type('32026', { delay: 120 });
    const full = await page.evaluate(() => [document.querySelector('.dt-wrap:has(#pmFrom) .dt-txt').value, document.querySelector('#pmFrom').value]);
    t.push(['b303: date box: "102" reads 10/2 (' + mid + '), then 10/23/2026 = 2026-10-23 (' + full.join(' = ') + ')', mid === '10/2' && full[0] === '10/23/2026' && full[1] === '2026-10-23']);
    await page.evaluate(() => { document.querySelector('#pmTo').value = '2026-11-05'; });
    t.push(['b303: a date set by the app shows as 11/05/2026', await page.$eval('.dt-wrap:has(#pmTo) .dt-txt', e => e.value) === '11/05/2026']);
  } else t.push(['b303: the region form has its date boxes', false]);
  await page.evaluate(() => closeModal());
  // b304: Collections by Currency in lines of about the same length, a figure never split.
  await page.evaluate(() => { closeModal(); renderAll(); });
  t.push(['b304: currency figures each kept whole (' + await page.$$eval('#totals .tc-bal .tc-cur', es => es.length) + ')', await page.$$eval('#totals .tc-bal .tc-cur', es => es.length > 0 && es.every(e => getComputedStyle(e).whiteSpace === 'nowrap'))]);
  // b303: the order Big Books, Adventures, Other, Pending Payments, Totals.
  await page.evaluate(() => { closeModal(); renderAll(); });
  const ord = await page.$$eval('#totals > .tcard', cs => cs.map(c => c.classList.contains('tc-coll') ? 'T' : c.classList.contains('pend') ? 'P' : c.querySelector('.label').textContent));
  t.push(['b303: totals bar order Big Books, AoTM, Other, Pending, Totals (' + ord.join(', ') + ')', ord[0] === 'Big Books' && ord[1] === 'AoTM' && ord[ord.length - 1] === 'T' && (!ord.includes('P') || ord[ord.length - 2] === 'P')]);
  // b303: Reorganize Menu lists no item the app no longer has.
  await page.evaluate(() => { closeModal(); menuOrderModal(); });
  const mo = await page.$$eval('#moList .mo-row', rs => rs.map(r => r.dataset.a));
  t.push(['b303: Reorganize Menu has no Specialty Reports, Report or Go to Sales Portal', mo.length > 5 && !mo.some(a => ['specreport', 'report', 'finleave', 'fintodo', 'bookdisplay'].includes(a))]);
  await page.evaluate(() => closeModal());

  // b304: one Change Location Order item; its pop-up has Season, Region and Event tabs.
  c({ action: 'saveSeason', name: 'Spring Tour' });
  await page.evaluate(() => pull()); await page.waitForTimeout(1500);
  await page.evaluate(() => { closeModal(); goTo('region', STATE.regions[0].regionId); }); await page.waitForTimeout(300);
  const locBtns = await page.$$eval('#sideNav [data-act="reorder"], #adminPanel [data-act="reorder"]', bs => bs.map(b => b.textContent.trim()));
  t.push(['b304: the menu has one Change Location Order (' + locBtns.join(' | ') + ')', locBtns.length >= 1 && locBtns.every(x => /Change Location Order/.test(x))]);
  await page.evaluate(() => { const b = document.createElement('button'); b.dataset.act = 'reorder'; document.body.appendChild(b); b.click(); b.remove(); });
  await page.waitForTimeout(200);
  const tabs = await page.$$eval('#roTabs [data-ro-k]', bs => bs.map(b => b.textContent + (b.classList.contains('on') ? '*' : '')));
  t.push(['b304: tabs Season, Region, Event; Event chosen at a region (' + tabs.join(', ') + ')', tabs.join(',') === 'Season,Region,Event*' && !!(await page.$('#roRegSel'))]);
  await page.click('#roTabs [data-ro-k="season"]'); await page.waitForTimeout(100);
  const sn0 = await page.$$eval('#roList .ro-row', rs => rs.map(r => r.dataset.id));
  await page.click('#roList [data-ro-dn="0"]'); await page.click('#roSave'); await page.waitForTimeout(1500);
  const snSrv = m.call({ action: 'getState', season: SA }).state.seasons.map(x => x.seasonId);
  t.push(['b304: the Season tab moves a season down and saves it (' + sn0.length + ' seasons)', sn0.length === 2 && snSrv[0] === sn0[1] && snSrv[1] === sn0[0]]);
  t.push(['b304: Reorganize Menu shows Change Location Order once and no Change Regional Order', await page.evaluate(() => { menuOrderModal(); const a = [...document.querySelectorAll('#moList .mo-row')].map(r => r.textContent); closeModal();
    return a.filter(x => /Change Location Order/.test(x)).length === 1 && !a.some(x => /Change Regional Order|Change Event Order/.test(x)); })]);

  // b304 (practice): Name and Language filters over the shelf.
  await page.evaluate(id => { closeModal(); goTo('region', id); }, R0.regionId); await page.waitForTimeout(400);
  const shelfN = () => page.$$eval('#invGrid > [data-id]:not([hidden]):not(.don-card)', c => c.length);
  const allN = await shelfN();
  t.push(['b304: the shelf has Name and Language filters (' + allN + ' titles)', await page.isVisible('#invFq') && await page.isVisible('#invFl') && allN > 1]);
  await page.fill('#invFq', 'radha'); await page.waitForTimeout(150);
  const rN = await page.$$eval('#invGrid > [data-id]:not([hidden]):not(.don-card) .bname', c => c.map(x => x.textContent));
  t.push(['b304: Name "radha" leaves only Sri Radha (' + rN.length + ')', rN.length >= 1 && rN.length < allN && rN.every(x => /Radha/i.test(x))]);
  const langs = await page.$$eval('#invFl option', o => o.map(x => x.value).filter(Boolean));
  await page.fill('#invFq', ''); await page.selectOption('#invFl', langs[0]); await page.waitForTimeout(150);
  t.push(['b304: Language ' + langs[0] + ' leaves only its titles', await page.$$eval('#invGrid > [data-id]:not([hidden]):not(.don-card) .lang-tag', (c, l) => c.length > 0 && c.every(x => x.textContent.trim() === l), langs[0])]);
  await page.evaluate(() => renderAll()); await page.waitForTimeout(200);
  t.push(['b304: the filter stays when the shelf is drawn again', await page.$eval('#invFl', e => e.value) === langs[0]]);
  await page.selectOption('#invFl', ''); await page.waitForTimeout(150);
  t.push(['b304: All languages shows every title again', await shelfN() === allN]);

  // b304 (practice): Multiple Book Sale, book by book.
  await page.evaluate(() => bundleModal()); await page.waitForTimeout(300);
  t.push(['b304: Multiple Book Sale starts with one line (title, language, Buy, Pre-order)', await page.$$eval('#mbLines .mbl-row', r => r.length) === 1 && !(await page.$('#modal .mb-list'))]);
  const bkB = await page.evaluate(() => { const b = shelfBooks().find(x => invQty(CUR_LOC, x.id) >= 2); return { base: bookLang(b).base, id: b.id }; });
  await page.selectOption('#mbLines .mbl-t', bkB.base); await page.waitForTimeout(150);
  if (!(await page.$eval('#mbLines .mbl-l', e => e.value))) await page.selectOption('#mbLines .mbl-l', bkB.id);
  await page.fill('#mbLines .mbl-buy', '2'); await page.waitForTimeout(150);
  await page.click('#mbAddLine'); await page.waitForTimeout(150);
  t.push(['b304: "Add another book" adds a line', await page.$$eval('#mbLines .mbl-row', r => r.length) === 2]);
  t.push(['b304: the count reads 2 books (' + await page.textContent('#mbCount') + ')', /^2 books/.test(await page.textContent('#mbCount'))]);
  await page.fill('#mbLines .mbl-buy', '999'); await page.waitForTimeout(150);
  t.push(['b304: Buy cannot pass what is in stock', !(await page.$eval('#mbWarn', e => e.hidden)) && Number(await page.$eval('#mbLines .mbl-buy', e => e.value)) < 999]);
  await page.fill('#mbLines .mbl-buy', '2'); await page.waitForTimeout(150);
  const sales0 = m.call({ action: 'getState', season: SA }).state.sales.length;
  await page.click('#saveBundle'); await page.waitForTimeout(1500);
  t.push(['b304: Record saves the 2 books as one sale', m.call({ action: 'getState', season: SA }).state.sales.length === sales0 + 2]);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(() => bundleModal()); await page.waitForTimeout(300);
  await page.selectOption('#mbLines .mbl-t', bkB.base); await page.waitForTimeout(150);
  t.push(['b304: phone: the line fits the window', await page.evaluate(() => { const m = document.querySelector('#modal .m-body'); return m.scrollWidth <= m.clientWidth + 1
    && [...document.querySelectorAll('#mbLines *')].every(e => { const r = e.getBoundingClientRect(), b = m.getBoundingClientRect(); return !e.offsetParent || r.right <= b.right + 1; }); })]);
  await page.evaluate(() => closeModal()); await page.setViewportSize({ width: 1150, height: 900 });

  /* 8. A closed place stops you before you enter anything. */
  c({ action: 'closeLocation', kind: 'event', id: 'ev_b300', counts: {} });
  await page.evaluate(() => pull()); await page.waitForTimeout(1500);
  await page.evaluate(() => goTo('event', 'ev_b300')); await page.waitForTimeout(400);
  const tryAct = act => page.evaluate(a => { const b = document.createElement('button'); b.dataset.act = a; b.dataset.book = (STATE.books[0] || {}).id; document.body.appendChild(b); b.click(); b.remove();
    return [document.querySelector('#toast').textContent, !!document.querySelector('#overlay.show')]; }, act);
  for (const act of ['sell', 'donation', 'uncat']) { const [msg, open] = await tryAct(act);
    t.push(['b301: closed event, ' + act + ': "Harinam Fair is closed. If you wish to enter information here, it must be re-opened." and no form', msg === 'Harinam Fair is closed. If you wish to enter information here, it must be re-opened.' && !open]); }
  t.push(['b301: the top bar has only the portal button and the Activity Log (name, Report and Refresh moved)', await page.evaluate(() => document.body.classList.contains('hdr2') && getComputedStyle(document.querySelector('#whoBtn')).display === 'none')]);

  t.push(['no page errors' + (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''), !errors.length]);
  let bad = 0;
  t.forEach(([n, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; });
  console.log(bad ? bad + ' failed' : 'all ' + t.length + ' passed');
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('STOPPED ' + e.stack); process.exit(1); });
