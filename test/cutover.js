/* Phase 3: moving the records from Google to the Cloudflare server.

   Google's side (Code.gs on the test stand-in sheets, filled by replaying a
   whole recorded session: seasons, regions, consignment, costs, shipments,
   closings...) and the server's own code, talking in-process as they would
   over the web. Checks the owner's steps, in order:
     copyToCloudflare()        a rehearsal: copied, every season identical,
                               and the app keeps working on Google;
     switchToCloudflare()      the switch; a phone still pointed at Google is
                               passed on to the server and loses nothing;
     (a bad copy switches nothing);
     copyBackFromCloudflare()  the way back, with everything done since. */
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });

(async () => {
  const quiet = console.log; console.log = () => {};
  const CF = 'https://tbs-server.example.workers.dev/', SECRET = 'cutover-secret-123';
  const m = require(path.join(__dirname, 'mini.js'));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const exec = (sql, ...p) => { const st = db.prepare(sql); return /^\s*select/i.test(sql) ? st.all(...p) : (st.run(...p), []); };
  const { makeServer } = await import(path.join(ROOT, 'server', 'src', 'core.js'));
  const srv = makeServer({ exec, timeZone: 'UTC', fetchImpl: async () => { throw new Error('offline'); },
                           googleClientId: 'c', adminEmails: 'owner@example.com', reportSecret: SECRET });

  // Google -> Cloudflare, as UrlFetchApp would carry it.
  let tamper = null;
  global.UrlFetchApp = { fetch: (url, opts) => {
    const body = JSON.parse(opts.payload);
    let text = url !== CF ? '{"ok":false}' : body.action === 'relay' ? srv.relay(body) : JSON.stringify(srv.bridge(body));
    if (tamper) text = tamper(body, text);
    return { getResponseCode: () => 200, getContentText: () => text };
  } };
  const cf = p => JSON.parse(srv.answer({ postData: { contents: JSON.stringify(p) } }));
  const log = () => { const out = []; return out; };

  // Google, full of records: a whole recorded session replayed.
  const lines = fs.readFileSync(path.join(__dirname, 'corpus', 'extra.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  for (const p of lines) {
    if (p.__init) m.init();
    else if ('__sync' in p || p.__patch) continue;
    else m.call(p);
  }
  const sid = m.call({ action: 'getState' }).state.activeSeason;
  const W = m.call({ action: 'getState', season: sid }).state.regions[0].whLoc;
  // ...and a second season, and Earthly HQ, each with a sale.
  const s2 = m.call({ action: 'saveSeason', name: 'Year-Round' }).result;
  m.call({ action: 'createRegion', season: s2, regionId: 'rg_yr', whLoc: 'wh_yr', name: 'Skopje', currencies: 'MKD,USD' });
  m.call({ action: 'setStockBulk', season: s2, location: 'wh_yr', items: [{ bookId: 'sr_en', qty: 5 }], override: true });
  m.call({ action: 'sell', season: s2, saleId: 'Y1', location: 'wh_yr', bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'MKD', amt: 2000 }] });
  m.call({ action: 'setSeason', seasonId: 'HQ' });
  m.call({ action: 'adjustStockBulk', season: 'HQ', location: 'wh_hq', items: [{ bookId: 'sr_en', delta: 20 }], override: true, note: 'printer' });
  m.call({ action: 'sell', season: 'HQ', saleId: 'H1', location: 'wh_hq', bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'INR', amt: 3000 }] });
  m.call({ action: 'setSeason', seasonId: sid });
  m.run("propSet_('CF_URL', " + JSON.stringify(CF) + "); propSet_('CF_SECRET', " + JSON.stringify(SECRET) + ")");

  const t = [];
  const googleSales = () => m.sheet('_sales').grid.slice(1).map(r => r[0]);
  const serverSales = () => srv.app.objectsOf_('_sales').map(r => String(r.saleId));
  const run = src => { try { return m.run(src); } catch (e) { return 'THREW ' + e.message; } };

  // 1. The rehearsal.
  let r = run('copyToCloudflare()');
  t.push(['copyToCloudflare: copied, and every season identical', r === 'Copied and identical.']);
  const cmp = m.run('compareWithCloudflare()');
  t.push(['…seasons compared: ' + cmp.lines.length, cmp.ok && cmp.lines.length === 3 && /^Earthly HQ: identical/.test(cmp.lines[2]) && cmp.lines.every(l => / identical — \d+ sales?/.test(l))]);
  quiet('   ' + cmp.lines.join('\n   '));
  t.push(['…every sale is on the server', JSON.stringify(serverSales().sort()) === JSON.stringify(googleSales().map(String).sort())]);
  t.push(['…and the server moved its revision on past Google\'s', Number(srv.kv.getProp('rev')) === Number(m.rev()) + 1]);
  let g = m.call({ action: 'sell', season: sid, saleId: 'R1', location: W, bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] });
  t.push(['a rehearsal changes nothing: the app keeps working on Google', g.ok && googleSales().includes('R1') && !serverSales().includes('R1')]);
  r = run('copyToCloudflare()');
  t.push(['…and can be run again, with what is new', r === 'Copied and identical.' && serverSales().includes('R1')]);

  // 2. A bad copy switches nothing.
  tamper = (body, text) => {
    if (body.action !== 'reportState') return text;
    const o = JSON.parse(text); if (o.result && o.result.sales && o.result.sales[0]) o.result.sales[0].p1amt = 999999;
    return JSON.stringify(o);
  };
  r = run('switchToCloudflare()');
  tamper = null;
  t.push(['if the copy does not match, nothing switches', /did not match/.test(String(r)) && !m.run('cfLive_()')]);
  g = m.call({ action: 'sell', season: sid, saleId: 'R2', location: W, bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] });
  t.push(['…and the app goes on working on Google', g.ok && googleSales().includes('R2')]);

  // 3. The switch.
  r = run('switchToCloudflare()');
  t.push(['switchToCloudflare: switched', r === 'Switched.' && m.run('cfLive_()') === true]);
  t.push(['…with everything, the last sale included', serverSales().includes('R2')]);
  g = m.call({ action: 'sell', season: sid, saleId: 'P1', location: W, bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }], opId: 'op-P1' });
  t.push(['a phone still pointed at Google: its sale reaches the server', g.ok && serverSales().includes('P1')]);
  t.push(['…and not Google\'s old sheets', !googleSales().includes('P1')]);
  g = m.call({ action: 'getState', season: sid });
  t.push(['…and it is shown the server\'s records', g.ok && g.state.sales.some(x => x.saleId === 'P1')]);
  g = m.call({ action: 'sell', season: sid, saleId: 'P1', location: W, bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }], opId: 'op-P1' });
  t.push(['…a resent save is still recognised (recorded once)', g.ok && serverSales().filter(x => x === 'P1').length === 1]);
  r = run('copyToCloudflare()');
  t.push(['after the switch, copying again is refused (it would erase newer records)', /Already switched/.test(String(r))]);

  // 4. The way back.
  cf({ action: 'sell', season: sid, saleId: 'C1', location: W, bookId: 'sr_en', legs: [{ type: 'Card', cur: 'EUR', amt: 35 }] });
  r = run('copyBackFromCloudflare()');
  t.push(['copyBackFromCloudflare: back on Google', r === 'Copied back.' && m.run('cfLive_()') === false]);
  t.push(['…with everything done on the server since', googleSales().includes('P1') && googleSales().includes('C1')]);
  g = m.call({ action: 'getState', season: sid });
  t.push(['…and the app works on Google again', g.ok && g.state.sales.some(x => x.saleId === 'C1') && !m.run('cfLive_()')]);
  t.push(['…identical to the server, season by season', m.run('compareWithCloudflare()').ok]);

  console.log = quiet;
  t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
})().catch(e => { console.error(e); process.exit(1); });
