/* Minimal Apps Script stand-in so Code.gs can be exercised in Node. */
const sheets = {};
let uid = 0;
const nextId = () => { uid++; return String.fromCharCode(97 + (uid % 26)).repeat(1) + 'aaaaa'; };

function mkSheet(name){
  const sh = {
    name, grid: [],
    getName:()=>name,
    getLastRow:()=>sh.grid.length,
    getLastColumn:()=>sh.grid.reduce((m,r)=>Math.max(m,r.length),0),
    getMaxRows:()=>Math.max(sh.grid.length,1000),
    getMaxColumns:()=>Math.max(sh.getLastColumn(),50),
    insertRowsAfter:()=>{}, insertColumnsAfter:()=>{}, deleteRow:i=>sh.grid.splice(i-1,1), deleteRows:(i,n)=>sh.grid.splice(i-1,n),
    appendRow:r=>{ if(global.__ops){ global.__ops.append++; global.__ops.cells=(global.__ops.cells||0)+r.length; } sh.grid.push(r.slice()); },
    clear:()=>{ sh.grid=[]; }, clearContents:()=>{ sh.grid=[]; },
    setColumnWidth:()=>{}, setRowHeight:()=>{}, setFrozenRows:()=>{}, setFrozenColumns:()=>{},
    hideSheet:()=>{}, showSheet:()=>{}, autoResizeColumn:()=>{},
    isSheetHidden:()=>false, activate:()=>{}, setName:n=>{ sh.name=n; }, getIndex:()=>1,
    getRange:(r,c,nr,nc)=>{
      nr=nr||1; nc=nc||1;
      const api={
        getValues:()=>{ global.__ops && global.__ops.read++;
          const out=[]; for(let i=0;i<nr;i++){ const row=sh.grid[r-1+i]||[]; const o=[];
            for(let j=0;j<nc;j++) o.push(row[c-1+j]===undefined?'':row[c-1+j]); out.push(o); }
          return out; },
        getValue:()=>api.getValues()[0][0],
        setValues:v=>{ if(global.__ops){ global.__ops.write++; global.__ops.cells=(global.__ops.cells||0)+v.length*((v[0]||[]).length); }
          v.forEach((row,i)=>{ const gi=r-1+i; while(sh.grid.length<=gi) sh.grid.push([]);
            row.forEach((val,j)=>{ sh.grid[gi][c-1+j]=val; }); }); return api; },
        setValue:v=>api.setValues([[v]]),
        setNumberFormat:()=>api, setNumberFormats:()=>api, setBackground:()=>api,
        setBackgrounds:()=>api, setFontColor:()=>api, setFontWeight:()=>api,
        setFontFamily:()=>api, setFontSize:()=>api, setBorder:()=>api,
        setHorizontalAlignment:()=>api, setVerticalAlignment:()=>api, setWrap:()=>api,
        merge:()=>api, breakApart:()=>api, setFontStyle:()=>api, setFontLine:()=>api,
        setTextRotation:()=>api, setNote:()=>api, setFormula:()=>api, setFormulas:()=>api,
        setDataValidation:()=>api, insertCheckboxes:()=>api, setShowHyperlink:()=>api,
        clearContent:()=>{ for(let i=0;i<nr;i++){ const row=sh.grid[r-1+i]; if(!row) continue;
            for(let j=0;j<nc;j++) row[c-1+j]=''; }
          // Drop wholly-blank trailing rows so getLastRow() shrinks, as Sheets does.
          while(sh.grid.length && sh.grid[sh.grid.length-1].every(v=>v===''||v===undefined)) sh.grid.pop();
          return api; },
        clearDataValidations:()=>api };
      return api; },
    getRangeList:()=>{ const rl={ setNumberFormat:()=>rl, setBackground:()=>rl, setFontColor:()=>rl,
      setFontWeight:()=>rl, setFontFamily:()=>rl, setFontSize:()=>rl, setBorder:()=>rl,
      setHorizontalAlignment:()=>rl, setFontStyle:()=>rl }; return rl; },
    getDataRange:()=>sh.getRange(1,1,Math.max(sh.grid.length,1),Math.max(sh.getLastColumn(),1)),
    getSheetId:()=>1, setTabColor:()=>{}, getFilter:()=>null, protect:()=>({ setDescription:()=>({ removeEditors:()=>({ addEditor:()=>{} }) }) })
  };
  return sh;
}
function mkFile(name){
  const f = { _name:name, _sheets:{},
    getName:()=>f._name, setName:n=>{ f._name=n; }, rename:n=>{ f._name=n; },
    getId:()=>'file_'+name.replace(/\W+/g,'_'),
    getUrl:()=>'https://x/'+name,
    getSheetByName:n=>f._sheets[n]||null,
    insertSheet:n=>{ f._sheets[n]=mkSheet(n); return f._sheets[n]; },
    getSheets:()=>Object.values(f._sheets),
    deleteSheet:sh=>{ delete f._sheets[sh.getName()]; },
    setSpreadsheetTimeZone:()=>{}, getSpreadsheetTimeZone:()=>'UTC',
    getActiveSheet:()=>Object.values(f._sheets)[0]||f.insertSheet('Sheet1'),
    setActiveSheet:()=>{}, moveActiveSheet:()=>{}, getNumSheets:()=>Object.keys(f._sheets).length };
  return f;
}
const active = mkFile('Master');
active._sheets = new Proxy(sheets, {});
global.SpreadsheetApp = {
  _files:{},
  getActive:()=>active, getActiveSpreadsheet:()=>active,
  openById:id=>{ SpreadsheetApp._files[id]=SpreadsheetApp._files[id]||mkFile(id); return SpreadsheetApp._files[id]; },
  create:name=>{ const f=mkFile(name); SpreadsheetApp._files[f.getId()]=f; return f; },
  flush:()=>{}
};
active.getSheetByName = n => sheets[n] || null;
active.insertSheet = n => { sheets[n]=mkSheet(n); return sheets[n]; };
active.getSheets = () => Object.values(sheets);
active.deleteSheet = sh => { delete sheets[sh.getName()]; };
active.getActiveSheet = () => Object.values(sheets)[0] || active.insertSheet('Sheet1');
active.setActiveSheet = () => {};
active.moveActiveSheet = () => {};
active.getNumSheets = () => Object.keys(sheets).length;

