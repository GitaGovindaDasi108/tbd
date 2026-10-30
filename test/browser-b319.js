/* Optional, needs Playwright + Chromium: node test/browser-b319.js
   b319 (Live app changes, Gita: "Seasonal leads need access to the cash
   tracker" / "Should also be for regional leads for their own region and
   event leads for their own event"): every lead has Track Cash, for its own
   places only; a Seller still has none. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });
const shot = n => path.join(os.tmpdir(), 'tbs-b319-' + n + '.png');
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
  const srv = makeServer({ exec, timeZone: 'UTC', fetchImpl, googleClientId: 'client-123', adminEmails: 'owner@example.com' });
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
    await page.goto('http://app.test/index.html' + (opts.live ? '' : '?practice')); await page.waitForTimeout(1500);
    await page.click('#fakeGsi'); await page.waitForTimeout(2500);
    page.cdp = await ctx.newCDPSession(page);
    return page;
  }
  try {
    /* Money at Vrindavana's warehouse, and some in another season. */
    await O({ action: 'adjustStockBulk', location: 'wh_in', items: [{ bookId: B[0], delta: 10 }], season: SA });
    await O({ action: 'adjustStockBulk', location: 'wh_x', items: [{ bookId: B[0], delta: 10 }], season: SB });
    await O({ action: 'sell', season: SA, saleId: 'S1', location: 'wh_in', bookId: B[0], legs: [{ type: 'Cash', cur: 'INR', amt: 500 }] });
    await O({ action: 'sell', season: SB, saleId: 'S2', location: 'wh_x', bookId: B[0], legs: [{ type: 'Cash', cur: 'USD', amt: 20 }] });

    /* The rules, asked of the server directly. */
    const mv = await asL({ action: 'cashMove', cashId: 'C1', fromAcct: 'wh_in', toAcct: 'wh_mt', cur: 'INR', amt: 100 });
    t.push(['she may move cash between her own places (' + (mv.error || 'ok') + ')', mv.ok !== false && !mv.error]);
    const bk = await asL({ action: 'cashMove', cashId: 'C2', fromAcct: 'wh_mt', toAcct: 'BANK', cur: 'INR', amt: 50 });
    t.push(['…and hand it to the Global Coordinator (' + (bk.error || 'ok') + ')', bk.ok !== false && !bk.error]);
    const rb = await asL({ action: 'cashMove', cashId: 'C3', fromAcct: 'wh_in', toAcct: 'BANK_rg_in', cur: 'INR', amt: 50 });
    t.push(['…and to her region\'s coordinator account (' + (rb.error || 'ok') + ')', rb.ok !== false && !rb.error]);
    const ox = await asL({ action: 'cashMove', cashId: 'C4', fromAcct: 'wh_x', toAcct: 'BANK', cur: 'USD', amt: 5 });
    t.push(['she cannot move another season\'s cash (' + (ox.error || 'allowed!') + ')', !!ox.error || ox.ok === false]);
    const bb = await asL({ action: 'cashMove', cashId: 'C5', fromAcct: 'BANK', toAcct: 'BANK_rg_x', cur: 'USD', amt: 5 });
    t.push(['…nor move bank money to another season', !!bb.error || bb.ok === false]);
    await O({ action: 'cashMove', cashId: 'C6', fromAcct: 'wh_x', toAcct: 'BANK', cur: 'USD', amt: 5, season: SB });
    const dx = await asL({ action: 'cashDelete', id: 'C6' });
    t.push(['…nor delete another season\'s cash entry', !!dx.error || dx.ok === false]);
    t.push(['…nor reset the tracker', !!(await asL({ action: 'cashResetAll' })).error]);
    const st = (await asL({ action: 'getState' })).state;
    t.push(['her state carries her season\'s cash entries only (' + (st.cash || []).map(c => c.id).sort().join(',') + ')',
      (st.cash || []).map(c => c.id).sort().join() === 'C1,C2,C3']);
    const del = await asL({ action: 'cashDelete', id: 'C3' });
    t.push(['she may delete her own season\'s entry', del.ok !== false && !del.error]);
    /* A Regional Lead: its own region. */
    await O({ action: 'peopleAdd', email: 'rl2@example.com', name: 'Reg Lead', role: 'RL', placeId: 'rg_in' });
    const R = await sessionOf('rl2@example.com', 'Reg Lead');
    const asR = p => ask(Object.assign({ s: R }, p));
    const rm = await asR({ action: 'cashMove', cashId: 'C7', fromAcct: 'wh_in', toAcct: 'BANK_rg_in', cur: 'INR', amt: 10 });
    t.push(['a Regional Lead may move its own region\'s cash (' + (rm.error || 'ok') + ')', rm.ok !== false && !rm.error]);
    const rx = await asR({ action: 'cashMove', cashId: 'C8', fromAcct: 'wh_mt', toAcct: 'BANK', cur: 'INR', amt: 1 });
    t.push(['…but not another region\'s (' + (rx.error || 'allowed!') + ')', !!rx.error || rx.ok === false]);

    /* An Event Lead: its own event. A Seller: nothing. */
    await O({ action: 'createEvent', eventId: 'ev_v1', name: 'Govardhan Puja', regionId: 'rg_in', season: SA });
    await O({ action: 'adjustStockBulk', location: 'ev_v1', items: [{ bookId: B[0], delta: 5 }], season: SA });
    await O({ action: 'sell', season: SA, saleId: 'S3', location: 'ev_v1', bookId: B[0], legs: [{ type: 'Cash', cur: 'INR', amt: 300 }] });
    await O({ action: 'peopleAdd', email: 'el@example.com', name: 'Ev Lead', role: 'EL', placeId: 'ev_v1' });
    await O({ action: 'peopleAdd', email: 'sel@example.com', name: 'Seller', role: 'S', placeId: 'ev_v1' });
    const E = await sessionOf('el@example.com', 'Ev Lead'), Sx = await sessionOf('sel@example.com', 'Seller');
    const asE = p => ask(Object.assign({ s: E }, p));
    const em = await asE({ action: 'cashMove', cashId: 'C9', fromAcct: 'ev_v1', toAcct: 'BANK_rg_in', cur: 'INR', amt: 100 });
    t.push(['an Event Lead may hand its event\'s cash to the region\'s coordinator (' + (em.error || 'ok') + ')', em.ok !== false && !em.error]);
    const ew = await asE({ action: 'cashMove', cashId: 'C10', fromAcct: 'wh_in', toAcct: 'ev_v1', cur: 'INR', amt: 1 });
    t.push(['…but not move the warehouse\'s cash (' + (ew.error || 'allowed!') + ')', !!ew.error || ew.ok === false]);
    const es = (await asE({ action: 'getState' })).state;
    t.push(['…and sees only its event\'s entries (' + (es.cash || []).map(c => c.id).join(',') + ')', (es.cash || []).map(c => c.id).join() === 'C9' && es.eventLead === true]);
    const sm = await ask({ s: Sx, action: 'cashMove', cashId: 'C11', fromAcct: 'ev_v1', toAcct: 'BANK', cur: 'INR', amt: 1 });
    t.push(['a Seller still has no cash tracker (' + sm.error + ')', !!sm.error || sm.ok === false]);

    /* In the app, on the live page. */
    const who = [['lead@example.com', 'Lead', 'rg_in', /Vrindavana — Warehouse/], ['rl2@example.com', 'Reg Lead', '', /Vrindavana — Warehouse/],
                 ['el@example.com', 'Ev Lead', '', /Govardhan Puja/], ['sel@example.com', 'Seller', '', null]];
    for (const [email, name, reg, sees] of who) for (const w of [390, 1150]) {
      const pg = await open(email, name, w, { live: true });
      if (reg) { await pg.selectOption('#locTabs [data-act="slregion"]', reg); await pg.waitForTimeout(600); }
      const has = await pg.evaluate(() => !!document.querySelector('#sideNav .sn-item[data-act="cash"], #adminActions [data-act="cash"]'));
      if (!sees) { t.push([w + 'px ' + name + ': no Track Cash in the menu', !has]); await pg.context().close(); continue; }
      t.push([w + 'px ' + name + ': Track Cash is in the menu', has]);
      await pg.evaluate(() => cashModal()); await pg.waitForTimeout(500);
      const txt = await pg.evaluate(() => (document.querySelector('#modal') || {}).innerText || '');
      t.push([w + 'px ' + name + ': Track Cash opens with its own place and the coordinators', sees.test(txt) && /Global Coordinator/.test(txt)
        && (name !== 'Ev Lead' || !/Warehouse/.test(txt))]);
      t.push([w + 'px ' + name + ': nothing sticks out sideways', await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth)]);
      await pg.screenshot({ path: shot('cash-' + name.replace(/ /g, '') + '-' + w) });
      await pg.context().close();
    }
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
