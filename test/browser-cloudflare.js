/* Optional, needs Playwright + Chromium and server/node_modules (npm install in server/):
     node test/browser-cloudflare.js

   The whole thing, end to end (Phase 2): the real app page in a real browser,
   talking to the Cloudflare server running on Cloudflare's own runtime
   (wrangler dev, locally), signing in through a stand-in Google whose signing
   key the server is pointed at for this test only. Checks that the owner signs
   in once and stays signed in, that saving works and lands in the server's
   database, that signing out locks the app again, and that a coordinator's
   link needs no sign-in at all. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const ROOT = path.join(__dirname, '..'), SERVER = path.join(ROOT, 'server');
const PORT = 8788, CERTS = 8799;
const API = 'http://127.0.0.1:' + PORT + '/';

(async () => {
  const t = [];
  // A stand-in Google: a key pair, the public half published like Google's.
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pub = Object.assign(await crypto.subtle.exportKey('jwk', pair.publicKey), { kid: 'k1', alg: 'RS256', use: 'sig' });
  const b64 = x => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
  const tokenFor = async (email, name) => {
    const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const body = b64({ iss: 'https://accounts.google.com', aud: 'client-123', email, name,
      email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600 });
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(head + '.' + body));
    return head + '.' + body + '.' + Buffer.from(sig).toString('base64url');
  };
  const TOKEN = await tokenFor('owner@example.com', 'The Owner');
  const certs = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ keys: [pub] })); });
  await new Promise(r => certs.listen(CERTS, '127.0.0.1', r));

  // The server, on Cloudflare's runtime, with a fresh database.
  execFileSync(process.execPath, [path.join(SERVER, 'build.cjs')], { stdio: 'ignore' });
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'tbs-cf-'));
  const dev = spawn(path.join(SERVER, 'node_modules', '.bin', 'wrangler'), ['dev', '--port', String(PORT), '--ip', '127.0.0.1',
    '--persist-to', persist, '--var', 'GOOGLE_CLIENT_ID:client-123', '--var', 'ADMIN_EMAILS:owner@example.com',
    '--var', 'GOOGLE_CERTS_URL:http://127.0.0.1:' + CERTS + '/certs'],
    { cwd: SERVER, env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; dev.stdout.on('data', d => { log += d; }); dev.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 60 && !/Ready on/.test(log); i++) await new Promise(r => setTimeout(r, 1000));
  const api = async p => (await fetch(API, { method: 'POST', body: JSON.stringify(p) })).json();
  /* The page's requests to the server, passed on as they are. (Straight from a
     test page to a local address, the browser's network rules would refuse.) */
  const relay = async route => {
    const q = route.request();
    const r = await fetch(q.url(), { method: q.method(), body: q.method() === 'POST' ? q.postData() : undefined });
    return route.fulfill({ status: r.status, body: await r.text(), headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  };

  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1150, height: 1000 } });
  await ctx.addInitScript(tok => { window.__TOKEN = tok; }, TOKEN);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  if (process.env.DEBUG) {
    page.on('console', m => console.log('   console: ' + m.text()));
    page.on('response', async r => { if (r.url().startsWith(API)) console.log('   reply: ' + (await r.text()).slice(0, 160)); });
    page.on('requestfailed', r => console.log('   failed: ' + r.url() + ' ' + (r.failure() || {}).errorText));
  }
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(API)) return relay(route);
    if (/accounts\.google\.com\/gsi\/client/.test(url)) {
      // Google's sign-in button, standing in: pressing it hands over the signed token.
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: `
        window.google = { accounts: { id: {
          initialize(o){ window.__gsi = o; },
          renderButton(el){ el.innerHTML = '<button id="fakeGsi">Sign in with Google</button>';
            el.querySelector('button').onclick = () => window.__gsi.callback({ credential: window.__TOKEN }); },
          prompt(){} } } };` });
    }
    if (url.startsWith('http://127.0.0.1:8790/')) {
      const rel = new URL(url).pathname.replace(/^\/+/, '') || 'index.html';
      if (rel === 'config.js') return route.fulfill({ status: 200, contentType: 'text/javascript',
        body: `window.TBS_CONFIG = { APPS_SCRIPT_URL: '${API}', GOOGLE_CLIENT_ID: 'client-123', POLL_SECONDS: 3600 };` });
      const f = path.join(ROOT, rel);
      if (fs.existsSync(f) && fs.statSync(f).isFile())
        return route.fulfill({ status: 200, body: fs.readFileSync(f),
          contentType: f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : undefined });
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  // (Measured, not offsetParent: the sign-in screen is fixed over the page, which has none.)
  const visible = sel => page.evaluate(s => { const e = document.querySelector(s); if (!e) return false;
    const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; }, sel);

  try {
    t.push(['(the server started on Cloudflare\'s runtime)', /Ready on/.test(log)]);
    await page.goto('http://127.0.0.1:8790/index.html'); await page.waitForTimeout(2500);
    t.push(['the owner\'s app asks to sign in with Google', await visible('#signIn') && await visible('#fakeGsi')]);
    await page.screenshot({ path: path.join(os.tmpdir(), 'tbs-cf-signin.png') });
    await page.click('#fakeGsi'); await page.waitForTimeout(2500);
    t.push(['after signing in, the app loads', !(await page.$('#signIn')) &&
      await page.evaluate(() => !!STATE && Array.isArray(STATE.books) && STATE.books.length > 0)]);
    const s = await page.evaluate(() => SESSION.get());
    t.push(['this device keeps its session', /^S[0-9a-f]{64}$/.test(s)]);

    // Some records, then a sale saved the app's own way (kept on the device, sent in order).
    const sid = (await api({ action: 'getState', s })).state.activeSeason;
    await api({ action: 'createRegion', s, season: sid, regionId: 'rg_it', whLoc: 'wh_it', name: 'Italy', currencies: 'EUR,USD' });
    await api({ action: 'setStockBulk', s, season: sid, location: 'wh_it', items: [{ bookId: 'sr_en', qty: 5 }], override: true });
    await page.evaluate(() => pull()); await page.waitForTimeout(1500);
    await page.evaluate(() => { goTo('region', 'rg_it'); });
    await page.evaluate(() => commit({ action: 'sell', saleId: 'CF1', location: 'wh_it', bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] },
      st => { st.sales.push({ saleId: 'CF1', location: 'wh_it', bookId: 'sr_en', type: 'SALE', p1type: 'Cash', p1cur: 'EUR', p1amt: 35 }); }, 'Sold'));
    await page.waitForTimeout(2500);
    const after = (await api({ action: 'getState', s, season: sid })).state;
    t.push(['a sale made in the app is saved on the server', after.sales.some(x => x.saleId === 'CF1')]);
    t.push(['…and the stock went down (5 → 4)', after.inventory.some(i => i.location === 'wh_it' && i.bookId === 'sr_en' && Number(i.qty) === 4)]);

    await page.reload(); await page.waitForTimeout(2500);
    t.push(['coming back later: still signed in, no sign-in screen', !(await page.$('#signIn')) &&
      await page.evaluate(() => (STATE.sales || []).some(x => x.saleId === 'CF1'))]);

    // A coordinator's link: no sign-in, ever.
    await api({ action: 'setKey', s, season: sid, kind: 'region', id: 'rg_it', key: 'kitaly12345' });
    const other = await (await browser.newContext()).newPage();
    await other.route('**/*', r => route2(r));
    async function route2(r) {
      const url = r.request().url();
      if (url.startsWith(API)) return relay(r);
      if (url.startsWith('http://127.0.0.1:8790/')) {
        const rel = new URL(url).pathname.replace(/^\/+/, '') || 'index.html';
        if (rel === 'config.js') return r.fulfill({ status: 200, contentType: 'text/javascript',
          body: `window.TBS_CONFIG = { APPS_SCRIPT_URL: '${API}', GOOGLE_CLIENT_ID: 'client-123', POLL_SECONDS: 3600 };` });
        const f = path.join(ROOT, rel);
        if (fs.existsSync(f) && fs.statSync(f).isFile()) return r.fulfill({ status: 200, body: fs.readFileSync(f),
          contentType: f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : undefined });
        return r.fulfill({ status: 404, body: '' });
      }
      return r.fulfill({ status: 204, body: '' });
    }
    await other.goto('http://127.0.0.1:8790/index.html?k=kitaly12345'); await other.waitForTimeout(3000);
    t.push(['a coordinator\'s link opens with no sign-in', !(await other.$('#signIn')) &&
      await other.evaluate(() => !!STATE && STATE.role === 'coordinator' && (STATE.regions || []).some(r => r.regionId === 'rg_it'))]);

    /* Live updates (Phase 4). The regular check is set to once an hour on both
       pages, so only the live line can bring a change this quickly. */
    await other.evaluate(() => closeModal()); await other.waitForTimeout(500);   // (the link's "who are you?" question)
    t.push(['both apps have their live line open', await page.evaluate(() => LIVE.open) && await other.evaluate(() => LIVE.open)]);
    const sees = (pg, id) => pg.evaluate(id => (STATE.sales || []).some(x => x.saleId === id), id);
    const within = async (ms, fn) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await new Promise(r => setTimeout(r, 100)); } return -1; };
    await api({ action: 'sell', s, season: sid, saleId: 'LIVE1', location: 'wh_it', bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] });
    const msOwner = await within(3000, () => sees(page, 'LIVE1')), msLink = await within(3000, () => sees(other, 'LIVE1'));
    if (msLink < 0) console.log('   link:', await other.evaluate(() => JSON.stringify({ open: LIVE.open, due: LIVE.due, REV, hidden: document.hidden, overlay: document.querySelector('#overlay').classList.contains('show'), sales: (STATE.sales || []).map(x => x.saleId), loc: CUR_LOC })));
    console.log('   live: owner saw it in ' + msOwner + ' ms, the link in ' + msLink + ' ms');
    t.push(['a sale saved elsewhere shows on the owner\'s app within 3 seconds', msOwner >= 0]);
    t.push(['…and on the coordinator\'s link', msLink >= 0]);
    // A sale made on the link shows on the owner's app.
    await other.evaluate(() => commit({ action: 'sell', saleId: 'LIVE2', location: 'wh_it', bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] },
      st => { st.sales.push({ saleId: 'LIVE2', location: 'wh_it', bookId: 'sr_en', type: 'SALE', p1type: 'Cash', p1cur: 'EUR', p1amt: 35 }); }, 'Sold'));
    t.push(['a sale on the coordinator\'s phone shows on the owner\'s', (await within(4000, () => sees(page, 'LIVE2'))) >= 0]);
    // The line drops (a tunnel): it comes back by itself, and changes flow again.
    await page.evaluate(() => LIVE.ws.close());
    t.push(['a dropped line reconnects by itself', (await within(5000, () => page.evaluate(() => LIVE.open))) >= 0]);
    await api({ action: 'sell', s, season: sid, saleId: 'LIVE3', location: 'wh_it', bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] });
    t.push(['…and the next sale arrives over it', (await within(3000, () => sees(page, 'LIVE3'))) >= 0]);
    // With a form open, the screen is not redrawn under you; it catches up when the form closes.
    await page.evaluate(() => openModal('<div class="m-body">a form</div>'));
    await api({ action: 'sell', s, season: sid, saleId: 'LIVE4', location: 'wh_it', bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] });
    await page.waitForTimeout(1500);
    t.push(['while a form is open, the screen is left alone', !(await sees(page, 'LIVE4'))]);
    await page.evaluate(() => closeModal());
    t.push(['…and catches up once it closes', (await within(12000, () => sees(page, 'LIVE4'))) >= 0]);

    // Someone new asks to come in; the owner approves them in the Admins panel (b207).
    const hctx = await browser.newContext();
    await hctx.addInitScript(tok => { window.__TOKEN = tok; }, await tokenFor('helper@example.com', 'Helper Das'));
    const helper = await hctx.newPage();
    await helper.route('**/*', async r => {
      if (/accounts\.google\.com\/gsi\/client/.test(r.request().url())) return r.fulfill({ status: 200, contentType: 'text/javascript', body: `
        window.google = { accounts: { id: {
          initialize(o){ window.__gsi = o; },
          renderButton(el){ el.innerHTML = '<button id="fakeGsi">Sign in with Google</button>';
            el.querySelector('button').onclick = () => window.__gsi.callback({ credential: window.__TOKEN }); },
          prompt(){} } } };` });
      return route2(r);
    });
    await helper.goto('http://127.0.0.1:8790/index.html'); await helper.waitForTimeout(2500);
    await helper.click('#fakeGsi'); await helper.waitForTimeout(2000);
    const note = await helper.evaluate(() => (document.querySelector('#signInErr') || {}).textContent || '');
    t.push(['someone new signs in: their request is sent, kindly said', /request to use the app has been sent/.test(note) && /Helper Das/.test(note) && !!(await helper.$('#signIn'))]);
    await page.evaluate(() => poll()); await page.waitForTimeout(800);
    t.push(['the owner sees "1 waiting" on the People button', /People\s*1 waiting/.test(await page.evaluate(() => document.querySelector('#adminActions').innerText))]);
    await page.click('#adminActions [data-act="people"]'); await page.waitForTimeout(1500);
    t.push(['the People panel shows the request, with their name', /Helper Das/.test(await page.evaluate(() => document.querySelector('#modal').innerText))]);
    // Give them Universal (the old "admin"), from the request.
    await page.click('#modal [data-ppl="give"][data-email="helper@example.com"]'); await page.waitForTimeout(300);
    await page.selectOption('#pplRole', 'U'); await page.click('#pplAdd'); await page.waitForTimeout(1500);
    t.push(['giving them a role answers the request', await page.evaluate(() => !document.querySelector('#modal [data-ppl="decline"]') &&
      /Helper Das[\s\S]*Universal/.test(document.querySelector('#modal').innerText))]);
    await page.screenshot({ path: path.join(os.tmpdir(), 'tbs-cf-people.png') });
    await helper.click('#fakeGsi'); await helper.waitForTimeout(2500);
    t.push(['…and now they are in', !(await helper.$('#signIn')) && await helper.evaluate(() => !!STATE && Array.isArray(STATE.books))]);

    // A Regional Lead for Italy, added by email from the panel. (Italy gets an event, so she has somewhere to put an Event Lead.)
    await api({ action: 'createEvent', s, season: sid, eventId: 'ev_fest', name: 'Festival', regionId: 'rg_it' });
    await page.evaluate(() => closeModal()); await page.click('#adminActions [data-act="people"]'); await page.waitForTimeout(1500);
    await page.fill('#pplEmail', 'gita@example.com'); await page.fill('#pplName', 'Gita');
    await page.selectOption('#pplRole', 'RL'); await page.selectOption('#pplPlace', 'rg_it');
    await page.click('#pplAdd'); await page.waitForTimeout(1500);
    const addTxt = await page.evaluate(() => document.querySelector('#modal').innerText);
    t.push(['adding someone by email, as Regional Lead for Italy', /Gita[\s\S]*Regional Lead\s*·\s*Italy/.test(addTxt)]);
    if (!/Gita[\s\S]*Regional Lead\s*·\s*Italy/.test(addTxt)) console.log('   panel: ' + addTxt.replace(/\s+/g, ' ').slice(0, 900));
    await page.evaluate(() => closeModal());
    const gctx = await browser.newContext();
    await gctx.addInitScript(tok => { window.__TOKEN = tok; }, await tokenFor('gita@example.com', 'Gita Devi Dasi'));
    const gita = await gctx.newPage();
    gita.on('pageerror', e => errors.push('gita: ' + e.message));
    gita.on('dialog', d => d.accept());
    await gita.route('**/*', async r => {
      if (/accounts\.google\.com\/gsi\/client/.test(r.request().url())) return r.fulfill({ status: 200, contentType: 'text/javascript', body: `
        window.google = { accounts: { id: {
          initialize(o){ window.__gsi = o; },
          renderButton(el){ el.innerHTML = '<button id="fakeGsi">Sign in with Google</button>';
            el.querySelector('button').onclick = () => window.__gsi.callback({ credential: window.__TOKEN }); },
          prompt(){} } } };` });
      return route2(r);
    });
    await gita.goto('http://127.0.0.1:8790/index.html'); await gita.waitForTimeout(2500);
    await gita.click('#fakeGsi'); await gita.waitForTimeout(3000);
    t.push(['the Regional Lead signs in and gets Italy\'s regional view', !(await gita.$('#signIn')) &&
      await gita.evaluate(() => STATE && STATE.role === 'coordinator')]);
    t.push(['…her name shows in the top bar', /Gita/.test(await gita.evaluate(() => document.querySelector('#whoBtn').textContent))]);
    await gita.click('#adminActions [data-act="people"]'); await gita.waitForTimeout(1500);
    const roleChoices = await gita.$$eval('#pplRole option', o => o.map(x => x.value));
    const rolesOk = JSON.stringify(roleChoices.sort()) === JSON.stringify(['EL', 'RA', 'S']);
    t.push(['…her People panel offers only roles below her own', rolesOk]);
    if (!rolesOk) console.log('   roles offered: ' + roleChoices);
    t.push(['…and lists only Italy\'s people (not the owner\'s helper)', !/Helper Das/.test(await gita.evaluate(() => document.querySelector('#modal').innerText))]);
    await gita.screenshot({ path: path.join(os.tmpdir(), 'tbs-cf-people-rl.png') });
    await gita.evaluate(() => closeModal());
    await gita.click('#whoBtn'); await gita.waitForTimeout(400);
    await gita.fill('#myName', 'Gita'); await gita.click('#myNameSave'); await gita.waitForTimeout(1200);
    t.push(['…she sets her display name in "You"', /Gita$/.test((await gita.evaluate(() => document.querySelector('#whoBtn').textContent)).trim())]);
    await gita.evaluate(() => closeModal());

    // Two usable roles: she chooses which to work in.
    await api({ action: 'peopleAdd', s, email: 'gita@example.com', role: 'EL', placeId: 'ev_fest' });
    await gita.reload(); await gita.waitForTimeout(3000);
    t.push(['with two roles, the top bar says which one she is working in', /Gita · Regional Lead/.test(await gita.evaluate(() => document.querySelector('#whoBtn').textContent))]);
    await gita.click('#whoBtn'); await gita.waitForTimeout(400);
    const elId = await gita.evaluate(() => ME.grants.find(g => g.role === 'EL').id);
    await gita.click(`#modal input[name="actAs"][value="${elId}"]`, { noWaitAfter: true }); await gita.waitForTimeout(4000);
    t.push(['…choosing Event Lead opens the app as that role', await gita.evaluate(() => STATE && STATE.role === 'seller') &&
      /Gita · Event Lead/.test(await gita.evaluate(() => document.querySelector('#whoBtn').textContent))]);

    // Someone whose only role is not usable yet (Seasonal Assistant) is told so, plainly.
    await api({ action: 'peopleAdd', s, email: 'sita@example.com', role: 'SA', placeId: sid });
    const sctx = await browser.newContext();
    await sctx.addInitScript(tok => { window.__TOKEN = tok; }, await tokenFor('sita@example.com', 'Sita'));
    const sita = await sctx.newPage();
    sita.on('pageerror', e => errors.push('sita: ' + e.message));
    await sita.route('**/*', async r => {
      if (/accounts\.google\.com\/gsi\/client/.test(r.request().url())) return r.fulfill({ status: 200, contentType: 'text/javascript', body: `
        window.google = { accounts: { id: {
          initialize(o){ window.__gsi = o; },
          renderButton(el){ el.innerHTML = '<button id="fakeGsi">Sign in with Google</button>';
            el.querySelector('button').onclick = () => window.__gsi.callback({ credential: window.__TOKEN }); },
          prompt(){} } } };` });
      return route2(r);
    });
    await sita.goto('http://127.0.0.1:8790/index.html'); await sita.waitForTimeout(2500);
    await sita.click('#fakeGsi'); await sita.waitForTimeout(3000);
    const na = await sita.evaluate(() => (document.querySelector('#noAccess') || {}).innerText || '');
    t.push(['a Seasonal Assistant (not usable until Stage 2) sees "Not quite yet", with her role', /Not quite yet/.test(na) && /Seasonal Assistant/.test(na) && /next update/.test(na)]);
    await sita.screenshot({ path: path.join(os.tmpdir(), 'tbs-cf-noaccess.png') });

    await page.evaluate(() => signOut()); await page.waitForTimeout(3000);
    t.push(['signing out locks the app again', await visible('#signIn')]);
    t.push(['…and the old session no longer works', (await api({ action: 'getState', s })).signIn === true]);
    t.push(['no errors in the page', !errors.length]);
    if (errors.length) console.log('   errors: ' + errors.join(' | '));
  } catch (e) {
    t.push(['ran to the end: ' + e.message, false]);
  } finally {
    await browser.close();
    dev.kill('SIGINT'); certs.close();
    await new Promise(r => setTimeout(r, 500));
    try { fs.rmSync(persist, { recursive: true, force: true }); } catch (e) {}
  }
  if (t.some(x => !x[1])) console.log('--- server log ---\n' + log.split('\n').slice(-25).join('\n'));
  t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
  process.exit(0);
})();
