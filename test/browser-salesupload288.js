/* Optional, needs Playwright + Chromium: node test/browser-salesupload288.js
   b288: Upload Sales Spreadsheet into an event (practice). A file shaped like
   Gita's sample (made-up names): known titles and payment types match by
   themselves, unknown titles are asked, blank and title-less rows are left out,
   a test row starts unticked, too few copies stops the upload, the whole file
   goes in at once, the Activity Log undoes it, and the same file again is
   recognised as already in. No overflow on a phone or a computer. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){ return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
m.init();
const st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason, R0 = st.regions[0];
m.call({ season: SA, action: 'createEvent', eventId: 'ev_isv', name: 'ISV Festival', regionId: R0.regionId });

const row = (book, pay, amt, type, name, phone, ts) => [book, pay, amt, type, name, phone, '"' + ts + '"'].join(',');
const lines = ['Book,Payment Method,Amount (USD),Type,Customer Name,Customer Phone,Timestamp'];
for (let i = 0; i < 6; i++) lines.push(row('Sri Radha (English)', ['credit card', 'zelle', 'paypal', 'venmo'][i % 4], 40, 'Sale', '', '', '6/7/2026, 5:3' + i + ':15 PM'));
for (let i = 0; i < 3; i++) lines.push(row('Sri Radha (Signed)', 'zelle', 40, 'Sale', '', '', '6/7/2026, 5:5' + i + ':59 PM'));
lines.push(row('Sri Radha (Russian)', 'credit card', 40, 'Pre-Order', 'Not a Preorder', '5555555555', '6/7/2026, 6:03:48 PM'));
lines.push(row('Sri Radha (English)', 'cash', 40, 'Pre-Order', 'Ananda Das', '+1 555 0100', '6/7/2026, 6:06:33 PM'));
lines.push(row('Govardhana', 'credit card', 40, 'Sale', '', '', '6/7/2026, 6:18:48 PM'));
lines.push(row('Donation', 'cash', 20, 'Donation', 'Mira', '555 0101', '6/8/2026, 8:27:00 AM'));
lines.push(',,,,,,', ',,,,,,', ',,-0.5,,,,');
const FILE = path.join(os.tmpdir(), 'isv-sample-test.csv');
fs.writeFileSync(FILE, lines.join('\r\n'));

const sales = () => m.call({ action: 'getState', season: SA }).state.sales.filter(s => s.location === 'ev_isv');
const qty = b => (m.call({ action: 'getState', season: SA }).state.inventory.find(i => i.location === 'ev_isv' && i.bookId === b) || {}).qty || 0;

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
  await page.evaluate(() => goTo('event', 'ev_isv')); await page.waitForTimeout(400);
  t.push(['the event\'s menu has 📤 Upload Sales Spreadsheet', await page.evaluate(() => !!document.querySelector('#sideNav [data-act="salesupload"]'))]);
  await page.evaluate(() => salesUploadModal()); await page.waitForTimeout(300);
  await page.setInputFiles('#supFile', FILE); await page.waitForTimeout(400);
  const txt = () => page.textContent('#supBody');
  let body = await txt();
  t.push(['the file is read (13 rows, blank and -0.5 rows left out)', /13 rows read/.test(body) && /2 blank rows/.test(body) && /no book/.test(body)]);
  t.push(['Sri Radha (English) matched by itself', await page.evaluate(() => $('[data-supbook="Sri Radha (English)"]').value === 'sr_en')]);
  t.push(['"Sri Radha (Signed)" and "Govardhana" are asked', await page.evaluate(() => !$('[data-supbook="Sri Radha (Signed)"]').value && !$('[data-supbook="Govardhana"]').value)]);
  t.push(['paypal → PayPal, credit card → Card, venmo → new', await page.evaluate(() => $('[data-suppay="paypal"]').value === 'PayPal' && $('[data-suppay="credit card"]').value === 'Card' && $('[data-suppay="venmo"]').value === '+Venmo')]);
  t.push(['amounts in USD from the heading', await page.evaluate(() => $('#supCur').value === 'USD')]);
  t.push(['dates read month first (7 June)', /7 Jun/.test(body)]);
  t.push(['"Not a Preorder" starts unticked', await page.evaluate(() => { const r = [...document.querySelectorAll('.sup-row')].find(x => /Not a Preorder/.test(x.textContent)); return r && !r.querySelector('input').checked && /test entry/.test(r.textContent); })]);
  t.push(['Upload waits until every title is matched', await page.evaluate(() => $('#supGo').disabled) && /Choose the app’s title/.test(body)]);
  await page.selectOption('[data-supbook="Sri Radha (Signed)"]', 'sr_en'); await page.waitForTimeout(100);
  await page.selectOption('[data-supbook="Govardhana"]', 'go_en'); await page.waitForTimeout(100);
  body = await txt();
  t.push(['too few copies at the event stops it, with Add Stock / Transfer', /Not enough copies/.test(body) && await page.evaluate(() => $('#supGo').disabled && !!$('#supBody [data-act="addstock"]'))]);
  m.call({ season: SA, action: 'adjustStockBulk', location: 'ev_isv', items: [{ bookId: 'sr_en', delta: 12 }, { bookId: 'go_en', delta: 2 }], override: true });
  await page.evaluate(() => closeModal()); await page.evaluate(() => pull()); await page.waitForTimeout(800);
  await page.evaluate(() => salesUploadModal()); await page.waitForTimeout(300);
  body = await txt();
  t.push(['reopened, the file and the choices are still there', /isv-sample-test\.csv/.test(body) && await page.evaluate(() => $('[data-supbook="Govardhana"]').value === 'go_en')]);
  t.push(['ready: 10 sales, 1 pre-order, 1 donation, 460 USD; Upload 12 rows', /10 sales, 1 pre-order, 1 donation · 460 USD/.test(body) && (await page.textContent('#supGo')) === 'Upload 12 rows']);
  for (const w of [390, 1100]) {
    await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(300);
    const over = await page.evaluate(() => { const m = document.querySelector('#modal'); const R = m.getBoundingClientRect().right;
      return [...m.querySelectorAll('*')].filter(e => e.offsetParent && e.getBoundingClientRect().right > R + 1 && !e.closest('.sup-rows')).map(e => e.className || e.tagName)
        .concat([...m.querySelectorAll('.sup-rows')].filter(e => e.scrollWidth > e.clientWidth + 1).map(() => 'sup-rows scrolls sideways')).slice(0, 3); });
    t.push(['no overflow in the upload window at ' + w + 'px' + (over.length ? ' — ' + over.join(' | ') : ''), !over.length]);
    if (process.env.SUP_SHOTS) { await page.evaluate(() => { try{ snShow(false); }catch(e){} }); await page.mouse.move(w - 5, 5); await page.waitForTimeout(300);
      for (const [k, y] of [['top', 0], ['rows', 9999]]) { await page.evaluate(y => { $('#supBody').scrollTop = y; }, y); await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(process.env.SUP_SHOTS, 'upload-' + (w < 500 ? 'phone' : 'computer') + '-' + k + '.png') }); } }
  }
  const before = qty('sr_en');
  await page.click('#supGo'); await page.waitForTimeout(1500);
  const S = sales();
  t.push(['12 rows recorded at the event (' + S.length + ')', S.length === 12]);
  t.push(['…10 sales, 1 pre-order with its name, 1 donation', S.filter(s => s.type === 'SALE').length === 10 && S.filter(s => s.type === 'PREORDER' && s.name === 'Ananda Das').length === 1 && S.filter(s => s.type === 'DONATION').length === 1]);
  t.push(['…on 7 June with their times', S.every(s => new Date(s.ts).getMonth() === 5) && S.some(s => new Date(s.ts).getHours() === 17)]);
  t.push(['…copies came off the shelf (' + before + ' → ' + qty('sr_en') + ')', qty('sr_en') === before - 9]);
  t.push(['…Venmo joined the payment types here', (m.call({ action: 'getState', season: SA }).state.regions.find(r => r.regionId === R0.regionId).payTypes || []).includes('Venmo')]);
  const act = m.call({ action: 'activity', season: SA });
  const list = (act.result || act.activity || act.list || []);
  const ent = (Array.isArray(list) ? list : []).find(e => /Uploaded 10 sales, 1 pre-order and 1 donation from a spreadsheet \(isv-sample-test\.csv\) into/.test(e.text));
  t.push(['the Activity Log says what was uploaded, with undo', !!ent && ent.canUndo]);
  // Same file again: recognised as already in.
  await page.evaluate(() => salesUploadModal()); await page.waitForTimeout(300);
  await page.setInputFiles('#supFile', FILE); await page.waitForTimeout(400);
  t.push(['the same file again: rows already in start unticked', /already in the app/.test(await txt()) && await page.evaluate(() => $('#supGo').textContent === 'Upload')]);
  await page.evaluate(() => closeModal());
  if (ent) m.call({ season: SA, action: 'undoActivity', id: ent.id });
  t.push(['undo takes the whole upload out and puts the copies back', sales().length === 0 && qty('sr_en') === before]);
  t.push(['no errors in the page' + (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''), !errors.length]);
  await browser.close();
  let bad = 0;
  t.forEach(([n, ok]) => { if (!ok) bad++; console.log((ok ? '  ok   ' : '  FAIL ') + n); });
  console.log(bad ? `\n${bad} failed` : `\nall ${t.length} passed`);
  process.exit(bad ? 1 : 0);
})();
