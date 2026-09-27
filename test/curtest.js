/* A currency a place does not list must not appear in its dialogs.

   Dialogs asked for PLN as their starting currency — a leftover from when the
   tour was only Poland. Since b191 a currency asked for is added to the list
   when the place lacks it (so editing an old sale keeps its own currency),
   which put PLN, already chosen, into every region that does not use it. */
const {T,store}=require(__dirname+'/clientsim.js');
const bk=id=>({id,name:id,cat:'big',usd:40,pln:150,eur:35,partnerId:''});
const reg=(regionId,whLoc,currencies)=>({regionId,name:regionId,whLoc,currencies,books:[],counts:{},closedAt:'',bookOrder:[]});
const base={seasonName:'S',warehouseName:'M',books:[bk('sr'),bk('we')],payTypes:['Cash','Card','Gift'],
  currencies:['PLN','EUR','MKD','USD'],rates:{perUsd:{PLN:3.8,EUR:.86,MKD:55,USD:1}},role:'admin',
  seasons:[{seasonId:'sA',name:'A',closedAt:''}],activeSeason:'sA',
  regions:[reg('mk','wh_mk',['MKD','USD']),reg('pl','wh_pl',['PLN','EUR','USD'])],
  events:[],holders:[],shipments:[],partners:[],payouts:[],prices:{},
  inventory:[{location:'wh_mk',bookId:'sr',qty:5},{location:'wh_mk',bookId:'we',qty:5},
             {location:'wh_pl',bookId:'sr',qty:5},{location:'wh_pl',bookId:'we',qty:5}],
  sales:[{saleId:'old',ts:'t',location:'wh_mk',type:'SALE',bookId:'sr',qty:1,p1type:'Cash',p1cur:'EUR',p1amt:35,
          p2type:'',p2cur:'',p2amt:0,pending:false,paid:true,dueamt:0,duecur:'',delivered:true,name:'',phone:'',comments:''}],
  cash:[],change:[],stockMoves:[],org:[],outstanding:{},qr:[],keys:{regions:{},events:{},sellers:{}},allRegions:[]};
T.setUp(JSON.parse(JSON.stringify(base)));

const opts=(id)=>{ const h=(store['#modal']||{}).innerHTML||''; const m=h.match(new RegExp('<select id="'+id+'">([\\s\\S]*?)</select>'));
  return m ? [...m[1].matchAll(/<option value="([^"]*)"( selected)?/g)].map(x=>x[1]+(x[2]?'*':'')) : null; };
const t=[];
const open=(what,fn)=>{ if(store['#modal']) store['#modal']._h=''; try{ fn(); }catch(e){ /* the mock DOM stops some bindings; the HTML is written first */ } return what; };

T.goTo('region','mk');
open('sale',()=>T.saleModal({bookId:'sr',loc:'wh_mk'}));
t.push(['Macedonia sale: currencies are MKD, USD only, starting on MKD', String(opts('pcur'))==='MKD*,USD']);
t.push(['Macedonia sale: amount owed offers no PLN', !(opts('duecur')||[]).some(c=>/PLN/.test(c))]);
open('bundle',()=>T.bundleModal());
t.push(['Macedonia multi-book: MKD, USD only', String(opts('pcur'))==='MKD*,USD']);
open('donation',()=>T.donationModal());
t.push(['Macedonia donation: MKD, USD only', String(opts('pcur'))==='MKD*,USD']);
t.push(['a stored currency the place lacks is still offered (EUR on an old sale)', T.curOptions('EUR').includes('value="EUR" selected')]);

T.goTo('region','pl');
open('sale',()=>T.saleModal({bookId:'sr',loc:'wh_pl'}));
t.push(['Poland sale still starts on PLN', String(opts('pcur'))==='PLN*,EUR,USD']);
t.forEach(([n,ok])=>console.log((ok?'PASS':'FAIL'), n));
