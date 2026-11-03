/* Optional, needs Playwright + Chromium: node test/browser-b326.js
   b326 (Gita chose "Add it on live" on a card): a shared link page offers
   "Have your own login? Sign in with Google ›", which opens the app without
   the link. A Season Lead on an old region link saw only that region. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });
const shot = n => path.join(os.tmpdir(), 'tbs-b326-' + n + '.png');
const API = 'http://api.test/';

(async () => {
  const quiet = console.log; console.log = () => {};
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const exec = (sql, ...p) => { const st = db.prepare(sql); return /^\s*select/i.test(sql) ? st.all(...p) : (st.run(...p), []); };
  const { makeServer } = await import(path.join(ROOT, 'server', 'src', 'core.js'));
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pub = Object.assign(await crypto.subtle.exportKey('jwk', pair.publicKey), { kid: 'k1', alg: 'RS256', use: 'sig' });
  const b64 = x => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
  async function token(email, name) {
    const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const body = b64({ iss: 'https://accounts.google.com', aud: 'client-123', email, name, email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600 });
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(head + '.' + body));
    return head + '.' + body + '.' + Buffer.from(sig).toString('base64url');
  }
  const fetchImpl = async url => {
    if (/oauth2\/v3\/certs/.test(url)) return { ok: true, status: 200, json: async () => ({ keys: [pub] }) };
    if (/open\.er-api/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ rates: { USD: 1, INR: 80 }, time_last_update_utc: 'today' }) };
    throw new Error('offline');
  };
  const srv = makeServer({ exec, timeZone: 'UTC', fetchImpl, googleClientId: 'client-123', adminEmails: 'owner@example.com', practice: true });
  await srv.warm();
  console.log = quiet;
  const ask = async p => JSON.parse(await srv.request({ postData: { contents: JSON.stringify(p) } }));
  const sessionOf = async (email, name) => (await ask({ action: 'signIn', idToken: await token(email, name) })).result.session;

  const owner = await sessionOf('owner@example.com', 'The Owner');
  const O = p => ask(Object.assign({ s: owner }, p));
  await O({ action: 'saveSeason', name: 'Kartika' });
  const SA = (await O({ action: 'getState' })).state.activeSeason;
  await O({ action: 'createRegion', regionId: 'rg_in', whLoc: 'wh_in', name: 'Vrindavana', currencies: 'INR,USD', season: SA });
  await O({ action: 'createRegion', regionId: 'rg_mt', whLoc: 'wh_mt', name: 'Mathura', currencies: 'INR,USD', season: SA });
  await O({ action: 'saveSeason', name: 'Other Tour' });
  const SB = (await O({ action: 'getState' })).state.activeSeason;
  await O({ action: 'createRegion', regionId: 'rg_x', whLoc: 'wh_x', name: 'Elsewhere', currencies: 'USD', season: SB });
  await O({ action: 'peopleAdd', email: 'lead@example.com', name: 'Lead', role: 'SL', placeId: SA });
  const B = (await O({ action: 'getState', season: SA })).state.books.filter(b => !b.partnerId).map(b => b.id);
  const L = await sessionOf('lead@example.com', 'Lead');
  const asL = p => ask(Object.assign({ s: L }, p));
  const stock = async loc => { const st = (await O({ action: 'getState', season: SA })).state; return (st.inventory || []).filter(i => i.location === loc && i.bookId === B[0]).reduce((a, i) => a + Number(i.qty), 0); };

  const browser = await chromium.launch();
  const t = [], errors = [];
  async function open(email, name, width, opts) {
    opts = opts || {};
    const ctx = await browser.newContext(Object.assign({ viewport: { width: width || 1150, height: opts.height || 1000 } },
      opts.phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}));
    await ctx.addInitScript(tok => { window.__TOKEN = tok; }, await token(email, name));
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(email + ': ' + e.message));
    page.on('dialog', d => d.accept(d.type() === 'prompt' ? 'UPI ref 4471' : undefined));
    await page.route('**/*', async route => {
      const req = route.request(), url = req.url();
      if (url.startsWith(API)) {
        const body = await srv.request({ postData: { contents: req.postData() || '{}' } });
        return route.fulfill({ status: 200, contentType: 'application/json', body, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
      if (/accounts\.google\.com\/gsi\/client/.test(url)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: `
        window.google = { accounts: { id: { initialize(o){ window.__gsi = o; },
          renderButton(el){ el.innerHTML = '<button id="fakeGsi">Sign in with Google</button>';
            el.querySelector('button').onclick = () => window.__gsi.callback({ credential: window.__TOKEN }); },
          prompt(){} } } };` });
      if (url.startsWith('http://app.test/')) {
        const rel = new URL(url).pathname.replace(/^\/+/, '') || 'index.html';
        if (rel === 'config.js') return route.fulfill({ status: 200, contentType: 'text/javascript',
          body: `window.TBS_CONFIG = { APPS_SCRIPT_URL: '${API}', GOOGLE_CLIENT_ID: 'client-123', POLL_SECONDS: 3600, LIVE_URL: '', PRACTICE_URL: '${API}' };` });
        const f = path.join(ROOT, rel);
        if (fs.existsSync(f) && fs.statSync(f).isFile())
          return route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : 'text/javascript' });
        return route.fulfill({ status: 404, body: '' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    if (opts.key) await ctx.addInitScript(k => { try { localStorage.setItem('tbs_who_' + k, 'Lead'); } catch (e) {} }, opts.key);
    await page.goto('http://app.test/index.html' + (opts.q || '')); await page.waitForTimeout(1500);
    if (!opts.key) { await page.click('#fakeGsi'); } await page.waitForTimeout(2500);
    page.cdp = await ctx.newCDPSession(page);
    return page;
  }
  try {
    await O({ action: 'setKey', kind: 'region', id: 'rg_in', season: SA });
    const key = (((await O({ action: 'getState', season: SA })).state.keys || {}).regions || {}).rg_in;
    t.push(['the region has a coordinator link to open (' + key + ')', !!key && typeof key === 'string']);
    for (const w of [390, 1150]) {
      for (const q of ['', '&practice']) {
        const pg = await open('lead@example.com', 'Lead', w, { key, q: '?k=' + key + q });
        const got = await pg.evaluate(() => { const e = document.querySelector('#linkSignIn');
          return { shown: !!e && !e.hidden, text: e ? e.innerText.trim() : '', href: e ? e.querySelector('a').getAttribute('href') : '' }; });
        t.push([w + 'px' + (q ? ' practice' : '') + ': the link page offers sign-in (' + got.text + ' → ' + got.href + ')',
          got.shown && /Sign in with Google/.test(got.text) && !/k=/.test(got.href) && (q ? /practice/.test(got.href) : !/practice/.test(got.href))]);
        t.push([w + 'px' + (q ? ' practice' : '') + ': nothing sticks out sideways', await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth)]);
        if (!q) {
          await pg.evaluate(() => askWhoAmI(true)); await pg.waitForTimeout(300);
          t.push([w + 'px: the name window offers it too', await pg.evaluate(() => !!document.querySelector('#modal .link-signin-a'))]);
          await pg.screenshot({ path: shot('modal-' + w) }); await pg.evaluate(() => closeModal());
          await pg.click('#linkSignIn a'); await pg.waitForTimeout(2500);
          const after = await pg.evaluate(() => ({ url: location.search, gsi: !!document.querySelector('#fakeGsi') }));
          t.push([w + 'px: tapping it opens the app without the link, at Google sign-in (' + after.url + ')', !/k=/.test(after.url) && after.gsi]);
          await pg.click('#fakeGsi'); await pg.waitForTimeout(2500);
          const regs = await pg.evaluate(() => [...(document.querySelector('#locTabs [data-act="slregion"]') || { options: [] }).options].map(o => o.textContent.trim()));
          t.push([w + 'px: …and once signed in she has the whole season (' + regs.join(', ') + ')', regs.includes('Vrindavana') && regs.includes('Mathura')]);
          await pg.screenshot({ path: shot('link-' + w) });
        }
        await pg.context().close();
      }
    }
    const pg = await open('lead@example.com', 'Lead', 390, { q: '' });
    t.push(['signed in without a link, the line is not there', await pg.evaluate(() => document.querySelector('#linkSignIn').hidden)]);
    await pg.context().close();
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
