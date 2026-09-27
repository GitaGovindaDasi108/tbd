/* The spreadsheets, for the Cloudflare server (Phase 2): the bridge.

   Google's side (Code.gs on the test stand-in sheets, test/mini.js) connected
   to the Cloudflare server's own code (server/src/core.js), the two talking
   to each other in-process exactly as they would over the web. Checks that:
     - the minute trigger draws the spreadsheets from the server's records,
       and only when something needs drawing and nobody is saving;
     - what Google learns (the files it made) goes back to the server;
     - nothing of the server's records is written into Google's own sheets;
     - "Sync sheet" and "Spreadsheet folders" in the app reach Google through
       the server, and answer as before;
     - a run that never reports back is given back to the list. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });

(async () => {
  const quiet = console.log; console.log = () => {};
  const CF = 'https://tbs-server.example.workers.dev/', SECRET = 'bridge-secret-123';
  const m = require(path.join(__dirname, 'mini.js'));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const exec = (sql, ...p) => { const st = db.prepare(sql); return /^\s*select/i.test(sql) ? st.all(...p) : (st.run(...p), []); };
  const { makeServer } = await import(path.join(ROOT, 'server', 'src', 'core.js'));

  // Google -> Cloudflare: Apps Script's UrlFetchApp, answered by the server's bridge.
  const calls = [];
  global.UrlFetchApp = { fetch: (url, opts) => {
    const body = JSON.parse(opts.payload);
    calls.push(body.action + (body.mode ? ':' + body.mode : ''));
    const text = url === CF ? JSON.stringify(srv.bridge(body)) : '{"ok":false}';
    return { getResponseCode: () => 200, getContentText: () => text };
  } };
  // Cloudflare -> Google: a forwarded request, answered by Apps Script's handle.
  const fetchImpl = async (url, init) => {
    if (url === 'https://script.google.com/macros/s/TEST/exec') {
      const p = JSON.parse(init.body);
      return { status: 200, text: async () => JSON.stringify(m.call(p)) };
    }
    throw new Error('offline');
  };
  const srv = makeServer({ exec, timeZone: 'UTC', fetchImpl, googleClientId: 'c', adminEmails: 'owner@example.com',
                           reportUrl: 'https://script.google.com/macros/s/TEST/exec', reportSecret: SECRET });
  const cf = p => JSON.parse(srv.answer({ postData: { contents: JSON.stringify(p) } }));
  // A signed-in owner, for the requests that go through the sign-in gate.
  exec('INSERT INTO session (token, email, exp, made) VALUES (?, ?, ?, ?)', 'Stest', 'owner@example.com', Date.now() + 864e5, Date.now());
  const ask = async p => JSON.parse(await srv.request({ postData: { contents: JSON.stringify(Object.assign({ s: 'Stest' }, p)) } }));

  // Google's side, set up as today, then connected.
  m.init();
  const googleSalesBefore = m.sheet('_sales').grid.length;
  m.run("propSet_('CF_URL', " + JSON.stringify(CF) + "); propSet_('CF_SECRET', " + JSON.stringify(SECRET) + "); propSet_('CF_LIVE', 'yes')");

  // Records on the Cloudflare server.
  let st = cf({ action: 'getState' }).state;
  cf({ action: 'saveSeason', seasonId: st.activeSeason, name: 'Cloud Tour' });
  const sid = cf({ action: 'getState' }).state.activeSeason;
  cf({ action: 'createRegion', season: sid, regionId: 'rg_cl', whLoc: 'wh_cl', name: 'Cloudland', currencies: 'EUR,USD' });
  cf({ action: 'setStockBulk', season: sid, location: 'wh_cl', items: [{ bookId: 'sr_en', qty: 6 }], override: true });
  cf({ action: 'sell', season: sid, saleId: 'CL1', location: 'wh_cl', bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] });

  const t = [];
  const files = () => Object.values(SpreadsheetApp._files);
  const cloudFile = () => files().find(f => /Cloudland/.test(f.getName()));

  // Someone is still saving: the minute trigger leaves it.
  calls.length = 0;
  m.sync(false);
  t.push(['while someone is saving, nothing is drawn', !cloudFile() && calls.join() === 'reportExport:tick']);

  // Quiet now.
  srv.kv.setProp('lastWriteAt', String(Date.now() - 60000));
  calls.length = 0;
  m.sync(false);
  const f = cloudFile();
  t.push(['the minute trigger draws the server\'s records', !!f && calls.join() === 'reportExport:tick,reportWriteBack']);
  const wh = f && f.getSheetByName('Cloudland — Warehouse Sales');
  t.push(['…the sale is in its spreadsheet', !!wh && wh.grid.some(r => r.includes('Sri Radha (English)'))]);
  const meta = cf({ action: 'getState' }).state.sheetLinks || {};
  t.push(['the file Google made is known to the server (its link in the app)', !!meta.regions && meta.regions.rg_cl === f.getId()]);
  t.push(['nothing is left waiting to be drawn', srv.kv.getProp('dirtyLocs') === '{}' && !srv.kv.getProp('cfInFlight')]);
  t.push(['Google\'s own sheets are untouched', m.sheet('_sales').grid.length === googleSalesBefore]);

  calls.length = 0;
  m.sync(false);
  t.push(['with nothing new, the trigger only asks', calls.join() === 'reportExport:tick']);

  // A new sale: drawn on the next quiet minute.
  cf({ action: 'sell', season: sid, saleId: 'CL2', location: 'wh_cl', bookId: 'sr_en', legs: [{ type: 'Card', cur: 'EUR', amt: 35 }] });
  srv.kv.setProp('lastWriteAt', String(Date.now() - 60000));
  m.sync(false);
  t.push(['a new sale reaches the spreadsheet', cloudFile().getSheetByName('Cloudland — Warehouse Sales').grid.filter(r => r.includes('Sri Radha (English)')).length >= 2]);

  // "Spreadsheet folders" and "Sync sheet", from the app, through the server.
  let r = await ask({ action: 'driveMap' });
  t.push(['"Spreadsheet folders" is answered by Google, through the server', r.ok && r.result && r.result.seasons.some(x => x.name === 'Cloud Tour')]);
  cf({ action: 'sell', season: sid, saleId: 'CL3', location: 'wh_cl', bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] });
  r = await ask({ action: 'syncSheets', season: sid });
  t.push(['"Sync sheet" redraws at once and answers with the state', r.ok && r.state && r.state.sales.some(x => x.saleId === 'CL3')
    && cloudFile().getSheetByName('Cloudland — Warehouse Sales').grid.filter(r => r.includes('Sri Radha (English)')).length >= 3]);
  r = await ask({ action: 'setDriveFolder', folder: 'https://drive.google.com/drive/folders/1AbCdEfGhIjK000001' });
  t.push(['changing the folder is done by Google', r.ok === true]);
  const acts = srv.app.objectsOf_('_activity').map(a => String(a.text || ''));
  t.push(['…and its Activity Log line is kept on the server', acts.some(x => /spreadsheets are filed/.test(x))]);

  // A run that never came back is given back after 15 minutes.
  srv.kv.setProp('dirtyLocs', JSON.stringify({ wh_cl: 1 }));
  srv.kv.setProp('lastWriteAt', '0');
  srv.bridge({ action: 'reportExport', mode: 'tick', secret: SECRET });           // claimed, and never reported
  t.push(['(taken)', srv.kv.getProp('dirtyLocs') === '{}' && !!srv.kv.getProp('cfInFlight')]);
  const fl = JSON.parse(srv.kv.getProp('cfInFlight')); fl.at -= 16 * 60 * 1000; srv.kv.setProp('cfInFlight', JSON.stringify(fl));
  const ex = srv.bridge({ action: 'reportExport', mode: 'tick', secret: SECRET });
  t.push(['a run that never reported back is given back and drawn again', ex.ok && !ex.result.idle && JSON.parse(ex.result.props.dirtyLocs).wh_cl === 1]);

  t.push(['without the secret, the bridge refuses', srv.bridge({ action: 'reportExport', secret: 'wrong' }).ok === false]);
  r = JSON.parse(m.call({ cfForward: true, secret: 'wrong', params: { action: 'driveMap' } }).ok === false ? '{"ok":false}' : '{}');
  t.push(['…and so does Google\'s side', r.ok === false]);

  console.log = quiet;
  t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
})().catch(e => { console.error(e); process.exit(1); });
