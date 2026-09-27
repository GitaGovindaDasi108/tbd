/* Drives every save action the browser tests never reach, so the golden
   replay (test/golden.js) covers the whole server — cash, change, deletes,
   payments, prices, consignment, seasons.

     TBS_RECORD=test/corpus/extra.jsonl node test/corpus-extra.js

   Each request must succeed unless marked `fails`; anything else is printed
   as FAIL, so a bad recording is caught before it becomes the baseline. */
const m = require(__dirname + '/mini.js');
m.init();
const t = [];
const say = (ok, what) => t.push([ok, what]);
let st = m.call({ action: 'getState' }).state;
const SA = st.activeSeason;
const PL = st.regions[0], W = PL.whLoc;
const books = st.books.filter(b => !b.partnerId);
const B0 = books[0].id, B1 = books[1].id, B2 = books[2].id;

function c(p, opts) {
  const r = m.call(Object.assign({ season: SA }, p));
  const want = !(opts && opts.fails);
  say(!!r.ok === want, p.action + (want ? '' : ' (refused, as it should be)') + (r.ok || !want ? '' : ': ' + r.error));
  return r;
}

// Places
c({ action: 'createRegion', regionId: 'rg_it', whLoc: 'wh_it', name: 'Italy', currencies: 'EUR,USD',
    prices: { [B0]: { EUR: 35, USD: 40 } } });
c({ action: 'createEvent', eventId: 'ev_a', name: 'Festival A', regionId: PL.regionId });
c({ action: 'createEvent', eventId: 'ev_b', name: 'Festival B', regionId: PL.regionId });
c({ action: 'createEvent', eventId: 'ev_c', name: 'Roma', regionId: 'rg_it' });
c({ action: 'createEvent', eventId: 'ev_x', name: 'Festival A', regionId: PL.regionId }, { fails: true });

// Stock
c({ action: 'setStockBulk', location: W, items: [{ bookId: B0, qty: 30 }, { bookId: B1, qty: 12 }, { bookId: B2, qty: 4 }], override: true });
c({ action: 'adjustStockBulk', location: 'wh_it', items: [{ bookId: B0, delta: 10 }], override: true, movePrefix: 'adj1' });
c({ action: 'transferBulk', from: W, to: 'ev_a', items: [{ bookId: B0, qty: 15 }, { bookId: B1, qty: 4 }], movePrefix: 'tb1', override: true });
c({ action: 'transferBulk', from: W, to: 'ev_a', items: [{ bookId: B2, qty: 99 }] }, { fails: true });
c({ action: 'transferExternal', direction: 'out', fromLoc: W, label: 'Printer', items: [{ bookId: B1, qty: 1 }], override: true });
c({ action: 'transferExternal', direction: 'out', fromLoc: W, toRegionId: 'rg_it', items: [{ bookId: B0, qty: 2 }], override: true });
c({ action: 'transferExternal', direction: 'in', fromLoc: W, label: 'Printer', items: [{ bookId: B2, qty: 3 }] });
c({ action: 'undoStockMove', id: 'tb1_' + B1 });
c({ action: 'undoStockMove', id: 'nope' }, { fails: true });

// Sales of every shape
const cash = (amt, cur) => [{ type: 'Cash', cur: cur || 'PLN', amt }];
c({ action: 'sell', saleId: 'S1', location: 'ev_a', bookId: B0, legs: cash(150), by: 'Ann', override: true });
c({ action: 'sell', saleId: 'S2', location: 'ev_a', bookId: B0, legs: [{ type: 'Card', cur: 'PLN', amt: 150 }], pending: true, override: true });
c({ action: 'sell', saleId: 'S3', location: 'ev_a', bookId: B0, legs: cash(100), dueamt: 50, duecur: 'PLN', override: true });
c({ action: 'sell', saleId: 'S4', location: 'ev_a', bookId: B0, legs: cash(200), changeamt: 50, changecur: 'PLN', override: true });
c({ action: 'sell', saleId: 'S5', location: 'ev_a', bookId: B1, isPreorder: true, legs: cash(150), name: 'Bob', phone: '+48123456', comments: 'blue cover' });
c({ action: 'sell', saleId: 'S6', location: 'ev_a', bookId: B0,
    legs: [{ type: 'Cash', cur: 'PLN', amt: 50 }, { type: 'Card', cur: 'EUR', amt: 20 }, { type: 'Zelle', cur: 'USD', amt: 5 }], override: true });
