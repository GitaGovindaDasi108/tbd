
const fs=require('fs');
const path=require('path');
/* index.html is at the repo root; this harness lives in test/. Override with
   TBS_APP=/path/to/index.html if needed. */
function findApp(){
  const tries=[process.env.TBS_APP, path.join(__dirname,'index.html'),
               path.join(__dirname,'..','index.html')].filter(Boolean);
  for(const p of tries) if(fs.existsSync(p)) return p;
  throw new Error('Could not find index.html — looked in '+tries.join(', '));
}
const h=fs.readFileSync(findApp(),'utf8');
const blocks=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
global.window={TBS_CONFIG:{APPS_SCRIPT_URL:'https://x/exec'},addEventListener(t,f){ (global._win=global._win||{})[t]=f; }};
const store={};
const mkCls=()=>{const set=new Set();return{add:c=>set.add(c),remove:c=>set.delete(c),toggle:(c,v)=>{v?set.add(c):set.delete(c);},contains:c=>set.has(c)};};
const mk=id=>store[id]||(store[id]={id,textContent:'',style:{},dataset:{},value:'',hidden:true,classList:mkCls(),
  firstChild:{textContent:''},_ev:{},addEventListener(t,f){ (store[id]._ev[t]=store[id]._ev[t]||[]).push(f); },querySelectorAll:()=>[],querySelector:()=>null,
  children:[],focus(){},select(){},onclick:null,insertAdjacentHTML(){}, set innerHTML(v){this._h=v;}, get innerHTML(){return this._h||'';}});
global.DOC_CLICKS=[];
function mkEl(cls, text){
  const kids=[{nodeType:3, textContent:text}];
  const el={ className:cls, dataset:{}, childNodes:kids, _attr:{},
    getAttribute:k=>el._attr[k]||null, setAttribute:(k,v)=>{el._attr[k]=v;},
    get textContent(){ return kids.filter(n=>n.nodeType===3).map(n=>n.textContent).join(''); },
    closest:()=>null, querySelector:()=>el._pencil||null,
    appendChild:n=>{ el._pencil=n; kids.push(n); }, remove(){} };
  return el;
}
global.__labelEls=[];
const __src=fs.readFileSync(findApp(),'utf8');
const __js=[...__src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
global.__radios=[{value:'keep',checked:true},{value:'send',checked:false}];
global.document={createElement:t=>({tagName:t,dataset:{},className:'',textContent:'',title:'',appendChild(){},remove(){}}),querySelector:s=>mk(s),
  querySelectorAll:sel=>(String(sel).indexOf('chgOpt')>=0?global.__radios:(String(sel).indexOf('.hint')>=0?global.__labelEls:[])),getElementById:id=>mk('#'+id),
  addEventListener(t,f){ if(t==='click') DOC_CLICKS.push(f); },hidden:false,title:'',scripts:[{src:'',textContent:__js}],body:{classList:mkCls(),innerHTML:__src}};
const SS={}; global.sessionStorage={getItem:k=>SS[k]===undefined?null:SS[k],setItem:(k,v)=>{SS[k]=String(v);},removeItem:k=>{delete SS[k];}};
const LS={}; global.localStorage={getItem:k=>LS[k]===undefined?null:LS[k],setItem:(k,v)=>{LS[k]=String(v);},removeItem:k=>{delete LS[k];}};
global.setInterval=()=>0;
global.location={search:'',origin:'https://x',pathname:'/t/'};
global.ARRIVED=[]; global.HELD=[];
global.fetch=(u,o)=>{ const p=JSON.parse(o.body);
  if(p.action==='getState') return Promise.resolve({text:()=>Promise.resolve(JSON.stringify({ok:true,rev:1,state:global.SNAP}))});
  global.ARRIVED.push(p.action+':'+(p.saleId||p.bundle||p.keepBundleId||''));
  return new Promise(res=>global.HELD.push(()=>res({text:()=>Promise.resolve(JSON.stringify({ok:true,rev:9}))})));
};
const cut = blocks[blocks.length-1].indexOf('(function init(){');
const code = (cut>=0 ? blocks[blocks.length-1].slice(0,cut) : blocks[blocks.length-1])
  + '\n;globalThis.T={commit,hideBooksModal,labelHtml,normLabelKey,stockModal,cacheLoad,shareReport,savePos,loadPos,goTo,switchSeason,prefetchSeasons,seasonCacheLoad,driveFolderModal,renderDriveMap,applyLabels,editLabelModal,renderCollectionsByRegion,pull,undoMovement,invQty,flushPending,newSaleId,outboxLoad,outboxRecover,derive,showSeason,renderAll,collectDescriptions,shelfBooks,allShelfBooks,hiddenHere,changeModal,activeChange,changeAt,eventModal,regionModal,commitSync,cashModal,renderWarehouseOverview,locName,scopeLabel,post,cashBalance,cashCollected,sentToBank,renderDriveMap,renderPayments,costsModal,scopedCosts,shareKeySet,sellerLinkSet,shareLinksModal,buildReport,renderTotals,renderTitleList,setUp:st=>{STATE=st;BASE=st;},ops:()=>OPS,pend:()=>PENDING,goTo};';
eval(code);
module.exports={T:globalThis.T,store,LS,SS,DOC_CLICKS:globalThis.DOC_CLICKS,fire:(sel,type,target)=>{(store[sel]._ev[type]||[]).forEach(f=>f({target,preventDefault(){}}));}};
