/* Dollars received, inside a payment type's dropdown.

   When a sale carries usdActual (what really landed for a digital payment), the
   payment type's own row already showed that figure — but the lines inside its
   dropdown (each place, Donations, Consignment) still showed converted
   estimates, so the dropdown did not add up to the row above it. */
const {T,store}=require(__dirname+'/clientsim.js');

const bk=(id,partnerId)=>({id,name:id,cat:'big',usd:40,pln:150,eur:40,partnerId:partnerId||''});
let k=0;
const S=(loc,book,o)=>Object.assign({saleId:'s'+(k++),ts:'t',location:loc,type:'SALE',bookId:book,qty:1,
  p1type:'Card',p1cur:'EUR',p1amt:40,p2type:'',p2cur:'',p2amt:0,pending:false,paid:true,dueamt:0,duecur:'',
  delivered:true,name:'',phone:'',comments:'',bundle:'',soldBy:'',changeamt:0,changecur:''},o||{});

// 0.8 EUR to the dollar, so every 40 EUR sale is estimated at $50.
T.setUp({seasonName:'S',warehouseName:'M',books:[bk('sr'),bk('fr','p1')],
  payTypes:['Cash','Card','Gift'],currencies:['EUR'],rates:{perUsd:{EUR:.8,USD:1}},role:'admin',
  seasons:[{seasonId:'sA',name:'A',closedAt:''}],activeSeason:'sA',
  regions:[{regionId:'rg',name:'Madrid',whLoc:'wh',currencies:['EUR'],books:[],counts:{},closedAt:'',bookOrder:[]}],
  events:[{eventId:'e1',name:'Festival',regionId:'rg',closedAt:''}],
  partners:[{partnerId:'p1',name:'Friends',regionId:'rg'}],
  holders:[],shipments:[],payouts:[],prices:{},inventory:[],
  sales:[
    S('wh','sr',{usdActual:45}),                     // warehouse: $45 really arrived (est. $50)
    S('e1','sr'),                                    // festival: no figure entered, stays $50
    S('e1','sr',{type:'DONATION',usdActual:48}),     // a donation: $48 arrived
    S('e1','fr',{usdActual:44}),                     // the Friends' book: $44 arrived
  ],
  cash:[],stockMoves:[],org:[],outstanding:{},qr:[],keys:{regions:{},events:{},sellers:{}},allRegions:[]});
T.goTo('region','rg');
T.renderPayments('#payTest');

// The table is a flat grid: a label cell, one cell per currency, then the USD cell.
const cells=[...store['#payTest'].innerHTML.matchAll(/<div class="([^"]*)"[^>]*>([^<]*)</g)]
  .map(m=>({cls:m[1], text:m[2].replace(/[▸\s]+/g,' ').trim()}));
const usdAfter=(label, clsPart)=>{
  const i=cells.findIndex(c=>c.text===label && (!clsPart || c.cls.includes(clsPart)));
  if(i<0) return null;
  const u=cells.slice(i+1).find(c=>/\busd\b/.test(c.cls));
  return u ? Number(u.text.replace(/[^0-9.\-]/g,'')) : null;
};
// The Card row's own label sits in a span, so find its USD cell by position.
const cardUsd=(()=>{ const u=cells.find(c=>/\busd\b/.test(c.cls) && /ptg-r/.test(c.cls)); return u?Number(u.text.replace(/[^0-9.\-]/g,'')):null; })();

const t=[];
t.push(['Card row shows dollars received ($187)', cardUsd===187]);
t.push(['Warehouse line shows $45, not the $50 estimate', usdAfter('Warehouse','ptg-s')===45]);
t.push(['Festival line (nothing entered) stays $50', usdAfter('Festival','ptg-s')===50]);
t.push(['Donations line shows $48 received', usdAfter('Donations','ptg-s')===48]);
t.push(['Consignment line shows $44 received', usdAfter('Consignment','ptg-s')===44]);
const kids=[usdAfter('Warehouse','ptg-s'),usdAfter('Festival','ptg-s'),usdAfter('Donations','ptg-s'),usdAfter('Consignment','ptg-s')];
t.push(['dropdown adds up to the row above it', Math.abs(kids.reduce((a,b)=>a+b,0)-cardUsd)<0.01]);
// In the Consignment section, the Friends' own dropdown lists the places.
t.push(['Friends › Festival line shows $44 received', usdAfter('Festival','conp1')===44]);
t.forEach(([n,ok])=>console.log((ok?'PASS':'FAIL'), n));
