/* Optional, needs Playwright + Chromium: node test/browser-buttons.js
   Real-browser check for rewording buttons. The app runs in Chromium; every
   request to the Apps Script address is answered by the fake server (mini.js)
   running the real Code.gs. Nothing leaves this machine. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){ return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const m = require(ROOT + '/test/mini.js');
m.init();
const st0 = m.call({ action: 'getState' });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { try { if(!sessionStorage.getItem('seeded')){ localStorage.setItem('tbs_edit_wording', '1'); sessionStorage.setItem('seeded','1'); } } catch (e) {} });
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.includes('script.google.com')) {
      let p = {}; try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(m.call(p)) });
    }
    if (url.startsWith('http://app.test/')) {
      const f = path.join(ROOT, new URL(url).pathname.replace(/^\/+/, '') || 'index.html');
      if (fs.existsSync(f) && fs.statSync(f).isFile())
        return route.fulfill({ status: 200, body: fs.readFileSync(f),
          contentType: f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : undefined });
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 204, body: '' });   // fonts etc.: nothing external
  });
  await page.goto('http://app.test/index.html');
  await page.waitForTimeout(2500);

  await page.screenshot({ path: require('os').tmpdir()+'/tbs-editing.png' });
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400);
  await page.screenshot({ path: require('os').tmpdir()+'/tbs-editing-phone.png' });
  await page.setViewportSize({ width: 1100, height: 900 }); await page.waitForTimeout(400);
  const t = [];
  // Which buttons got a pencil?
  const info = await page.evaluate(() => {
    const withP = [...document.querySelectorAll('button')].filter(b => b.querySelector(':scope > .pencil'));
    const symbolOnly = [...document.querySelectorAll('button')].filter(b => !/[A-Za-z]{2}/.test(b.textContent));
    return { withPencil: withP.map(b => b.textContent.replace('✏️', '').trim()),
             symbolWithPencil: symbolOnly.filter(b => b.querySelector('.pencil')).length };
  });
  console.log('buttons with a pencil:', info.withPencil.slice(0, 12).join(' | '), info.withPencil.length > 12 ? '…' : '');
  t.push(['buttons get a pencil in edit mode', info.withPencil.length > 0]);
  t.push(['symbol-only buttons (✕ etc.) get no pencil', info.symbolWithPencil === 0]);

  // Pick a button that does something visible, and tap ITS PENCIL with the real mouse.
  const target = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(b => b.querySelector(':scope > .pencil')
      && (b.dataset.act || b.getAttribute('onclick')) && b.dataset.act !== 'editwording' && b.offsetParent);
    if (!b) return null;
    b.setAttribute('data-probe', '1');
    // Record whether the button's own action runs.
    window.__buttonFired = 0;
    b.addEventListener('click', () => { window.__buttonFired++; });
    return b.textContent.replace('✏️', '').trim();
  });
  console.log('testing on button:', JSON.stringify(target));
  await page.click('button[data-probe] > .pencil');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    fired: window.__buttonFired,
    modal: (document.querySelector('#modal') || {}).textContent || '' }));
  t.push(['tapping the pencil opens "Rewrite these words"', /Rewrite these words/.test(after.modal)]);
  t.push(['tapping the pencil does NOT press the button', after.fired === 0]);

  // Reword it and save.
  await page.fill('#lblText', 'My **new** words');
  await page.click('#lblSave');
  await page.waitForTimeout(1500);
  const now = await page.evaluate(() => {
    const b = document.querySelector('button[data-probe]') ||
      [...document.querySelectorAll('button')].find(x => /My new words/.test(x.textContent));
    return b ? { text: b.textContent.replace('✏️', '').trim(), bold: !!b.querySelector('b'), pencil: !!b.querySelector('.pencil') } : null;
  });
  console.log('button now reads:', JSON.stringify(now));
  t.push(['the button shows the new words', !!now && now.text === 'My new words']);
  t.push(['**bold** works on a button', !!now && now.bold]);
  t.push(['the reworded button can be reworded again (pencil kept)', !!now && now.pencil]);
  const saved = m.call({ action: 'getState' }).state.labels || {};
  t.push(['wording saved on the server', Object.values(saved).includes('My **new** words')]);

  // Turn editing off: pencils go, the button still does its job.
  await page.evaluate(() => { try { localStorage.setItem('tbs_edit_wording', '0'); } catch (e) {} });
  await page.reload(); await page.waitForTimeout(2500);
  const off = await page.evaluate(() => ({
    pencils: document.querySelectorAll('button .pencil').length,
    still: [...document.querySelectorAll('button')].some(x => x.textContent.trim() === 'My new words') }));
  t.push(['no pencils once editing is finished', off.pencils === 0]);
  t.push(['new words still shown after reload', off.still]);

  t.push(['no errors in the page', errors.length === 0]);
  if (errors.length) console.log('page errors:', errors);
  await page.screenshot({ path: require('os').tmpdir()+'/tbs-buttons.png' });
  t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
  await browser.close();
})();
