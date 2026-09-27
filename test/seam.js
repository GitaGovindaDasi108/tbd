/* Keeps the storage layer honest: only the Google Sheets backend may touch the
   hidden data sheets, the script properties or the cache. Everything else
   goes through objectsOf_ / db* / prop* / temp* (see DATA STORE in Code.gs).

     node test/seam.js

   The readable spreadsheets (reports) and Drive filing are built with Sheets
   and Drive by design; they read their data through the store like everything
   else, and are listed here by name. Adding Google calls anywhere new fails
   this test — put them in the backend, or in the report code, deliberately. */
const fs = require('fs'), path = require('path');
const file = [path.join(__dirname, '..', 'Code.gs'), path.join(__dirname, 'Code.gs')].find(fs.existsSync);
const src = fs.readFileSync(process.env.TBS_CODE || file, 'utf8');

// The storage backend: the only code that may reach the data sheets, properties and cache.
const BACKEND = ['STORE_', 'KV_', 'getSheet_', 'sheetsPrepare_', 'hideDataSheets_', 'migrateSales_'];
// Building and filing the readable spreadsheets. Sheets and Drive, never the data sheets.
const REPORTS = ['checkDriveAccess', 'removeStaleTabs_', 'openOrCreateSheetFile_', 'driveRoot_', 'chosenFolder_',
  'driveMap_', 'doSetSeasonFolder', 'placeInFolder_', 'doDescriptionsSheet', 'doSetDriveFolder', 'syncSheets',
  'paintSheet_', 'renderPartnerSheet_', 'renderSeasonSheet_', 'renderHQSheet_', 'renderView_', 'orderTabs_', 'removeStaleRegionTabs_',
  // A renamed or deleted event's old readable tab is removed on the spot.
  'doRenameEvent', 'doDeleteEvent'];

// Drop comments so explanations may mention the services freely.
const code = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
                .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

// Which top-level function or var each line belongs to.
const lines = code.split('\n');
let owner = '(top)';
const owners = lines.map(l => {
  const m = l.match(/^function\s+([\w$]+)/) || l.match(/^var\s+([\w$]+)\s*=/);
  if (m) owner = m[1];
  return owner;
});

const checks = [
  { what: 'hidden data sheets (getSheet_)', re: /\bgetSheet_\s*\(/, allowed: BACKEND },
  { what: 'script properties', re: /\bPropertiesService\b/, allowed: BACKEND },
  { what: 'script cache', re: /\bCacheService\b/, allowed: BACKEND },
  { what: 'Sheets', re: /\bSpreadsheetApp\b|\.getRange\s*\(|\.getSheetByName\s*\(|\.insertSheet\s*\(|\.appendRow\s*\(/,
    allowed: BACKEND.concat(REPORTS) },
  { what: 'Drive', re: /\bDriveApp\b/, allowed: REPORTS }
];

const t = [];
checks.forEach(c => {
  const bad = [];
  lines.forEach((l, i) => { if (c.re.test(l) && c.allowed.indexOf(owners[i]) < 0) bad.push(owners[i] + ' (line ' + (i + 1) + ')'); });
  t.push([!bad.length, c.what + ' reached only where allowed' + (bad.length ? ': ' + bad.join(', ') : '')]);
});

// Report code reads its data like everything else: never a data sheet by name.
const byName = [];
lines.forEach((l, i) => {
  if (/getSheetByName\s*\(\s*['"]_/.test(l) && BACKEND.indexOf(owners[i]) < 0) byName.push(owners[i] + ' (line ' + (i + 1) + ')');
});
t.push([!byName.length, 'no data sheet opened by name outside the backend' + (byName.length ? ': ' + byName.join(', ') : '')]);

// Every allow-listed name still exists, so this list cannot rot silently.
const defined = new Set(owners);
BACKEND.concat(REPORTS).forEach(n => { if (!defined.has(n)) t.push([false, 'allow-listed name no longer exists: ' + n]); });

t.forEach(([ok, n]) => console.log((ok ? 'PASS' : 'FAIL'), n));
