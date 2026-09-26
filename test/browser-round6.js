/* Optional, needs Playwright + Chromium: node test/browser-round6.js
   b189: a plain sale shows only how and how much, with the rest under
   "Specialized Sales"; and "Dollars actually received", entered from the
   sales log after the sale — single and multi-book — and kept through edits. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-r6-' + n + '.png');

m.init();
const ok = (r, what) => { if (!r.ok) throw new Error(what + ': ' + r.error); return r; };
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason;
const books = st.books.filter(b => !b.partnerId);
const [B0, B1] = books.map(b => b.id);
const pl = st.regions[0];
const c = (p, w) => ok(m.call(Object.assign({ season: SA }, p)), w || p.action);
c({ action: 'adjustStockBulk', location: pl.whLoc, items: [{ bookId: B0, delta: 20 }, { bookId: B1, delta: 10 }], override: true });
const state = () => m.call({ action: 'getState', season: SA }).state;

(async () => {
  const browser = await chromium.launch();
  const t = [], errors = [];
  const page = await browser.newPage({ viewport: { width: 1100, height: 950 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.includes('script.google.com')) {
      let p = {}; try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(m.call(p)) });
    }
    if (url.startsWith('http://app.test/')) {
      const f = path.join(ROOT, new URL(url).pathname.replace(/^\/+/, '') || 'index.html');
      if (fs.existsSync(f) && fs.statSync(f).isFile())
        return route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : undefined });
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto('http://app.test/index.html'); await page.waitForTimeout(2000);
  const shown = sel => page.isVisible(sel);
  try {
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(300);

    // 1. A plain sale: payment type, currency, amount — and Specialized Sales, closed.
    await page.evaluate(b => saleModal({ bookId: b, isPreorder: false, loc: CUR_LOC }), B0); await page.waitForTimeout(300);
    t.push(['plain sale shows payment type, currency, amount', await shown('#ptype') && await shown('#pcur') && await shown('#pamt')]);
    t.push(['…and hides the rest', !(await shown('#paySeg')) && !(await shown('#cname')) && !(await shown('#ccomments')) && !(await shown('#csTs'))]);
    t.push(['"Specialized Sales" sits below, closed', /Specialized Sales/.test(await page.textContent('#specBox > summary')) &&
      await page.evaluate(() => !document.querySelector('#specBox').open)]);
    await page.screenshot({ path: shot('1-plain') });
    await page.click('#saveSale'); await page.waitForTimeout(1200);
    t.push(['a plain sale records with one tap', (state().sales || []).filter(x => x.bookId === B0 && x.type === 'SALE').length === 1]);
    await page.evaluate(b => saleModal({ bookId: b, isPreorder: false, loc: CUR_LOC }), B0); await page.waitForTimeout(300);
    await page.click('#specBox > summary'); await page.waitForTimeout(100);
    t.push(['opening it reveals everything else', await shown('#paySeg') && await shown('#cname') && await shown('#ccomments') && await shown('#csTs')]);
    await page.evaluate(() => closeModal());
    await page.evaluate(b => saleModal({ bookId: b, isPreorder: true, loc: CUR_LOC }), B1); await page.waitForTimeout(300);
    t.push(['a pre-order opens it (a name is needed)', await page.evaluate(() => document.querySelector('#specBox').open)]);
    await page.evaluate(() => closeModal());

    // 2. Dollars actually received: not on the sale screen — in the sales log, after the sale.
    await page.evaluate(b => saleModal({ bookId: b, isPreorder: false, loc: CUR_LOC }), B0); await page.waitForTimeout(300);
    await page.selectOption('#ptype', 'Card'); await page.click('#specBox > summary');
    t.push(['the sale screen has no dollars-received box', !(await page.$('#usdAct')) && !/Dollars actually received/i.test(await page.textContent('#modal'))]);
    await page.fill('#cname', 'Card One');
    await page.click('#saveSale'); await page.waitForTimeout(1200);
    let s1 = state().sales.find(x => x.name === 'Card One');
    const btn = page.locator(`.usd-btn[data-id="${s1.saleId}"]:visible`).first();
    t.push(['the sale in the log has a "$ Received" button', (await btn.count()) === 1 && /\$ Received/.test(await btn.textContent())]);
    await btn.click(); await page.waitForTimeout(300);
    await page.fill('#uaVal', '38.5'); await page.screenshot({ path: shot('2-usd') });
    await page.click('#uaSave'); await page.waitForTimeout(1200);
    s1 = state().sales.find(x => x.name === 'Card One');
    t.push(['saved with the dollars received', Number(s1.usdActual) === 38.5]);
    t.push(['the row shows "($38.5 received)"', /\(\$38\.5 received\)/.test(await page.evaluate(() => document.body.innerText))]);
    // An edit of the sale keeps it.
    await page.evaluate(id => saleModal({ bookId: STATE.sales.find(x => x.saleId === id).bookId, edit: STATE.sales.find(x => x.saleId === id) }), s1.saleId);
    await page.waitForTimeout(300);
    t.push(['Edit of a sale with a name opens Specialized Sales', await page.evaluate(() => document.querySelector('#specBox').open)]);
    await page.fill('#ccomments', 'kept');
    await page.click('#saveSale'); await page.waitForTimeout(1200);
    t.push(['editing the sale keeps the dollars received', Number(state().sales.find(x => x.name === 'Card One').usdActual) === 38.5]);

    // 3. Multiple books: the same button, one figure shared out over the books.
    await page.evaluate(() => bundleModal()); await page.waitForTimeout(300);
    await page.click(`.mb-plus[data-book="${B0}"][data-kind="buy"]`); await page.click(`.mb-plus[data-book="${B1}"][data-kind="buy"]`);
    await page.selectOption('#ptype', 'Card');
    await page.click('#specBox > summary'); await page.fill('#cname', 'Two Books');
    await page.click('#saveBundle'); await page.waitForTimeout(1500);
    let mem = state().sales.filter(x => x.name === 'Two Books');
    const bbtn = page.locator(`.usd-btn[data-bundle="${mem[0].bundle}"]:visible`).first();
    t.push(['the multi-book sale in the log has a "$ Received" button', (await bbtn.count()) === 1]);
    await bbtn.click(); await page.waitForTimeout(300);
    await page.fill('#uaVal', '50'); await page.click('#uaSave'); await page.waitForTimeout(1500);
    mem = state().sales.filter(x => x.name === 'Two Books');
    t.push(['one figure for the whole transaction, shared out and adding up to 50', mem.length === 2 && Math.abs(mem.reduce((a, x) => a + Number(x.usdActual), 0) - 50) < 0.001]);
    await page.evaluate(b => bundleModal({ bundle: b, members: STATE.sales.filter(x => x.bundle === b) }), mem[0].bundle); await page.waitForTimeout(400);
    await page.fill('#ccomments', 'kept'); await page.click('#saveBundle'); await page.waitForTimeout(1500);
    mem = state().sales.filter(x => x.name === 'Two Books');
    t.push(['editing the multi-book sale keeps it', Math.abs(mem.reduce((a, x) => a + Number(x.usdActual), 0) - 50) < 0.001]);
    await page.screenshot({ path: shot('3-log') });

    // 4. Donations too.
    c({ action: 'donate', saleId: 'd_card1', location: pl.whLoc, legs: [{ type: 'Card', cur: 'PLN', amt: 100 }], name: 'Giver' });
    await page.evaluate(() => pull()); await page.waitForTimeout(800);
    const dbtn = page.locator('.usd-btn[data-id="d_card1"]:visible').first();
    t.push(['a card donation in the log has "$ Received"', (await dbtn.count()) === 1]);
    await dbtn.click(); await page.waitForTimeout(300);
    await page.fill('#uaVal', '25'); await page.click('#uaSave'); await page.waitForTimeout(1200);
    t.push(['…and it is saved', Number(state().sales.find(x => x.saleId === 'd_card1').usdActual) === 25]);
    t.push(['the donation row shows "($25 received)"', /\(\$25 received\)/.test(await page.evaluate(() => document.body.innerText))]);
    await page.evaluate(() => donationModal(STATE.sales.find(x => x.saleId === 'd_card1'))); await page.waitForTimeout(300);
    await page.fill('#ccomments', 'thank you'); await page.click('#saveDon'); await page.waitForTimeout(1200);
    t.push(['editing the donation keeps it', Number(state().sales.find(x => x.saleId === 'd_card1').usdActual) === 25]);
  } catch (e) {
    console.log('STOPPED:', e.message.split('\n')[0]);
    t.push(['test ran to the end', false]);
    try { await page.screenshot({ path: shot('stopped') }); } catch (e2) {}
  }
  t.push(['no errors in the page', errors.length === 0]);
  if (errors.length) console.log('page errors:', errors);
  t.forEach(([n, okk]) => console.log((okk ? 'PASS' : 'FAIL'), n));
  console.log('screenshots:', shot('*'));
  await browser.close();
})();
