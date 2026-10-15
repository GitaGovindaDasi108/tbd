/* Optional, needs Playwright + Chromium: node test/browser-lang.js
   b221: a title's language (the word in brackets at its end) gets a colour —
   a small label beside the title and a stripe down its card. Same language,
   same colour; each new language its own, without moving the others. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
const shot = n => path.join(os.tmpdir(), 'tbs-lang-' + n + '.png');

m.init();
const ok = (r, what) => { if (!r.ok) throw new Error(what + ': ' + r.error); return r; };
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason, pl = st.regions[0];
const c = (p, w) => ok(m.call(Object.assign({ season: SA }, p)), w || p.action);
const esId = c({ action: 'addBook', name: 'Sri Radha (Spanish)', cat: 'big' }).result;
const bgId = c({ action: 'addBook', name: 'Bhagavad Gita', cat: 'big' }).result;
st = m.call({ action: 'getState' }).state;
c({ action: 'setStockBulk', location: pl.whLoc, override: true,
    items: st.books.filter(b => !b.partnerId).map(b => ({ bookId: b.id, qty: 3 })) });
c({ action: 'sell', saleId: 's_ru', location: pl.whLoc, bookId: 'sr_ru', legs: [{ type: 'Cash', cur: 'PLN', amt: 150 }] });

(async () => {
  const browser = await chromium.launch();
  const t = [], errors = [];
  async function open(width) {
    const page = await browser.newPage({ viewport: { width: width || 1100, height: 1000 } });
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
    await page.goto('http://app.test/index.html'); await page.waitForTimeout(2000);
    return page;
  }
  // Each shelf card: its title, its label, and its stripe colour.
  const cards = page => page.evaluate(() => [...document.querySelectorAll('#invGrid .book:not(.don-card)')].map(e => {
    const tag = e.querySelector('.bname .lang-tag');
    return { title: e.querySelector('.bname').childNodes[0].textContent.trim(), tag: tag ? tag.textContent.trim() : '',
             tagColor: tag ? getComputedStyle(tag).color : '', stripe: getComputedStyle(e).borderLeftColor,
             stripeW: getComputedStyle(e).borderLeftWidth };
  }));
  const by = (list, title, tag) => list.find(x => x.title === title && x.tag === tag) || {};

  let page;
  try {
    page = await open();
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(400);
    let k = await cards(page);
    const srEn = by(k, 'Sri Radha', 'English'), goEn = by(k, 'Govardhana', 'English');
    const srRu = by(k, 'Sri Radha', 'Russian'), goRu = by(k, 'Govardhana', 'Russian');
    const srEs = by(k, 'Sri Radha', 'Spanish'), bg = by(k, 'Bhagavad Gita', '');
    t.push(['the title reads "Sri Radha" with its language as a label', !!srEn.title && !!srRu.title && !!srEs.title]);
    t.push(['English titles share one colour', srEn.tagColor && srEn.tagColor === goEn.tagColor]);
    t.push(['Russian titles share one colour', srRu.tagColor && srRu.tagColor === goRu.tagColor]);
    t.push(['English, Russian and Spanish are three different colours',
      new Set([srEn.tagColor, srRu.tagColor, srEs.tagColor]).size === 3]);
    t.push(['each card has a stripe in its language\'s colour', srEn.stripe === srEn.tagColor && srRu.stripe === srRu.tagColor && srEn.stripeW === '4px']);
    t.push(['a title with no language: no label, no stripe', bg.title === 'Bhagavad Gita' && bg.tag === '' && bg.stripeW !== '4px']);
    await page.screenshot({ path: shot('1-shelf') });

    // The same label in the other places a title stands on its own.
    t.push(['Distribution by Title: labels and stripes', await page.evaluate(() =>
      document.querySelectorAll('#titleList .stat-card.has-lang .lang-tag').length > 0)]);
    t.push(['sales log: the sale reads "Sri Radha" + Russian label', await page.evaluate(() => {
      const r = document.querySelector('#log .li-book'); return !!r && /^Sri Radha/.test(r.textContent.trim()) && r.querySelector('.lang-tag').textContent === 'Russian'; })]);
    await page.click('#adminActions [data-act="bookdisplay"]'); await page.waitForTimeout(300);
    t.push(['Edit Book Display: labels', await page.evaluate(() => document.querySelectorAll('#bdList .lang-tag').length >= 3)]);
    await page.screenshot({ path: shot('2-bookdisplay') });
    await page.evaluate(() => closeModal());
    await page.evaluate(() => goTo('season')); await page.waitForTimeout(300);
    t.push(['Warehouse Overview: labels and stripes', await page.evaluate(() =>
      document.querySelectorAll('#whOverview .stat-card.has-lang .lang-tag').length > 0)]);
    await page.screenshot({ path: shot('3-season'), fullPage: true });

    // A new language: its own colour, and nobody else's colour moves.
    const before = { en: srEn.tagColor, ru: srRu.tagColor, es: srEs.tagColor };
    const hiId = c({ action: 'addBook', name: 'Sri Radha (Hindi)', cat: 'big' }).result;
    c({ action: 'setStockBulk', location: pl.whLoc, override: true, items: [{ bookId: hiId, qty: 2 }] });
    await page.click('[data-act="refresh"]'); await page.waitForTimeout(1500);
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(400);
    k = await cards(page);
    const hi = by(k, 'Sri Radha', 'Hindi');
    t.push(['a new language (Hindi) gets a colour of its own, automatically', !!hi.tagColor && !Object.values(before).includes(hi.tagColor)]);
    t.push(['…and English, Russian and Spanish keep theirs',
      by(k, 'Sri Radha', 'English').tagColor === before.en && by(k, 'Sri Radha', 'Russian').tagColor === before.ru && by(k, 'Sri Radha', 'Spanish').tagColor === before.es]);
    // A ninth language and beyond never repeats a colour exactly.
    t.push(['twelve languages in the catalogue, twelve different colours', await page.evaluate(() => {
      const keep = STATE.books;
      STATE.books = Array.from({ length: 12 }, (_, i) => ({ id: 'L' + i, name: 'Sri Radha (Lang' + i + ')' }));
      try { return new Set(STATE.books.map(b => langColor(bookLang(b).lang).c)).size === 12; }
      finally { STATE.books = keep; }
    })]);
    t.push(['the book names themselves are unchanged (reports, spreadsheets)', m.call({ action: 'getState' }).state.books.some(b => b.name === 'Sri Radha (Spanish)')]);
    await page.close();

    page = await open(390);
    await page.evaluate(r => goTo('region', r), pl.regionId); await page.waitForTimeout(400);
    await page.screenshot({ path: shot('4-phone') });
    t.push(['phone: nothing wider than the screen', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)]);
    await page.close();
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
