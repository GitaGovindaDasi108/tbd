/* Optional, needs Playwright + Chromium: node test/browser-b317.js
   b317 (Live app changes, practice first; Gita chose "Build it" on a card):
   a Season Lead works across every region of its season, like a Regional Lead
   in each, and may add regions and events there. Nothing outside the season. */
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){
  return require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });
const shot = n => path.join(os.tmpdir(), 'tbs-b317-' + n + '.png');
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
    await page.goto('http://app.test/index.html' + (opts.live ? '' : '?practice')); await page.waitForTimeout(1500);
    await page.click('#fakeGsi'); await page.waitForTimeout(2500);
    page.cdp = await ctx.newCDPSession(page);
    return page;
  }
  try {
    /* The rules, asked of the server directly. */
    const st = (await asL({ action: 'getState' })).state;
    t.push(['the server lets her in, with both of the season\'s regions and nothing else (' + (st.regions || []).map(r => r.name).join(', ') + ')',
      !!st && st.seasonLead === true && (st.regions || []).map(r => r.regionId).sort().join() === 'rg_in,rg_mt']);
    t.push(['she may add stock in either region', (await asL({ action: 'adjustStockBulk', location: 'wh_mt', items: [{ bookId: B[0], delta: 5 }] })).ok
      && (await asL({ action: 'adjustStockBulk', location: 'wh_in', items: [{ bookId: B[0], delta: 4 }] })).ok && await stock('wh_mt') === 5]);
    t.push(['…and move stock between the two', (await asL({ action: 'transferMulti', moves: [{ from: 'wh_in', to: 'wh_mt', bookId: B[0], qty: 2 }] })).ok !== false]);
    t.push(['she may add an event in either region', (await asL({ action: 'createEvent', eventId: 'ev_m1', name: 'Kirtan', regionId: 'rg_mt' })).ok]);
    t.push(['she may add a region to her season', (await asL({ action: 'createRegion', regionId: 'rg_rk', whLoc: 'wh_rk', name: 'Radha Kunda', currencies: 'INR' })).ok
      && ((await O({ action: 'getState', season: SA })).state.regions || []).some(r => r.regionId === 'rg_rk')]);
    t.push(['…and it is not put in another season', !((await O({ action: 'getState', season: SB })).state.regions || []).some(r => r.regionId === 'rg_rk')]);
    const out = await asL({ action: 'adjustStockBulk', location: 'wh_x', items: [{ bookId: B[0], delta: 1 }] });
    t.push(['she cannot touch another season (' + (out.error || 'allowed!') + ')', !out.ok]);
    const hq = await asL({ action: 'adjustStockBulk', location: 'wh_hq', items: [{ bookId: B[0], delta: 1 }] });
    t.push(['…nor Earthly HQ', !hq.ok]);
    t.push(['…nor Universal-only things such as Edit Wording', !(await asL({ action: 'setLabel', key: 'x', text: 'y' })).ok]);

    /* In the app. */
    for (const w of [390, 1150]) {
      const pg = await open('lead@example.com', 'Lead', w);
      const path = () => pg.evaluate(() => [...document.querySelectorAll('#locTabs .crumb-btn, #locTabs select')].map(x => x.tagName === 'SELECT' ? '[' + x.selectedOptions[0].textContent.trim() + ']' : x.textContent.trim()).join(' › '));
      const p0 = await path();
      t.push([w + 'px: she opens on her season, no "Not quite yet" (' + p0 + ')', /^Kartika/.test(p0) && !(await pg.evaluate(() => /Not quite yet/.test(document.body.innerText)))]);
      await pg.selectOption('#locTabs [data-act="slregion"]', 'rg_mt'); await pg.waitForTimeout(600);
      const p1 = await path();
      t.push([w + 'px: the path picks a region, then its events (' + p1 + ')', /\[Mathura\]/.test(p1) && /Summary/.test(p1)]);
      await pg.selectOption('#locTabs [data-act="slevent"]', 'ev_m1'); await pg.waitForTimeout(600);
      t.push([w + 'px: …and an event', await pg.evaluate(() => CUR_LEVEL === 'event' && CUR_LOC === 'ev_m1')]);
      const menu = await pg.evaluate(() => [...document.querySelectorAll('#sideNav .sn-group .sn-item .sn-t')].map(x => x.textContent.trim()));
      t.push([w + 'px: her menu has Add New Stock and Transfer Existing Stock', menu.includes('Add New Stock') && menu.includes('Transfer Existing Stock')]);
      const regs = await pg.evaluate(() => [...document.querySelector('#locTabs [data-act="slregion"]').options].map(o => o.textContent.trim()));
      t.push([w + 'px: the region list offers "＋ New region…" and no other season (' + regs.join(', ') + ')', regs.some(x => /New region/.test(x)) && !regs.some(x => /Elsewhere/.test(x))]);
      t.push([w + 'px: nothing sticks out sideways', await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth)]);
      await pg.screenshot({ path: shot('lead-' + w) });
      await pg.context().close();
    }
    /* b318: Season Lead is live too: a live server (practice off) lets her in. */
    const live = makeServer({ exec, timeZone: 'UTC', fetchImpl, googleClientId: 'client-123', adminEmails: 'owner@example.com' });
    await live.warm();
    const lask = async p => JSON.parse(await live.request({ postData: { contents: JSON.stringify(p) } }));
    const lsess = async (email, name) => (await lask({ action: 'signIn', idToken: await token(email, name) })).result.session;
    const lo = await lsess('owner@example.com', 'The Owner');
    await lask({ action: 'saveSeason', name: 'Live Kartika', s: lo });
    const LS = (await lask({ action: 'getState', s: lo })).state.activeSeason;
    await lask({ action: 'peopleAdd', email: 'live.lead@example.com', name: 'Live Lead', role: 'SL', placeId: LS, s: lo });
    const ll = await lsess('live.lead@example.com', 'Live Lead');
    const lv = await lask({ action: 'getState', s: ll });
    t.push(['b318: on the live app a Season Lead opens her own season (' + String(lv.error || 'ok').slice(0, 40) + ')', lv.ok !== false && !lv.noAccess && lv.state && lv.state.lockedSeason === LS]);
    const lr = await lask({ action: 'createRegion', regionId: 'rg_live', whLoc: 'wh_live', name: 'Radha Kunda', currencies: 'USD', season: LS, s: ll });
    t.push(['b318: on the live app she can add a region to her season', lr.ok !== false && !lr.error]);
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