const props = {};
global.PropertiesService = { getScriptProperties:()=>({
  getProperty:k=>(k in props?props[k]:null), setProperty:(k,v)=>{props[k]=String(v);},
  deleteProperty:k=>{delete props[k];}, getProperties:()=>props }) };
/* Like Apps Script's cache, things run out: after the seconds given, or ten
   minutes (at most six hours). */
const _cache = {}, _cacheExp = {};
const _cacheLive = k => (k in _cache) && !(_cacheExp[k] <= Date.now());
const _cachePut = (k, v, secs) => { _cache[k] = v; _cacheExp[k] = Date.now() + 1000 * Math.min(Number(secs) || 600, 21600); };
global.CacheService = { getScriptCache:()=>({
  get:k=>(_cacheLive(k)?_cache[k]:null), put:_cachePut, remove:k=>{delete _cache[k];},
  getAll:keys=>{ const o={}; keys.forEach(k=>{ if(_cacheLive(k)) o[k]=_cache[k]; }); return o; },
  putAll:(obj,secs)=>{ Object.keys(obj).forEach(k=>_cachePut(k,obj[k],secs)); },
  removeAll:keys=>{ keys.forEach(k=>{ delete _cache[k]; }); } }) };
global.LockService = { getScriptLock:()=>({ tryLock:()=>true, waitLock:()=>true, releaseLock:()=>{} }) };
global.Utilities = { getUuid:()=>nextId()+nextId(), sleep:()=>{}, formatDate:(d)=>String(d),
  formatString:(f,...a)=>f };
global.ContentService = { createTextOutput:t=>({ setMimeType:()=>({ getContent:()=>t }), getContent:()=>t }),
  MimeType:{ JSON:'json' } };
// A Drive stand-in that remembers folders and where each file was moved.
global.__drive = { folders:{}, placed:{}, n:0 };
function mkFolder(name, parent){
  const id = '1AbCdEfGhIjK' + String(++__drive.n).padStart(6,'0');
  const f = { id, name, parent, kids:{},
    getId:()=>id, getName:()=>name,
    getFoldersByName:nm=>{ const hit=f.kids[nm]; return { hasNext:()=>!!hit, next:()=>hit }; },
    createFolder:nm=>{ const c=mkFolder(nm,f); f.kids[nm]=c; return c; } };
  __drive.folders[id]=f; return f;
}
const __myDrive = mkFolder('My Drive', null);
global.DriveApp = {
  getFileById:id=>({ moveTo:folder=>{ __drive.placed[id]=folder.getId(); }, setSharing:()=>{}, addEditor:()=>{} }),
  getRootFolder:()=>__myDrive,
  getFolderById:id=>{ const f=__drive.folders[id]; if(!f) throw new Error('no folder'); return f; },
  createFolder:nm=>__myDrive.createFolder(nm),
  getFoldersByName:nm=>__myDrive.getFoldersByName(nm) };
global.Session = { getActiveUser:()=>({ getEmail:()=>'me@x.com' }), getScriptTimeZone:()=>'UTC' };
global.ScriptApp = { newTrigger:()=>({ timeBased:()=>({ everyMinutes:()=>({ create:()=>{} }) }) }),
  getProjectTriggers:()=>[], deleteTrigger:()=>{} };
global.SpreadsheetApp.BorderStyle = { SOLID:'SOLID', SOLID_MEDIUM:'SOLID_MEDIUM',
  SOLID_THICK:'SOLID_THICK', DOTTED:'DOTTED', DASHED:'DASHED', DOUBLE:'DOUBLE' };