c({ action: 'sell', saleId: 'S7', location: 'ev_a', bookId: B0, legs: cash(100), dueamt: 10, duecur: 'EUR', override: true });
c({ action: 'sell', saleId: 'S8', location: 'ev_b', bookId: B2, legs: cash(150) }, { fails: true });   // none there
c({ action: 'markPaid', saleId: 'S2' });
c({ action: 'markPaid', saleId: 'S3' });
c({ action: 'markPaid', saleId: 'S7' });
c({ action: 'giveChange', saleId: 'S4', location: 'ev_a' });
c({ action: 'markDelivered', saleId: 'S5', fromStock: true, fromLoc: W });
c({ action: 'markDelivered', saleId: 'S5', fromStock: true, fromLoc: W }, { fails: true });
c({ action: 'sellBundle', keepBundleId: 'BX', location: 'ev_a', items: [{ bookId: B0, pre: false }, { bookId: B1, pre: true }],
    legs: cash(300), pending: true, name: 'Cara', override: true });
c({ action: 'markPaidBundle', bundle: 'BX' });
c({ action: 'markDeliveredBundle', bundle: 'BX', fromStock: true, fromLoc: W });
c({ action: 'sellBundle', keepBundleId: 'BY', location: 'ev_a', items: [{ bookId: B0 }, { bookId: B0 }], legs: cash(300), override: true });
c({ action: 'deleteBundle', bundle: 'BY' });
c({ action: 'sellBundle', keepBundleId: 'BY', location: 'ev_a', items: [{ bookId: B0 }, { bookId: B0 }], legs: cash(300), override: true });  // deleted: stays deleted
c({ action: 'editSale', saleId: 'S1', location: 'ev_a', type: 'SALE', bookId: B0, legs: [{ type: 'Card', cur: 'PLN', amt: 150 }], comments: 'edited' });
c({ action: 'setUsdActual', saleId: 'S1', usd: 38.5 });
c({ action: 'deleteSale', saleId: 'S4' });
c({ action: 'deleteSale', saleId: 'S4' });                     // a resend: quietly fine
c({ action: 'sell', saleId: 'S4', location: 'ev_a', bookId: B0, legs: cash(150), override: true });   // stays deleted
c({ action: 'donate', saleId: 'D1', location: 'ev_a', legs: cash(20), name: 'Dev' });

// Cash and change
c({ action: 'cashMove', cashId: 'CM1', fromAcct: 'ev_a', toAcct: W, cur: 'PLN', amt: 100, note: 'evening' });
c({ action: 'cashMove', cashId: 'CM2', fromAcct: 'ev_a', toAcct: W, cur: 'PLN', amt: 99999 }, { fails: true });
c({ action: 'cashFloat', loc: 'ev_b', items: [{ cur: 'PLN', amt: 50 }, { cur: 'EUR', amt: 10 }], note: 'till' });
c({ action: 'cashFloat', loc: 'ev_b', back: 'true', items: [{ cur: 'PLN', amt: 20 }] });
c({ action: 'cashAdjust', toAcct: W, cur: 'PLN', amt: 5, note: 'found' });
c({ action: 'cashSet', toAcct: W, cur: 'EUR', amt: 30 });
c({ action: 'cashEdit', id: 'CM1', kind: 'MOVE', fromAcct: 'ev_a', toAcct: W, cur: 'PLN', amt: 90, note: 'edited' });
c({ action: 'changeWithdraw', id: 'CH1', cashId: 'CW1', amt: 20, cur: 'PLN', source: W, loc: 'ev_a' });
c({ action: 'changeWithdraw', id: 'CH2', cashId: 'CW2', amt: 10, cur: 'PLN', source: 'OTHER', sourceName: 'Sita', loc: 'ev_a' });
c({ action: 'changeWithdraw', id: 'CH3', cashId: 'CW3', amt: 5, cur: 'PLN', source: W, loc: 'ev_b' });
c({ action: 'changeReturn', id: 'CH2', cashId: 'CRCH2' });
c({ action: 'cashMoveAll', fromAcct: 'ev_a', toAcct: W, changeIds: 'CH1', idPrefix: 'MA1' });
c({ action: 'changeDelete', id: 'CH3' });
c({ action: 'cashDelete', id: 'CM1' });
c({ action: 'cashDelete', id: 'MA1_PLN' });
c({ action: 'cashMove', cashId: 'CM1', fromAcct: 'ev_a', toAcct: W, cur: 'PLN', amt: 1 });   // deleted: stays deleted
c({ action: 'cashResetAcct', acct: 'ev_b' });
c({ action: 'cashMove', cashId: 'CM3', fromAcct: 'BANK', toAcct: W, cur: 'PLN', amt: 40 });
c({ action: 'cashResetBank' });

