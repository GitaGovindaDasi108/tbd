const {T,store}=require(__dirname+'/clientsim.js');
const tick=()=>new Promise(r=>setTimeout(r,40));
const q=sel=>document.querySelector(sel);
const S=(loc,cur,amt)=>({saleId:'s'+Math.random(),ts:'t',location:loc,type:'SALE',bookId:'b',qty:1,p1type:'Cash',p1cur:cur,p1amt:amt,p2type:'',p2cur:'',p2amt:0,pending:false,paid:true});
const rows=()=>{ const h=store['#modal'].innerHTML;
  return [...h.matchAll(/<tr><th>([\s\S]*?)<\/th>([\s\S]*?)<\/tr>/g)]
    .map(m=>[m[1].replace(/<[^>]+>/g,'').trim(), m[2].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()]); };
T.setUp({activeSeason:'s',seasons:[{seasonId:'s',name:'E'}],seasonName:'E',books:[{id:'b',name:'B',cat:'big'}],
  payTypes:['Cash'],currencies:['EUR'],rates:{perUsd:{EUR:.86,USD:1}},role:'admin',
  regions:[{regionId:'it',name:'Italy',whLoc:'wh_it',currencies:['EUR'],books:[],counts:{},bookOrder:''}],
  events:[],holders:[],shipments:[],partners:[],payouts:[],prices:{},inventory:[],
  sales:[S('wh_it','EUR',200)],
  change:[{id:'CH1',ts:'t',amt:10,cur:'EUR',source:'BANK',sourceName:'',loc:'wh_it',returnedAt:''}],
  cash:[{id:'CW1',ts:'t',kind:'MOVE',fromAcct:'BANK',toAcct:'wh_it',cur:'EUR',amt:10,purpose:'FLOAT',changeRef:'CH1',note:'Change withdrawn'}],
  stockMoves:[],org:[],outstanding:{},qr:[],keys:{},allRegions:[],allEvents:[]});
global.fetch=(u,o)=>{ const p=JSON.parse(o.body); ARRIVED.push(p.action+':'+(p.cashId||p.idPrefix||p.id||'')); 
  return Promise.resolve({text:()=>Promise.resolve(JSON.stringify({ok:true,rev:9}))}); };
(async()=>{
  T.goTo('region','it'); T.cashModal();
  console.log('--- 200 € of sales, with 10 € of borrowed change in the box ---');
  rows().forEach(r=>console.log('   '+r[0].padEnd(24), r[1]));
  console.log('regions own figure is 200 €          :', rows().some(r=>/Warehouse/.test(r[0]) && /^200 €/.test(r[1].trim())));
  console.log('the change is shown beside the figure   :', /chg-here/.test(store['#modal'].innerHTML));
  console.log('the Global Coordinator still has its 10:', rows().some(r=>/Global Coordinator/.test(r[0])));
  // return the change
  global.confirm=()=>true;
  DOC_CLICKS.forEach(f=>{ try{ f({target:{closest:sel=>sel==='[data-act]'?{dataset:{act:'chgback',id:'CH1'}}:null}, preventDefault(){}}); }catch(e){} });
  await tick();
  T.cashModal();
  console.log('');
  console.log('--- after returning the change ---');
  rows().forEach(r=>console.log('   '+r[0].padEnd(24), r[1]));
  console.log('still exactly the 200 € of sales       :', rows().some(r=>/Warehouse/.test(r[0]) && /200/.test(r[1])));
  console.log('no change marking left                 :', !/chg-here|chg-gone/.test(store['#modal'].innerHTML));
  console.log('the return is in the movement log      :', /Change returned/.test(store['#modal'].innerHTML.replace(/<[^>]+>/g,' ')));
  process.exit(0);
})();
