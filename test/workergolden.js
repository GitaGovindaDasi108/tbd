/* The Cloudflare server against Google, over every recorded session (Phase 2).

     node test/workergolden.js            (builds server/src/app.gen.js first)

   Each corpus is replayed twice from an empty start with the same clock:
     - on Google's side, as test/golden.js does (Code.gs on the stand-in sheets);
     - through the Cloudflare server's own code (server/src/core.js: Code.gs
       wrapped for Cloudflare, its Google stand-ins, the SQLite store), with
       its memory emptied before every request so only the database counts.
   After every request the replies and every table must match.

   What is allowed to differ is only what the spreadsheets themselves write
   (and the change counter, `rev`, which Google also moves for them):
   the Cloudflare server makes no spreadsheets (Google still does), so the
   spreadsheet ids and folder notes Google keeps in _meta, the links to those
   files in the reply, and the syncs that make them, are left out. */
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');

const SHEET_ACTIONS = /^(driveMap|syncSheets|setDriveFolder|setSeasonFolder|descriptionsSheet)$/;
const SHEET_META = /^(placed:|regionSheetId|seasonSheetId|partnerSheetId|driveRootFolder|driveMapStamp|fid:|fnm:|descSheetId|descriptionsSheet)/;

/* ---------- child: replay one corpus through the Cloudflare server ---------- */
if (process.argv[2] === '--worker-replay') {
  (async () => {
    const RealDate = Date;
    let now = RealDate.UTC(2026, 5, 1, 8, 0, 0);
    class FakeDate extends RealDate {
      constructor(...a) { if (a.length) super(...a); else super(now); }
      static now() { return now; }
    }
    global.Date = FakeDate;
    const quiet = console.log; console.log = () => {};
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    const exec = (sql, ...p) => { const st = db.prepare(sql); return /^\s*select/i.test(sql) ? st.all(...p) : (st.run(...p), []); };
    const { makeServer } = await import(path.join(ROOT, 'server', 'src', 'core.js'));
    // Ids made the same way as test/mini.js's, so both sides name things alike.
    let uid = 0;
    const nextId = () => { uid++; return String.fromCharCode(97 + (uid % 26)) + 'aaaaa'; };
    const srv = makeServer({ exec, timeZone: 'UTC', fetchImpl: async () => { throw new Error('offline'); },
                             uuid: () => nextId() + nextId() });
    const norm = v => (v instanceof RealDate ? 'D:' + (isNaN(v) ? 'invalid' : v.toISOString()) : (v === undefined || v === null ? '' : v));
    const lines = fs.readFileSync(process.argv[3], 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    const clean = t => JSON.parse(JSON.stringify(JSON.parse(t), (k, v) => (k === 'build' || k === 'serverBuild' || k === 'serverTime') ? '' : v));
    const steps = [];
    for (const p of lines) {
      now += 60000;
      let reply;
      try {
        srv.forget();
        if (p.__init) {
          // initialize()'s record-keeping part, then the tests' sample tour
          // (test/mini.js: "Europe Tour" › "Poland", warehouse WAREHOUSE).
          const a = srv.app;
          a.sheetMemoClear_(); a.setSeasonContext_('');
          a.ensureReady(true); a.cacheClear_(); a.flushStockMoves_(); a.markDirtyAll_();
          if (!a.objectsOf_('_regions').some(r => String(r.seasonId) !== 'HQ')) {
            a.dbUpdate_('_seasons', { seasonId: a.activeSeasonId_() }, { name: 'Europe Tour' });
            const prices = {};
            a.BOOKS.forEach(b => { prices[b.id] = { PLN: b.pln, EUR: b.eur, USD: b.usd }; });
            a.doCreateRegion({ regionId: 'rg_poland', whLoc: a.WAREHOUSE, name: 'Poland', currencies: 'PLN,EUR,USD', prices });
            a.cacheClear_(); a.bumpRev_();
          }
          reply = 'init';
        } else if ('__sync' in p) reply = 'sync';
        else if (p.__patch) reply = 'patch-skipped';
        else reply = clean(srv.answer({ postData: { contents: JSON.stringify(p) } }));
      } catch (e) { reply = 'THREW ' + e.message; }
      steps.push({ req: p, reply, data: srv.dump(norm) });
    }
    fs.writeFileSync(process.argv[4], JSON.stringify({ steps }));
    console.log = quiet;
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
  return;
}

/* ---------- parent ---------- */
execFileSync(process.execPath, [path.join(ROOT, 'server', 'build.cjs')], { stdio: 'ignore' });
const dir = path.join(__dirname, 'corpus');
const files = process.argv.slice(2).filter(a => !a.startsWith('--')).length
  ? process.argv.slice(2).filter(a => !a.startsWith('--'))
  : fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort().map(f => path.join(dir, f));

const env = Object.assign({}, process.env, { NODE_NO_WARNINGS: '1', TBS_IGNORE_TIME: '1', TBS_RECORD: '', TBS_STORE: '',
                                             TBS_SKIP_SYNC: '1' });   // no spreadsheet building on either side
function runBase(corpus) {
  const out = path.join(os.tmpdir(), 'tbs-wg-base-' + process.pid + '.json');
  execFileSync(process.execPath, [path.join(__dirname, 'golden.js'), '--replay', corpus, out], { env, maxBuffer: 1 << 30 });
  const r = JSON.parse(fs.readFileSync(out, 'utf8')); fs.unlinkSync(out); return r;
}
function runWorker(corpus) {
  const out = path.join(os.tmpdir(), 'tbs-wg-worker-' + process.pid + '.json');
  execFileSync(process.execPath, [__filename, '--worker-replay', corpus, out], { env, maxBuffer: 1 << 30 });
  const r = JSON.parse(fs.readFileSync(out, 'utf8')); fs.unlinkSync(out); return r;
}

// Leave out what only the spreadsheets write (see the top).
function scrubData(d) {
  if (!d) return d;
  if (d._meta) d._meta.rows = d._meta.rows.filter(r => !SHEET_META.test(String(r.key)));
  return d;
}
function scrubReply(r) {
  if (!r || typeof r !== 'object') return r;
  // (rev only has to go up: Google also counts its spreadsheet actions as changes.)
  return JSON.parse(JSON.stringify(r, (k, v) => (k === 'sheetLinks' || k === 'driveFolder' || k === 'rev') ? '' : v));
}
function firstDiff(a, b, at) {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return { at, base: a, now: b };
  if (Array.isArray(a) !== Array.isArray(b)) return { at, base: a, now: b };
  for (const k of new Set(Object.keys(a).concat(Object.keys(b)))) {
    const d = firstDiff(a[k], b[k], at + (Array.isArray(a) ? '[' + k + ']' : '.' + k));
    if (d) return d;
  }
  return null;
}
const short = v => { const s = JSON.stringify(v); return s && s.length > 300 ? s.slice(0, 300) + '…' : s; };

let bad = 0;
for (const f of files) {
  const name = path.basename(f);
  /* Both sides get the same requests, minus the spreadsheet work (syncs, and
     where the files are kept): that stays with Google, and it writes its own
     Activity Log lines and ids, which would shift everything after it. */
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  const kept = lines.filter(l => { const p = JSON.parse(l); return !('__sync' in p) && !SHEET_ACTIONS.test(p.action || ''); });
  const tmp = path.join(os.tmpdir(), 'tbs-wg-corpus-' + process.pid + '.jsonl');
  fs.writeFileSync(tmp, kept.join('\n') + '\n');
  let A, B;
  try { A = runBase(tmp); B = runWorker(tmp); }
  catch (e) { console.log('ERROR    ' + name + '\n' + String(e.stderr || e.message).slice(0, 2000)); bad++; continue; }
  let diff = null, where = '';
  for (let i = 0; i < A.steps.length && !diff; i++) {
    const a = A.steps[i], b = B.steps[i] || {};
    diff = firstDiff(scrubReply(a.reply), scrubReply(b.reply), 'reply') || firstDiff(scrubData(a.data), scrubData(b.data), 'data');
    if (diff) where = 'request ' + (i + 1) + ' ' + short(a.req);
  }
  if (diff) { bad++; console.log('FAIL     ' + name + ' — ' + where + '\n           at ' + diff.at + '\n           google:     ' + short(diff.base) + '\n           cloudflare: ' + short(diff.now)); }
  else console.log('PASS     ' + name + ' — ' + A.steps.length + ' requests identical on Cloudflare'
                   + (lines.length > kept.length ? ' (' + (lines.length - kept.length) + ' spreadsheet steps left to Google)' : ''));
}
console.log(bad ? '\n' + bad + ' corpus(es) differ.' : '\nAll identical.');
process.exit(bad ? 1 : 0);