// Costs, contacts, QR codes, payment types, prices
c({ action: 'saveCost', id: 'cost1', amt: 3, cur: 'PLN', category: 'Card machine fee', location: 'ev_a', payType: 'Card' });
c({ action: 'saveCost', id: 'cost1', amt: 4, cur: 'PLN', category: 'Card machine fee', location: 'ev_a', payType: 'Card' });
c({ action: 'saveCost', id: 'cost2', amt: 2, cur: 'EUR', category: 'Bank fee', location: 'wh_it' });
c({ action: 'deleteCost', id: 'cost2' });
c({ action: 'orgSave', scope: 'SEASON', rows: [{ category: 'General', name: 'Gita', phone: '+16500000000' }, { category: 'Bank', name: 'Rasika' }] });
c({ action: 'orgSave', scope: PL.regionId, rows: [{ id: 'O1', category: 'Warehouse', name: 'Tulasi', phone: '+48500000000' }] });
c({ action: 'orgSave', scope: PL.regionId, rows: [{ id: 'O1', category: 'Warehouse', name: 'Tulasi S', phone: '+48500000001' }, { category: 'Festival', name: 'Daivi' }] });
c({ action: 'qrSave', scope: 'SEASON', rows: [{ id: 'Qseed01', label: 'Wise', caption: 'new caption', src: 'qr-wise.jpeg' }, { label: 'Revolut', caption: 'r', src: 'data:image/png;base64,AAAA' }] });
c({ action: 'setPayTypes', kind: 'event', id: 'ev_a', types: ['Cash', 'Card', 'cash'] });
c({ action: 'setPayTypes', kind: 'region', id: 'rg_it', types: ['Cash', 'Wise'] });
c({ action: 'setPayTypes', kind: 'event', id: 'ev_a', types: [] });
c({ action: 'setPrices', regionId: 'rg_it', prices: { [B0]: { EUR: 30 }, [B1]: { EUR: 28, USD: 33 } } });
c({ action: 'editRegion', regionId: 'rg_it', name: 'Italia', currencies: 'EUR,USD,GBP', books: [B0, B1].join(','), prices: { [B0]: { EUR: 31, USD: 40, GBP: 27 } } });
c({ action: 'regionAddBooks', regionId: 'rg_it', bookIds: B2 });
c({ action: 'setRegionHidden', regionId: 'rg_it', hidden: B1 });
c({ action: 'setEventHidden', eventId: 'ev_b', hidden: B2 });
c({ action: 'reorder', kind: 'region', ids: ['rg_it', PL.regionId] });
c({ action: 'reorder', kind: 'event', ids: ['ev_b', 'ev_a'] });
c({ action: 'reorderBooks', regionId: PL.regionId, ids: [B1, B0] });
c({ action: 'reorderBooks', ids: [B2, B1, B0] });
c({ action: 'setWarehouseName', name: 'Polska' });
c({ action: 'saveLabel', key: 'hello', text: 'Hi there' });
c({ action: 'saveLabel', key: 'hello', text: 'Hi again' });
c({ action: 'saveLabel', key: 'hello', text: '' });
c({ action: 'renameEvent', eventId: 'ev_b', name: 'Festival Bee' });
c({ action: 'setKey', kind: 'event', id: 'ev_b' });
c({ action: 'setKey', kind: 'region', id: PL.regionId, key: 'kabcdefghij12' });
c({ action: 'sellerLink', regionId: PL.regionId, key: 'sabcdefghij12', scope: 'ev_a' });

