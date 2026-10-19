/* People and roles on the Cloudflare server (b222, docs/PERMISSIONS.md).

   Everyone signs in with Google (a stand-in Google signs the tokens, as in
   test/auth.js). Checks who may give and remove which role where, what each
   role can use until Stage 2, names on what people record, roles ending when
   their place closes, sign-in requests, and the old admin list carried over. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });

(async () => {
  const quiet = console.log; console.log = () => {};
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const exec = (sql, ...p) => { const st = db.prepare(sql); return /^\s*select/i.test(sql) ? st.all(...p) : (st.run(...p), []); };
  // An admin added the old way, before roles: must come out Universal.
  exec('CREATE TABLE admin (email TEXT PRIMARY KEY, name TEXT NOT NULL, addedBy TEXT NOT NULL, addedAt INTEGER NOT NULL)');
  exec('INSERT INTO admin (email, name, addedBy, addedAt) VALUES (?, ?, ?, ?)', 'oldadmin@example.com', 'Old Admin', 'owner@example.com', 1);
  const { makeServer } = await import(path.join(ROOT, 'server', 'src', 'core.js'));

  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pub = Object.assign(await crypto.subtle.exportKey('jwk', pair.publicKey), { kid: 'k1', alg: 'RS256', use: 'sig' });
  const b64 = x => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
  async function token(email, name) {
    const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const body = b64({ iss: 'https://accounts.google.com', aud: 'client-123', email, name: name || '', email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600 });
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(head + '.' + body));
    return head + '.' + body + '.' + Buffer.from(sig).toString('base64url');
  }
  const fetchImpl = async url => {
    if (/googleapis\.com\/oauth2\/v3\/certs/.test(url)) return { ok: true, status: 200, json: async () => ({ keys: [pub] }) };
    throw new Error('offline');
  };
  const srv = makeServer({ exec, timeZone: 'UTC', fetchImpl, googleClientId: 'client-123', adminEmails: 'owner@example.com' });
  const ask = async p => JSON.parse(await srv.request({ postData: { contents: JSON.stringify(p) } }));
  const signIn = async (email, name) => ask({ action: 'signIn', idToken: await token(email, name) });
  const session = async (email, name) => { const r = await signIn(email, name); return r.ok ? r.result.session : null; };

  const t = [];
  const owner = await session('owner@example.com', 'The Owner');
  const O = p => ask(Object.assign({ s: owner }, p));

  // A season with Italy (two events) and Poland (one event); a second season.
  await O({ action: 'saveSeason', name: 'Europe Tour' });
  let st = (await O({ action: 'getState' })).state;
  const SA = st.activeSeason;
  const B = st.books.filter(b => !b.partnerId)[0].id;
  await O({ action: 'createRegion', regionId: 'rg_it', whLoc: 'wh_it', name: 'Italy', currencies: 'EUR,USD', season: SA });
  await O({ action: 'createRegion', regionId: 'rg_pl', whLoc: 'wh_pl', name: 'Poland', currencies: 'PLN,USD', season: SA });
  await O({ action: 'createEvent', eventId: 'ev_yoga', name: 'Yoga Studio', regionId: 'rg_it', season: SA });
  await O({ action: 'createEvent', eventId: 'ev_rome', name: 'Rome Temple', regionId: 'rg_it', season: SA });
  await O({ action: 'createEvent', eventId: 'ev_krak', name: 'Krakow Fair', regionId: 'rg_pl', season: SA });
  await O({ action: 'adjustStockBulk', location: 'ev_yoga', items: [{ bookId: B, delta: 20 }], override: true, season: SA });
  await O({ action: 'adjustStockBulk', location: 'ev_rome', items: [{ bookId: B, delta: 20 }], override: true, season: SA });

  // ---- The old admin list ----
  let r = await signIn('oldadmin@example.com');
  t.push(['an admin from before roles signs in as Universal', r.ok && (await ask({ action: 'me', s: r.result.session })).result.universal === true]);

  // ---- Universal gives roles ----
  r = await O({ action: 'peopleAdd', email: 'Gita@example.com', name: 'Gita', role: 'RL', placeId: 'rg_it' });
  t.push(['Universal gives a Regional Lead for Italy', r.ok && r.result.people.some(x => x.email === 'gita@example.com' && x.grants.some(g => g.role === 'RL' && /Italy/.test(g.place)))]);
  r = await O({ action: 'peopleAdd', email: 'gita@example.com', role: 'RL', placeId: 'rg_it' });
  t.push(['…the same role twice is refused', !r.ok && /already/.test(r.error)]);
  r = await O({ action: 'peopleAdd', email: 'not-an-email', role: 'S', placeId: 'ev_yoga' });
  t.push(['…a bad email is refused', !r.ok && /full email/.test(r.error)]);

  // ---- The Regional Lead ----
  const gita = await session('gita@example.com', 'Gita Devi Dasi');
  const G = p => ask(Object.assign({ s: gita }, p));
  r = await G({ action: 'getState' });
  t.push(['a Regional Lead signs in and works as Italy\'s regional link', r.ok && r.state.role === 'coordinator' && r.acting]);
  r = await G({ action: 'createEvent', eventId: 'ev_milan', name: 'Milan Fair', regionId: 'rg_it' });
  t.push(['…can create an event in Italy', r.ok]);
  r = await G({ action: 'sell', location: 'ev_krak', bookId: B, legs: [{ type: 'Cash', cur: 'PLN', amt: 10 }] });
  t.push(['…cannot sell in Poland', !r.ok && /does not cover/.test(r.error)]);
  r = await G({ action: 'peopleAdd', email: 'radha@example.com', role: 'EL', placeId: 'ev_yoga' });
  t.push(['…gives an Event Lead at an Italian event', r.ok]);
  r = await G({ action: 'peopleAdd', email: 'radha@example.com', role: 'RA', placeId: 'rg_it' });
  t.push(['…and a Regional Assistant for Italy (several roles, one person)', r.ok && r.result.people.find(x => x.email === 'radha@example.com').grants.length === 2]);
  r = await G({ action: 'peopleAdd', email: 'x@example.com', role: 'EL', placeId: 'ev_krak' });
  t.push(['…cannot give a role in Poland', !r.ok && /cannot give/.test(r.error)]);
  r = await G({ action: 'peopleAdd', email: 'x@example.com', role: 'RL', placeId: 'rg_it' });
  t.push(['…cannot give her own role', !r.ok]);
  r = await G({ action: 'peopleAdd', email: 'x@example.com', role: 'U' });
  t.push(['…nor Universal', !r.ok]);
  r = await G({ action: 'peopleList' });
  t.push(['…sees only people with roles in Italy', r.ok && !r.result.people.some(x => x.email === 'oldadmin@example.com') &&
    r.result.choices.every(c => ['RA', 'EL', 'S'].includes(c.role))]);

  // ---- The Event Lead (also a Regional Assistant) ----
  const radha = await session('radha@example.com', 'R. Smith');
  const R = p => ask(Object.assign({ s: radha }, p));
  let me = (await R({ action: 'me' })).result;
  const elId = me.grants.find(g => g.role === 'EL').id, raId = me.grants.find(g => g.role === 'RA').id;
  t.push(['her roles: Event Lead usable now; Regional Assistant waits for the next update',
    me.grants.find(g => g.id === elId).usable && !me.grants.find(g => g.id === raId).usable]);
  r = await R({ action: 'getState', g: raId });
  t.push(['asking to act as the Assistant falls back to her usable role', r.ok && r.state.role === 'seller' && r.acting === elId]);
  r = await R({ action: 'setMyName', name: 'Radha' });
  t.push(['she sets her display name', r.ok && r.result.name === 'Radha']);
  r = await R({ action: 'sell', saleId: 'sY1', location: 'ev_yoga', bookId: B, by: 'Someone Else', legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] });
  t.push(['…sells at her event', r.ok]);
  st = (await O({ action: 'getState', season: SA })).state;
  t.push(['…and the sale carries her name, whatever the page sent', (st.sales.find(x => x.saleId === 'sY1') || {}).soldBy === 'Radha']);
  r = await R({ action: 'sell', location: 'ev_rome', bookId: B, legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] });
  t.push(['…cannot sell at another event', !r.ok && /does not cover/.test(r.error)]);
  r = await R({ action: 'peopleAdd', email: 'sita@example.com', role: 'S', placeId: 'ev_yoga' });
  t.push(['…adds a Seller at her event', r.ok]);
  r = await R({ action: 'peopleAdd', email: 'sita@example.com', role: 'S', placeId: 'ev_rome' });
  t.push(['…not at another event', !r.ok]);
  r = await R({ action: 'peopleAdd', email: 'sita@example.com', role: 'EL', placeId: 'ev_yoga' });
  t.push(['…and no role but Seller', !r.ok]);
  r = await G({ action: 'peopleAdd', email: 'tulasi@example.com', role: 'S', placeId: 'ev_yoga' });
  const tulasiId = r.result.people.find(x => x.email === 'tulasi@example.com').grants[0].id;
  r = await R({ action: 'peopleRemove', id: tulasiId });
  t.push(['an Event Lead cannot remove a Seller someone else added', !r.ok]);
  r = await R({ action: 'peopleList' });
  const sitaId = r.result.people.find(x => x.email === 'sita@example.com').grants[0].id;
  r = await R({ action: 'peopleRemove', id: elId });
  t.push(['…nor her own role', !r.ok && /your own/.test(r.error)]);
  r = await R({ action: 'emergencyLink', eventId: 'ev_yoga' });
  const key = r.ok && r.result.key;
  t.push(['…makes an emergency link for her event', !!key]);
  r = await ask({ action: 'getState', k: key });
  t.push(['…which works as a sales link for that event', r.ok && r.state.role === 'seller']);
  r = await R({ action: 'emergencyLink', eventId: 'ev_rome' });
  t.push(['…but not for another event', !r.ok]);

  // ---- The Seller ----
  const sita = await session('sita@example.com', 'Sita');
  const S = p => ask(Object.assign({ s: sita }, p));
  r = await S({ action: 'getState' });
  t.push(['a Seller signs in and works as a sales link for her event', r.ok && r.state.role === 'seller']);
  r = await S({ action: 'peopleList' });
  t.push(['…sees no People panel', !r.ok]);
  r = await S({ action: 'createEvent', eventId: 'ev_x', name: 'X', regionId: 'rg_it' });
  t.push(['…cannot create events', !r.ok && /not available/.test(r.error)]);
  r = await S({ action: 'adminsList' });
  t.push(['…nor reach the old Admins panel', !r.ok]);
  r = await R({ action: 'peopleRemove', id: sitaId });
  t.push(['the Event Lead removes the Seller she added', r.ok]);
  r = await S({ action: 'getState' });
  t.push(['…and the Seller is signed out at once', !r.ok && r.signIn === true]);

  // ---- Sign-in requests ----
  r = await signIn('newbie@example.com', 'New Person');
  t.push(['someone with no role leaves a request', !r.ok && r.pending]);
  r = await G({ action: 'peopleList' });
  t.push(['…the Regional Lead sees it', r.ok && r.result.requests.some(x => x.email === 'newbie@example.com')]);
  r = await G({ action: 'peopleAdd', email: 'newbie@example.com', role: 'S', placeId: 'ev_rome' });
  t.push(['…and answers it with a Seller role', r.ok && !r.result.requests.some(x => x.email === 'newbie@example.com')]);
  r = await signIn('newbie@example.com', 'New Person');
  t.push(['…after which they get in', r.ok && !!r.result.session]);
  r = await (await signIn('nosy@example.com')) && await R({ action: 'peopleList' });
  t.push(['an Event Lead can answer requests too (Sellers only)', r.ok && r.result.requests.some(x => x.email === 'nosy@example.com')]);
  r = await R({ action: 'peopleDecline', email: 'nosy@example.com' });
  t.push(['…and decline one', r.ok && !r.result.requests.some(x => x.email === 'nosy@example.com')]);

  // ---- Roles end when their place closes ----
  await O({ action: 'closeLocation', kind: 'event', id: 'ev_yoga', counts: {}, season: SA });
  r = await R({ action: 'getState' });
  t.push(['when Yoga Studio closes, its Event Lead has nothing usable left', !r.ok && r.noAccess === true]);
  me = (await R({ action: 'me' })).result;
  t.push(['…her role shows why', /Yoga Studio is closed/.test(me.grants.find(g => g.id === elId).why)]);
  await O({ action: 'reopenLocation', kind: 'event', id: 'ev_yoga', season: SA });
  r = await R({ action: 'getState' });
  t.push(['…and reopening it brings the role back', r.ok && r.state.role === 'seller']);

  // ---- Universal ----
  r = await O({ action: 'peopleAdd', email: 'finance@example.com', role: 'F' });
  t.push(['only Universal gives Finance', r.ok]);
  r = await G({ action: 'peopleAdd', email: 'finance2@example.com', role: 'F' });
  t.push(['…a Regional Lead cannot', !r.ok]);
  r = await O({ action: 'peopleAdd', email: 'helper@example.com', role: 'U' });
  const helper = await session('helper@example.com');
  r = await ask({ action: 'getState', s: helper });
  t.push(['someone given Universal gets the full app', r.ok && r.state.role === 'admin']);
  r = await ask({ action: 'peopleList', s: helper });
  t.push(['…sees everyone, the owner included', r.ok && r.result.people.some(x => x.email === 'owner@example.com' && x.owner)]);
  r = await ask({ action: 'adminsList', s: helper });
  t.push(['the old Admins panel lists Universal people', r.ok && r.result.admins.some(a => a.email === 'helper@example.com')]);

  // ---- Each person's own book order, kept with their login (b243) ----
  r = await G({ action: 'setMyPref', key: 'bookOrder', value: ['b3', 'b1', 'b2'] });
  t.push(['b243: a person keeps their own book order', r.ok && JSON.stringify(r.result.prefs.bookOrder) === '["b3","b1","b2"]']);
  r = await G({ action: 'me' });
  t.push(['…it comes back with "me" (any device they sign in on)', r.ok && JSON.stringify(r.result.prefs.bookOrder) === '["b3","b1","b2"]']);
  r = await ask({ action: 'me', s: helper });
  t.push(['…nobody else gets it', r.ok && !r.result.prefs.bookOrder]);
  r = await G({ action: 'setMyPref', key: 'bookOrderPhone', value: ['b2', 'b3'] });
  t.push(['b244: …and a different one for phones, alongside', r.ok && r.result.prefs.bookOrderPhone[0] === 'b2' && r.result.prefs.bookOrder[0] === 'b3']);
  r = await G({ action: 'setMyPref', key: 'role', value: 'U' });
  t.push(['…only known settings can be kept', !r.ok && /cannot be kept/.test(r.error)]);
  r = await ask({ action: 'setMyPref', key: 'bookOrder', value: ['x'] });
  t.push(['…not without signing in', !r.ok]);
  r = await G({ action: 'setMyPref', key: 'bookOrder', value: null });
  t.push(['…and back to the shared order', r.ok && !('bookOrder' in r.result.prefs)]);

  console.log = quiet;
  t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL') + ' ' + n));
  const bad = t.filter(x => !x[1]).length;
  console.log(bad ? bad + ' FAILED' : 'All ' + t.length + ' passed');
  process.exitCode = bad ? 1 : 0;
})();
