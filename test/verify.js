const {T,store}=require(__dirname+'/clientsim.js');
const tick=(n=60)=>new Promise(r=>setTimeout(r,n));
const S=(loc,cur,amt)=>({saleId:'s1',ts:'t',location:loc,type:'SALE',bookId:'b',qty:1,p1type:'Cash',p1cur:cur,p1amt:amt,p2type:'',p2cur:'',p2amt:0,pending:false,paid:true});
T.setUp({activeSeason:'s',seasons:[{seasonId:'s',name:'E'}],seasonName:'E',books:[{id:'b',name:'B',cat:'big'}],
  payTypes:['Cash'],currencies:['EUR'],rates:{perUsd:{EUR:.86,USD:1}},role:'admin',
  regions:[{regionId:'it',name:'Italy',whLoc:'wh_it',currencies:['EUR'],books:[],counts:{},bookOrder:''}],
  events:[],holders:[],shipments:[],partners:[],payouts:[],prices:{},inventory:[{location:'wh_it',bookId:'b',qty:5}],
  sales:[],cash:[],change:[],stockMoves:[],org:[],outstanding:{},qr:[],keys:{},allRegions:[],allEvents:[]});
const said=()=>{ const t=document.querySelector('#toast'); return (t.className||'').includes('show') ? ((t.className.includes('err')?'ERROR: ':'')+t.textContent) : ''; };
// The save LANDS on the server, but the reply never reaches the app.
const applied=new Set();
global.fetch=(u,o)=>{ const p=JSON.parse(o.body);
  if(p.action==='opStatus') return Promise.resolve({text:()=>Promise.resolve(JSON.stringify({ok:true,done:applied.has(p.checkOp)}))});
  if(p.action==='getState') return Promise.resolve({text:()=>Promise.resolve(JSON.stringify({ok:true,rev:9,state:T.derive()}))});
  applied.add(p.opId);                                  // the server did the work...
  const e=new Error('The server took too long to answer.'); e.network=true;
  return Promise.reject(e);                             // ...but the answer never arrives
};
(async()=>{
  T.goTo('region','it');
  T.commit({action:'sell',saleId:'S1',location:'wh_it',bookId:'b',legs:[{type:'Cash',cur:'EUR',amt:35}]},
    st=>st.sales.push({saleId:'S1',location:'wh_it',type:'SALE',bookId:'b'}), null);
  await tick(200);
  console.log('message shown to the user :', JSON.stringify(said()));
  console.log('saves left waiting       :', T.pend().length);
  console.log('badge text               :', JSON.stringify((store['#pendBadge']||{}).textContent||''));
  console.log('the sale is still there  :', T.derive().sales.some(s=>s.saleId==='S1'));
  console.log('');
  // and the genuine case: the server never got it
  applied.clear();
  global.fetch=(u,o)=>{ const p=JSON.parse(o.body);
    if(p.action==='opStatus') return Promise.resolve({text:()=>Promise.resolve(JSON.stringify({ok:true,done:false}))});
    const e=new Error('No connection to the server.'); e.network=true; return Promise.reject(e); };
  document.querySelector('#toast').className='';
  T.commit({action:'sell',saleId:'S2',location:'wh_it',bookId:'b',legs:[{type:'Cash',cur:'EUR',amt:35}]}, st=>{}, null);
  await tick(200);
  console.log('genuinely offline — message:', JSON.stringify(said()));
  console.log('  it waits, as it should :', T.pend().length===1);
  process.exit(0);
})();
