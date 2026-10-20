/* The read-only key (b253): READ_KEY on the live server lets Claude read the
   records (every table, or a season as Universal sees it) and nothing else.
   A wrong, missing or short key gets nothing; no other request is answered
   with it; and reading changes nothing. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });

(async () => {
  const quiet = console.log; console.log = () => {};
  const { DatabaseSync } = require('node:sqlite');
  const sqlOf = db => (sql, ...p) => { const st = db.prepare(sql); return /^\s*select/i.test(sql) ? st.all(...p) : (st.run(...p), []); };
  const db = new DatabaseSync(':memory:');
  const { makeServer } = await import(path.join(ROOT, 'server', 'src', 'core.js'));
  const KEY = 'a-long-read-only-key-0123456789';
  const offline = async () => { throw new Error('offline'); };
  const live = makeServer({ exec: sqlOf(db), timeZone: 'UTC', fetchImpl: offline, googleClientId: 'c', adminEmails: 'owner@example.com', readKey: KEY });
  console.log = quiet;
  sqlOf(db)('INSERT INTO session (token, email, exp, made) VALUES (?, ?, ?, ?)', 'Lown', 'owner@example.com', Date.now() + 864e5, Date.now());
  const ask = async (srv, p) => JSON.parse(await srv.request({ postData: { contents: JSON.stringify(p) } }));
  const L = p => ask(live, Object.assign({ s: 'Lown' }, p));
  const t = [];

  const SA = (await L({ action: 'getState' })).state.activeSeason;
  await L({ action: 'createRegion', season: SA, regionId: 'rg_it', whLoc: 'wh_it', name: 'Italy', currencies: 'EUR,USD' });
  await L({ action: 'setStockBulk', season: SA, location: 'wh_it', items: [{ bookId: 'sr_en', qty: 5 }], override: true });
  await L({ action: 'sell', season: SA, saleId: 'LIVE1', location: 'wh_it', bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] });
  await L({ action: 'peopleAdd', email: 'rita@example.com', name: 'Rita', role: 'RL', placeId: 'rg_it' });
  const rev0 = live.rev();

  const st = await ask(live, { action: 'readOnly', key: KEY, what: 'state', season: SA });
  t.push(['with the key, a season reads as Universal sees it (Italy, its sale)', st.ok && st.state.regions.some(r => r.regionId === 'rg_it') && st.state.sales.some(x => x.saleId === 'LIVE1')]);
  const ex = await ask(live, { action: 'readOnly', key: KEY, what: 'export' });
  t.push(['with the key, every table and the people with their roles', ex.ok && Object.keys(ex.result.tables).length > 5
    && ex.result.people.grants.some(g => g.email === 'rita@example.com' && g.role === 'RL')]);
  t.push(['…but never sign-ins', !JSON.stringify(ex.result).includes('Lown')]);
  t.push(['reading changes nothing (the revision stays)', live.rev() === rev0]);

  t.push(['a wrong key, or none, gets nothing', !(await ask(live, { action: 'readOnly', key: 'wrong', what: 'export' })).ok
    && !(await ask(live, { action: 'readOnly', what: 'export' })).ok]);
  t.push(['the key cannot be used to save: a sale sent with it is refused', !(await ask(live, { action: 'sell', key: KEY, k: '', season: SA, saleId: 'X1', location: 'wh_it', bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] })).ok
    && !(await ask(live, { action: 'sell', s: KEY, season: SA, saleId: 'X2', location: 'wh_it', bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] })).ok]);
  t.push(['…and readOnly answers nothing but "export" and "state"', !(await ask(live, { action: 'readOnly', key: KEY, what: 'sell' })).ok]);
  t.push(['nothing was saved', live.rev() === rev0 && !(await L({ action: 'getState', season: SA })).state.sales.some(x => /^X/.test(x.saleId))]);
  const noKey = makeServer({ exec: sqlOf(new DatabaseSync(':memory:')), timeZone: 'UTC', fetchImpl: offline, googleClientId: 'c', adminEmails: 'o@x' });
  t.push(['a server with no READ_KEY answers no one', !(await ask(noKey, { action: 'readOnly', key: '', what: 'export' })).ok]);
  const shortKey = makeServer({ exec: sqlOf(new DatabaseSync(':memory:')), timeZone: 'UTC', fetchImpl: offline, googleClientId: 'c', adminEmails: 'o@x', readKey: 'short' });
  t.push(['a READ_KEY under 24 characters is not accepted', !(await ask(shortKey, { action: 'readOnly', key: 'short', what: 'export' })).ok]);

  let bad = 0;
  t.forEach(([n, okk]) => { if (!okk) bad++; console.log((okk ? 'PASS' : 'FAIL'), n); });
  if (bad) process.exitCode = 1;
})().catch(e => { console.error(e); process.exit(1); });
