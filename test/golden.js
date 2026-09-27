/* Replay recorded requests against two versions of Code.gs and compare.

     node test/golden.js                      # every corpus in test/corpus/, against git HEAD
     node test/golden.js --base=b191tag       # against any git revision
     node test/golden.js --verbose test/corpus/round2.jsonl

   Why: moving the data off Google Sheets means rewriting how every record is
   read and written, while nothing the app sees may change. Each corpus is the
   exact list of requests a real test session made (recorded with
   TBS_RECORD=file, see mini.js). Both versions replay it from an empty
   spreadsheet with the same clock, and after every request we compare
     - the reply the app would get, and
     - every hidden data sheet, row by row, column by column;
   and at the end the readable spreadsheets built from them.
   The first difference in each corpus is printed. */
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const ROOT = path.join(__dirname, '..');

/* ---------- child: replay one corpus, print what happened ---------- */
if (process.argv[2] === '--replay') {
  // One clock for everyone: fixed within a request, a minute on between
  // requests, so timestamps and anything named from them match exactly.
  const RealDate = Date;
  let now = RealDate.UTC(2026, 5, 1, 8, 0, 0);
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(now); }
    static now() { return now; }
  }
  global.Date = FakeDate;
  const quiet = console.log; console.log = () => {};   // Code.gs chatter
  const m = require(path.join(__dirname, 'mini.js'));
  const lines = fs.readFileSync(process.argv[3], 'utf8').split('\n').filter(Boolean).map(JSON.parse);

  const norm = v => {
    if (v instanceof RealDate) return 'D:' + (isNaN(v) ? 'invalid' : v.toISOString());
    if (v === undefined || v === null) return '';
    return v;
  };
  const dumpSheet = sh => {
    const g = sh.grid.map(r => r.map(norm));
    const head = (g[0] || []).map(String);
    const rows = g.slice(1).map(r => {
      const o = {};
      head.forEach((h, i) => { if (h !== '') o[h] = r[i] === undefined ? '' : r[i]; });
      return o;
    });
    return { head, rows };
  };
  const dumpData = () => {
    const out = {};
    const act = m.sheet ? SpreadsheetApp.getActive() : null;
    act.getSheets().forEach(sh => { if (/^_/.test(sh.getName())) out[sh.getName()] = dumpSheet(sh); });
    return out;
  };
  const dumpReports = () => {
    const out = {};
    SpreadsheetApp.getActive().getSheets().forEach(sh => {
      if (!/^_/.test(sh.getName())) out['master/' + sh.getName()] = sh.grid.map(r => r.map(norm));
    });
    Object.keys(SpreadsheetApp._files).sort().forEach(id => {
      const f = SpreadsheetApp._files[id];
      f.getSheets().forEach(sh => { out[f.getName() + '/' + sh.getName()] = sh.grid.map(r => r.map(norm)); });
    });
    return out;
  };
  const cleanReply = r => {
    const s = JSON.stringify(r, (k, v) => (k === 'build' || k === 'serverBuild') ? '' : v);
    return JSON.parse(s);
  };

  const steps = [];
  for (const p of lines) {
    now += 60000;
    let reply;
    try {
      if (p.__init) { m.init(); reply = 'init'; }
      else if ('__sync' in p) { m.sync(p.__sync); reply = 'sync'; }
      else if (p.__patch) { reply = 'patch-skipped'; }
      else reply = cleanReply(m.call(p));
    } catch (e) { reply = 'THREW ' + e.message; }
    steps.push({ req: p, reply, data: dumpData() });
  }
  now += 60000;
  try { m.sync(true); } catch (e) { steps.push({ req: 'final sync', reply: 'THREW ' + e.message }); }
  // To a file: a large write to a pipe is cut short by process.exit.
  fs.writeFileSync(process.argv[4], JSON.stringify({ steps, reports: dumpReports(), finalData: dumpData() }));
  console.log = quiet;
  process.exit(0);
}

/* ---------- parent: run both versions, compare ---------- */
const args = process.argv.slice(2);
const baseArg = (args.find(a => a.startsWith('--base=')) || '--base=HEAD').slice(7);
const verbose = args.includes('--verbose');
let files = args.filter(a => !a.startsWith('--'));
if (!files.length) {
  const dir = path.join(__dirname, 'corpus');
  files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort().map(f => path.join(dir, f));
}

const baseCode = path.join(os.tmpdir(), 'tbs-golden-base-' + process.pid + '.gs');
fs.writeFileSync(baseCode, execFileSync('git', ['show', baseArg + ':Code.gs'], { cwd: ROOT, maxBuffer: 1 << 28 }));

function run(codePath, corpus) {
  const out = path.join(os.tmpdir(), 'tbs-golden-out-' + process.pid + '.json');
  execFileSync(process.execPath, [__filename, '--replay', corpus, out],
    { env: Object.assign({}, process.env, { TBS_CODE: codePath, TBS_RECORD: '' }), maxBuffer: 1 << 30 });
  const res = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.unlinkSync(out);
  return res;
}

/* Where two values first differ, as a readable path. */
function firstDiff(a, b, at) {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object')
    return { at, base: a, now: b };
  if (Array.isArray(a) !== Array.isArray(b)) return { at, base: a, now: b };
  const keys = Array.from(new Set(Object.keys(a).concat(Object.keys(b))));
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], at + (Array.isArray(a) ? '[' + k + ']' : '.' + k));
    if (d) return d;
  }
  return null;
}
const short = v => { const s = JSON.stringify(v); return s && s.length > 300 ? s.slice(0, 300) + '…' : s; };

let bad = 0;
for (const f of files) {
  const name = path.basename(f);
  let A, B;
  try { A = run(baseCode, f); B = run(path.join(ROOT, 'Code.gs'), f); }
  catch (e) { console.log('ERROR    ' + name + '\n' + String(e.stderr || e.message).slice(0, 2000)); bad++; continue; }
  let diff = null, where = '';
  for (let i = 0; i < Math.max(A.steps.length, B.steps.length) && !diff; i++) {
    const a = A.steps[i] || {}, b = B.steps[i] || {};
    diff = firstDiff(a.reply, b.reply, 'reply');
    if (!diff) diff = firstDiff(a.data, b.data, 'data');
    if (diff) where = 'request ' + (i + 1) + ' ' + short(a.req || b.req);
  }
  if (!diff) { diff = firstDiff(A.reports, B.reports, 'reports'); if (diff) where = 'readable spreadsheets'; }
  if (diff) {
    bad++;
    console.log('FAIL     ' + name + ' — ' + where + '\n           at ' + diff.at +
                '\n           base: ' + short(diff.base) + '\n           now:  ' + short(diff.now));
  } else {
    const writes = A.steps.filter(s => s.req && s.req.action && !/^(getState|ping|activity|openPreorders|opStatus|setSeason)$/.test(s.req.action)).length;
    console.log('PASS     ' + name + ' — ' + A.steps.length + ' requests (' + writes + ' saves) identical' + (verbose ? '' : ''));
  }
}
fs.unlinkSync(baseCode);
console.log(bad ? '\n' + bad + ' corpus(es) differ.' : '\nAll identical.');
process.exit(bad ? 1 : 0);