global.SpreadsheetApp.WrapStrategy = { WRAP:'WRAP', OVERFLOW:'OVERFLOW', CLIP:'CLIP' };
global.SpreadsheetApp.newDataValidation = ()=>({ requireValueInList:()=>({ build:()=>({}) }) });
global.console = console;

/* Code.gs lives at the repo root; this harness lives in test/. Look beside the
   harness first, then one level up, so it works either way. Override with
   TBS_CODE=/path/to/Code.gs if you keep it somewhere else. */
const __fs = require('fs'), __path = require('path');
function __find(name){
  const tries = [process.env.TBS_CODE && name==='Code.gs' ? process.env.TBS_CODE : null,
                 __path.join(__dirname, name),
                 __path.join(__dirname, '..', name)].filter(Boolean);
  for(const p of tries) if(__fs.existsSync(p)) return p;
  throw new Error('Could not find ' + name + ' — looked in ' + tries.join(', '));
}
const code = __fs.readFileSync(__find('Code.gs'),'utf8');
eval(code);

/* TBS_STORE=memory keeps every record in memory (memstore.js) instead of the
   hidden sheets, through the same two objects Code.gs uses for storage. */
/* TBS_STORE=sqlite keeps them in a SQLite database (server/src/sqlstore.js) —
   the store the Cloudflare server uses. With TBS_SQL_COLD=1 what it holds in
   memory is forgotten before every request, so only the database is trusted. */
const __mem = process.env.TBS_STORE === 'memory' ? require('./memstore.js')
  : process.env.TBS_STORE === 'sqlite' ? (function () {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(':memory:');
      const exec = (sql, ...params) => {
        const st = db.prepare(sql);
        return /^\s*select/i.test(sql) ? st.all(...params) : (st.run(...params), []);
      };
      return require(__path.join(__dirname, '..', 'server', 'src', 'sqlstore.js')).makeSqlStore(exec);
    })()
  : null;
if (__mem) { STORE_ = __mem.store; KV_ = __mem.kv; }

/* TBS_RECORD=/path/file.jsonl writes every request, in order, one per line.
   test/golden.js replays such a file to prove a change behaves exactly as
   before — the safety net for moving the data off Google Sheets. */
const __rec = process.env.TBS_RECORD;
/* The tour the tests were written against: a season called "Europe Tour" with
   one region, "Poland", whose warehouse has the original id WAREHOUSE and
   PLN/EUR/USD prices. A real new spreadsheet starts empty (b197); this sample
   lives only here. Made directly, so it leaves no activity-log entries. */
function sampleTour(){
  if(objectsOf_('_regions').some(r=>String(r.seasonId)!=='HQ')) return;   // an older Code.gs made its own
  const sid = activeSeasonId_();
  dbUpdate_('_seasons', { seasonId: sid }, { name: 'Europe Tour' });
  const prices = {};
  BOOKS.forEach(b=>{ prices[b.id] = { PLN: b.pln, EUR: b.eur, USD: b.usd }; });
  doCreateRegion({ regionId: 'rg_poland', whLoc: WAREHOUSE, name: 'Poland', currencies: 'PLN,EUR,USD', prices });
  cacheClear_(); bumpRev_();
}
function call(params){
  if(__rec) __fs.appendFileSync(__rec, JSON.stringify(params) + '\n');
  if(__mem && __mem.forget && process.env.TBS_SQL_COLD) __mem.forget();
  const e = { postData:{ contents: JSON.stringify(params) } };
  const out = handle(e);
  try { return JSON.parse(out.getContent()); }
  catch(err){ return { ok:false, error:'unparseable', raw:out }; }
}
module.exports = {
  initBare:()=>initialize(),
  call, init:()=>{ if(__rec) __fs.appendFileSync(__rec, '{"__init":1}\n'); try{ initialize(); sampleTour(); }catch(e){ console.error('init failed', e.message, (e.stack||'').split('\n').slice(1,4).join(' / ')); } },
  label:l=>locLabel_(l),
  sync:f=>{ if(__rec) __fs.appendFileSync(__rec, JSON.stringify({__sync:!!f})+'\n'); return syncSheets(f); },
  cash:(a,c)=>cashCollected_(a,c), tour:()=>tourSales_(),
  // As after a save: forget what was read, and move the revision on so no saved
  // copy of the state is served (tests use it after editing the data directly).
  clear:()=>{ sheetMemoClear_(); cacheClear_(); bumpRev_(); },
  sheet:n=>active.getSheetByName(n),
  floatOut:l=>floatOutstanding_(l), bal:(a,c)=>cashBalance_(a,c),
  pay:l=>payTypesFor_(l),
  // Test hooks: swap a backend function for one call path, and read the revision.
  patch:(name,fn)=>{ if(__rec) __fs.appendFileSync(__rec, JSON.stringify({__patch:name})+'\n'); const old=eval(name); eval(name+' = fn'); return old; },
  rev:()=>getRev_(),
  // Test hook: run a line inside Code.gs's own scope (e.g. to forget cached rates).
  run:src=>eval(src),
  mem:__mem
};
