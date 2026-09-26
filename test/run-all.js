/* Run every regression script, plus a syntax check on both source files.
 *
 *   node test/run-all.js
 *
 * Exits non-zero if anything fails, so it can gate a commit. */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const here = __dirname;
const root = fs.existsSync(path.join(here, '..', 'index.html'))
  ? path.join(here, '..') : here;

const SCRIPTS = ['simtest.js', 'bundle.js', 'chg2.js', 'verify.js',
                 'stale.js', 'createtest.js', 'dutchtest.js', 'reptest.js'];

let bad = 0;

/* Both files must parse before anything else is worth running. Code.gs is not a
 * module, so it is checked as a script. */
for (const f of ['index.html', 'Code.gs']) {
  const src = path.join(root, f);
  if (!fs.existsSync(src)) { console.log(`MISSING  ${f}`); bad++; continue; }
  const tmp = path.join(require('os').tmpdir(), 'tbs-check-' + f + '.js');
  let text = fs.readFileSync(src, 'utf8');
  if (f === 'index.html') {
    const blocks = text.match(/<script>([\s\S]*?)<\/script>/g) || [];
    text = blocks.map(b => b.replace(/<\/?script>/g, '')).join('\n;\n');
  }
  fs.writeFileSync(tmp, text);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
        console.log(`OK       ${f} parses`); }
  catch (e) { console.log(`SYNTAX   ${f}\n${e.stderr}`); bad++; }
}

for (const s of SCRIPTS) {
  const file = path.join(here, s);
  if (!fs.existsSync(file)) { console.log(`MISSING  ${s}`); bad++; continue; }
  let out = '';
  try { out = execFileSync(process.execPath, [file], { encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { console.log(`ERROR    ${s}\n${(e.stdout || '') + (e.stderr || '')}`); bad++; continue; }
  const lines = out.split('\n');
  const fails = lines.filter(l => /\bFAIL\b|: false/.test(l));
  const passes = lines.filter(l => /\bPASS\b|: true/.test(l)).length;
  if (fails.length) { console.log(`FAIL     ${s} — ${fails.length} of ${passes + fails.length}`);
                      fails.forEach(l => console.log('           ' + l.trim())); bad++; }
  else console.log(`OK       ${s}${passes ? ` — ${passes} checks` : ' (prints output; read it)'}`);
}

console.log(bad ? `\n${bad} problem(s).` : '\nAll clear.');
process.exit(bad ? 1 : 0);
