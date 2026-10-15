/* The spreadsheets, Stage 4 (b226): a note on top of every tab; each file shared
   with the people whose roles reach it (Universal edit, the rest view); people
   the app did not add are left alone; Spreadsheet Links shows a person only
   their own files. Google's side (test/mini.js) talks to the server's own code
   in-process, as in test/bridge.js, with a Drive stand-in that keeps who has what. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });

(async () => {
  const quiet = console.log; console.log = () => {};
  const CF = 'https://tbs-server.example.workers.dev/', SECRET = 'share-secret-123';
  const m = require(path.join(__dirname, 'mini.js'));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const exec = (sql, ...p) => { const st = db.prepare(sql); return /^\s*select/i.test(sql) ? st.all(...p) : (st.run(...p), []); };
  const { makeServer } = await import(path.join(ROOT, 'server', 'src', 'core.js'));

  // Drive: who has each file, and every call made.
  const perms = {}, driveCalls = [];
  const P = id => (perms[id] = perms[id] || { e: new Set(), v: new Set() });
  const oldGet = DriveApp.getFileById;
  DriveApp.getFileById = id => Object.assign(oldGet(id), {
    addEditor: x => { driveCalls.push('+e ' + x); P(id).e.add(x); P(id).v.delete(x); },
    addViewer: x => { driveCalls.push('+v ' + x); if (x === 'nogoogle@x.com') throw new Error('not a Google account'); if (!P(id).e.has(x)) P(id).v.add(x); },
    removeEditor: x => { driveCalls.push('-e ' + x); P(id).e.delete(x); },
    removeViewer: x => { driveCalls.push('-v ' + x); P(id).v.delete(x); } });
  global.Session.getEffectiveUser = () => ({ getEmail: () => 'script-owner@example.com' });

  global.UrlFetchApp = { fetch: (url, opts) => {
    const body = JSON.parse(opts.payload);
    const text = url === CF ? JSON.stringify(srv.bridge(body)) : '{"ok":false}';
    return { getResponseCode: () => 200, getContentText: () => text };
  } };
  const fetchImpl = async (url, init) => {
    if (url === 'https://script.google.com/macros/s/TEST/exec') return { status: 200, text: async () => JSON.stringify(m.call(JSON.parse(init.body))) };
    throw new Error('offline');
  };
  const srv = makeServer({ exec, timeZone: 'UTC', fetchImpl, googleClientId: 'c', adminEmails: 'owner@example.com',
                           reportUrl: 'https://script.google.com/macros/s/TEST/exec', reportSecret: SECRET });
  const cf = p => JSON.parse(srv.answer({ postData: { contents: JSON.stringify(p) } }));
  const session = (tok, email) => exec('INSERT INTO session (token, email, exp, made) VALUES (?, ?, ?, ?)', tok, email, Date.now() + 864e5, Date.now());
  session('Sown', 'owner@example.com');
  const ask = async (p, tok) => JSON.parse(await srv.request({ postData: { contents: JSON.stringify(Object.assign({ s: tok || 'Sown' }, p)) } }));

  m.init();
  m.run("propSet_('CF_URL', " + JSON.stringify(CF) + "); propSet_('CF_SECRET', " + JSON.stringify(SECRET) + "); propSet_('CF_LIVE', 'yes')");
  let st = cf({ action: 'getState' }).state;
  cf({ action: 'saveSeason', seasonId: st.activeSeason, name: 'Share Tour' });
  const sid = cf({ action: 'getState' }).state.activeSeason;
  cf({ action: 'createRegion', season: sid, regionId: 'rg_a', whLoc: 'wh_a', name: 'Aland', currencies: 'EUR,USD' });
  cf({ action: 'createRegion', season: sid, regionId: 'rg_b', whLoc: 'wh_b', name: 'Beland', currencies: 'EUR,USD' });
  cf({ action: 'createEvent', season: sid, eventId: 'ev_a', name: 'A Fest', regionId: 'rg_a' });
  const pt = cf({ action: 'savePartner', season: sid, regionId: 'rg_a', name: 'A Friends' }).result;
  cf({ action: 'saveConsignBook', season: sid, partnerId: pt, name: 'A Songs', cat: 'small', regionId: 'rg_a', location: 'wh_a', stock: 2 });
  cf({ action: 'sell', season: sid, saleId: 'S1', location: 'wh_a', bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }], override: true });
  for (const [email, role, placeId] of [['rl@x.com', 'RL', 'rg_a'], ['sl@x.com', 'SL', sid], ['fin@x.com', 'F', ''],
                                         ['el@x.com', 'EL', 'ev_a'], ['u2@x.com', 'U', ''], ['nogoogle@x.com', 'RA', 'rg_b']]) {
    const r = await ask({ action: 'peopleAdd', email, name: email.split('@')[0], role, placeId });
    if (!r.ok) console.error('peopleAdd', email, r.error);
  }

  const t = [];
  const minute = () => { srv.kv.setProp('lastWriteAt', String(Date.now() - 60000)); m.sync(false); };
  minute(); minute();                         // draw, then share the new files
  const meta = k => srv.app.getMeta_(k, '');
  const A = meta('regionSheetId:rg_a'), B = meta('regionSheetId:rg_b'), S = meta('seasonSheetId:' + sid), C = meta('partnerSheetId:' + pt);
  const has = (id, kind, x) => P(id)[kind].has(x);
  t.push(['(the files exist)', !!(A && B && S && C)]);

  const fileA = SpreadsheetApp._files[A];
  const tab = fileA && fileA.getSheetByName('Summary');
  t.push(['every tab starts with the note', !!tab && /^If you wish to edit this sheet, please make a copy\. Note that this sheet is being created from the app\. If you wish for any changes you make to be reflected permanently, you must change them in the app itself\.$/.test(tab.grid[0][0])
    && /Aland/.test(tab.grid[1][0])]);
  const wtab = fileA && fileA.getSheetByName('Aland — Warehouse Sales');
  t.push(['…the sales tabs too', !!wtab && /make a copy/.test(wtab.grid[0][0])]);

  t.push(['Universal people edit every file (the owner, and another Universal)', [A, B, S, C].every(id => has(id, 'e', 'owner@example.com') && has(id, 'e', 'u2@x.com'))]);
  t.push(['Finance views every file', [A, B, S, C].every(id => has(id, 'v', 'fin@x.com'))]);
  t.push(['the Seasonal Lead views the season\'s summary, regions and consignment', [A, B, S, C].every(id => has(id, 'v', 'sl@x.com'))]);
  t.push(['the Regional Lead views their region\'s file and its consignment group\'s', has(A, 'v', 'rl@x.com') && has(C, 'v', 'rl@x.com')]);
  t.push(['…not another region\'s, nor the season summary', !has(B, 'v', 'rl@x.com') && !has(S, 'v', 'rl@x.com')]);
  t.push(['an Event Lead gets no spreadsheet', Object.values(perms).every(x => !x.v.has('el@x.com') && !x.e.has('el@x.com'))]);
  t.push(['nobody but Universal edits', Object.values(perms).every(x => [...x.e].every(e => /owner@|u2@/.test(e)))]);
  t.push(['the script\'s own account is never added', !driveCalls.some(c => /script-owner/.test(c))]);
  t.push(['an address Drive refuses is noted, not fatal', /nogoogle@x.com/.test(meta('sheetShareError'))]);

  // Someone shared by hand stays; nothing changes, nothing is called.
  P(A).v.add('friend@x.com');
  driveCalls.length = 0;
  await ask({ action: 'syncSheets', season: sid });
  t.push(['nothing changed: not one Drive call', driveCalls.length === 0]);

  // The Regional Lead's role is removed: they lose the file, the friend keeps it.
  const list = (await ask({ action: 'peopleList' })).result;
  const g = (list.people || list.grants || []).flatMap(x => x.grants || [x]).find(x => (x.email === 'rl@x.com' || x.email === undefined) && x.role === 'RL');
  const rr = await ask({ action: 'peopleRemove', id: g && g.id });
  minute();
  t.push(['a role taken away: their view goes on the next minute', rr.ok && !has(A, 'v', 'rl@x.com') && !has(C, 'v', 'rl@x.com')]);
  t.push(['…and someone shared by hand is left alone', has(A, 'v', 'friend@x.com')]);

  // Spreadsheet Links, for a Regional Lead signed in: their own files, no folders.
  await ask({ action: 'peopleAdd', email: 'rl2@x.com', name: 'Rita', role: 'RL', placeId: 'rg_b' });
  session('Srl2', 'rl2@x.com');
  const map = (await ask({ action: 'driveMap' }, 'Srl2'));
  const names = map.ok ? map.result.seasons.flatMap(s => s.files.concat(s.consignFiles)).map(f => f.name) : [];
  t.push(['a Regional Lead\'s Spreadsheet Links: only their region\'s file', map.ok && names.length === 1 && /Beland/.test(names[0])]);
  t.push(['…view only, and no folders', map.ok && map.result.viewOnly === true && !map.result.root && map.result.seasons.every(s => !s.folder && !s.consign)]);
  t.push(['…and they cannot rebuild the spreadsheets', !(await ask({ action: 'syncSheets', season: sid }, 'Srl2')).ok]);
  const own = await ask({ action: 'driveMap' });
  t.push(['Universal still sees every file and the folders', own.ok && !own.result.viewOnly && own.result.seasons.some(s => s.files.length >= 3)]);

  console.log = quiet;
  let bad = 0;
  t.forEach(([n, ok]) => { if (!ok) bad++; console.log((ok ? 'PASS' : 'FAIL'), n); });
  if (bad) process.exitCode = 1;
})().catch(e => { console.error(e); process.exit(1); });
