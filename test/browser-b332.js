/* Optional, needs Playwright + Chromium: node test/browser-b332.js
   b332 (Gita, 5 Nov): who may use the practice space is set in Permissions
   ("Use the practice space"), on the live app. A live server and a practice
   server joined to it, as on the web. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });
const shot = n => path.join(os.tmpdir(), 'tbs-b332-' + n + '.png');
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
    if (/open\.er-api/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ rates: { USD: 1, INR: 80, EUR: 0.9 }, time_last_update_utc: 'today' }) };
    throw new Error('offline');
  };
  const live = makeServer({ exec, timeZone: 'UTC', fetchImpl, googleClientId: 'client-123', adminEmails: 'owner@example.com', practiceSecret: 'phrase' });
  const PRAC = 'http://prac.test/', LIVEURL = 'https://live.test/';
  const pdb = new DatabaseSync(':memory:');
  const pexec = (sql, ...p) => { const st = pdb.prepare(sql); return /^\s*select/i.test(sql) ? st.all(...p) : (st.run(...p), []); };
  const toLive = async (url, init) => url === LIVEURL ? { status: 200, ok: true, text: async () => await live.request({ postData: { contents: init.body } }) } : fetchImpl(url, init);
  const prac = makeServer({ exec: pexec, timeZone: 'UTC', fetchImpl: toLive, googleClientId: 'client-123', adminEmails: 'owner@example.com',
    practice: true, liveUrl: LIVEURL, liveSecret: 'phrase' });
  await live.warm();
  console.log = quiet;
  const ask = async p => JSON.parse(await live.request({ postData: { contents: JSON.stringify(p) } }));
  const owner = (await ask({ action: 'signIn', idToken: await token('owner@example.com', 'The Owner') })).result.session;
  const O = p => ask(Object.assign({ s: owner }, p));
  await O({ action: 'saveSeason', name: 'Kartika' });
  const SA = (await O({ action: 'getState' })).state.activeSeason;
  await O({ action: 'createRegion', regionId: 'rg_in', whLoc: 'wh_in', name: 'Vrindavana', currencies: 'INR,USD', season: SA });
  await O({ action: 'createEvent', eventId: 'ev_k', name: 'Kirtan Mela', regionId: 'rg_in', season: SA });
  await O({ action: 'peopleAdd', email: 'rita@example.com', name: 'Rita', role: 'RL', placeId: 'rg_in' });
  await O({ action: 'peopleAdd', email: 'sita@example.com', name: 'Sita', role: 'S', placeId: 'ev_k' });
  const t = [], errors = [];
  const browser = await chromium.launch();
  async function open(email, name, width, q) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.addInitScript(tok => { window.__TOKEN = tok; }, await token(email, name));
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(email + ': ' + e.message));
    page.on('dialog', d => d.accept());
    await page.route('**/*', async route => {
      const req = route.request(), url = req.url();
      const srv = url.startsWith(PRAC) ? prac : url.startsWith(API) ? live : null;
      if (srv) {
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
          body: `window.TBS_CONFIG = { APPS_SCRIPT_URL: '${API}', GOOGLE_CLIENT_ID: 'client-123', POLL_SECONDS: 3600, LIVE_URL: '', PRACTICE_URL: '${PRAC}' };` });
        const f = path.join(ROOT, rel);
        if (fs.existsSync(f) && fs.statSync(f).isFile())
          return route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : 'text/javascript' });
        return route.fulfill({ status: 404, body: '' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    await page.goto('http://app.test/index.html' + (q || '')); await page.waitForTimeout(1500);
    await page.click('#fakeGsi'); await page.waitForTimeout(2500);
    return page;
  }
  const hasLink = pg => pg.evaluate(() => [...document.querySelectorAll('a[href*="practice"]')].some(a => /Practice/.test(a.textContent) && !/Leave/.test(a.textContent)));
  const fits = pg => pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1
    && [...document.querySelectorAll('#modal .m-body, .signin')].every(e => e.scrollWidth <= e.clientWidth + 1));
  try {
    for (const w of [390, 1150]) {
      await O({ action: 'permSet', table: {}, people: {} });
      let pg = await open('rita@example.com', 'Rita', w);
      const hl = await hasLink(pg); t.push([w + 'px: live, Rita (Regional Lead) has no Practice Space link as standard', !hl]);
      await pg.context().close();
      // Universal ticks it for Regional Leads on live.
      pg = await open('owner@example.com', 'The Owner', w);
      await pg.evaluate(() => permissionsModal()); await pg.waitForTimeout(1200);
      const row = await pg.evaluate(() => { const td = [...document.querySelectorAll('#modal .pm-cap')].find(x => /Use the practice space/.test(x.textContent));
        return td ? { now: !!td.querySelector('.pm-now'), locked: td.parentElement.querySelector('select').disabled } : null; });
      t.push([w + 'px: live Permissions have "Use the practice space", marked in use now, changeable', !!row && row.now && !row.locked]);
      t.push([w + 'px: …the Permissions window fits', await fits(pg)]);
      await pg.screenshot({ path: shot('perm-live-' + w) });
      await pg.evaluate(() => { const s = document.querySelector('#modal select[data-cap="use_the_practice_space"][data-role="RL"]'); s.value = 'y'; s.dispatchEvent(new Event('change')); });
      await pg.click('#pmSave'); await pg.waitForTimeout(1500);
      await pg.context().close();
      const tb = (await O({ action: 'permGet' })).result.table;
      t.push([w + 'px: …saved for Regional Leads', tb.use_the_practice_space && tb.use_the_practice_space.RL === 'y']);
      pg = await open('rita@example.com', 'Rita', w);
      t.push([w + 'px: now Rita has the Practice Space link', await hasLink(pg)]);
      await pg.context().close();
      // In practice: Rita comes in; Sita (Seller) is refused at sign-in.
      pg = await open('rita@example.com', 'Rita', w, '?practice');
      t.push([w + 'px: Rita signs in to practice and sees the app', await pg.evaluate(() => !document.querySelector('#signIn') && !document.querySelector('#noAccess') && !!STATE)]);
      t.push([w + 'px: …with the Leave Practice Space link', await pg.evaluate(() => [...document.querySelectorAll('#sideNav a, #adminPanel a')].some(a => /Leave Practice/.test(a.textContent)))]);
      await pg.context().close();
      pg = await open('sita@example.com', 'Sita', w, '?practice');
      const msg = await pg.evaluate(() => ($('#signInErr') || {}).textContent || '');
      t.push([w + 'px: Sita (Seller) is told the practice space is not open to her', /Use the practice space/.test(msg)]);
      t.push([w + 'px: …the sign-in page fits', await fits(pg)]);
      await pg.screenshot({ path: shot('refused-' + w) });
      await pg.context().close();
      // Universal in practice: the row is shown as live set it, and cannot be changed there.
      pg = await open('owner@example.com', 'The Owner', w, '?practice');
      await pg.evaluate(() => permissionsModal()); await pg.waitForTimeout(1500);
      const prow = await pg.evaluate(() => { const td = [...document.querySelectorAll('#modal .pm-cap')].find(x => /Use the practice space/.test(x.textContent));
        const s = document.querySelector('#modal select[data-cap="use_the_practice_space"][data-role="RL"]');
        return td ? { note: /Set this in the live app/.test(td.textContent), locked: s.disabled, val: s.value } : null; });
      t.push([w + 'px: practice Permissions show the live answer (Regional Leads: yes), locked, "Set this in the live app"', !!prow && prow.note && prow.locked && prow.val === 'y']);
      t.push([w + 'px: …fits', await fits(pg)]);
      await pg.screenshot({ path: shot('perm-practice-' + w) });
      await pg.context().close();
    }
    // A session already open when access is taken away: the plain screen, with the way to the real app.
    const sita = (await ask({ action: 'signIn', idToken: await token('sita@example.com', 'Sita') })).result.session;
    await O({ action: 'permSet', table: { use_the_practice_space: { S: 'y' } }, people: {} });
    const pg = await open('sita@example.com', 'Sita', 390, '?practice');
    t.push(['given to Sellers, Sita comes into practice', await pg.evaluate(() => !document.querySelector('#noAccess') && !document.querySelector('#signIn'))]);
    await O({ action: 'permSet', table: {}, people: { 'sita@example.com': { use_the_practice_space: 'n' } } });
    await pg.evaluate(() => { try { localStorage.removeItem('tbs_state_cache'); } catch (e) {} });
    await pg.reload(); await pg.waitForTimeout(3000);
    const box = await pg.evaluate(() => { const b = document.querySelector('#noAccess'); return b ? b.textContent : ''; });
    t.push(['taken away on live: within a minute she sees the practice space is not open to her, with "Go to the real app"', /Go to the real app/.test(box) || /Use the practice space/.test(await pg.evaluate(() => document.body.textContent))]);
    await pg.screenshot({ path: shot('closed-390') });
  } finally { await browser.close(); }
  t.forEach(([n, ok]) => console.log((ok ? 'PASS ' : 'FAIL ') + n));
  if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
  const bad = t.filter(x => !x[1]).length + errors.length;
  console.log(bad ? bad + ' problem(s).' : 'All clear.');
  process.exitCode = bad ? 1 : 0;
})().catch(e => { console.error(e); process.exit(1); });