// A regional link and a seller link, as their holders would use them
const coord = r => m.call(Object.assign({ k: 'kabcdefghij12', by: 'Coord' }, r));
const seller = r => m.call(Object.assign({ k: 'sabcdefghij12', by: 'Sam' }, r));
say(coord({ action: 'getState' }).ok, 'coordinator link reads its region');
say(seller({ action: 'getState' }).ok, 'seller link reads its event');
say(seller({ action: 'sell', saleId: 'SL1', location: 'ev_a', bookId: B0, legs: cash(150), override: true }).ok, 'seller link sells at its event');
say(!seller({ action: 'sell', saleId: 'SL2', location: W, bookId: B0, legs: cash(150) }).ok, 'seller link refused elsewhere');
say(coord({ action: 'transferMulti', moves: [{ from: W, to: 'ev_b', bookId: B0, qty: 1 }], movePrefix: 'cm1' }).ok, 'coordinator link moves stock in region');
say(!coord({ action: 'cashMove', fromAcct: W, toAcct: 'BANK', cur: 'PLN', amt: 1 }).ok, 'coordinator link refused cash');
say(!m.call({ action: 'getState', k: 'knotarealkey00' }).ok, 'unknown link refused');

// Consignment
const pt = c({ action: 'savePartner', name: 'Local group', regionId: PL.regionId, note: 'n' }).result;
c({ action: 'savePartner', partnerId: pt, name: 'Local group 2', regionId: PL.regionId, note: 'n2' });
const cb = c({ action: 'saveConsignBook', partnerId: pt, name: 'Local Gita', cat: 'other', regionId: PL.regionId,
               prices: { PLN: 20 }, stock: 6, location: W }).result;
c({ action: 'saveConsignBook', bookId: cb, name: 'Local Gita (2nd ed.)', cat: 'big', regionId: PL.regionId, prices: { PLN: 25 } });
c({ action: 'sell', saleId: 'SC1', location: W, bookId: cb, legs: cash(25), override: true });
c({ action: 'partnerPayout', payoutId: 'PO1', partnerId: pt, items: [{ cur: 'PLN', amt: 10 }], method: 'Cash', fromLoc: W, note: 'first' });
c({ action: 'partnerPayout', payoutId: 'PO1', partnerId: pt, items: [{ cur: 'PLN', amt: 10 }], method: 'Cash', fromLoc: W });   // resend
c({ action: 'deletePayout', id: 'PO1_0' });
c({ action: 'renameBook', bookId: cb, name: 'Local Gita (3rd ed.)', cat: 'aotm' });
const tmp = c({ action: 'addBook', name: 'Temporary', cat: 'other' }).result;
c({ action: 'setStockBulk', location: W, items: [{ bookId: tmp, qty: 2 }], override: true });
c({ action: 'deleteBook', bookId: tmp });
c({ action: 'deleteBook', bookId: cb }, { fails: true });     // it has a sale

// Devotee storage
const hd = c({ action: 'saveHolder', regionId: PL.regionId, name: 'Radha', phone: '+48111', newHolderId: 'hd_abcd12' }).result;
c({ action: 'saveHolder', holderId: hd, regionId: PL.regionId, name: 'Radha D', phone: '+48112', note: 'garage' });
c({ action: 'transferMulti', moves: [{ from: W, to: hd, bookId: B0, qty: 3 }], movePrefix: 'tm1' });
c({ action: 'cashMove', cashId: 'CM4', fromAcct: 'BANK', toAcct: hd, cur: 'PLN', amt: 5 });
c({ action: 'deleteHolder', holderId: hd });

// Shipments, both kinds
c({ action: 'sendShipment', shipId: 'sh_aaaa11', fromRegion: PL.regionId, toRegion: 'rg_it', mode: 'devotee', carrier: 'Hari',
    phone: '+39', items: [{ bookId: B0, qty: 2 }, { bookId: B1, qty: 1 }], note: 'bag' });
