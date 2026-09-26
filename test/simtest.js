const {T}=require(__dirname+'/clientsim.js');
const tick=()=>new Promise(r=>setTimeout(r,20));
const base={seasonName:'S',warehouseName:'M',books:[{id:'sr',name:'Sri Radha',cat:'big',usd:40,pln:150,eur:35,partnerId:''}],
  payTypes:['Cash'],currencies:['EUR'],rates:{perUsd:{EUR:.86,USD:1}},role:'admin',
  seasons:[{seasonId:'sA',name:'A',closedAt:''},{seasonId:'sB',name:'B',closedAt:''}],activeSeason:'sA',
  regions:[{regionId:'rg',name:'Madrid',whLoc:'wh',currencies:['EUR'],books:[],counts:{},closedAt:'',bookOrder:[]}],
  events:[],holders:[],shipments:[],partners:[],payouts:[],prices:{},inventory:[{location:'wh',bookId:'sr',qty:9}],
  sales:[],cash:[],stockMoves:[],org:[],outstanding:{},qr:[],keys:{regions:{},events:{},sellers:{}},allRegions:[]};
const copy=o=>JSON.parse(JSON.stringify(o));
global.SNAP=base; T.setUp(copy(base));
(async()=>{
  const t=[];
  const id=T.newSaleId();
  T.commit({action:'sell',saleId:id,location:'wh',bookId:'sr',legs:[{type:'Cash',cur:'EUR',amt:35}]},
    st=>st.sales.push({saleId:id,location:'wh',type:'SALE',bookId:'sr',p1type:'Cash',p1cur:'EUR',p1amt:35}),null);
  T.commit({action:'editSale',saleId:id,type:'SALE',bookId:'sr',location:'wh',legs:[{type:'Card',cur:'EUR',amt:35}]},
    st=>{ const x=st.sales.find(s=>s.saleId===id); if(x) x.p1type='Card'; },null);
  await tick();
  t.push(['sale shows at once, under its real name', T.derive().sales.some(x=>x.saleId===id)]);
  t.push(['it can be edited at once', T.derive().sales.find(x=>x.saleId===id).p1type==='Card']);
  t.push(['only the sale has gone out so far', ARRIVED.join()==='sell:'+id]);
  t.push(['both are held on the device', T.outboxLoad().length===2]);
  HELD.shift()(); await tick();
  t.push(['the edit goes only after the sale is done', ARRIVED.join()===('sell:'+id+',editSale:'+id)]);
  t.push(['confirmed sale leaves the device copy', T.outboxLoad().length===1]);
  HELD.shift()(); await tick();
  t.push(['all confirmed, device copy empty', T.outboxLoad().length===0]);

  const lost=T.newSaleId();
  T.commit({action:'sell',saleId:lost,location:'wh',bookId:'sr',legs:[{type:'Cash',cur:'EUR',amt:35}]}, st=>{}, null);
  await tick();
  t.push(['page closes mid-save: still held on device', T.outboxLoad().some(x=>x.saleId===lost)]);
  T.outboxRecover();
  t.push(['app reopens: queued to send again', T.pend().some(x=>x.payload.saleId===lost)]);

  const mid=T.newSaleId();
  T.commit({action:'sell',saleId:mid,location:'wh',bookId:'sr',legs:[{type:'Cash',cur:'EUR',amt:35}]},
    st=>st.sales.push({saleId:mid,location:'wh',type:'SALE',bookId:'sr'}),null);
  const n=T.ops().length;
  T.showSeason(Object.assign(copy(base),{activeSeason:'sB'}),1,'sB');
  t.push(['switch season: the change is kept', T.ops().length===n]);
  t.push(['  and not shown in the other season', !T.derive().sales.some(x=>x.saleId===mid)]);
  T.showSeason(copy(base),1,'sA');
  t.push(['back again: it shows', T.derive().sales.some(x=>x.saleId===mid)]);
  t.push(['leaving mid-save asks first', (function(){ const e={preventDefault(){this.p=true}}; global._win.beforeunload(e); return !!e.p; })()]);
  t.forEach(([n,ok])=>console.log((ok?'PASS':'FAIL'), n));
  process.exit(0);
})();
