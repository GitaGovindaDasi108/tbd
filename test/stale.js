const {T}=require(__dirname+'/clientsim.js');
const tick=(n=60)=>new Promise(r=>setTimeout(r,n));
const mk=(season,name,regions)=>({activeSeason:season,seasonName:name,
  seasons:[{seasonId:'eu',name:'Europe Tour'},{seasonId:'yr',name:'Year-Round'}],
  books:[],payTypes:['Cash'],currencies:['EUR'],rates:{perUsd:{EUR:.86,USD:1}},role:'admin',regions,
  events:[],holders:[],shipments:[],partners:[],payouts:[],prices:{},inventory:[],sales:[],cash:[],change:[],costs:[],
  stockMoves:[],org:[],outstanding:{},qr:[],keys:{},allRegions:[],allEvents:[]});
const EU=mk('eu','Europe Tour',[{regionId:'pl',name:'Poland',whLoc:'wh_pl',currencies:['EUR'],books:[],counts:{},bookOrder:''}]);
const YR=mk('yr','Year-Round',[{regionId:'zg',name:'Zagreb',whLoc:'wh_zg',currencies:['EUR'],books:[],counts:{},bookOrder:''}]);
T.setUp(JSON.parse(JSON.stringify(EU)));
let releaseOldPoll, releaseSwitch;
global.fetch=(u,o)=>{ const p=JSON.parse(o.body);
  if(p.action==='getState') return new Promise(res=>{ releaseOldPoll=()=>res({text:()=>Promise.resolve(JSON.stringify({ok:true,rev:5,state:EU}))}); });
  if(p.action==='setSeason') return new Promise(res=>{ releaseSwitch=()=>res({text:()=>Promise.resolve(JSON.stringify({ok:true,rev:9,state:YR}))}); });
  return Promise.resolve({text:()=>Promise.resolve(JSON.stringify({ok:true,rev:9}))}); };
(async()=>{
  const pollPromise = T.pull();          // an ordinary refresh starts...
  T.switchSeason('yr');                  // ...and you switch season while it is in the air
  await tick();
  console.log('right after switching  :', T.derive().activeSeason, '(' + (T.derive().regions[0]||{}).name + ')');
  releaseSwitch(); await tick();
  console.log('after the switch lands :', T.derive().activeSeason, '(' + (T.derive().regions[0]||{}).name + ')');
  releaseOldPoll(); await tick();        // the OLD refresh finally comes back
  console.log('after the old refresh  :', T.derive().activeSeason, '(' + (T.derive().regions[0]||{}).name + ')  <-- must still be Year-Round');
  process.exit(0);
})();