c({ action: 'editShipment', shipId: 'sh_aaaa11', tracking: 'T1', eta: '2026-06-10', note: 'bag 2' });
c({ action: 'adjustShipment', shipId: 'sh_aaaa11', counts: { [B0]: 1 }, note: 'one left behind' });
c({ action: 'receiveShipment', shipId: 'sh_aaaa11', items: [{ bookId: B0, qty: 1 }] });
c({ action: 'receiveShipment', shipId: 'sh_aaaa11', items: [{ bookId: B1, qty: 1 }], toLoc: 'ev_c' });
c({ action: 'sendShipment', shipId: 'sh_bbbb22', fromRegion: 'OUTSIDE', toRegion: PL.regionId, mode: 'shipping', origin: 'India',
    items: [{ bookId: B2, qty: 5 }], toLoc: 'ev_a' });
c({ action: 'deleteShipment', shipId: 'sh_bbbb22' });
c({ action: 'sendShipment', fromRegion: 'OUTSIDE', toRegion: PL.regionId, mode: 'direct', origin: 'Printer', items: [{ bookId: B2, qty: 2 }] });

// Pre-orders fulfilled by another region
c({ action: 'sell', saleId: 'P1', location: 'ev_c', bookId: B0, isPreorder: true, legs: cash(35, 'EUR'), name: 'Luca' });
c({ action: 'setFulfilBy', remoteSaleId: 'P1', fulfilBy: PL.regionId });
c({ action: 'setFulfilBy', remoteSaleId: 'P1', fulfilBy: '', declined: true });
c({ action: 'fulfilRemote', remoteSaleId: 'P1', fromLoc: W });

// Closing and reopening places; close-progress drafts
c({ action: 'saveCloseDraft', kind: 'event', id: 'ev_b', draft: { checks: [1, 2], counts: { [W + '|' + B0]: 3 }, note: 'half way' } });
c({ action: 'closeLocation', kind: 'event', id: 'ev_b', counts: { ['ev_b|' + B0]: 0 }, note: 'end' });
c({ action: 'sell', saleId: 'S9', location: 'ev_b', bookId: B0, legs: cash(150) }, { fails: true });   // closed
c({ action: 'reopenLocation', kind: 'event', id: 'ev_b' });

// Drive: the top folder, a season's folder, the wording sheet
c({ action: 'setDriveFolder', folder: 'https://drive.google.com/drive/folders/1AbCdEfGhIjK000001' });
c({ action: 'setSeasonFolder', seasonId: SA, which: 'season', folder: '1AbCdEfGhIjK000001' });
c({ action: 'setSeasonFolder', seasonId: SA, which: 'season', reset: 'true' });
c({ action: 'descriptionsSheet', rows: JSON.stringify([{ where: 'Top', kind: 'button', text: 'Sell' }]) });
m.sync(true);

// A second season: hand stock over, then remove it all again
const S2 = c({ action: 'saveSeason', name: 'Year Round' }).result;
c({ action: 'saveSeason', seasonId: S2, name: 'Year-Round' });
c({ action: 'createRegion', season: S2, regionId: 'rg_yr', whLoc: 'wh_yr', name: 'Barcelona', currencies: 'EUR' });
c({ action: 'seasonTransfer', fromRegion: PL.regionId, toRegion: 'rg_yr', items: [{ bookId: B0, qty: 2 }], note: 'winter' });
c({ action: 'setSeason', seasonId: SA });
c({ action: 'reopenSeason', seasonId: S2 });
c({ action: 'deleteEvent', eventId: 'ev_c', restoreSold: true });
c({ action: 'deleteRegion', regionId: 'rg_it', confirmName: 'Italia', moveStockTo: PL.regionId });
c({ action: 'deleteSeason', seasonId: S2, confirmName: 'Year-Round' });
c({ action: 'deleteSeason', seasonId: SA, confirmName: 'wrong' }, { fails: true });
say(m.call({ action: 'opStatus', checkOp: 'nothing' }).ok, 'opStatus answers');
say(m.call({ action: 'ping' }).ok, 'ping answers');
c({ action: 'cashResetAll' });
m.sync(true);

t.forEach(([ok, n]) => console.log((ok ? 'PASS' : 'FAIL'), n));
