const m=require(__dirname+'/mini.js'); const {call}=m;
const state=()=>{ _priceMemo=null; return call({action:'getState'}).state; };
m.init();
const t=[]; const wh=state().regions[0].whLoc;
const qty=b=>{ const i=state().inventory.find(x=>x.location===wh&&x.bookId===b); return i?i.qty:0; };
const holds=b=>state().sales.filter(s=>s.bundle===b).map(s=>s.bookId).sort().join('+');
call({action:'setStockBulk',location:wh,items:[{bookId:'go_ru',qty:1},{bookId:'sr_en',qty:1},{bookId:'we_en',qty:3},{bookId:'adv_en',qty:0}],override:true});
call({action:'sellBundle',keepBundleId:'B1',location:wh,items:[{bookId:'go_ru',pre:false},{bookId:'sr_en',pre:false}],legs:[{type:'Cash',cur:'PLN',amt:200}]});
// a swap with no stock: refused, nothing invented, transaction intact
let r=call({action:'editBundle',bundle:'B1',location:wh,items:[{bookId:'adv_en',pre:false},{bookId:'sr_en',pre:false}],legs:[{type:'Cash',cur:'PLN',amt:200}]});
t.push(['swap without stock refused', !r.ok]);
t.push(['no phantom stock', qty('go_ru')===0 && qty('adv_en')===0]);
t.push(['transaction intact', holds('B1')==='go_ru+sr_en']);
// three more attempts must not accumulate anything
[1,2,3].forEach(()=>call({action:'editBundle',bundle:'B1',location:wh,items:[{bookId:'adv_en',pre:false},{bundleId:'x',bookId:'sr_en',pre:false}],legs:[{type:'Cash',cur:'PLN',amt:200}]}));
t.push(['still no phantom stock after 4 tries', qty('go_ru')===0 && qty('adv_en')===0]);
// with stock, the swap works and frees the old book
call({action:'setStockBulk',location:wh,items:[{bookId:'adv_en',qty:1}],override:true});
r=call({action:'editBundle',bundle:'B1',location:wh,items:[{bookId:'adv_en',pre:false},{bookId:'sr_en',pre:false}],legs:[{type:'Cash',cur:'PLN',amt:200}]});
t.push(['swap with stock works', r.ok && holds('B1')==='adv_en+sr_en']);
t.push(['old book returned, new one taken', qty('go_ru')===1 && qty('adv_en')===0]);
// growing a transaction uses its own freed copies correctly
r=call({action:'editBundle',bundle:'B1',location:wh,items:[{bookId:'adv_en',pre:false},{bookId:'sr_en',pre:false},{bookId:'we_en',pre:false}],legs:[{type:'Cash',cur:'PLN',amt:300}]});
t.push(['adding a third book works', r.ok && holds('B1')==='adv_en+sr_en+we_en' && qty('we_en')===2]);
// asking for more than exists is refused, with the shortfall named
r=call({action:'editBundle',bundle:'B1',location:wh,items:[{bookId:'we_en',pre:false},{bookId:'we_en',pre:false},{bookId:'we_en',pre:false},{bookId:'we_en',pre:false}],legs:[{type:'Cash',cur:'PLN',amt:400}]});
t.push(['too many copies refused, shortfall named', !r.ok && /available at/.test(r.error||'')]);
t.push(['and that transaction is still whole', holds('B1')==='adv_en+sr_en+we_en']);
t.forEach(([n,ok])=>console.log((ok?'PASS':'FAIL'), n));
