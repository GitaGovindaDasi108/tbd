const {T}=require(__dirname+'/clientsim.js');
const tick=()=>new Promise(r=>setTimeout(r,20));
const base={seasonName:'S',warehouseName:'M',books:[{id:'sr',name:'Sri Radha',cat:'big',usd:40,pln:150,eur:35,partnerId:''}],
  payTypes:['Cash'],currencies:['EUR'],rates:{perUsd:{EUR:.86,USD:1}},role:'admin',
  seasons:[{seasonId:'sA',name:'A',closedAt:''}],activeSeason:'sA',
  regions:[{regionId:'rg',name:'Madrid',whLoc:'wh',currencies:['EUR'],books:[],counts:{},closedAt:'',bookOrder:[]}],
  events:[],holders:[],shipments:[],partners:[],payouts:[],prices:{},inventory:[{location:'wh',bookId:'sr',qty:9}],
  sales:[],cash:[],stockMoves:[],org:[],outstanding:{},qr:[],keys:{regions:{},events:{},sellers:{}},allRegions:[]};
global.SNAP=base; T.setUp(JSON.parse(JSON.stringify(base)));
// A phone set to Dutch loses signal: the browser's own error, in Dutch.
global.fetch=()=>Promise.reject(new TypeError('De netwerkverbinding is verbroken.'));
(async()=>{
  const id=T.newSaleId();
  T.commit({action:'sell',saleId:id,location:'wh',bookId:'sr',legs:[{type:'Cash',cur:'EUR',amt:35}]},
    st=>st.sales.push({saleId:id,location:'wh',type:'SALE',bookId:'sr'}),null);
  await tick(); await tick();
  const t=[];
  t.push(['sale still on screen', T.derive().sales.some(x=>x.saleId===id)]);
  t.push(['kept to send later (offline queue)', T.pend().some(x=>x.payload.saleId===id)]);
  const toasts=Object.values(require(__dirname+'/clientsim.js').store).map(x=>x.textContent||'').join(' ');
  t.push(['no Dutch shown to the user', !/netwerkverbinding|verbroken/i.test(toasts)]);
  t.forEach(([n,ok])=>console.log((ok?'PASS':'FAIL'), n));
  process.exit(0);
})();
