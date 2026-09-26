const {T,store}=require(__dirname+'/clientsim.js');
// extra functions for this test
const extra = new Function('return 0');
const bk=(id,n,cat)=>({id,name:n,cat,usd:40,pln:150,eur:35,partnerId:''});
let k=0;
const S=(book,loc,o)=>Object.assign({saleId:'s'+(k++),ts:'t',location:loc,type:'SALE',bookId:book,qty:1,
  p1type:'Cash',p1cur:'EUR',p1amt:35,p2type:'',p2cur:'',p2amt:0,pending:false,paid:true,dueamt:0,duecur:'',
  delivered:true,name:'',phone:'',comments:'',bundle:'',soldBy:'',changeamt:0,changecur:''},o||{});
const G={p1type:'Gift',p1amt:0};
T.setUp({seasonName:'Europe Tour',warehouseName:'M',
  books:[bk('sr','Sri Radha (Spanish)','big'),bk('we','Western (English)','big'),bk('adv','Adventures (English)','aotm')],
  payTypes:['Cash','Card','Gift'],currencies:['EUR'],rates:{perUsd:{EUR:.86,USD:1}},role:'admin',
  seasons:[{seasonId:'sA',name:'A',closedAt:''}],activeSeason:'sA',
  regions:[{regionId:'rg',name:'Madrid',whLoc:'wh',currencies:['EUR'],books:[],counts:{},closedAt:'',bookOrder:[]}],
  events:[{eventId:'e2',name:'Festival',regionId:'rg',closedAt:''}],holders:[],shipments:[],partners:[],payouts:[],prices:{},
  inventory:[{location:'wh',bookId:'sr',qty:40},{location:'wh',bookId:'adv',qty:12}],
  sales:[...Array(16).fill(0).map(()=>S('sr','e2')), S('sr','e2',G), S('sr','e2',{type:'PREORDER',delivered:false}),
         S('we','e2'), ...Array(11).fill(0).map(()=>S('adv','e2')), S('adv','e2',G),S('adv','e2',G),S('adv','e2',G)],
  cash:[],stockMoves:[],org:[],outstanding:{},qr:[],keys:{regions:{},events:{},sellers:{}},allRegions:[]});
T.goTo('region','rg');
module.exports={T,store};
