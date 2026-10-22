/* The practice space (b231): a second server, the same code, with its own
   database, filled with a copy of the live records and people. Nothing done
   there reaches the live app; it never touches the spreadsheets; the live
   server only lets it READ, with its own phrase. Both servers run here, in
   one process, the practice one reaching the live one as it would on the web. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });

(async () => {
  const quiet = console.log; console.log = () => {};
  const { DatabaseSync } = require('node:sqlite');
  const sqlOf = db => (sql, ...p) => { const st = db.prepare(sql); return /^\s*select/i.test(sql) ? st.all(...p) : (st.run(...p), []); };
  const liveDb = new DatabaseSync(':memory:'), prDb = new DatabaseSync(':memory:');
  const { makeServer } = await import(path.join(ROOT, 'server', 'src', 'core.js'));
  const LIVE = 'https://tbs-server.example.workers.dev/', PHRASE = 'read-only-copy-phrase';
  const live = makeServer({ exec: sqlOf(liveDb), timeZone: 'UTC', fetchImpl: async () => { throw new Error('offline'); },
    googleClientId: 'c', adminEmails: 'owner@example.com', practiceSecret: PHRASE });
  let liveCalls = 0;
  const toLive = async (url, init) => {
    if (url !== LIVE) throw new Error('offline');
    liveCalls++;
    const text = await live.request({ postData: { contents: init.body } });
    return { status: 200, text: async () => text };
  };
  const practice = makeServer({ exec: sqlOf(prDb), timeZone: 'UTC', fetchImpl: toLive, googleClientId: 'c', adminEmails: '',
    practice: true, liveUrl: LIVE, liveSecret: PHRASE });
  console.log = quiet;
  const session = (db, tok, email) => sqlOf(db)('INSERT INTO session (token, email, exp, made) VALUES (?, ?, ?, ?)', tok, email, Date.now() + 864e5, Date.now());
  const ask = async (srv, p) => JSON.parse(await srv.request({ postData: { contents: JSON.stringify(p) } }));
  session(liveDb, 'Lown', 'owner@example.com');
  const L = p => ask(live, Object.assign({ s: 'Lown' }, p));
  const t = [];

  // The live app: a season, a region, a sale; a Regional Lead.
  const SA = (await L({ action: 'getState' })).state.activeSeason;
  await L({ action: 'createRegion', season: SA, regionId: 'rg_it', whLoc: 'wh_it', name: 'Italy', currencies: 'EUR,USD' });
  await L({ action: 'setStockBulk', season: SA, location: 'wh_it', items: [{ bookId: 'sr_en', qty: 5 }], override: true });
  await L({ action: 'sell', season: SA, saleId: 'LIVE1', location: 'wh_it', bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] });
  await L({ action: 'peopleAdd', email: 'rita@example.com', name: 'Rita', role: 'RL', placeId: 'rg_it' });

  // The first request to the practice server copies the live app.
  session(prDb, 'Pown', 'owner@example.com'); session(prDb, 'Prita', 'rita@example.com');
  const P = p => ask(practice, Object.assign({ s: 'Pown' }, p));
  let st = (await P({ action: 'getState', season: SA })).state;
  t.push(['the practice space starts as a copy of the live app (Italy, its sale)', !!st && st.regions.some(r => r.regionId === 'rg_it') && st.sales.some(x => x.saleId === 'LIVE1')]);
  t.push(['…with the live people and roles: the owner is Universal there too (from live)', !!st && st.role === 'admin']);
  const rita = await ask(practice, { s: 'Prita', action: 'me' });
  t.push(['…and Rita is Regional Lead for Italy there too', rita.ok && (rita.result.grants || []).some(g => g.role === 'RL' && g.placeId === 'rg_it')]);
  t.push(['practiceInfo says it is practice, and when it was copied', (await ask(practice, { action: 'practiceInfo' })).result.copiedAt > 0
    && (await ask(live, { action: 'practiceInfo' })).result.practice === false]);

  // Practising changes nothing on live.
  await P({ action: 'sell', season: SA, saleId: 'PRAC1', location: 'wh_it', bookId: 'sr_en', legs: [{ type: 'Cash', cur: 'EUR', amt: 35 }] });
  await P({ action: 'createRegion', season: SA, regionId: 'rg_x', whLoc: 'wh_x', name: 'Pretendland', currencies: 'EUR,USD' });
  const lv = (await L({ action: 'getState', season: SA })).state;
  t.push(['a sale and a region made in practice are not on live', !lv.sales.some(x => x.saleId === 'PRAC1') && !lv.regions.some(r => r.regionId === 'rg_x')]);
  t.push(['…and are in practice', (await P({ action: 'getState', season: SA })).state.sales.some(x => x.saleId === 'PRAC1')]);
  const calls = liveCalls;
  await P({ action: 'getState', season: SA });
  t.push(['after the first copy, practice does not keep asking live', liveCalls === calls]);

  // Never the spreadsheets.
  const sh = await P({ action: 'syncSheets', season: SA });
  t.push(['the practice space refuses to build spreadsheets', !sh.ok && /does not build spreadsheets/.test(sh.error)]);

  // Starting over: Universal only, back to a fresh copy.
  t.push(['a Regional Lead cannot start practice over', !(await ask(practice, { s: 'Prita', action: 'practiceReset' })).ok]);
  await L({ action: 'sell', season: SA, saleId: 'LIVE2', location: 'wh_it', bookId: 'sr_en', legs: [{ type: 'Card', cur: 'EUR', amt: 35 }] });
  const rs = await P({ action: 'practiceReset' });
  st = (await P({ action: 'getState', season: SA })).state;
  t.push(['Universal starts it over: practice\'s own sale and region are gone, live\'s new sale is there',
    rs.ok && !st.sales.some(x => x.saleId === 'PRAC1') && !st.regions.some(r => r.regionId === 'rg_x') && st.sales.some(x => x.saleId === 'LIVE2')]);
  t.push(['…and the owner is still signed in there', (await P({ action: 'me' })).ok]);
  t.push(['the live app has no "start over"', !(await L({ action: 'practiceReset' })).ok]);

  // The live server only lets the right phrase read a copy.
  t.push(['without the phrase, live refuses to hand over a copy', !(await ask(live, { action: 'practiceExport', secret: 'wrong' })).ok
    && !(await ask(live, { action: 'practiceExport' })).ok]);
  const noPhrase = makeServer({ exec: sqlOf(new DatabaseSync(':memory:')), timeZone: 'UTC', fetchImpl: toLive, googleClientId: 'c', adminEmails: 'o@x' });
  t.push(['a live server with no PRACTICE_SECRET hands a copy to no one', !(await ask(noPhrase, { action: 'practiceExport', secret: '' })).ok]);
  const ex = await ask(live, { action: 'practiceExport', secret: PHRASE });
  t.push(['the copy carries no spreadsheet bookkeeping (nothing to redraw, no claim)', ex.ok && !('dirtyLocs' in ex.result.props) && !('cfInFlight' in ex.result.props)]);

  /* Finance's launch (b274): Universal brings practice's wording and Finance
     settings to live; practice's expenses stay there. */
  await P({ action: 'saveLabel', key: 'Panel: Finance › Overview', text: 'Laksmi Overview' });
  await P({ action: 'expRulesSet', rules: {} }).catch(() => {});
  await P({ action: 'placeMetaSet', kind: 'regions', id: 'rg_it', from: '2026-10-08', to: '2026-11-08' });
  const out = await P({ action: 'finCarryOut' });
  t.push(['b274: practice hands Universal its wording and settings', out.ok && out.result.labels.some(l => l.text === 'Laksmi Overview') && !!out.result.props.placeDates]);
  t.push(['b274: …but not to a Regional Lead', !(await ask(practice, { s: 'Prita', action: 'finCarryOut' })).ok]);
  t.push(['b274: live does not hand out its own (that is practice\'s side)', !(await L({ action: 'finCarryOut' })).ok]);
  const inn = await L({ action: 'finCarryIn', labels: out.result.labels, props: out.result.props });
  const lst = (await L({ action: 'getState', season: SA })).state;
  t.push(['b274: live takes them: the wording is live\'s now', inn.ok && inn.result.words >= 1 && lst.labels['Panel: Finance › Overview'] === 'Laksmi Overview']);
  const lm = await L({ action: 'placeMetaGet' });
  t.push(['b274: …and Italy\'s dates', lm.ok && (lm.result.regions || []).some(r => r.id === 'rg_it' && r.from === '2026-10-08')]);
  t.push(['b274: practice cannot be written to this way', !(await P({ action: 'finCarryIn', labels: [], props: {} })).ok]);
  t.push(['b274: expenses work on the live app now', (await L({ action: 'expOptions' })).ok]);

  /* b288: wording changed in both places is hers to choose; one side alone wins. */
  await L({ action: 'saveLabel', key: 'Panel: X › Both', text: 'Live old' });
  await L({ action: 'saveLabel', key: 'Panel: X › LiveOnly', text: 'Same' });
  await L({ action: 'saveLabel', key: 'Panel: X › PracOnly', text: 'Same' });
  t.push(['b288: starting practice over remembers live\'s wording as it was', (await P({ action: 'practiceReset' })).ok && (await P({ action: 'finCarryOut' })).result.base['Panel: X › Both'] === 'Live old']);
  await P({ action: 'saveLabel', key: 'Panel: X › Both', text: 'Practice new' });
  await L({ action: 'saveLabel', key: 'Panel: X › Both', text: 'Live new' });
  await L({ action: 'saveLabel', key: 'Panel: X › LiveOnly', text: 'Live edit' });
  await P({ action: 'saveLabel', key: 'Panel: X › PracOnly', text: 'Practice edit' });
  const o2 = (await P({ action: 'finCarryOut' })).result;
  const plan = await L({ action: 'finCarryIn', labels: o2.labels, props: o2.props, base: o2.base, plan: true });
  t.push(['b288: the plan: one changed in both (both versions shown), practice-only comes over, live-only stays',
    plan.ok && plan.result.both.length === 1 && plan.result.both[0].practice === 'Practice new' && plan.result.both[0].live === 'Live new' && plan.result.take === 1 && plan.result.keep === 1]);
  t.push(['b288: …nothing written until she has chosen', !(await L({ action: 'finCarryIn', labels: o2.labels, props: o2.props, base: o2.base, choices: {} })).ok]);
  const go = await L({ action: 'finCarryIn', labels: o2.labels, props: o2.props, base: o2.base, choices: { 'Panel: X › Both': 'live' } });
  const lab = (await L({ action: 'getState', season: SA })).state.labels;
  t.push(['b288: her choice (live\'s) kept, practice-only brought over, live-only untouched',
    go.ok && lab['Panel: X › Both'] === 'Live new' && lab['Panel: X › PracOnly'] === 'Practice edit' && lab['Panel: X › LiveOnly'] === 'Live edit']);
  // Edit Finance-Only Locations (b288): practice only.
  const fpa = await P({ action: 'finPlaceAdd', name: 'Airport', parent: '' });
  t.push(['b288: a Finance-only place can be renamed in practice', fpa.ok && (await P({ action: 'finPlaceEdit', id: fpa.result.id, name: 'Airport store' })).ok]);
  t.push(['b288: …and removed when nothing is recorded there', (await P({ action: 'finPlaceEdit', id: fpa.result.id, remove: true })).ok]);
  t.push(['b288: not on the live app yet', !(await L({ action: 'finPlaceEdit', id: 'fp_x', name: 'y' })).ok]);

  let bad = 0;
  t.forEach(([n, okk]) => { if (!okk) bad++; console.log((okk ? 'PASS' : 'FAIL'), n); });
  if (bad) process.exitCode = 1;
})().catch(e => { console.error(e); process.exit(1); });
