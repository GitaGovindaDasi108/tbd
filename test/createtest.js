const {T,store}=require(__dirname+'/clientsim.js');
const tick=()=>new Promise(r=>setTimeout(r,40));
T.setUp({activeSeason:'s',seasons:[{seasonId:'s',name:'E'}],seasonName:'E',books:[],payTypes:['Cash'],currencies:['EUR'],
  rates:{perUsd:{EUR:.86,USD:1}},role:'admin',
  regions:[{regionId:'it',name:'Italy',whLoc:'wh_it',currencies:['EUR'],books:[],counts:{},bookOrder:''}],
  events:[],holders:[],shipments:[],partners:[],payouts:[],prices:{},inventory:[],sales:[],cash:[],stockMoves:[],org:[],outstanding:{},qr:[],keys:{},allRegions:[],allEvents:[]});
T.goTo('region','it');
(async()=>{
  // a server that never answers, as in the screenshot
  global.fetch=(u,o)=>{ const p=JSON.parse(o.body); ARRIVED.push(p.action);
    return new Promise(res=>HELD.push(()=>res({text:()=>Promise.resolve(JSON.stringify({ok:true,rev:9}))}))); };
  T.eventModal();
  document.querySelector('#evname').value='Yoga Studio';
  (document.querySelector('#saveEv')._ev.click||[]).forEach(f=>f({}));
  await tick();
  const ev=T.derive().events;
  console.log('event appears at once        :', ev.length===1 && ev[0].name==='Yoga Studio');
  console.log('request sent, nothing awaited:', ARRIVED.includes('createEvent'));
  console.log('no error in the dialog       :', !(document.querySelector('#modalErr').textContent||'').trim());
  T.eventModal();
  document.querySelector('#evname').value='Yoga Studio';
  (document.querySelector('#saveEv')._ev.click||[]).forEach(f=>f({}));
  console.log('same name refused before sending:', /already exists/.test(document.querySelector('#modalErr').textContent||''));
  console.log('still just one event         :', T.derive().events.length===1);
  process.exit(0);
})();
