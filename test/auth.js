/* Signing in to the owner's app on the Cloudflare server (Phase 2).

   A stand-in "Google" signs ID tokens with its own key, so every check in
   server/src/auth.js runs for real: the signature, who the token is for, when
   it runs out, and the admin list. Links keep working with no sign-in. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });

(async () => {
  const quiet = console.log; console.log = () => {};
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const exec = (sql, ...p) => { const st = db.prepare(sql); return /^\s*select/i.test(sql) ? st.all(...p) : (st.run(...p), []); };
  const { makeServer } = await import(path.join(ROOT, 'server', 'src', 'core.js'));

  // A stand-in Google: a signing key, published the way Google publishes its keys.
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pub = Object.assign(await crypto.subtle.exportKey('jwk', pair.publicKey), { kid: 'k1', alg: 'RS256', use: 'sig' });
  const b64 = x => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
  async function token(claims, key) {
    const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const body = b64(Object.assign({ iss: 'https://accounts.google.com', aud: 'client-123', email: 'owner@example.com',
      email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600 }, claims));
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', (key || pair).privateKey, new TextEncoder().encode(head + '.' + body));
    return head + '.' + body + '.' + Buffer.from(sig).toString('base64url');
  }
  const fetchImpl = async url => {
    if (/googleapis\.com\/oauth2\/v3\/certs/.test(url)) return { ok: true, status: 200, json: async () => ({ keys: [pub] }) };
    throw new Error('offline');
  };
  const srv = makeServer({ exec, timeZone: 'UTC', fetchImpl, googleClientId: 'client-123', adminEmails: 'Owner@example.com, helper@example.com' });
  const ask = async p => JSON.parse(await srv.request({ postData: { contents: JSON.stringify(p) } }));

  const t = [];
  let r = await ask({ action: 'getState' });
  t.push(['the owner\'s app without signing in is refused, and asked to sign in', r.ok === false && r.signIn === true && !r.state]);
  r = await ask({ action: 'sell', location: 'x', bookId: 'y' });
  t.push(['…and so is any save', r.ok === false && r.signIn === true]);
  r = await ask({ action: 'ping' });
  t.push(['the revision check needs no sign-in (it says nothing else)', r.ok === true && typeof r.rev === 'number']);

  r = await ask({ action: 'signIn', idToken: await token({}) });
  t.push(['an admin signs in with Google and gets a session', r.ok && /^S[0-9a-f]{64}$/.test(r.result.session) && r.result.email === 'owner@example.com']);
  const s = r.result.session;
  r = await ask({ action: 'getState', s });
  if (!(r.ok === true && !!r.state)) process.stderr.write(JSON.stringify(r).slice(0, 400) + '\n');
  t.push(['with it, the app loads', r.ok === true && !!r.state && Array.isArray(r.state.books)]);
  t.push(['a session lasts 90 days', Math.abs(new Date((await ask({ action: 'signIn', idToken: await token({}) })).result.expires) - Date.now() - 90 * 864e5) < 60000]);

  const bad = async (claims, key) => (await ask({ action: 'signIn', idToken: await token(claims, key) }));
  const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  r = await bad({}, other);
  t.push(['a token not signed by Google is refused', r.ok === false && /not valid/.test(r.error)]);
  r = await bad({ aud: 'someone-else' });
  t.push(['a token meant for another app is refused', r.ok === false && /different app/.test(r.error)]);
  r = await bad({ exp: Math.floor(Date.now() / 1000) - 10 });
  t.push(['an expired token is refused', r.ok === false && /expired/.test(r.error)]);
  r = await bad({ email: 'stranger@example.com' });
  t.push(['someone not on the admin list is refused', r.ok === false && /not on the list/.test(r.error)]);
  r = await bad({ email_verified: false });
  t.push(['an unconfirmed email is refused', r.ok === false && /not confirmed/.test(r.error)]);
  r = await ask({ action: 'getState', s: 'S' + '0'.repeat(64) });
  t.push(['a made-up session is refused', r.ok === false && r.signIn === true]);

  // Links: no sign-in, exactly as before (Code.gs decides what a link may do).
  const st = (await ask({ action: 'getState', s })).state;
  await ask({ action: 'saveSeason', name: 'Tour', s });
  const sid = (await ask({ action: 'getState', s })).state.activeSeason;
  await ask({ action: 'createRegion', regionId: 'rg_x', whLoc: 'wh_x', name: 'Testland', currencies: 'EUR,USD', s, season: sid });
  await ask({ action: 'setKey', kind: 'region', id: 'rg_x', key: 'kcoordinator1', s, season: sid });
  r = await ask({ action: 'getState', k: 'kcoordinator1' });
  t.push(['a coordinator\'s link works with no sign-in', r.ok === true && r.state && r.state.role === 'coordinator']);
  r = await ask({ action: 'getState', k: 'knotarealkey' });
  t.push(['a wrong link is still refused', r.ok === false && /no longer valid/.test(r.error)]);
  r = await ask({ action: 'getState', k: '   ' });
  t.push(['a blank link is not the owner', r.ok === false && r.signIn === true]);

  await ask({ action: 'signOut', s });
  r = await ask({ action: 'getState', s });
  t.push(['signing out ends the session', r.ok === false && r.signIn === true]);

  // Taken off the list: their sessions stop working at once.
  const s2 = (await ask({ action: 'signIn', idToken: await token({ email: 'helper@example.com' }) })).result.session;
  const srv2 = makeServer({ exec, timeZone: 'UTC', fetchImpl, googleClientId: 'client-123', adminEmails: 'owner@example.com' });
  r = JSON.parse(await srv2.request({ postData: { contents: JSON.stringify({ action: 'getState', s: s2 }) } }));
  t.push(['someone taken off the admin list is signed out everywhere', r.ok === false && r.signIn === true]);

  const noSetup = makeServer({ exec, timeZone: 'UTC', fetchImpl, googleClientId: '', adminEmails: '' });
  r = JSON.parse(await noSetup.request({ postData: { contents: JSON.stringify({ action: 'getState' }) } }));
  t.push(['with sign-in not set up, the owner\'s app stays locked', r.ok === false && r.signIn === true]);

  console.log = quiet;
  void st;
  t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
})().catch(e => { console.error(e); process.exit(1); });
