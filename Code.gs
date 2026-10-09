/**
 * TRANSCENDENTAL BOOK SALES — Google Apps Script backend
 * ------------------------------------------------------
 * The Sheet is the database. The HTML page is the only UI.
 *
 * SETUP (once):
 *   1. Create a Google Sheet.
 *   2. Extensions -> Apps Script. Delete any code, paste ALL of this file.
 *   3. Run `initialize` once (pick it in the toolbar, Run, approve the prompt).
 *      This builds the hidden data sheets AND installs the 1-minute sheet-sync
 *      trigger. You only ever need to run it once per Sheet.
 *   4. Deploy -> New deployment -> "Web app".
 *        Execute as: Me          Who has access: Anyone
 *      Copy the /exec URL into config.js (NOT index.html).
 *   5. After changing this code: Deploy -> Manage deployments -> pencil icon ->
 *      Version: New version -> Deploy. This KEEPS the same URL and keeps all data.
 *      Never use "New deployment" for an update — that makes a second URL.
 *
 * A second warehouse = a new Sheet + a new deployment + its own config.js.
 *
 * SPEED NOTES (why this version is much faster than the first):
 *   - Reads are served from CacheService, so the 15-second poll from 7 devices
 *     no longer re-reads the whole Sheet 28 times a minute.
 *   - Writes only touch the tiny hidden data sheets. They no longer rebuild the
 *     human-readable tabs, which is what made every sale take several seconds.
 *   - The readable tabs are rebuilt by a background trigger once a minute, and
 *     only for the locations that actually changed.
 */

/* ============================ CONFIG ============================ */

var WAREHOUSE = 'WAREHOUSE';            // the id of the FIRST region's warehouse, kept as a
                                        // literal so its old data stays valid. Only an id:
                                        // there is no default warehouse (see homeWarehouse_).
/* Earthly HQ: the level above every season. It keeps its own warehouse (books
   straight from the printer, in India) and sells like a region, so it IS a
   region record — one that lives in a "season" of its own, HQ_ID, and so is
   never counted inside any tour. Opening it shows every season's totals. */
var HQ_ID     = 'HQ';
var HQ_REGION = 'rg_hq';
var HQ_WH     = 'wh_hq';
var SEASON    = 'SEASON';               // the whole tour: every region rolled up together
var SUMMARY   = 'SUMMARY';              // synthetic key: the cross-everything aggregator tab
var RATE_PLN_PER_USD = 3.79;            // fallback: 3.79 PLN = 1 USD (used only if the live fetch fails)
var RATE_EUR_PER_USD = 0.87;            // fallback: 0.87 EUR = 1 USD

// Live exchange rates, resolved once per execution. Fetched from Frankfurter
// (free, no key, European Central Bank data), cached for six hours so we are not
// hitting the network on every request, and falling back to the constants above
// if anything goes wrong — the app must never break because a rate lookup did.
var _fxMemo = null;
// Try several free rate providers in turn; return the first that answers with
// sensible PLN and EUR figures. Each returns { plnPerUsd, eurPerUsd, asOf }.
/* Live FX, base USD, for whatever currencies the season actually uses — the set
   grows as regions are added (MKD, GBP, INR ...), so we ask for them by name
   rather than assuming PLN/EUR. Returns { RATES:{CUR: perUsd}, live, asOf }. */
function fxProviders_(wanted) {
  var list = (wanted || []).filter(function (c) { return c !== 'USD'; });
  var q = list.join(',');
  // The widest source first: one request returns about 160 currencies, so a
  // region can be priced in any of them before it has made a sale.
  return [
    // open.er-api.com — free, no key, very wide currency coverage (MKD, INR ...).
    function () {
      var d = fxGet_('https://open.er-api.com/v6/latest/USD');
      if (d && d.rates) return { rates: d.rates, asOf: String(d.time_last_update_utc || '').slice(0, 16) };
      return null;
    },
    // Frankfurter — ECB data. Major currencies only; the fallback.
    function () {
      if (!q) return { rates: {}, asOf: '' };
      var d = fxGet_('https://api.frankfurter.app/latest?from=USD&to=' + encodeURIComponent(q));
      if (d && d.rates) return { rates: d.rates, asOf: String(d.date || '') };
      return null;
    }
  ];
}
function fxGet_(url) {
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, validateHttpsCertificates: true });
  if (resp.getResponseCode() !== 200) return null;
  return JSON.parse(resp.getContentText());
}

function getRates_() {
  /* A closed season keeps the rates of the day it closed, so its dollar
     figures stop moving — on screen and in its spreadsheets alike. */
  try {
    var ss = seasonById_(activeSeasonId_());
    if (ss && ss.closedAt && ss.frozenRates) {
      var fr = JSON.parse(ss.frozenRates);
      if (fr && fr.RATES) { fr.frozen = true; fr.live = false; return fr; }
    }
  } catch (e) {}
  if (_fxMemo) return _fxMemo;
  var wanted = allCurrencies_();
  var key = 'fx_v4_' + wanted.join('-');
  try {
    var hit = tempGet_(key);
    if (hit) { var c = JSON.parse(hit); if (c && c.live) { _fxMemo = c; return _fxMemo; } }
  } catch (e) {}

  var need = wanted.filter(function (c) { return c !== 'USD'; });
  var live = null;
  var providers = fxProviders_(wanted);
  for (var i = 0; i < providers.length && !live; i++) {
    try {
      var got = providers[i]();
      if (!got || !got.rates) continue;
      // Only accept a provider that covers EVERY currency in use — a partial
      // answer would silently value some collections at zero.
      var rates = { USD: 1 }, ok = true;
      need.forEach(function (c) { if (!(Number(got.rates[c]) > 0)) ok = false; });
      /* Keep every rate it returned, not only those in use. Keeping just the
         in-use ones meant a NEW region's currency had no rate at all, so the
         price calculator in the region dialog came out blank — it worked in
         Europe Tour only because those currencies happened to be in use. */
      Object.keys(got.rates).forEach(function (c) {
        var v = Number(got.rates[c]);
        if (v > 0) rates[String(c).toUpperCase()] = v;
      });
      if (ok) live = { RATES: rates, live: true, asOf: got.asOf || '' };
    } catch (e) { /* try the next provider */ }
  }

  if (live) {
    tempPut_(key, JSON.stringify(live), 6 * 3600);
    _fxMemo = live;
    return _fxMemo;
  }
  // Offline: fall back to the built-in figures for the currencies we know, and
  // 0 for any we don't (better an obvious zero than a silently wrong number).
  var fb = { USD: 1, PLN: RATE_PLN_PER_USD, EUR: RATE_EUR_PER_USD };
  var out = { USD: 1 };
  need.forEach(function (c) { out[c] = fb[c] || 0; });
  _fxMemo = { RATES: out, live: false, asOf: '' };
  return _fxMemo;
}
/** How many units of `cur` equal one USD. */
function perUsd_(cur) {
  var r = getRates_().RATES || {};
  var v = Number(r[String(cur || '').toUpperCase()]);
  return v > 0 ? v : 0;
}

function plnPerUsd_() { return perUsd_('PLN') || RATE_PLN_PER_USD; }
function eurPerUsd_() { return perUsd_('EUR') || RATE_EUR_PER_USD; }

// cat: 'big'  = the large-format titles (150 PLN / 35 EUR / 40 USD)
//      'aotm' = Adventures
var BOOKS = [
  { id: 'sr_en',  name: 'Sri Radha (English)',    cat: 'big',  usd: 40, pln: 150, eur: 35 },
  { id: 'we_en',  name: 'Western (English)',      cat: 'big',  usd: 40, pln: 150, eur: 35 },
  { id: 'ea_en',  name: 'Eastern (English)',      cat: 'big',  usd: 40, pln: 150, eur: 35 },
  { id: 'go_en',  name: 'Govardhana (English)',   cat: 'big',  usd: 40, pln: 150, eur: 35 },
  { id: 'sr_ru',  name: 'Sri Radha (Russian)',    cat: 'big',  usd: 40, pln: 150, eur: 35 },
  { id: 'we_ru',  name: 'Western (Russian)',      cat: 'big',  usd: 40, pln: 150, eur: 35 },
  { id: 'ea_ru',  name: 'Eastern (Russian)',      cat: 'big',  usd: 40, pln: 150, eur: 35 },
  { id: 'go_ru',  name: 'Govardhana (Russian)',   cat: 'big',  usd: 40, pln: 150, eur: 35 },
  { id: 'adv_en', name: 'Adventures (English)',   cat: 'aotm', usd: 15, pln: 55,  eur: 13 }
];

/* Gift stays last: it is not really a way of paying, it is the absence of one,
   and it reads oddly in the middle of a list of methods. */
var PAY_TYPES = ['Cash', 'Card', 'Zelle', 'PayPal', 'Wise', 'Other', 'Gift'];

var SALES_HEADERS = ['saleId','ts','location','type','bookId','qty',
  'p1type','p1cur','p1amt','p2type','p2cur','p2amt',
  'pending','paid','name','phone','comments','delivered','dsource','dueamt','duecur','bundle',
  'soldBy','changeamt','changecur',
  /* What actually landed in the account, in USD, for a digital payment.
     A transfer arrives already converted and skimmed of fees, so the app uses
     this figure instead of estimating one from an exchange rate. */
  'usdActual',
  /* A pre-order another region delivers: which region is asked (any season),
     the shelf the copy came off, and when — and which region declined it. */
  'fulfilBy','fulfilLoc','fulfilAt','fulfilDeclined',
  /* A third payment and beyond (rare), as JSON: [{type,cur,amt}, …]. The first
     two keep their own columns so the sheets read as before. */
  'pmore',
  /* The shelf a delivered pre-order's copy came off, so deleting the sale puts
     it back there rather than on some default warehouse. */
  'dfrom'];

// Sheet theme — mirrors the colors used in index.html.
var TH = {
  plum:   '#3B2A46',
  gold:   '#E9CE86',
  goldD:  '#B8862F',
  cream:  '#FBF6EC',
  paper:  '#FFFDF8',
  paper2: '#FFF8EC',
  line:   '#EBDFC8',
  ink:    '#2A2230',
  muted:  '#7A6E63',
  green:  '#2E7D4F',
  clay:   '#C0392B',
  saffron:'#C4661A'
};

/* ============================ ROUTING ============================ */

/* A revision number changes on every write. Devices poll this instead of
   pulling the whole state, so "nothing has changed" costs one property read. */
function getRev_() {
  var v = propGet_('rev');
  return v ? Number(v) : 0;
}
function bumpRev_() {
  var n = getRev_() + 1;
  propSet_('rev', String(n));
  return n;
}

function doGet(e)  { return handle(e); }
/* Which build of this script is actually running.

   Pasting Code.gs is not enough: the web app keeps serving the last deployed
   version until you make a NEW VERSION. The app shows this next to its own
   build number, so a half-finished deployment is visible at a glance instead
   of looking like a bug. */
var SERVER_BUILD = 'b220';

/* Are the readable spreadsheets made HERE? Yes on Google. On the Cloudflare
   server (server/, Phase 2) the records live in its database and the
   spreadsheets are still made by Google, so it sets this false: nothing that
   builds or tidies a spreadsheet runs there. */
var REPORTS_HERE_ = true;

function doPost(e) { return handle(e); }

/* Requests carry a one-off id so a repeat cannot be applied twice.

   Apps Script occasionally answers a perfectly good write with something the
   app cannot read — a redirect or an error page rather than JSON. The write has
   happened; the app just cannot tell. Pressing the button again then did the
   work a second time. Now the second attempt is recognized and given the
   original answer back, so a retry is always safe. */
function opSeen_(opId) {
  if (!opId) return null;
  return tempGet_('op_' + opId);
}
function rememberOp_(opId, reply) {
  if (!opId) return;
  // Ten minutes is far longer than anyone keeps pressing a button.
  // Six hours — the most the cache allows — so a save re-sent long after a
  // closed page is still recognized rather than applied a second time.
  tempPut_('op_' + opId, reply, 21600);
}

function handle(e) {
  try {
    var params = {};
    if (e && e.postData && e.postData.contents) {
      params = JSON.parse(e.postData.contents);
    } else if (e && e.parameter) {
      params = e.parameter;
    }
    var action = params.action || 'getState';

    // The Cloudflare server passing on a spreadsheet request (Phase 2).
    if (params.cfForward && !MIRROR_) return raw(cfForwarded_(params));
    // Switched to Cloudflare (Phase 3): a phone still pointed here is passed on.
    if (!MIRROR_ && !params.cfForward && cfLive_()) return raw(cfRelay_(params));

    /* Already done? Hand back the same answer instead of repeating the work. */
    var prior = opSeen_(params.opId);
    if (prior) return raw(prior);
    sheetMemoClear_();                   // never serve rows read before this request
    _moveBuffer = [];                    // nothing carried over from a previous call
    _cashIds = [];                       // nor cash rows
    _movesById = null;
    setSeasonContext_('');               // no season carried over from a previous call
    _cashBy = '';                        // nor who was asking

    // ---- Cheapest possible call: one property read, no sheet access. ----
    if (action === 'ping') {
      return raw('{"ok":true,"rev":' + getRev_() + '}');
    }

    // Who is asking? No key = the full admin app, exactly as before.
    var who = roleFor_(params.k);
    if (who.role === 'invalid') {
      return raw('{"ok":false,"error":"That link is no longer valid. Ask for a new one."}');
    }

    /* Switching season is really a read: nothing accumulates, and the app needs
       the other season's data straight away. Answering with it here turns two
       round trips into one, which is what made switching feel slow next to
       moving between regions. */
    if (action === 'setSeason') {
      if (String(params.seasonId || '') === HQ_ID) {
        if (who.role !== 'admin') throw new Error('That action is not available on this link.');
        ensureHQ_();
        setSeasonContext_(HQ_ID);        // looked at, never stored as the default
        return raw(consistentStateReply_(who));
      }
      doSetSeason(params);
      // Revision and data read together — the same fix as for refreshes, which
      // this path had been missing.
      return raw(consistentStateReply_(who));
    }

    /* Each device says which season it is looking at.

       The season on view used to be ONE value on the server, shared by every
       device. Anything that changed it — another tab, a phone, opening the app
       elsewhere — changed it for everyone, so a Sync or a refresh answered with
       whichever season was set last and the app fell back into Europe Tour.
       Now the device's own season answers its own requests. The stored value is
       only the starting point for a device that has not chosen one yet. */
    // Who is making this change, for the cash record.
    _cashBy = String(params.by || '').trim().slice(0, 40) ||
      (who.role === 'admin' ? 'main app' : (who.role === 'coordinator' ? 'coordinator link' : 'seller link'));

    if (who.role === 'admin' && params.season && seasonById_(String(params.season))) {
      setSeasonContext_(String(params.season));
    }
    if (who.role === 'admin' && String(params.season || '') === HQ_ID) {
      ensureHQ_();
      setSeasonContext_(HQ_ID);
    }

    // ---- Reads: no lock, cache-backed. ----
    if (action === 'getState') {
      return raw(consistentStateReply_(who));
    }
    // Every pre-order still waiting, in any season — to take one on for another region.
    if (action === 'openPreorders') {
      if (who.role === 'seller') throw new Error('That action is not available on this link.');
      return raw(JSON.stringify({ ok: true, result: openPreorders_() }));
    }
    // The activity log, fetched when it is opened rather than with every refresh.
    if (action === 'activity') {
      if (who.role === 'seller') throw new Error('That action is not available on this link.');
      var sid = (who.role === 'admin') ? activeSeasonId_()
        : ((regionById_(String(who.regionId || '')) || {}).seasonId || activeSeasonId_());
      return raw(JSON.stringify({ ok: true, result: activityList_(who, sid) }));
    }

    /* Did this save land? A read, so no lock.

       The app asks before it ever reports a failure or holds a change as
       "waiting". Every applied save is remembered here by its own id, so the
       answer is authoritative — which stops a slow reply being mistaken for a
       save that never happened. */
    if (action === 'opStatus') {
      /* Asked about under its OWN parameter name: passing it as opId made the
         request look like a repeat of that very save, so the early "already
         done this" check answered with the save's old reply instead of running
         this check at all. */
      var oid = String(params.checkOp || '');
      var done = false;
      if (oid) done = !!tempGet_('op_' + oid);
      return raw('{"ok":true,"done":' + (done ? 'true' : 'false') + '}');
    }

    // Spreadsheet work is Google's (see REPORTS_HERE_).
    if (!REPORTS_HERE_ && /^(driveMap|syncSheets|setDriveFolder|setSeasonFolder|descriptionsSheet)$/.test(action)) {
      throw new Error('The spreadsheets are looked after by Google — this is not available here yet.');
    }

    // ---- Where every spreadsheet is filed (read-only; owner only). ----
    if (action === 'driveMap') {
      if (who.role !== 'admin') throw new Error('That action is not available on this link.');
      return raw(JSON.stringify({ ok: true, result: driveMap_() }));
    }

    // ---- Rebuild the readable tabs on demand (no lock; not a data write). ----
    if (action === 'syncSheets') {
      if (who.role !== 'admin') throw new Error('That action is not available on this link.');
      syncSheets(true);          // manual press: rebuild every file
      return raw(consistentStateReply_(who));
    }

    // A link's writes belong to its own season, not whichever one the owner
    // happens to be looking at.
    if (who.role !== 'admin') {
      var lr = regionById_(String(who.regionId || ''));
      if (lr) setSeasonContext_(lr.seasonId);
    }

    // Everything below writes. Refuse anything this link isn't entitled to,
    // and anything aimed at a place that has been closed off.
    assertAllowed_(who, action, params);
    assertNotClosed_(action, params);

    // ---- Writes: serialized so 7 devices can't corrupt the data. ----
    var result;
    var lock = LockService.getScriptLock();
    lock.waitLock(25000);
    try {
      ensureReady();
      retireBuiltInLabels_();
      // Leftovers of deleted seasons and regions, cleared on the next save too.
      if (!MIRROR_ && !tempGet_('orphan_sweep')) { tempPut_('orphan_sweep', '1', 3600); try { purgeOrphans_(); } catch (e) {} }
      activityBefore_(action, params);
      switch (action) {
        case 'undoActivity':     result = doUndoActivity(params, who); break;
        case 'undoActivityPart': result = doUndoActivityPart(params, who); break;
        case 'setStockBulk':     doSetStockBulk(params);     break;
        case 'adjustStockBulk':  doAdjustStockBulk(params);  break;
        case 'sell':             doSell(params);             break;
        case 'sellBundle':       doSellBundle(params);       break;
        case 'deleteBundle':     doDeleteBundle(params);     break;
        case 'markPaidBundle':   doMarkPaidBundle(params);   break;
        case 'markDeliveredBundle': doMarkDeliveredBundle(params); break;
        case 'editBundle':       doEditBundle(params);       break;
        case 'donate':           doDonate(params);           break;
        case 'setPayTypes':      doSetPayTypes(params);      break;
        case 'setPayTypeCurrency': result = doSetPayTypeCurrency(params); break;
        case 'createEvent':      result = doCreateEvent(params);  break;
        case 'setEventHidden':   result = doSetEventHidden(params); break;
        case 'setRegionHidden':  result = doSetRegionHidden(params); break;
        case 'renameEvent':      doRenameEvent(params);      break;
        case 'deleteEvent':      doDeleteEvent(params);      break;
        case 'transferBulk':     doTransferBulk(params);     break;
        case 'transferMulti':    doTransferMulti(params);    break;
        case 'setFulfilBy':      result = doSetFulfilBy(params, who); break;
        case 'fulfilRemote':     result = doFulfilRemote(params, who); break;
        case 'transferExternal':  doTransferExternal(params);  break;
        case 'editSale':         doEditSale(params);         break;
        case 'deleteSale':       doDeleteSale(params);       break;
        case 'markPaid':         doMarkPaid(params);         break;
        case 'giveChange':       doGiveChange(params);       break;
        case 'markDelivered':    doMarkDelivered(params);    break;
        case 'setWarehouseName': doSetWarehouseName(params); break;
        case 'cashMove':         doCashMove(params);         break;
        case 'cashFloat':        doFloat(params);            break;
        case 'cashAdjust':       doCashAdjust(params);       break;
        case 'cashSet':          doCashSet(params);          break;
        case 'cashDelete':       doCashDelete(params);       break;
        case 'cashResetBank':    doCashResetBank(params);    break;
        case 'cashEdit':         doCashEdit(params);         break;
        case 'cashResetAcct':    doCashResetAcct(params);    break;
        case 'cashMoveAll':      doCashMoveAll(params);      break;
        case 'cashResetAll':     doCashResetAll(params);     break;
        case 'undoStockMove':    doUndoStockMove(params);    break;
        case 'orgSave':          doOrgSave(params);          break;
        case 'addBook':          result = doAddBook(params); break;
        case 'renameBook':       doRenameBook(params);      break;
        case 'deleteBook':       result = doDeleteBook(params); break;
        case 'qrSave':           doQrSave(params);           break;
        case 'createRegion':     result = doCreateRegion(params); break;
        case 'editRegion':       doEditRegion(params);       break;
        case 'deleteRegion':     doDeleteRegion(params);     break;
        case 'saveSeason':       result = doSaveSeason(params); break;
        case 'deleteSeason':     doDeleteSeason(params);      break;
        case 'closeSeason':      result = doCloseSeason(params); break;
        case 'reopenSeason':     doReopenSeason(params);      break;
        case 'setKey':           result = doSetKey(params);  break;
        case 'setUsdActual':     result = doSetUsdActual(params); break;
        case 'saveLabel':        result = doSaveLabel(params); break;
        case 'changeWithdraw':   result = doChangeWithdraw(params); break;
        case 'changeReturn':     result = doChangeReturn(params);   break;
        case 'changeDelete':     result = doChangeDelete(params);   break;
        case 'changeMove':       doChangeMove(params);              break;
        case 'setDriveFolder':   result = doSetDriveFolder(params); break;
        case 'descriptionsSheet': result = doDescriptionsSheet(params); break;
        case 'setSeasonFolder':  result = doSetSeasonFolder(params); break;
        case 'saveCost':         result = doSaveCost(params); break;
        case 'deleteCost':       doDeleteCost(params);        break;
        case 'sellerLink':       result = doSellerLink(params); break;
        case 'closeLocation':    result = doCloseLocation(params); break;
        case 'reorder':          doReorder(params);              break;
        case 'reorderBooks':     doReorderBooks(params);         break;
        case 'setPrices':        doSetPrices(params);             break;
        case 'saveConsignBook':  result = doSaveConsignBook(params); break;
        case 'savePartner':      result = doSavePartner(params);  break;
        case 'partnerPayout':    doPartnerPayout(params);         break;
        case 'saveHolder':       result = doSaveHolder(params);   break;
        case 'regionAddBooks':   doRegionAddBooks(params);        break;
        case 'sendShipment':     result = doSendShipment(params); break;
        case 'seasonTransfer':   result = doSeasonTransfer(params); break;
        case 'editShipment':     doEditShipment(params);          break;
        case 'deleteShipment':   result = doDeleteShipment(params); break;
        case 'deletePayout':     doDeletePayout(params);          break;
        case 'deleteHolder':     result = doDeleteHolder(params);  break;
        case 'adjustShipment':   result = doAdjustShipment(params); break;
        case 'receiveShipment':  result = doReceiveShipment(params); break;
        case 'reopenLocation':   doReopenLocation(params);   break;
        case 'saveCloseDraft':   doSaveCloseDraft(params);   break;
        default: throw new Error('Unknown action: ' + action);
      }
      cacheClear_();                       // data changed; drop the stale copy
      activityRecord_(action, params, result, who);   // before the movements are flushed
      // Deliberately NOT returning the state. The page already applied this
      // change locally the moment the button was pressed; rebuilding and
      // shipping the whole state here would only make the write slower.
      flushStockMoves_();          // one write for however many rows this action made
      // Tells the background render to hold off while a burst of work is going on.
      propSet_('lastWriteAt', String(Date.now()));
      /* If the caller says it needs the new state, send it with the reply.

         Structural changes used to save, then fetch the state in a second
         request. Each round trip to Apps Script costs a second or more, so
         every such action cost two — which is why adding a link or moving stock
         felt slow when the work itself takes milliseconds. */
      var rev = bumpRev_();
      var body = '';
      if (params.wantState) {
        body = ',"state":' + ((who.role === 'admin') ? stateJson_() : JSON.stringify(scopedState_(who)));
      }
      var reply = '{"ok":true,"rev":' + rev +
                  (result === undefined ? '' : ',"result":' + JSON.stringify(result)) +
                  body + '}';
      // Remember this reply so a repeat of the same request returns it rather
      // than doing the work twice.
      rememberOp_(params.opId, reply);
      return raw(reply);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return raw(JSON.stringify({ ok: false, error: englishError_(err) }));
  }
}

function raw(str) {
  return ContentService.createTextOutput(str).setMimeType(ContentService.MimeType.JSON);
}

/* ============================ CACHE ============================ */
/* CacheService caps a value at 100 KB, so long sales logs are chunked. */

var CACHE_KEY = 'tbs_state';
var CHUNK = 90000;
var MAX_CHUNKS = 12;

function cachePut_(str, rev) {
  try {
    var KEY = CACHE_KEY + '_r' + rev;
    var n = Math.ceil(str.length / CHUNK);
    if (n > MAX_CHUNKS) return;            // too big to cache; reads stay direct
    var payload = {};
    for (var i = 0; i < n; i++) payload[KEY + '_' + i] = str.substr(i * CHUNK, CHUNK);
    payload[KEY + '_n'] = String(n);
    KV_.putTempAll(payload, 3600);               // an hour is plenty; the key changes on every write
  } catch (err) { /* cache is an optimisation, never a requirement */ }
}

function cacheGet_(rev) {
  try {
    var KEY = CACHE_KEY + '_r' + rev;
    var n = KV_.getTemp(KEY + '_n');
    if (!n) return null;
    n = Number(n);
    var keys = [];
    for (var i = 0; i < n; i++) keys.push(KEY + '_' + i);
    var got = KV_.getTempAll(keys);
    var out = '';
    for (var j = 0; j < n; j++) {
      var part = got[KEY + '_' + j];
      if (part === undefined || part === null) return null;   // partial expiry
      out += part;
    }
    return out;
  } catch (err) { return null; }
}

/* Bumping the revision already retires the old snapshot, so this only needs to
   clear the entry for the revision we are on. */
function cacheClear_() {
  sheetMemoClear_();                     // data just changed; re-read on demand
  try {
    var rev = getRev_();
    var KEY = CACHE_KEY + '_r' + rev;
    var keys = [KEY + '_n'];
    for (var i = 0; i < MAX_CHUNKS; i++) keys.push(KEY + '_' + i);
    KV_.delTempAll(keys);
  } catch (err) { /* ignore */ }
}

/* What a share link's holder actually receives. Trimmed rather than filtered in
   the page: money and other regions never leave the server, so there is nothing
   to uncover by poking at the browser. */
function scopedState_(who) {
  /* Pin to the link's own season before anything is read. */
  var mine = regionById_(String(who.regionId || ''));
  setSeasonContext_(mine ? mine.seasonId : '');
  try { return scopedStateFor_(who); }
  finally { setSeasonContext_(''); }
}

function scopedStateFor_(who) {
  // Cached against the revision and the link, exactly like the admin copy —
  // otherwise every poll on a share link rebuilt the whole thing, which is what
  // made selling from a link feel sluggish.
  var rev = getRev_();
  var tag = 'sc_' + (who.role === 'seller' ? (who.eventIds || [who.eventId]).join('.') : who.regionId);
  var hit = cacheGet_(rev + '_' + tag);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* rebuild */ } }
  var out = scopedStateBuild_(who);
  try { cachePut_(JSON.stringify(out), rev + '_' + tag); } catch (e) {}
  return out;
}

function scopedStateBuild_(who) {
  var full = JSON.parse(stateJson_());
  var isSeller = (who.role === 'seller');
  var regionId = who.regionId;
  var myEvents = isSeller ? (who.eventIds || [who.eventId]).filter(Boolean) : [];
  var locs = isSeller ? myEvents : locsInRegion_(regionId);
  var mine = {}; locs.forEach(function (l) { mine[l] = 1; });
  /* A regional link sees the batches coming to or leaving its region — and
     what is in them, since a batch's books are held under its own id. A sales
     link sees none. */
  full.shipments = isSeller ? [] : (full.shipments || []).filter(function (x) {
    return String(x.toRegion) === String(regionId) || String(x.fromRegion) === String(regionId);
  });
  var shipLocs = {}; full.shipments.forEach(function (x) { shipLocs[x.shipId] = 1; });

  full.role = who.role;
  full.lockedRegion = regionId;
  // One event means the app can lock onto it; several means a chooser.
  full.lockedEvent = (isSeller && myEvents.length === 1) ? myEvents[0] : '';
  full.sellerEvents = myEvents;

  full.regions = (full.regions || []).filter(function (r) { return r.regionId === regionId; });
  full.events  = (full.events  || []).filter(function (e) {
    return isSeller ? myEvents.indexOf(e.eventId) >= 0 : String(e.regionId || '') === regionId;
  });
  full.inventory = (full.inventory || []).filter(function (i) { return mine[i.location] || shipLocs[i.location]; });
  full.remote = isSeller ? [] : (full.remote || []).filter(function (x) { return String(x.fulfilBy) === String(regionId); });
  full.sales     = (full.sales     || []).filter(function (x) { return mine[x.location]; });
  var drafts = {};
  Object.keys(full.closeDrafts || {}).forEach(function (k) {
    var id = k.split(':').slice(1).join(':');
    if (!isSeller && (mine[id] || id === regionId)) drafts[k] = full.closeDrafts[k];
  });
  full.closeDrafts = drafts;
  full.costs     = isSeller ? [] : (full.costs || []).filter(function (c) { return mine[c.location]; });
  full.change    = isSeller ? [] : (full.change || []).filter(function (c) {
    // A link sees change at its own places or with its own coordinator.
    return mine[String(c.loc)] || String(c.loc) === 'BANK_' + regionId;
  });
  delete full.driveFolder;     // an owner's setting, not for link holders
  delete full.everywhere;      // every season's figures are for the owner at HQ only
  full.stockMoves = isSeller ? [] : (full.stockMoves || []).filter(function (m) {
    return mine[m.fromLoc] || mine[m.toLoc];
  });
  full.org = (full.org || []).filter(function (r) {
    var sc = String(r.scope || '');
    return sc === regionId || mine[sc];
  });
  full.qr  = (full.qr  || []).filter(function (q) {
    return q.scope === SEASON || q.scope === regionId;
  });
  // Money handling never travels down a share link.
  /* Cash: only movements that touch this link's own places. A transfer from
     their warehouse to the bank is theirs to see — the bank's balance is not,
     since it belongs to the whole tour. Entries between two other places never
     leave the server, so the balance cannot be pieced together here either. */
  full.cash = (full.cash || []).filter(function (c) {
    return c && (mine[String(c.fromAcct)] || mine[String(c.toAcct)]);
  });
  full.hideBank = true;                  // no universal bank balance on a link
  full.sheetLinks = { season: '', regions: {} };
  if (isSeller) full.hideMoney = true;   // sellers record payments but see no totals
  return full;
}

/* Trim a built state to the season being shown.

   Regions are filtered at source, and every other record hangs off a location
   that belongs to a region — so one pass over the season's locations scopes
   sales, stock, cash, movements, events, devotees, shipments and partners
   together. Without it, last year's sales would show up under this year. */
function scopeToSeason_(st) {
  var sid = activeSeasonId_();
  var mine = {};
  (st.regions || []).forEach(function (r) {
    locsInRegion_(r.regionId).forEach(function (l) { mine[String(l)] = 1; });
  });
  var regionOk = {};
  (st.regions || []).forEach(function (r) { regionOk[r.regionId] = 1; });

  // A shipment belongs to the season if either end does.
  (st.shipments || []).forEach(function (x) {
    if (regionOk[x.fromRegion] || regionOk[x.toRegion]) mine[x.shipId] = 1;
  });

  st.events     = (st.events     || []).filter(function (e) { return regionOk[String(e.regionId || '')]; });
  st.holders    = (st.holders    || []).filter(function (h) { return regionOk[String(h.regionId)]; });
  st.partners   = (st.partners   || []).filter(function (x) { return regionOk[String(x.regionId)]; });
  st.shipments  = (st.shipments  || []).filter(function (x) { return regionOk[x.fromRegion] || regionOk[x.toRegion]; });
  st.inventory  = (st.inventory  || []).filter(function (i) { return mine[String(i.location)]; });
  st.sales      = (st.sales      || []).filter(function (x) { return mine[String(x.location)]; });
  st.stockMoves = (st.stockMoves || []).filter(function (m) {
    return mine[String(m.fromLoc)] || mine[String(m.toLoc)];
  });
  st.cash       = (st.cash       || []).filter(function (c) {
    return mine[String(c.fromAcct)] || mine[String(c.toAcct)]
        || String(c.fromAcct) === 'BANK' || String(c.toAcct) === 'BANK';
  });
  st.costs = (st.costs || []).filter(function (c) { return mine[String(c.location)]; });
  // Requests this season's regions were asked to fulfill, wherever they came from.
  st.remote = (st.remote || []).filter(function (x) { return regionOk[String(x.fulfilBy)]; });
  /* Change follows the money, so it can be sitting with a coordinator rather
     than at a place. Keeping only the places made it disappear from the app
     the moment it was banked — while still being owed to whoever lent it. */
  st.change = (st.change || []).filter(function (c) {
    var l = String(c.loc);
    return mine[l] || l === 'BANK' || l.indexOf('BANK_') === 0;
  });
  var payoutOk = {};
  st.partners.forEach(function (x) { payoutOk[x.partnerId] = 1; });
  st.payouts = (st.payouts || []).filter(function (x) { return payoutOk[String(x.partnerId)]; });
  return st;
}

/* The state and its revision number, read as ONE moment.

   The reply used to build the data and then read the revision number a second
   time. A save landing in between produced a reply stamped with the NEW
   revision but carrying the OLD data. The app trusts that stamp to decide which
   of its own pending changes the server already has — so it discarded a change
   the server had not yet sent back, and the transaction vanished until the next
   refresh brought it home. That was the "disappears, then reappears".

   Writes already take the script lock; reading under the same lock means no
   save can land between the two, so the stamp always matches the data. If the
   lock is momentarily unavailable, the revision is read BEFORE the data: the
   stamp can then only be older than the data, never newer, and an older stamp
   merely makes the app keep its copy a moment longer — it can never make a
   transaction disappear. */
function consistentStateReply_(who) {
  var lock = LockService.getScriptLock();
  var held = false;
  try { lock.waitLock(20000); held = true; } catch (e) { /* fall through, safely */ }
  try {
    var rev = getRev_();
    var body = (who.role === 'admin') ? stateJson_() : JSON.stringify(scopedState_(who));
    // The running version, stamped on the reply itself — never read from a saved copy.
    return '{"ok":true,"rev":' + rev + ',"build":"' + SERVER_BUILD + '","state":' + body + '}';
  } finally {
    if (held) lock.releaseLock();
  }
}

/* Every message the app shows is in English.

   The app's own errors are written in English. But errors raised by Google's
   services — a lock that timed out, a spreadsheet that could not be reached —
   arrive in the language of the Google account, which is how a Dutch message
   turned up in an English app. Those are recognized and replaced with an
   English explanation; the original is kept in the log for diagnosis. */
function englishError_(err) {
  var msg = String(err && err.message ? err.message : err || '');
  var name = String(err && err.name || '');
  /* Our own messages are thrown as plain Error, and the JavaScript engine's
     own errors are English too — both pass through untouched. Only Google's
     service exceptions, which follow the account's language, are replaced.
     (Guessing "foreign" from the words would misfire on a place like Kraków.) */
  var ours = { 'Error':1, 'TypeError':1, 'RangeError':1, 'ReferenceError':1, 'SyntaxError':1, '':1 };
  if (ours[name]) return msg;
  try { console.error('Service error (shown in English):', name, msg); } catch (e) {}
  var m = msg.toLowerCase();
  if (/lock|vergrendel|verrou|sperre|bloqueo/.test(m))
    return 'The system was busy with another save. Please try again in a moment.';
  if (/timed? ?out|time-out|tijdslimiet|zeitüberschreitung|délai/.test(m))
    return 'That took too long to finish. Please try again.';
  if (/quota|limit|limiet/.test(m))
    return 'Google limited how much can be done right now. Please try again shortly.';
  if (/permission|toestemming|autoris|berechtigung|access|toegang/.test(m))
    return 'The app does not have permission to do that. Check the deployment settings.';
  if (/spreadsheet|sheet|range|bereik/.test(m))
    return 'The spreadsheet could not be read or written just then. Please try again.';
  return 'Something went wrong on the server. Please try again.';
}

function stateJson_() {
  // Read the revision first: whatever we return is a snapshot OF that revision,
  // and it gets stored under that revision's key. A concurrent write moves the
  // revision on, so this snapshot can never be served as if it were newer.
  // Cached per season as well as per revision: two seasons at the same revision
  // are different states.
  var rev = getRev_() + '_' + activeSeasonId_();   // includes any link's pinned season
  /* And per version of this code: a copy made by an older deployment must never
     be served by a newer one — it carried the old version number, so the app
     warned "not updated" straight after a successful deploy. */
  rev += '_' + SERVER_BUILD;
  var hit = cacheGet_(rev);
  if (hit) return hit;
  var st = readState();
  // The currency each payment type arrives in, once any has been set (b210).
  var ptc = payTypeCurrencies_();
  if (Object.keys(ptc).length) st.payTypeCur = ptc;
  // At HQ, every season's records ride along, taken before HQ's own trim.
  if (isHQ_()) st.everywhere = everywhere_(st.sales, st.inventory);
  var str = JSON.stringify(scopeToSeason_(st));
  cachePut_(str, rev);
  return str;
}

/* ============================ SETUP ============================ */

function initialize() {
  ensureReady(true);
  // Repairs above can change how existing rows read, so the cached state must
  // not survive them.
  cacheClear_();
  hideDataSheets_();
  removeStaleTabs_();
  flushStockMoves_();
  installTrigger_();
  markDirtyAll_();
  checkDriveAccess();              // says in the log whether filing will work
  // Deliberately NOT rendering the sheets here. Setting up the data takes a
  // moment; rebuilding every regional and season file can take minutes, and
  // Apps Script stops a script after six — which made initialize look like it
  // had failed when the data part had in fact finished. The minute trigger
  // picks the rendering up, or press "Sync sheet" in the app.
}

/** Set up the data AND rebuild every sheet. Only for a small tour, or when you
    are happy to wait — initialize() alone is the safe one. */
function initializeAndRebuild() {
  initialize();
  syncSheets(true);
}

/* Run this from the editor to find out whether the app can file spreadsheets
   in Google Drive. It reports in the Execution log, in plain English.

   Selecting it and pressing Run is also the surest way to make Google ask for
   the Drive permission if it has not been granted: this function uses Drive
   directly, so Google cannot run it without asking first. */
function checkDriveAccess() {
  var msg;
  try {
    DriveApp.getRootFolder().getName();          // needs the Drive permission
    var f = driveRoot_();
    msg = 'OK — Drive access is working. Spreadsheets will be filed in the folder "' +
          f.getName() + '". Press Sync sheet in the app to file them now.';
  } catch (e) {
    msg = 'NOT YET — the app cannot use Google Drive. ' +
          'Google said: ' + String(e && e.message || e) + '. ' +
          'See the setup note: the project may be limited to a fixed list of permissions.';
  }
  console.log(msg);
  return msg;
}

/* The master tab was renamed from "<name> — Warehouse" to "Summary" plus a
   separate "<name> — Warehouse Sales". Delete the old one so it does not linger
   as an out-of-date duplicate. */
function removeStaleTabs_() {
  var ss = SpreadsheetApp.getActive();
  var stale = ss.getSheetByName(getWarehouseName_() + ' \u2014 Warehouse');
  if (stale) {
    try { ss.deleteSheet(stale); } catch (err) { /* leave it if it is the only sheet */ }
  }
}

/* The 1-minute sheet-refresh trigger is a convenience, not a requirement: the app
   works fully without it (the ⇪ Sync sheet button does the same job on demand).
   So a missing trigger permission must never stop initialize from finishing. */
function installTrigger_() {
  try {
    var have = ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === 'syncSheets';
    });
    if (!have) ScriptApp.newTrigger('syncSheets').timeBased().everyMinutes(1).create();
  } catch (err) {
    Logger.log('Could not install the auto-sync trigger (' + err + '). ' +
      'The app still works — use the "Sync sheet" button, or add the ' +
      'script.scriptapp scope to appsscript.json to enable auto-refresh.');
  }
}

function ensureReady(force) {
  // Checking five sheets on every single request was measurable overhead, so
  // the all-clear is remembered for an hour.
  if (!force) {
    if (tempGet_('tbs_ready_v4')) return;
  }

  dbCreate_('_meta',      ['key','value']);
  dbCreate_('_books',     ['id','name','cat','usd','pln','eur','sort']);
  dbCreate_('_custombooks',['id','name','cat','createdAt','partnerId','sort']);
  dbCreate_('_partners',  ['partnerId','regionId','name','note','createdAt','archived']);
  dbCreate_('_payouts',   ['id','partnerId','ts','cur','amt','note','method']);
  dbCreate_('_costs',     ['id','ts','location','category','payType','cur','amt','note','partnerId']);
  dbCreate_('_change',    ['id','ts','amt','cur','source','sourceName','loc','returnedAt','by']);
  dbCreate_('_labels',    ['key','text']);
  dbCreate_('_qr',        ['id','scope','label','caption','src','sort']);
  dbCreate_('_holders',   ['holderId','regionId','name','phone','note','createdAt','archived']);
  dbCreate_('_shipments', ['shipId','fromRegion','toRegion','mode','carrier','phone',
                        'tracking','trackingUrl','eta','note','status','createdAt','arrivedAt',
                        'manifest','origin']);
  dbCreate_('_regions',   ['regionId','name','whLoc','sort','createdAt','currencies','books','key','closedAt','seasonId']);
  dbCreate_('_seasons',   ['seasonId','name','sort','createdAt','closedAt']);
  dbCreate_('_prices',    ['regionId','bookId','cur','price']);
  dbCreate_('_events',    ['eventId','name','createdAt','regionId','key','closedAt','sort','payTypes']);
  dbCreate_('_inventory', ['location','bookId','qty']);
  dbCreate_('_sales',     SALES_HEADERS);
  dbCreate_('_cash',      ['id','ts','kind','fromAcct','toAcct','cur','amt','note','purpose','by','changeAmt','changeIds','changeRef']);
  dbCreate_('_org',       ['id','scope','category','sort','name','phone']);
  dbCreate_('_stockmoves',['id','ts','kind','fromLoc','toLoc','bookId','qty','note','fromBefore','fromAfter','toBefore','toAfter']);

  sheetsPrepare_();                      // phone columns as text, before anything is written

  /* A new spreadsheet starts with the book catalogue and nothing else: no
     region, no contacts, no payment codes. (It used to create a region named
     "Poland" with Polish prices, the original contact list and three personal
     payment codes — from when the app was Poland's alone.) Seasons, regions and
     everything in them are made in the app. */
  /* The built-in titles, written by position over whatever the first rows
     hold; anything else on those rows (a hand-placed sort) is kept. */
  var oldBooks = objectsOf_('_books');
  if (!oldBooks.length || force) {
    var seeded = BOOKS.map(function (b, i) {
      return Object.assign({}, oldBooks[i] || {}, { id: b.id, name: b.name, cat: b.cat, usd: b.usd, pln: b.pln, eur: b.eur });
    }).concat(oldBooks.slice(BOOKS.length).map(function (o) {
      return Object.assign({}, o, { id: '', name: '', cat: '', usd: '', pln: '', eur: '' });
    }));
    dbSave_('_books', seeded, ['id','name','cat','usd','pln','eur']);
  }

  migrateSeason_();
  dbAddCols_('_sales', ['soldBy']);
  dbAddCols_('_sales', ['changeamt']);
  dbAddCols_('_sales', ['changecur']);
  migrateSales_();
  tempPut_('tbs_ready_v4', '1', 3600);
}

/* One-time upgrade to the season/region/event hierarchy.

   Deliberately non-destructive: Poland's warehouse keeps the literal location id
   'WAREHOUSE', so every existing sale, inventory row, cash entry and stock move
   still points at exactly the right place. We only add the region record around
   them, stamp existing events with it, and scope existing org rows to it.      */
function migrateSeason_() {
  dbAddCols_('_events', ['regionId']);
  dbAddCols_('_org', ['scope']);
  dbAddCols_('_regions', ['currencies']);
  dbAddCols_('_regions', ['books']);
  dbAddCols_('_regions', ['key']);
  dbAddCols_('_events', ['key']);
  dbAddCols_('_events', ['closedAt']);
  dbAddCols_('_events', ['sort']);
  dbAddCols_('_events', ['hidden']);
  dbAddCols_('_shipments', ['manifest']);
  dbAddCols_('_custombooks', ['partnerId']);
  dbAddCols_('_payouts', ['method']);
  dbAddCols_('_shipments', ['origin']);
  dbAddCols_('_cash', ['purpose']);
  dbAddCols_('_cash', ['by']);
  dbAddCols_('_cash', ['changeAmt']);
  dbAddCols_('_cash', ['changeIds']);
  dbAddCols_('_cash', ['changeRef']);
  dbAddCols_('_regions', ['seasonId']);
  dbAddCols_('_events', ['payTypes']);
  dbAddCols_('_custombooks', ['sort']);
  dbAddCols_('_regions', ['bankName']);
  dbAddCols_('_regions', ['bookOrder']);
  dbAddCols_('_costs', ['partnerId']);
  dbAddCols_('_regions', ['sellerKey']);
  dbAddCols_('_regions', ['sellerScope']);
  dbAddCols_('_regions', ['payTypes']);
  dbAddCols_('_regions', ['closedAt']);

  var firstRegionId = '';

  /* Data from before regions existed (sales, stock, events at the literal
     WAREHOUSE) is adopted by a first region. A new spreadsheet has nothing to
     adopt, so it gets no region at all. */
  var legacy = !objectsOf_('_regions').length &&
    (objectsOf_('_sales').length || objectsOf_('_inventory').length || objectsOf_('_events').length);
  if (legacy) {
    // Named after whatever the warehouse was already called.
    var whName = String(getWarehouseName_() || 'Warehouse').trim() || 'Warehouse';
    firstRegionId = 'rg_' + Utilities.getUuid().slice(0, 6);
    // Poland's original three currencies, in the order the app has always shown them.
    dbInsert_('_regions', { regionId: firstRegionId, name: whName, whLoc: WAREHOUSE, sort: 0,
                            createdAt: new Date(), currencies: 'PLN,EUR,USD' });
  } else {
    var existing = regionsOrdered_();
    firstRegionId = existing.length ? existing[0].regionId : '';
  }

  // Stamp any event that predates regions onto the first region.
  if (firstRegionId) {
    dbUpdate_('_events', function (e) { return !String(e.regionId || '').trim(); }, { regionId: firstRegionId });
  }

  // Seed that region's prices from the built-in figures, so nothing changes for
  // Poland while later regions get their own pricing.
  if (dbHas_('_prices') && !objectsOf_('_prices').length && firstRegionId) {
    var rows = [];
    allBooks_().forEach(function (b) {
      rows.push({ regionId: firstRegionId, bookId: b.id, cur: 'PLN', price: Number(b.pln) || 0 });
      rows.push({ regionId: firstRegionId, bookId: b.id, cur: 'EUR', price: Number(b.eur) || 0 });
      rows.push({ regionId: firstRegionId, bookId: b.id, cur: 'USD', price: Number(b.usd) || 0 });
    });
    dbInsert_('_prices', rows);
  }

  repairOrgColumns_();

  // Existing org entries belong to that first region (they were written when the
  // warehouse WAS the whole world).
  if (firstRegionId) {
    dbUpdate_('_org', function (o) { return !String(o.scope || '').trim(); }, { scope: firstRegionId });
  }
}

/* Put the org chart back together after the column-order bug.

   When 'scope' was introduced it was appended to the END of the sheet, while
   the code wrote it SECOND. Rows saved in between landed one column out: the
   scope sat under "category", the category under "sort", and so on down the
   line — which is why contacts turned into phone numbers and event ids showed
   up as job titles. Detected by a category that is really a scope, so a healthy
   sheet is left completely alone. */
function looksLikeScope_(v) {
  v = String(v || '').trim();
  if (!v) return false;
  if (v === SEASON) return true;
  return /^(rg_|ev_|wh_)/i.test(v);
}

function repairOrgColumns_() {
  var rows = objectsOf_('_org');
  if (!rows.length) return;

  var shifted = rows.filter(function (r) { return looksLikeScope_(r.category); });
  if (!shifted.length) return;                 // nothing to do

  var fixed = rows.map(function (r) {
    if (!looksLikeScope_(r.category)) {
      return { id: String(r.id || ''), scope: String(r.scope || ''),
               category: String(r.category || ''), sort: Number(r.sort) || 0,
               name: String(r.name || ''), phone: String(r.phone || '') };
    }
    // Shift every field back one place to where it belongs.
    return {
      id: String(r.id || ''),
      scope: String(r.category || ''),
      category: String(r.sort || ''),
      sort: Number(r.name) || 0,
      name: String(r.phone || ''),
      phone: String(r.scope || '')
    };
  }).filter(function (r) { return r.category && (r.name || r.phone); });

  dbSave_('_org', fixed, ['id','scope','category','sort','name','phone']);
  console.log('Repaired ' + shifted.length + ' org row(s) shifted by the scope-column change.');
}

/* ---- Closing a place ------------------------------------------------------
   A closed event or region is finished with: nothing can be sold, moved or
   edited there again. The records stay fully visible — closing is about
   settling the books, not hiding them. Outstanding payments and undelivered
   pre-orders don't block closing, they just leave it marked as still having
   work attached. */
function closedAtOf_(loc) {
  loc = String(loc);
  var regs = regionsOrdered_();
  for (var i = 0; i < regs.length; i++) {
    if (regs[i].whLoc === loc) return regs[i].closedAt || '';
  }
  var evs = objectsOf_('_events');
  for (var j = 0; j < evs.length; j++) {
    if (String(evs[j].eventId) === loc) {
      if (evs[j].closedAt) return evs[j].closedAt;
      // An event inside a closed region is closed with it.
      var r = regionById_(String(evs[j].regionId || ''));
      return (r && r.closedAt) ? r.closedAt : '';
    }
  }
  return '';
}
function isClosedLoc_(loc) { return !!closedAtOf_(loc); }

/* Actions that change what happened somewhere. Reading is always allowed. */
var MUTATING_ACTIONS = {
  sell:1, sellBundle:1, donate:1, editSale:1, editBundle:1, deleteSale:1,
  settle:1, deliver:1, markPaid:1,
  transferBulk:1, transferExternal:1, adjustStockBulk:1, setStockBulk:1,
  undoStockMove:1, transferMulti:1, fulfilRemote:1
};

/* Except these. Closing a place means no NEW business — but the promises it
   already made still have to be kept: a pre-order handed over, a debt paid.
   Allowing exactly these lets a partly-closed region finish settling itself,
   and it flips to fully closed the moment nothing is outstanding. */
var SETTLING_ACTIONS = {
  markPaid:1, giveChange:1, markDelivered:1, markDeliveredBundle:1, settle:1, deliver:1
};

function assertNotClosed_(action, params) {
  if (SETTLING_ACTIONS[action]) return;      // finishing what was already promised
  if (!MUTATING_ACTIONS[action]) return;
  var touched = [];
  ['location', 'from', 'to', 'fromLoc'].forEach(function (f) {
    if (params[f]) touched.push(String(params[f]));
  });
  (params.moves || []).forEach(function (m) {
    if (m && m.from) touched.push(String(m.from));
    if (m && m.to) touched.push(String(m.to));
  });
  if (params.saleId) {
    objectsOf_('_sales').forEach(function (r) {
      if (String(r.saleId) === String(params.saleId)) touched.push(String(r.location));
    });
  }
  for (var i = 0; i < touched.length; i++) {
    if (isClosedLoc_(touched[i])) {
      throw new Error(locLabel_(touched[i]) + ' is closed. Reopen it first if something needs changing.');
    }
  }
}

/** Is there still work attached to these locations? */
function outstandingAt_(locs) {
  var mine = {}; locs.forEach(function (l) { mine[String(l)] = 1; });
  var owed = 0, undelivered = 0;
  tourSales_().forEach(function (r) {
    if (!mine[String(r.location)]) return;
    if (pendingFlag_(r) || (Number(r.dueamt) || 0) > 0) owed++;
    if (String(r.type) === 'PREORDER' && !isDelivered_(r)) undelivered++;
  });
  return { owed: owed, undelivered: undelivered };
}

function setClosed_(kind, id, when) {
  var sheetName = kind === 'event' ? '_events' : '_regions';
  var idCol = kind === 'event' ? 'eventId' : 'regionId';
  if (dbCols_(sheetName).indexOf('closedAt') < 0) throw new Error('That sheet has not been upgraded — run initialize.');
  var match = {}; match[idCol] = String(id);
  if (!dbUpdate_(sheetName, match, { closedAt: when })) throw new Error('That no longer exists.');
}

/* Close an event or a region, reconciling the shelves on the way out.

   `counts` is what was physically there at the end. Anything that differs from
   what the system expected is recorded as an adjustment with a note, so the
   discrepancy is visible in the transfer log rather than silently absorbed. */
/* Closing takes a while — a count, a checklist — so it can be saved part-way
   and picked up again, on any device. Kept until the place is closed. */
var CLOSE_DRAFT_PREFIX = 'cldraft:';
function doSaveCloseDraft(p) {
  var kind = String(p.kind || 'event'), id = String(p.id || '');
  if (!id) throw new Error('Nothing to save.');
  var key = CLOSE_DRAFT_PREFIX + kind + ':' + id;
  if (p.clear) { propDel_(key); return; }
  var d = p.draft || {};
  var draft = { checks: (d.checks || []).map(Number), counts: d.counts || {}, note: String(d.note || '').slice(0, 500),
                at: new Date().toISOString(), by: _cashBy || '' };
  propSet_(key, JSON.stringify(draft).slice(0, 8500));
}
function closeDrafts_() {
  var all = propAll_(), out = {};
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(CLOSE_DRAFT_PREFIX) !== 0) return;
    try { out[k.slice(CLOSE_DRAFT_PREFIX.length)] = JSON.parse(all[k]); } catch (e) {}
  });
  return out;
}

function doCloseLocation(p) {
  var kind = String(p.kind || 'event');
  var id = String(p.id || '');
  if (kind === 'region' && id === HQ_REGION) throw new Error('Earthly HQ is never closed.');
  var locs = (kind === 'event') ? [id] : locsInRegion_(id);
  if (!locs.length) throw new Error('Nothing to close.');
  propDel_(CLOSE_DRAFT_PREFIX + kind + ':' + id);   // done with it

  var counts = p.counts || {};
  var map = loadInvMap_();
  var diffs = [];
  Object.keys(counts).forEach(function (compound) {
    // keys arrive as "location|bookId" so a region can count several places
    var bits = compound.split('|');
    var loc = bits.length > 1 ? bits[0] : locs[0];
    var bookId = bits.length > 1 ? bits[1] : bits[0];
    if (locs.indexOf(loc) < 0) return;
    var counted = Math.max(0, Math.round(Number(counts[compound])));
    if (isNaN(counted)) return;
    var expected = getQty_(map, loc, bookId);
    if (counted === expected) return;
    setQty_(map, loc, bookId, counted);
    stockMoveAppend_({ kind: 'ADJUST', toLoc: loc, bookId: bookId, qty: counted - expected,
      note: 'Closing count' + (p.note ? ' — ' + p.note : ''),
      toBefore: expected, toAfter: counted });
    diffs.push({ loc: loc, bookId: bookId, expected: expected, counted: counted });
  });
  saveInvMap_(map);

  setClosed_(kind, id, new Date());
  // A region's dollars stop moving the day it closes.
  if (kind === 'region') freezeRegionRates_(id, null);
  /* Only redraw the spreadsheets if the closing actually changed a number.

     A clean close — counts matching what the app expected — alters nothing but
     a status flag, so rebuilding the region's file (and re-running every
     currency conversion in it) is work for no result. When a count differs the
     stock really has moved, and then it is redrawn as usual. */
  if (diffs && diffs.length) {
    markDirtyRegions_([kind === 'event' ? regionOfLoc_(id) : id]);
  }
  return { diffs: diffs, outstanding: outstandingAt_(locs) };
}

/* The currencies a region's money is in: its own list, and any its sales, debts
   and costs actually used. */
function regionCurrencies_(regionId) {
  var locs = {}, out = {};
  locsInRegion_(regionId).forEach(function (l) { locs[l] = 1; });
  objectsOf_('_holders').forEach(function (h) { if (String(h.regionId || '') === String(regionId)) locs[String(h.holderId)] = 1; });
  var r = objectsOf_('_regions').filter(function (x) { return String(x.regionId) === String(regionId); })[0];
  if (r) parseCurList_(r.currencies).forEach(function (c) { out[c] = 1; });
  objectsOf_('_sales').forEach(function (s) {
    if (!locs[String(s.location)]) return;
    eachLeg_(s, function (l) { if (l.cur) out[String(l.cur).toUpperCase()] = 1; });
    if (s.duecur) out[String(s.duecur).toUpperCase()] = 1;
  });
  objectsOf_('_costs').forEach(function (c) { if (locs[String(c.location)] && c.cur) out[String(c.cur).toUpperCase()] = 1; });
  delete out.USD;
  return Object.keys(out).sort();
}

/* Store the rates a closed region's dollars are counted at.

   `rates` is given when filling in a region that closed before this existed
   (the rates of its closing day); otherwise today's — or, in a closed season,
   the season's frozen ones. Nothing is stored unless every currency the region
   used has a rate, so a region is never frozen with a currency worth zero. */
function freezeRegionRates_(regionId, given, asOf) {
  var curs = regionCurrencies_(regionId);
  var src = given, when = asOf || '';
  if (!src) {
    var fx = getRates_();
    if (!fx || !(fx.live || fx.frozen)) return false;   // offline: filled in later
    src = fx.RATES || {};
    when = fx.asOf || '';
  }
  var out = { USD: 1 };
  for (var i = 0; i < curs.length; i++) {
    var v = Number(src[curs[i]]);
    if (!(v > 0)) return false;
    out[curs[i]] = v;
  }
  dbAddCols_('_regions', ['frozenRates']);
  dbUpdate_('_regions', { regionId: String(regionId) },
            { frozenRates: JSON.stringify({ RATES: out, asOf: String(when), frozenAt: new Date().toISOString() }) });
  return true;
}

/* Regions closed before rates were frozen with them: look up the rates of the
   day each one closed (Frankfurter keeps the ECB's history) and store them.
   Currencies the ECB does not publish take today's rate, so the figures stop
   moving from here on. Runs in the background, a few regions at a time. */
function backfillRegionRates_() {
  if (!dbHas_('_regions')) return 0;
  var todo = objectsOf_('_regions').filter(function (r) {
    return r && r.regionId && r.closedAt && !r.frozenRates && String(r.regionId) !== HQ_REGION;
  }).slice(0, 5);
  var done = 0;
  todo.forEach(function (r) {
    try {
      var d = new Date(r.closedAt);
      if (isNaN(d)) return;
      var day = d.toISOString().slice(0, 10);
      var curs = regionCurrencies_(r.regionId);
      var rates = {};
      if (curs.length) {
        var h = fxGet_('https://api.frankfurter.app/' + day + '?from=USD&to=' + encodeURIComponent(curs.join(',')));
        if (h && h.rates) Object.keys(h.rates).forEach(function (c) { rates[String(c).toUpperCase()] = Number(h.rates[c]); });
        var ctx = _seasonOverride;
        setSeasonContext_('');
        try {
          var today = getRates_();
          if (today && today.live) curs.forEach(function (c) { if (!(rates[c] > 0)) rates[c] = Number((today.RATES || {})[c]); });
        } finally { setSeasonContext_(ctx); }
      }
      if (freezeRegionRates_(r.regionId, rates, day)) { done++; markDirtyRegions_([String(r.regionId)]); }
    } catch (e) { /* try again next time */ }
  });
  if (done) { cacheClear_(); bumpRev_(); }
  return done;
}

function doReopenLocation(p) {
  var kind = String(p.kind || 'event'), id = String(p.id || '');
  setClosed_(kind, id, '');
  // Open again: its dollars follow the rates again until it closes once more.
  if (kind === 'region' && dbCols_('_regions').indexOf('frozenRates') >= 0) {
    dbUpdate_('_regions', { regionId: id }, { frozenRates: '' });
  }
  markDirtyRegions_([kind === 'event' ? regionOfLoc_(id) : id]);
}

/* ---- Devotee storage ---- */
/* Save a hand-picked order for regions or a region's events.

   Deliberately manual: which places matter most, and which are winding down,
   is a judgement about the tour rather than something a rule can infer. */
function doReorder(p) {
  var kind = String(p.kind || 'region');
  var ids = (p.ids || []).map(String);
  if (!ids.length) return;
  var sheetName = kind === 'event' ? '_events' : '_regions';
  var idCol = kind === 'event' ? 'eventId' : 'regionId';
  if (dbCols_(sheetName).indexOf('sort') < 0) throw new Error('That sheet has not been upgraded — run initialize.');
  dbUpdate_(sheetName, function (o) { return ids.indexOf(String(o[idCol])) >= 0; },
    function (o) { return { sort: ids.indexOf(String(o[idCol])) }; });
  markDirtyAll_();
}

/* One transfer, however many legs: from several shelves at once (a warehouse
   and its sub-warehouses), into several at once (an event's books split
   between devotees' homes), or simply one place to another — in this season or
   into another. Everything is checked before anything moves, so a transfer
   either happens whole or not at all. */
function doTransferMulti(p) {
  var moves = (p.moves || []).map(function (m) {
    return { from: String(m.from || ''), to: String(m.to || ''), bookId: String(m.bookId || ''),
             qty: Math.max(0, Math.round(Number(m.qty) || 0)) };
  }).filter(function (m) { return m.qty > 0 && m.from && m.to && m.from !== m.to && bookById_(m.bookId); });
  if (!moves.length) throw new Error('Enter a quantity for at least one title.');
  /* Both ends must be real places — a warehouse, an event or a sub-warehouse in
     any season. Books sent to a name the app does not know would simply vanish. */
  var known = {};
  allRegionsEverywhere_().forEach(function (r) { if (r.whLoc) known[r.whLoc] = 1; });
  objectsOf_('_events').forEach(function (e) { if (e.eventId) known[String(e.eventId)] = 1; });
  objectsOf_('_holders').forEach(function (h) { if (h.holderId && !truthyCell_(h.archived)) known[String(h.holderId)] = 1; });
  moves.forEach(function (m) {
    [m.from, m.to].forEach(function (l) {
      if (!known[l]) throw new Error('One of those places is no longer listed. Nothing was moved.');
    });
  });

  var map = loadInvMap_();
  var need = {};
  moves.forEach(function (m) { var k = m.from + '||' + m.bookId; need[k] = (need[k] || 0) + m.qty; });
  Object.keys(need).forEach(function (k) {
    var bits = k.split('||'), have = getQty_(map, bits[0], bits[1]);
    if (have < need[k]) {
      throw new Error('Only ' + have + ' × ' + bookById_(bits[1]).name + ' at ' + locLabel_(bits[0]) +
        ' — you asked to move ' + need[k] + '. Nothing was moved.');
    }
  });
  var touched = {};
  moves.forEach(function (m, i) {
    var fB = getQty_(map, m.from, m.bookId), tB = getQty_(map, m.to, m.bookId);
    addQty_(map, m.from, m.bookId, -m.qty);
    addQty_(map, m.to, m.bookId, m.qty);
    stockMoveAppend_({ id: p.movePrefix ? (p.movePrefix + '_' + i) : '',
      kind: 'TRANSFER', fromLoc: m.from, toLoc: m.to, bookId: m.bookId, qty: m.qty,
      note: String(p.note || ''),
      fromBefore: fB, fromAfter: fB - m.qty, toBefore: tB, toAfter: tB + m.qty });
    touched[m.from] = 1; touched[m.to] = 1;
  });
  saveInvMap_(map);
  Object.keys(touched).forEach(function (l) { markDirty_(l); });
}

function doSaveHolder(p) {
  var name = String(p.name || '').trim();
  if (!name) throw new Error('Give the devotee a name.');
  var regionId = String(p.regionId || '');
  if (!regionById_(regionId)) throw new Error('Pick a region.');
  var id = String(p.holderId || '');
  if (id) {
    var hSet = { name: name, phone: String(p.phone || '').trim(), note: String(p.note || '').trim() };
    if (p.archived !== undefined) hSet.archived = !!p.archived;
    dbUpdate_('_holders', { holderId: id }, hSet);
  } else {
    /* Named by the app when it is made alongside a transfer, so the transfer
       sent right after it can already point at it; a resend is ignored. */
    id = /^hd_[a-z0-9]{4,16}$/.test(String(p.newHolderId || '')) ? String(p.newHolderId)
       : 'hd_' + Utilities.getUuid().slice(0, 6);
    var exists = objectsOf_('_holders').some(function (h) { return String(h.holderId) === id; });
    if (!exists) {
      dbInsert_('_holders', { holderId: id, regionId: regionId, name: name, phone: String(p.phone || '').trim(),
        note: String(p.note || '').trim(), createdAt: new Date(), archived: false });
    }
  }
  markDirtyRegions_([regionId]);
  return id;
}

/* ---- Sending stock between regions ----

   Three ways books travel, and the difference matters for the counts:
     direct   — they arrive at once, exactly as before.
     devotee  — a porter carries them; we hold a name and a number.
     shipping — a courier; we hold tracking details.
   For the latter two the books sit in a shipment of their own until someone
   confirms they landed, so neither region counts them as on the shelf.        */
/* Move stock from a region in one season to a region in another.

   Books outlive a tour: what is left in Macedonia at the end of the Europe Tour
   is the same stock that starts the year-round selling there. This hands it
   over directly — no transit, because nothing is traveling; the books are
   already where they are, they just belong to a different tour now. */
function doSeasonTransfer(p) {
  var from = regionById_(String(p.fromRegion || ''));
  var to   = regionById_(String(p.toRegion || ''));
  if (!from) throw new Error('Pick where the books are coming from.');
  if (!to)   throw new Error('Pick where the books are going.');
  if (from.regionId === to.regionId) throw new Error('That is the same region.');

  var fromLoc = String(p.fromLoc || from.whLoc);
  var toLoc   = String(p.toLoc   || to.whLoc);
  var items = (p.items || []).map(function (it) {
    return { bookId: String(it.bookId), qty: Math.max(0, Math.round(Number(it.qty) || 0)) };
  }).filter(function (it) { return it.qty > 0 && bookById_(it.bookId); });
  if (!items.length) throw new Error('Enter a quantity for at least one title.');

  var map = loadInvMap_();
  items.forEach(function (it) {
    var have = getQty_(map, fromLoc, it.bookId);
    if (have < it.qty) {
      throw new Error('Only ' + have + ' × ' + bookById_(it.bookId).name + ' at ' +
        locLabel_(fromLoc) + ' — you asked to move ' + it.qty + '. Nothing was moved.');
    }
  });

  var fromSeason = (seasonById_(from.seasonId) || {}).name || 'another season';
  var toSeason   = (seasonById_(to.seasonId)   || {}).name || 'another season';
  items.forEach(function (it) {
    var fB = getQty_(map, fromLoc, it.bookId), tB = getQty_(map, toLoc, it.bookId);
    addQty_(map, fromLoc, it.bookId, -it.qty);
    addQty_(map, toLoc, it.bookId, it.qty);
    stockMoveAppend_({ kind: 'TRANSFER', fromLoc: fromLoc, toLoc: toLoc,
      bookId: it.bookId, qty: it.qty,
      note: 'Handed over from ' + fromSeason + ' to ' + toSeason + (p.note ? ' — ' + p.note : ''),
      fromBefore: fB, fromAfter: fB - it.qty, toBefore: tB, toAfter: tB + it.qty });
  });
  saveInvMap_(map);
  markDirty_(fromLoc); markDirty_(toLoc);
  markDirtyRegions_([from.regionId, to.regionId]);
  return { moved: items.reduce(function (t, it) { return t + it.qty; }, 0) };
}

/* Every region across every season, for the pickers that reach beyond the tour
   you are standing in. */
/* A date as text, the same wherever the server runs: String(date) writes it in
   the server's own time zone (Google: the script's; Cloudflare: UTC), so the
   same moment read differently on the two. Anything else is left as it is. */
function dateText_(v) {
  if (v instanceof Date) return isNaN(v) ? '' : v.toISOString();
  return String(v);
}

function allRegionsEverywhere_() {
  var seasons = {};
  seasonsAll_().forEach(function (x) { seasons[x.seasonId] = x.name; });
  return objectsOf_('_regions').filter(function (r) { return r && r.regionId; })
    .map(function (r) {
      return { regionId: String(r.regionId), name: String(r.name),
               whLoc: String(r.whLoc || ''), seasonId: String(r.seasonId || ''),
               seasonName: seasons[String(r.seasonId || '')] ||
                           (String(r.seasonId || '') === HQ_ID ? 'Earthly HQ' : ''),
               closedAt: r.closedAt ? dateText_(r.closedAt) : '' };
    });
}

function doSendShipment(p) {
  var fromRegion = String(p.fromRegion || '');
  var toRegion = String(p.toRegion || '');
  var mode = String(p.mode || 'devotee');
  /* Books can also arrive from beyond the tour entirely — shipped from India,
     say, when there is no Indian region. Nothing leaves a shelf then; the batch
     simply exists on its way in, and becomes stock when it lands. */
  var fromOutside = (fromRegion === OUTSIDE_ORIGIN);
  var from = fromOutside ? null : regionById_(fromRegion);
  var to = regionById_(toRegion);
  if (!fromOutside && !from) throw new Error('Pick where the books are leaving from.');
  if (!to) throw new Error('Pick where the books are going.');
  if (!fromOutside && fromRegion === toRegion) throw new Error('That is the same region — pick another.');

  var items = (p.items || []).map(function (it) {
    return { bookId: String(it.bookId), qty: Math.max(0, Math.round(Number(it.qty) || 0)),
             fromLoc: String(it.fromLoc || '') };
  }).filter(function (it) { return it.qty > 0 && bookById_(it.bookId); });
  if (!items.length) throw new Error('Enter a quantity for at least one title.');

  var srcLoc = fromOutside ? '' : String(p.fromLoc || from.whLoc);
  /* Each title may leave from its own shelf — the warehouse or one of its
     sub-warehouses — as long as that shelf belongs to the sending region. */
  var srcLocs = fromOutside ? [] : locsInRegion_(fromRegion);
  items.forEach(function (it) {
    it.from = (it.fromLoc && srcLocs.indexOf(it.fromLoc) >= 0) ? it.fromLoc : srcLoc;
  });
  var map = loadInvMap_();
  if (!fromOutside) {
    var needS = {};
    items.forEach(function (it) { var k = it.from + '||' + it.bookId; needS[k] = (needS[k] || 0) + it.qty; });
    Object.keys(needS).forEach(function (k) {
      var bits = k.split('||'), have = getQty_(map, bits[0], bits[1]);
      if (have < needS[k]) {
        throw new Error('Only ' + have + ' × ' + bookById_(bits[1]).name + ' at ' +
          locLabel_(bits[0]) + ' — you asked to send ' + needS[k] + '. Nothing was sent.');
      }
    });
  }

  if (fromOutside && mode === 'direct') {
    // Straight onto the destination shelf: this is new stock entering the tour.
    items.forEach(function (it) {
      var tB = getQty_(map, to.whLoc, it.bookId);
      addQty_(map, to.whLoc, it.bookId, it.qty);
      stockMoveAppend_({ kind: 'ADJUST', toLoc: to.whLoc, bookId: it.bookId, qty: it.qty,
        note: 'Arrived from ' + (p.origin || 'outside the tour') + (p.note ? ' — ' + p.note : ''),
        toBefore: tB, toAfter: tB + it.qty });
    });
    saveInvMap_(map);
    markDirtyRegions_([toRegion]);
    return '';
  }

  if (mode === 'direct') {
    items.forEach(function (it) {
      var fB = getQty_(map, it.from, it.bookId), tB = getQty_(map, to.whLoc, it.bookId);
      addQty_(map, it.from, it.bookId, -it.qty);
      addQty_(map, to.whLoc, it.bookId, it.qty);
      stockMoveAppend_({ kind: 'TRANSFER', fromLoc: it.from, toLoc: to.whLoc,
        bookId: it.bookId, qty: it.qty, note: p.note,
        fromBefore: fB, fromAfter: getQty_(map, it.from, it.bookId),
        toBefore: tB, toAfter: getQty_(map, to.whLoc, it.bookId) });
      markDirty_(it.from);
    });
    saveInvMap_(map);
    markDirty_(to.whLoc);
    return '';
  }

  /* In transit: the books live in the shipment until it is received.
     The app names the batch, as it does everything else, so it shows as on its
     way the moment it is sent and a resend is recognized rather than doubled. */
  var shipId = /^sh_[a-z0-9]{4,16}$/.test(String(p.shipId || '')) ? String(p.shipId)
             : 'sh_' + Utilities.getUuid().slice(0, 6);
  if (isDeleted_(shipId)) return shipId;
  if (shipmentById_(shipId)) return shipId;
  var manifest = {};
  items.forEach(function (it) { manifest[it.bookId] = (manifest[it.bookId] || 0) + it.qty; });
  /* Where in the region they are meant to land — an event as well as the
     warehouse. Written by header name, so the column can be added here the
     first time without anyone having to re-run initialize. */
  var toLoc = String(p.toLoc || '');
  if (toLoc && locsInRegion_(toRegion).indexOf(toLoc) < 0) toLoc = '';
  dbAddCols_('_shipments', ['toLoc']);
  var rowS = { shipId: shipId, fromRegion: fromRegion, toRegion: toRegion, mode: mode,
    carrier: String(p.carrier || '').trim(), phone: String(p.phone || '').trim(),
    tracking: String(p.tracking || '').trim(), trackingUrl: String(p.trackingUrl || '').trim(),
    eta: p.eta ? new Date(p.eta) : '', note: String(p.note || '').trim(),
    status: 'IN_TRANSIT', createdAt: new Date(), arrivedAt: '', manifest: JSON.stringify(manifest),
    origin: String(p.origin || '').trim(), toLoc: toLoc };
  dbInsert_('_shipments', rowS);

  items.forEach(function (it) {
    addQty_(map, shipId, it.bookId, it.qty);
    if (fromOutside) {
      stockMoveAppend_({ kind: 'ADJUST', toLoc: shipId, bookId: it.bookId, qty: it.qty,
        note: 'On its way from ' + (p.origin || 'outside the tour'),
        toBefore: 0, toAfter: it.qty });
      return;
    }
    var fB = getQty_(map, it.from, it.bookId);
    addQty_(map, it.from, it.bookId, -it.qty);
    stockMoveAppend_({ kind: 'TRANSFER', fromLoc: it.from, toLoc: shipId,
      bookId: it.bookId, qty: it.qty,
      note: 'Sent in transit to ' + to.name + (p.carrier ? ' with ' + p.carrier : ''),
      fromBefore: fB, fromAfter: getQty_(map, it.from, it.bookId),
      toBefore: 0, toAfter: it.qty });
  });
  saveInvMap_(map);
  if (srcLoc) markDirty_(srcLoc);
  markDirtyRegions_(fromOutside ? [toRegion] : [fromRegion, toRegion]);
  return shipId;
}

/* Correct what is actually in a shipment.

   Batches break up in real life — at an airport a bag gets redistributed, a
   couple of copies never make it in, someone adds a few more. Rather than
   pretend the manifest was right, this sets the true contents and records the
   difference against the sending region, so nothing simply evaporates. */
/* Where a batch's copies of one title came from, so copies that never travel
   go back to the very shelf they left — a sub-warehouse included — rather than
   all landing on the warehouse shelf. Read from the movement record: every
   send into the batch was logged with its source. Most recent sends are
   unwound first; anything not traceable, or whose shelf is gone, goes to
   `fallback`. Returns [{loc, qty}]. */
function shipReturnPlan_(shipId, fromRegion, bookId, qty, fallback) {
  var live = {};
  if (fromRegion) locsInRegion_(fromRegion).forEach(function (l) { live[l] = 1; });
  var sent = objectsOf_('_stockmoves').filter(function (m) {
    return String(m.toLoc) === String(shipId) && String(m.bookId) === String(bookId) &&
           String(m.kind) === 'TRANSFER' && m.fromLoc && live[String(m.fromLoc)];
  });
  var plan = [], left = qty;
  for (var i = sent.length - 1; i >= 0 && left > 0; i--) {
    var take = Math.min(left, Math.max(0, Math.round(Number(sent[i].qty) || 0)));
    if (!take) continue;
    var loc = String(sent[i].fromLoc);
    var hit = plan.filter(function (x) { return x.loc === loc; })[0];
    if (hit) hit.qty += take; else plan.push({ loc: loc, qty: take });
    left -= take;
  }
  if (left > 0 && fallback) {
    var fb = plan.filter(function (x) { return x.loc === fallback; })[0];
    if (fb) fb.qty += left; else plan.push({ loc: fallback, qty: left });
  }
  return plan;
}

function doAdjustShipment(p) {
  var id = String(p.shipId || '');
  var ship = shipmentById_(id);
  if (!ship) throw new Error('That shipment is no longer listed.');
  var from = regionById_(ship.fromRegion);
  // A batch that began outside the tour has no shelf to return copies to, so a
  // correction there is simply an adjustment.
  var backTo = String(p.backTo || (from ? from.whLoc : ''));

  var map = loadInvMap_();
  var counts = p.counts || {};
  var changes = [];
  Object.keys(counts).forEach(function (bookId) {
    if (!bookById_(bookId)) return;
    var want = Math.max(0, Math.round(Number(counts[bookId])));
    if (isNaN(want)) return;
    var have = getQty_(map, id, bookId);
    if (want === have) return;
    var delta = want - have;
    setQty_(map, id, bookId, want);
    // Copies that never traveled go back where they came from; extras that
    // turned up are taken from there, so the sending region stays truthful.
    if (backTo && delta < 0) {
      shipReturnPlan_(id, ship.fromRegion, bookId, -delta, backTo).forEach(function (r) {
        var rB = getQty_(map, r.loc, bookId);
        addQty_(map, r.loc, bookId, r.qty);
        stockMoveAppend_({ kind: 'TRANSFER', fromLoc: id, toLoc: r.loc, bookId: bookId, qty: r.qty,
          note: 'Shipment contents corrected' + (p.note ? ' — ' + p.note : ''),
          toBefore: rB, toAfter: rB + r.qty });
        markDirty_(r.loc);
      });
    } else if (backTo) {
      var bB = getQty_(map, backTo, bookId);
      addQty_(map, backTo, bookId, -delta);
      stockMoveAppend_({ kind: 'TRANSFER', fromLoc: backTo, toLoc: id,
        bookId: bookId, qty: Math.abs(delta),
        note: 'Shipment contents corrected' + (p.note ? ' — ' + p.note : ''),
        toBefore: have, toAfter: want });
    } else {
      stockMoveAppend_({ kind: 'ADJUST', toLoc: id, bookId: bookId, qty: delta,
        note: 'Shipment contents corrected' + (p.note ? ' — ' + p.note : ''),
        toBefore: have, toAfter: want });
    }
    changes.push({ bookId: bookId, was: have, now: want });
  });
  saveInvMap_(map);

  // The manifest is what SHOULD arrive in total, so a correction shifts it by
  // the same amount — otherwise "4 of 5" would keep quoting a number that was
  // never really in the bag.
  if (changes.length) {
    dbUpdate_('_shipments', { shipId: id }, function (o) {
      var man = parseManifest_(o.manifest);
      changes.forEach(function (c) {
        man[c.bookId] = Math.max(0, (Number(man[c.bookId]) || 0) + (c.now - c.was));
        if (!man[c.bookId]) delete man[c.bookId];
      });
      return { manifest: JSON.stringify(man) };
    });
  }
  if (backTo) markDirty_(backTo);
  markDirtyRegions_([ship.fromRegion, ship.toRegion]);
  return { changes: changes };
}

/* Delete a shipment outright.

   A batch created by mistake had no way out — you could correct its contents but
   not remove it. Anything still traveling in it goes back where it came from,
   so the books are never lost along with the record. */
function doDeleteShipment(p) {
  var id = String(p.shipId || '');
  var ship = shipmentById_(id);
  if (!ship) return;                                  // already gone
  var from = regionById_(ship.fromRegion);
  var backTo = from ? from.whLoc : '';

  var map = loadInvMap_();
  var returned = 0;
  allBooks_().forEach(function (b) {
    var q = getQty_(map, id, b.id);
    if (!q) return;
    returned += q;
    setQty_(map, id, b.id, 0);
    if (backTo) {
      var was = q;
      shipReturnPlan_(id, ship.fromRegion, b.id, q, backTo).forEach(function (r) {
        var tB = getQty_(map, r.loc, b.id);
        addQty_(map, r.loc, b.id, r.qty);
        stockMoveAppend_({ kind: 'TRANSFER', fromLoc: id, toLoc: r.loc, bookId: b.id, qty: r.qty,
          note: 'Shipment deleted — books returned', fromBefore: was, fromAfter: was - r.qty,
          toBefore: tB, toAfter: tB + r.qty });
        was -= r.qty;
        markDirty_(r.loc);
      });
    } else {
      stockMoveAppend_({ kind: 'ADJUST', toLoc: id, bookId: b.id, qty: -q,
        note: 'Shipment deleted', toBefore: q, toAfter: 0 });
    }
  });
  saveInvMap_(map);

  dbDelete_('_shipments', { shipId: id });
  if (backTo) markDirty_(backTo);
  markDirtyRegions_([ship.fromRegion, ship.toRegion]);
  return { returned: returned };
}

/* Remove a hand-over recorded against a partner — a mistyped amount, say. */
function doDeletePayout(p) {
  var id = String(p.id || '');
  dbDelete_('_payouts', { id: id });
  markDirtyAll_();
}

/* Remove a devotee-storage place outright. Any books still shown there go back
   to the region's warehouse rather than disappearing with the record. */
function doDeleteHolder(p) {
  var id = String(p.holderId || '');
  var rows = objectsOf_('_holders');
  var mine = null;
  rows.forEach(function (h) { if (String(h.holderId) === id) mine = h; });
  if (!mine) return;
  var reg = regionById_(String(mine.regionId));
  var backTo = reg ? reg.whLoc : '';
  var map = loadInvMap_();
  var moved = 0;
  allBooks_().forEach(function (b) {
    var q = getQty_(map, id, b.id);
    if (!q) return;
    moved += q;
    setQty_(map, id, b.id, 0);
    if (backTo) {
      var tB = getQty_(map, backTo, b.id);
      addQty_(map, backTo, b.id, q);
      stockMoveAppend_({ kind: 'TRANSFER', fromLoc: id, toLoc: backTo, bookId: b.id, qty: q,
        note: 'Devotee storage removed — books returned', fromBefore: q, fromAfter: 0,
        toBefore: tB, toAfter: tB + q });
    }
  });
  saveInvMap_(map);
  dbDelete_('_holders', { holderId: id });
  markDirtyRegions_([String(mine.regionId)]);
  return { returned: moved };
}

function doEditShipment(p) {
  var id = String(p.shipId || '');
  var oldTo = '';
  var found = dbUpdate_('_shipments', { shipId: id }, function (o) {
    var set = {};
    // Where outside books came from is typed in, so a typo can be put right.
    ['carrier','phone','tracking','trackingUrl','note','origin'].forEach(function (f) {
      if (p[f] !== undefined) set[f] = String(p[f]).trim();
    });
    if (p.eta !== undefined) set.eta = p.eta ? new Date(p.eta) : '';
    // Plans change on the road — a batch bound for Croatia may end up meeting
    // the tour in London instead. The books are already in the shipment, so
    // redirecting is just a matter of where they are expected to land.
    if (p.toRegion !== undefined && String(p.toRegion) !== String(o.toRegion)) {
      var dest = regionById_(String(p.toRegion));
      if (!dest) throw new Error('Pick a region for them to go to.');
      if (String(p.toRegion) === String(o.fromRegion)) {
        throw new Error('That is where they came from — pick somewhere else, or receive them back.');
      }
      oldTo = String(o.toRegion);
      set.toRegion = String(p.toRegion);
    }
    return set;
  });
  if (!found) throw new Error('That shipment is no longer listed.');
  if (oldTo) {
    // Both the old and the new destination change what they are expecting.
    markDirtyRegions_([oldTo, String(p.toRegion)]);
  }
  // Otherwise details only — no stock moved, so nothing needs rebuilding.
}

/* Receive some or all of a shipment. Anything not received stays in transit,
   so a porter who hands over half their bag is recorded honestly. */
function doReceiveShipment(p) {
  var id = String(p.shipId || '');
  var ship = shipmentById_(id);
  if (!ship) throw new Error('That shipment is no longer listed.');
  var to = regionById_(ship.toRegion);
  if (!to) throw new Error('That shipment has nowhere to arrive.');
  var destLoc = String(p.toLoc || to.whLoc);

  var map = loadInvMap_();
  var items = (p.items || []).map(function (it) {
    return { bookId: String(it.bookId), qty: Math.max(0, Math.round(Number(it.qty) || 0)) };
  }).filter(function (it) { return it.qty > 0; });

  items.forEach(function (it) {
    var have = getQty_(map, id, it.bookId);
    var qty = Math.min(have, it.qty);
    if (qty <= 0) return;
    var tB = getQty_(map, destLoc, it.bookId);
    addQty_(map, id, it.bookId, -qty);
    addQty_(map, destLoc, it.bookId, qty);
    stockMoveAppend_({ kind: 'TRANSFER', fromLoc: id, toLoc: destLoc,
      bookId: it.bookId, qty: qty, note: 'Arrived' + (p.note ? ' — ' + p.note : ''),
      fromBefore: have, fromAfter: have - qty,
      toBefore: tB, toAfter: tB + qty });
  });
  saveInvMap_(map);

  // Anything left over means it is still partly on the road.
  var left = 0;
  allBooks_().forEach(function (b) { left += getQty_(map, id, b.id); });
  var status = left > 0 ? 'PARTIAL' : 'ARRIVED';
  dbUpdate_('_shipments', { shipId: id },
    status === 'ARRIVED' ? { status: status, arrivedAt: new Date() } : { status: status });
  markDirty_(destLoc);
  markDirtyRegions_([ship.fromRegion, ship.toRegion]);
  return { status: status, remaining: left };
}

/* ---- Access without accounts ----------------------------------------------
   A share link carries a random key. No key means the full admin app, exactly
   as before. A key resolves to one event (a seller) or one region (a local
   coordinator), and the SERVER decides what that role may do — hiding buttons
   in the page would only be decoration, since anyone can edit a URL. */
var OUTSIDE_ORIGIN = 'OUTSIDE';

var SELLER_ACTIONS = {
  getState:1, ping:1, orgSave:1, giveChange:1,
  sell:1, sellBundle:1, donate:1,
  editSale:1, editBundle:1, deleteSale:1,
  settle:1, deliver:1, markPaid:1
};
var COORD_EXTRA = {
  transferBulk:1, createEvent:1, adjustStockBulk:1, setStockBulk:1, closeLocation:1, saveCloseDraft:1,
  // Add Stock: books on their way in, and switching on an existing title here.
  sendShipment:1, regionAddBooks:1,
  // Books in transit: marking their own region's deliveries as arrived.
  receiveShipment:1,
  // Transfer Existing Stock: moves within the region, and its sub-warehouses.
  transferMulti:1, saveHolder:1,
  // Activity log: undo, limited inside to this link's own region.
  undoActivity:1, undoActivityPart:1,
  // Pre-orders fulfilled by another region (checked inside).
  setFulfilBy:1, fulfilRemote:1
};

/* Who is holding this link, and what they can see.

   A seller link belongs to the REGION, not to one event. Which event it opens
   on is a setting the owner changes — so the same link follows a person from
   Monday's festival to Tuesday's, and can be widened to the whole region at
   reconciliation time without reissuing anything.

   Per-event keys are still honored, so links already handed out keep working. */
function sellerScopeFor_(reg) {
  var scope = String(reg.sellerScope || '').trim();
  var events = objectsOf_('_events').filter(function (e) {
    return String(e.regionId || '') === String(reg.regionId);
  }).map(function (e) { return String(e.eventId); });
  if (!scope || scope === 'ALL') return events;              // every event here
  var wanted = scope.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  var live = wanted.filter(function (id) { return events.indexOf(id) >= 0; });
  // A scope pointing at an event that has since gone falls back to all of them,
  // so a seller is never left staring at nothing.
  return live.length ? live : events;
}

function roleFor_(key) {
  key = String(key || '').trim();
  if (!key) return { role: 'admin' };

  var regs = objectsOf_('_regions');
  for (var j = 0; j < regs.length; j++) {
    if (String(regs[j].sellerKey || '') && String(regs[j].sellerKey) === key) {
      var reg = regionById_(String(regs[j].regionId));
      var ids = sellerScopeFor_(regs[j]);
      return { role: 'seller', regionId: String(regs[j].regionId),
               eventIds: ids, eventId: ids[0] || '' };
    }
    if (String(regs[j].key || '') && String(regs[j].key) === key) {
      return { role: 'coordinator', regionId: String(regs[j].regionId) };
    }
  }

  // An older per-event link: still valid, scoped to that one event.
  var evs = objectsOf_('_events');
  for (var i = 0; i < evs.length; i++) {
    if (String(evs[i].key || '') && String(evs[i].key) === key) {
      return { role: 'seller', eventId: String(evs[i].eventId),
               eventIds: [String(evs[i].eventId)],
               regionId: String(evs[i].regionId || '') };
    }
  }
  return { role: 'invalid' };
}

/** Set (or clear) the region's seller link, and what it shows. */
function doSellerLink(p) {
  var regionId = String(p.regionId || '');
  if (!regionById_(regionId)) throw new Error('That region is no longer listed.');
  dbAddCols_('_regions', REGION_HEADERS);
  var made = '';
  dbUpdate_('_regions', { regionId: regionId }, function (o) {
    var set = {};
    var key = o.sellerKey;
    if (p.revoke) { key = ''; set.sellerKey = key; }
    else if (!String(key || '') || p.regenerate) {
      key = suppliedKey_(p.key, 's') || ('s' + Utilities.getUuid().replace(/-/g, '').slice(0, 14));
      set.sellerKey = key;
    }
    if (p.scope !== undefined) set.sellerScope = String(p.scope || '');
    made = String(key || '');
    return set;
  });
  cacheClear_();
  return made;
}

/** Throws unless this role may run this action against this location. */
function assertAllowed_(who, action, params) {
  if (who.role === 'admin') return;
  if (who.role === 'invalid') {
    throw new Error('That link is no longer valid. Ask for a new one.');
  }
  var ok = SELLER_ACTIONS[action] ||
           (who.role === 'coordinator' && COORD_EXTRA[action]);
  if (!ok) throw new Error('That action is not available on this link.');

  // Confine writes to the places this link covers.
  var allowed = {};
  if (who.role === 'seller') (who.eventIds || [who.eventId]).forEach(function (id) { if (id) allowed[id] = 1; });
  else locsInRegion_(who.regionId).forEach(function (l) { allowed[l] = 1; });

  ['location', 'from', 'to', 'fromLoc'].forEach(function (f) {
    var v = params[f];
    if (v && !allowed[String(v)]) {
      throw new Error('This link does not cover ' + locLabel_(String(v)) + '.');
    }
  });
  // Closing (and its saved progress): only this link's own region or its events.
  if ((action === 'closeLocation' || action === 'saveCloseDraft') &&
      (params.kind === 'region' ? String(params.id) !== String(who.regionId) : !allowed[String(params.id)])) {
    throw new Error('This link can only close places in its own region.');
  }
  if (action === 'createEvent' && who.role === 'coordinator') {
    params.regionId = who.regionId;          // never another region's
  }
  /* A regional link may bring books in from outside, into its own region only.
     Sending its stock to another region is the owner's call. */
  if (action === 'sendShipment' &&
      (String(params.fromRegion) !== OUTSIDE_ORIGIN || String(params.toRegion) !== String(who.regionId) ||
       (params.toLoc && !allowed[String(params.toLoc)]))) {
    throw new Error('This link can only bring books into its own region.');
  }
  /* Receiving: only a batch heading for this link's region, onto one of its own shelves. */
  if (action === 'receiveShipment') {
    var sh = shipmentById_(String(params.shipId || ''));
    if (!sh || String(sh.toRegion) !== String(who.regionId) ||
        (params.toLoc && !allowed[String(params.toLoc)])) {
      throw new Error('This link can only receive books arriving in its own region.');
    }
  }
  /* Every leg of a transfer must start and end inside the link's region. */
  if (action === 'transferMulti') {
    (params.moves || []).forEach(function (m) {
      [m.from, m.to].forEach(function (l) {
        if (l && !allowed[String(l)]) throw new Error('This link does not cover ' + locLabel_(String(l)) + '.');
      });
    });
  }
  /* A sub-warehouse (devotee storage) may be added or edited in its own region only. */
  if (action === 'saveHolder') {
    var hOk = String(params.regionId) === String(who.regionId);
    if (hOk && params.holderId) {
      hOk = holdersOfRegion_(who.regionId).some(function (h) { return h.holderId === String(params.holderId); });
    }
    if (!hOk) throw new Error('This link can only change storage in its own region.');
  }
  if (action === 'regionAddBooks' && String(params.regionId) !== String(who.regionId)) {
    throw new Error('This link can only change its own region.');
  }
  if (action === 'orgSave') {
    // They may keep their own page's contacts, not another level's.
    var sc = String(params.scope || '');
    // A seller link may cover several events, so check the whole set.
    var mayEdit = (who.role === 'seller')
      ? ((who.eventIds || [who.eventId]).indexOf(sc) >= 0)
      : (sc === who.regionId || allowed[sc]);
    if (!mayEdit) throw new Error('This link can only change its own contacts.');
  }
  // Editing or deleting someone else's sale is out of scope too.
  if (params.saleId) {
    var target = null;
    objectsOf_('_sales').forEach(function (r) {
      if (String(r.saleId) === String(params.saleId)) target = r;
    });
    if (target && !allowed[String(target.location)]) {
      throw new Error('That sale belongs to another location.');
    }
  }
}

/** Create or rotate the share key for an event or a region. */
/* A link code the app chose itself, accepted only if it is the right shape.

   The app now picks the code (from the browser's secure random source) so the
   link can be shown the moment it is asked for, and saved behind the scenes.
   Anything malformed is ignored and a fresh one issued here instead. */
function suppliedKey_(v, prefix) {
  var k = String(v || '');
  var re = new RegExp('^' + prefix + '[a-z0-9]{10,24}$');
  return re.test(k) ? k : '';
}

/* ---- Costs: money spent to make the sales ----

   A card-machine fee, a bank charge — recorded against the place it belongs to
   so the totals can show what was actually kept. Kept out of the cash box on
   purpose: a card fee is taken by the processor, not from the till. */
var COST_CATEGORIES = ['Card machine fee', 'Bank fee', 'Other'];
function doSaveCost(p) {
  var amt = Number(p.amt);
  if (!(amt > 0)) throw new Error('Give the cost an amount.');
  var cur = String(p.cur || '').trim().toUpperCase();
  if (!cur) throw new Error('Pick a currency.');
  var loc = String(p.location || '');
  if (!loc) throw new Error('Pick where the cost belongs.');
  var cat = COST_CATEGORIES.indexOf(String(p.category)) >= 0 ? String(p.category) : 'Other';
  var id = String(p.id || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 40);
  // A cost may belong to a consignment group rather than to us.
  var pid = String(p.partnerId || '');
  if (pid && !partnerById_(pid)) throw new Error('That consignment group is no longer listed.');
  var obj = { id: id, ts: p.ts ? new Date(p.ts) : new Date(), location: loc, category: cat,
              payType: String(p.payType || ''), cur: cur, amt: amt,
              note: String(p.note || '').trim().slice(0, 200), partnerId: pid };
  // Created on first use, so recording a cost works even before initialize is run.
  dbCreate_('_costs', ['id','ts','location','category','payType','cur','amt','note','partnerId']);
  sheetMemoClear_();
  dbAddCols_('_costs', ['id','ts','location','category','payType','cur','amt','note','partnerId']);
  var at = id ? objectsOf_('_costs').findIndex(function (x) { return String(x.id) === id; }) : -1;
  if (at >= 0) {
    dbUpdate_('_costs', firstOnly_({ id: id }), obj);    // an edit
  } else {
    if (!obj.id) obj.id = 'C' + Utilities.getUuid().slice(0, 8);
    dbInsert_('_costs', obj);                           // new (or a resend of a new one)
  }
  markDirtyRegions_([regionOfLoc_(loc)]);
  return obj.id;
}
function doDeleteCost(p) {
  var id = String(p.id || '');
  if (!dbHas_('_costs')) return;                        // nothing recorded yet
  var loc = '';
  objectsOf_('_costs').forEach(function (x) { if (String(x.id) === id) loc = String(x.location); });
  dbDelete_('_costs', { id: id });
  if (loc) markDirtyRegions_([regionOfLoc_(loc)]);
}

/* ---- Change: money borrowed to give to buyers ----

   It comes from somewhere — a coordinator, an event's takings, or a person who
   simply handed it over — and it goes back there. It travels with the cash it
   sits among, so it is tracked as its own thing: where it came from, where it
   is now, and whether it has gone home. */
/* Created on first use, so change works before initialize has been re-run. */
function changeRows_() {
  dbCreate_('_change', ['id','ts','amt','cur','source','sourceName','loc','returnedAt','by']);
  return objectsOf_('_change');
}

function doChangeWithdraw(p) {
  var amt = Number(p.amt);
  if (!(amt > 0)) throw new Error('Give the change an amount.');
  var cur = String(p.cur || '').trim().toUpperCase();
  if (!cur) throw new Error('Pick a currency.');
  var loc = String(p.loc || '');
  if (!loc) throw new Error('Say where the change will be kept.');
  var source = String(p.source || '');
  var sourceName = String(p.sourceName || '').trim().slice(0, 60);
  if (source === 'OTHER' && !sourceName) throw new Error('Say who the change came from.');
  if (!source) throw new Error('Say where the change came from.');

  var c = changeRows_();
  var id = String(p.id || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 40) || ('CH' + Utilities.getUuid().slice(0, 8));
  if (isDeleted_(id)) return id;                                                        // deleted on purpose
  for (var i = 0; i < c.length; i++) if (String(c[i].id) === id) return id;             // a resend
  dbInsert_('_change', { id: id, ts: p.ts ? new Date(p.ts) : new Date(), amt: amt, cur: cur,
                source: source, sourceName: sourceName, loc: loc, returnedAt: '', by: _cashBy });

  // The cash itself: out of the source (if the source is an account we keep), into the place.
  if (source === 'OTHER') {
    cashAppend_({ id: p.cashId, kind: 'ADJUST', toAcct: loc, cur: cur, amt: amt, purpose: 'FLOAT',
                  changeRef: id, note: 'Change from ' + sourceName });
  } else {
    cashAppend_({ id: p.cashId, kind: 'MOVE', fromAcct: source, toAcct: loc, cur: cur, amt: amt,
                  purpose: 'FLOAT', changeRef: id, note: 'Change withdrawn' });
  }
  markDirty_(loc);
  return id;
}

/** Give the change back to where it came from. */
function doChangeReturn(p) {
  var id = String(p.id || '');
  var hit = null;
  changeRows_().forEach(function (r) { if (String(r.id) === id) hit = r; });
  if (!hit) throw new Error('That change record is no longer listed.');
  if (String(hit.returnedAt || '')) return id;                 // already back — a resend
  var loc = String(hit.loc), source = String(hit.source);
  var amt = Number(hit.amt) || 0, cur = String(hit.cur);
  if (source === 'OTHER') {
    cashAppend_({ id: p.cashId, kind: 'ADJUST', toAcct: loc, cur: cur, amt: -amt, purpose: 'FLOAT_BACK',
                  changeRef: id, note: 'Change returned to ' + String(hit.sourceName || 'whoever lent it') });
  } else {
    cashAppend_({ id: p.cashId, kind: 'MOVE', fromAcct: loc, toAcct: source, cur: cur, amt: amt,
                  purpose: 'FLOAT_BACK', changeRef: id, note: 'Change returned' });
  }
  dbUpdate_('_change', { id: id }, { returnedAt: new Date() });
  markDirty_(loc);
  return id;
}

/* Remove a change entry outright, moving no money.

   For an entry that should never have been there — including one left behind
   from before movements and change records were linked, which showed in
   Withdrawn Change with no movement anywhere to match it. */
function doChangeDelete(p) {
  var id = String(p.id || '');
  if (!id) return '';
  changeRows_();
  dbDelete_('_change', { id: id });
  tombstone_(id);
  // Any movements that only existed to carry this change go with it.
  dbAddCols_('_cash', CASH_HEADERS);
  dbDelete_('_cash', function (r) { return String(r.changeRef || '') === id; });
  markDirtyAll_();
  return id;
}

/** The change traveled with the money. If it reached its source, it is home. */
function doChangeMove(p) {
  var ids = p.ids || [];
  if (!ids.length) return '';
  var to = String(p.toLoc || '');
  changeRows_();
  dbUpdate_('_change', function (r) {
    return ids.indexOf(String(r.id)) >= 0 && !String(r.returnedAt || '');
  }, function (r) {
    var set = { loc: to };
    if (to && to === String(r.source)) set.returnedAt = new Date();   // back where it came from
    return set;
  });
  return '';
}

/* Rewrite a piece of the app's wording, or put it back.

   Keyed by the original words, so a label that is never rewritten costs
   nothing and the app falls back to what it always said. */
/* ---- Wording built into the app (b201) ----

   Every rewording saved with the pencil up to b201 is now the app's own text,
   so the saved copies are retired: the code is the reference, and the old
   words are not remembered. Removed once, under the lock, on the first save
   after this is deployed — only where the saved text is still exactly what
   was built in, so anything reworded since is kept. */
var BUILT_IN_LABELS_ = {
  "(tap a type for the regional split)": "drop-down = regional totals",
  "(tap for the per-title breakdown)": "drop down = sales per title",
  "What each region has brought in: its own takings, less its costs. Consignment money is held for the groups and is shown in Consignment.": "*consignment sales and costs have been automatically subtracted",
  "(what each region has taken)": "net collections* for each region",
  "(where every title sits across the tour)": "total available stock + locations by region",
  "Click region to move cash": "to transfer cash, click regional name",
  "Who to contact about what in book distribution. Tap a number to message on WhatsApp.": "Useful Contacts for Books Sales",
  "Every spreadsheet the app keeps, and where it is filed. Tap a name to open it. Any folder can be pointed elsewhere; its spreadsheets move there on the next sync.": "These sheets are our database. Please view and use with caution.",
  "Card-machine fees and other costs of selling. They show beneath the payment totals, taken off to give the net. They do not touch the cash box.": "costs deducted from book sales are logged here",
  "This applies to one region at a time.": "click a region to transfer stock",
  "Put whatever is active at the top and anything finished at the bottom. This is the order they appear in everywhere.": "organize regions as needed for efficiency",
  "Panel: Total Sales by Title › sold / pre-ordered": "sold / pre-ordered / gifted",
  "Panel: Total Collections by Payment › (tap a type for the regional split)": "drop-down = regional totals",
  "Panel: Collections by Region › (what each region has taken)": "net sales* for each region",
  "Panel: Collections by Region › What each region has brought in: its own takings, less its costs. Consignment money is held for the groups and is shown in Consignment.": "*net sales = gross sales - (consignment + costs)",
  "Panel: Sales by Region › (tap for the per-title breakdown)": "drop down = sales by title",
  "Panel: Warehouse Overview › (where every title sits across the tour)": "inventory and inventory locations",
  "Panel: App Admin › (setup, stock movements and money handling)": "various settings for adminstering sales",
  "Panel: Total Sales by Title › Total Sales by Title": "Distribution by Title",
  "Dialog › Copy this and paste it into WhatsApp, or send it straight there.": "data reports designed for sending via text",
  "Panel: Distribution by Title › sold / pre-ordered": "sold / pre-ordered / gifted",
  "Panel: Sales by Title › sold / pre-ordered": "sold / pre-ordered / gifted",
  "Panel: Sales by Title › Sales by Title": "Distribution by Title",
  "Panel: Totals by Payment Type › (tap a type to see it event by event)": "drop down = totals by event",
  "Panel: Active Sales Log › Active Sales Log": "Sales Log",
  "Dialog › Card-machine fees and other costs of selling. They show beneath the payment totals, taken off to give the net. They do not touch the cash box.": "Enter any costs associated with book distribution here.",
  "Dialog › This place has its own list. Clear it to follow the tour again.": "select the forms of payment accepted in this region",
  "Dialog › Anything you add here can be used straight away. It stays on this region unless you add it elsewhere too.": "Payment types added here apply to this region only.",
  "Dialog › Send a link and that person can record sales straight away — no login. Anyone holding a link has that access, so reset it if a phone goes missing.": "Generate seller links with limited permissions. \nTurn off links when event or region is permanently closed.",
  "Dialog › Put whatever is active at the top and anything finished at the bottom. This is the order they appear in everywhere.": "Shift the order of events for efficiency of access.",
  "Dialog › Choose what to include.": "select reports you'd like to send",
  "Dialog › One link for everyone selling here. The link itself never changes, so nobody has to be sent a new one.": "generate a link for devotees selling books at events. when the event changes, you can change the event here. devotee sellers keep the same link throughout the ENTIRE regional event.",
  "Dialog › Whole region": "Region Link",
  "Dialog › Sellers": "Seller Link",
  "Dialog › Fill in every title you are carrying, then send the whole load at once. Transfers add to what is already there.": "Count all books brought to the event (twice or three times). Enter the numbers here to populate the event inventory.",
  "Dialog › How are they travelling?": "Journey To Be Taken",
  "Dialog › To which region": "To",
  "Dialog › Which books": "Select Books",
  "Dialog › For books that outlive a tour — what is left here at the end becomes the opening stock of the next one. Nothing travels; the books stay put and simply belong to the other season from now on.": "if books are being transferred outside the current season, enter the numbers here",
  "Dialog › Every time stock is added to a location, or moved between the warehouse and an event, it shows here.": "All stock movements are listed here. \nClick ↺ to reverse a stock movement.",
  "Dialog › Use": "To add stock to existing inventory, enter number next to the \"+\" sign. To subtract stock click the \"+\" sign (it will become a \"-\" sign) and then enter the number to be subtracted. To manually change the stock number, enter number in the \"updated\" column.",
  "Dialog › Following the tour at the moment. Change anything here and this place keeps its own list.": "Please select the payment types accepted in this region.",
  "Dialog › Books kept at devotees' homes. They count as their region's stock, and can be sold from directly or moved with the ordinary transfer.": "This is to help us understand where our books are held at a regional level.",
  "Dialog › Books belonging to a local group, sold from our table. Their sales and their money stay out of every tour total, and each group gets its own spreadsheet.": "Consignment books are those we sell on behalf of another party.\nPlease enter information about these books here.",
  "Dialog › Drag a row by its handle, or use the arrows. This is the order titles appear on every shelf and in every list, everywhere on the tour.": "Change book order for use efficiency.",
  "Dialog › A region has its own warehouse, its own currencies and its own prices.": "A region is the umbrella that contains all events in one locality.",
  "Dialog › Currencies": "Enter all accepted currencies by their official abbreviation.",
  "Dialog › fill all": "select relevant offerings",
  "Dialog › (comma separated — USD is always included)": "(Separate currencies with a comma.)",
  "Dialog › Untick a title this region won't offer and it stays out of the sale screens. Use the \"fill all\" row to price a whole category at once. Set a price in the": "1. Select books that will be available for sale in the region.\n2. When entering currency, fill in the price by local currency first. The price in other currencies will automatically populate. \n3. Set price in other currencies to a whole number (round down).",
  "Dialog › The 36 books still on its shelves": "Move Remaining Stock",
  "Dialog › to existing inventory, enter the amount to be added in the field next to the “+” sign.": ", enter the amount to be added in the field next to the “+” sign.",
  "Dialog › click the “+” sign (it will become a “−” sign) and then enter the number to be subtracted.": ", click the “+” sign, and then enter the number to be subtracted.",
  "Dialog › Recorded here — £23.46": "Entry Log",
  "Dialog › Who to contact about what in book distribution. Tap a number to message on WhatsApp.": "Contacts for issues and questions.",
  "Dialog › This applies to one region at a time.": "Click region name to make changes.",
  "Dialog › Click region to move cash": "Click region to transfer cash.",
  "Dialog › Everywhere on the tour": "Books Currently Between Locations",
  "Dialog › Nothing is on the road.": "Nothing at this time.",
  "Dialog › No devotee storage set up anywhere yet.": "No books are being stored with local devotees.",
  "Dialog › To add someone, open their region.": "To add a devotee storing books, navigate to their region.",
  "Dialog › Their card takings, sent back the same way they came in. Recording it here settles what we owe — our own money was never mixed with it.": "Click \"record delivery\" if:\n1. We used their credit card machine, and they already have the payout.\n2. We were cashed out for credit card charges and we gave them money for this cashout.",
  "Dialog › To add a group, open their region.": "To add consignment books, open the region where books will be sold.",
  "Dialog › Their cash takings, sent back the same way they came in. Recording it here settles what we owe — our own money was never mixed with it.": "Click \"record delivery\" when we have given consignees what we collected for their book sales.",
  "Dialog › Untick a title to keep it off this event's shelf. It can still be pre-ordered — use “Pre-order another title” beneath the shelf.": "Deselect a title to hide it from the sales inventory.",
  "Dialog › Add a group": "Add a consignee",
  "Panel: App Admin › 👁 Titles offered here (5 hidden)": "Hide Unused Titles",
  "Panel: App Admin › 🏠 Devotees storing books": "Devotee Book Storage",
  "Panel: App Admin › 💳 Payments taken here": "💳 Edit Payment Types",
  "Panel: App Admin › 🧾 Costs": "🧾 Record Costs",
  "Panel: App Admin › 📁 Spreadsheet folders": "📁 Spreadsheet Links",
  "Panel: App Admin › 👥 Org chart": "👥 App and Sales Support",
  "Panel: App Admin › 💵 Cash": "💵 Cash Tracker",
  "Dialog › Search for the region or event where you’d like to add inventory. If you do not see your region or event, please add it first.": "Enter the **region** or **event** where you’d like to add inventory.",
  "Panel: Event Inventory 📱 Digital Payment QRs 📋 › ＋ Pre-order another title (4 not offered here)": "+ Pre-Orders (Unlisted Titles)",
  "Panel: App Admin › 👁 Titles offered here (4 hidden)": "Hide Titles",
  "Panel: Event Inventory 📱 Digital Payment QRs 📋 › ＋ Multiple Books — one transaction": "+ Multiple Book Sale",
  "Dialog › Every spreadsheet the app keeps, and where it is filed. Tap a name to open it. Any folder can be pointed elsewhere; its spreadsheets move there on the next sync.": "Data from the sales tracker in spreadsheet form.",
  "Dialog › Top folder": "Top-Level Folder",
  "Dialog › A completely fresh start — no regions, events, stock, sales or money. Only the book titles carry over, since those belong to no single tour.": "Seasons are a period of time that serve as an umbrella for Gurudeva's travels to several regions in one area of the world.\nFor example, Book Tour is a season where Srila Gurudeva travels to several cities in India.",
  "Dialog › Moving it also moves the copy — it goes back on the old shelf and comes off the new one.": "\u0000hide",
  "Dialog › Checking for the latest…": "\u0000hide",
  "Dialog › Courier · 45678 · Outside the tour → Test Region. Enter how many of each actually arrived. Anything less than the full amount stays recorded as still travelling, so a batch that came in pieces stays honest.": "Enter how many books arrived.\nAnything left will still be coded as \"in transit.\"",
  "Dialog › Add a new one by clicking here.": "\u0000hide",
  "Dialog › Relates to payment type (optional)": "Payment Type (Optional)",
  "Dialog › Recorded here": "Cost Log",
  "Dialog › Set how many of each book are being bought (from stock) and how many pre-ordered. You can do both in one sale. The total fills in as you go.": "For one person buying multiple books in one transaction.",
  "Dialog › Everything done in Test Region except sales, which keep their own log — newest first. Delete undoes that change; entries that cannot safely be undone have no Delete.": "All activity from the app is logged here.\nDelete with care.",
  "Dialog › Outside the tour → Test Region · 12 books still coming": "\u0000hide",
  "Dialog › Change this if the books will meet the tour somewhere else.": "\u0000hide",
  "Dialog › India → Test Region · 7 books still coming": "\u0000hide",
  "Dialog › With Hari Haribol · India → Test Region. Set what is actually in the batch. The difference goes back to the sending region, so nothing disappears from the count.": "\u0000hide",
  "Panel: Books in Transit › Edit details": "Edit Details",
  "Panel: Books in Transit › # still coming": "# in transit",
  "Panel: Books in Transit › Correct contents": "Correct Contents",
  "Dialog: Correct what is traveling › With Hari Haribol · India → Test Region. Set what is actually in the batch. The difference goes back to the sending region, so nothing disappears from the count.": "\u0000hide",
  "Dialog: Correct what is traveling › Correct what is traveling": "Correct Contents",
  "Dialog: Partial Delivery Arrived › Courier · # · Outside the tour → Test Region. Enter how many of each actually arrived. Anything less than the full amount stays recorded as still traveling, so a batch that came in pieces stays honest.": "If only part of the delivery arrived, please enter that amount here.",
  "Panel: App Admin › 🔗 Share Links": "🔗 Sales Links",
  "Panel: App Admin › 💵 Cash Tracker": "💵 Track Cash",
  "Dialog: Record sale › Change we owe them": "CHANGE **WE** OWE",
  "Dialog: Record sale › (optional — if you couldn't break their note)": "(optional)",
  "Dialog: Record sale › Date & time (optional — defaults to now)": "Date & Time",
  "Dialog: Record sale › Still owed": "What They Still Owe"
};
function retireBuiltInLabels_() {
  if (String(getMeta_('labelsBuiltIn', '')) === 'b201') return;
  if (!dbHas_('_labels')) return;
  // (A small table; with nothing of these in it, nothing is written at all.)
  var gone = dbDelete_('_labels', function (r) {
    var k = String(r.key);
    return Object.prototype.hasOwnProperty.call(BUILT_IN_LABELS_, k) && String(r.text) === BUILT_IN_LABELS_[k];
  });
  if (gone) { setMeta_('labelsBuiltIn', 'b201'); cacheClear_(); }
}

function doSaveLabel(p) {
  var key = String(p.key || '').slice(0, 300);
  if (!key) throw new Error('Nothing to rewrite.');
  var text = String(p.text == null ? '' : p.text).slice(0, 600);
  dbCreate_('_labels', ['key', 'text']);
  sheetMemoClear_();
  var rows = objectsOf_('_labels');
  var at = -1;
  rows.forEach(function (x, i) { if (String(x.key) === key) at = i; });
  if (!text) {                       // emptied: back to the original wording
    if (at >= 0) rows.splice(at, 1);
  } else if (at >= 0) {
    rows[at].text = text;
  } else {
    rows.push({ key: key, text: text });
  }
  dbSave_('_labels', rows);
  return text;
}

/* The dollars actually received for a sale paid digitally.

   The sale still counts in the currency it was made in — nothing about the
   local totals changes. Only the USD column uses this figure in place of a
   converted estimate, so the tour's dollar figure is what the bank shows. */
/** The dollars received as typed: empty means "use the estimate". */
function usdActualIn_(v) {
  return (v === '' || v === null || v === undefined) ? '' : Math.round((Number(v) || 0) * 100) / 100;
}
/* One figure for a whole transaction, shared out over its books in proportion
   to what each was estimated at, so the parts always add up to it. */
function splitUsdActual_(total, perItemLegs) {
  if (total === '') return perItemLegs.map(function () { return ''; });
  var est = perItemLegs.map(function (L) { var t = 0; (L || []).forEach(function (l) { if (l.type !== 'Gift') t += toUSD_(l.amt, l.cur); }); return t; });
  var sum = est.reduce(function (a, b) { return a + b; }, 0);
  var out = [], running = 0;
  for (var i = 1; i < est.length; i++) {
    var share = Math.round((sum ? total * est[i] / sum : total / est.length) * 100) / 100;
    out[i] = share; running += share;
  }
  out[0] = Math.round((total - running) * 100) / 100;
  return out;
}

function doSetUsdActual(p) {
  var saleId = String(p.saleId || '');
  var v = (p.usd === '' || p.usd === null || p.usd === undefined) ? '' : (Number(p.usd) || 0);
  dbAddCols_('_sales', SALES_HEADERS);
  if (!dbUpdate_('_sales', { saleId: saleId }, { usdActual: v })) throw new Error('That sale is no longer in the log.');
  markDirtyAll_();
  return v;
}

function doSetKey(p) {
  var kind = String(p.kind || '');
  var id = String(p.id || '');
  var key = String(p.clear) === 'true' ? ''
    : (suppliedKey_(p.key, 'k') || ('k' + Utilities.getUuid().replace(/-/g, '').slice(0, 10)));
  var sheetName = kind === 'event' ? '_events' : '_regions';
  var idCol = kind === 'event' ? 'eventId' : 'regionId';
  if (dbCols_(sheetName).indexOf('key') < 0) throw new Error('This sheet has not been upgraded yet — run initialize.');
  var match = {}; match[idCol] = id;
  if (!dbUpdate_(sheetName, match, { key: key })) throw new Error('That no longer exists.');
  /* A link changes no figures, so there is nothing to redraw. This used to flag
     every spreadsheet on the tour, which is why issuing one took seconds. */
  cacheClear_();
  return key;
}

/* ---- Regions: the middle tier between the season and its events ---- */
/* ---- Seasons ---------------------------------------------------------------

   A season is one tour: Europe 2026, Europe 2027. Everything else already hangs
   off a region — sales, cash, stock, events, devotees, shipments all live at
   locations, and every location belongs to a region — so scoping the REGIONS to
   a season scopes the whole app with it. That is why this is a small change
   rather than a rewrite. */
var REGION_HEADERS = ['regionId','name','whLoc','sort','createdAt','currencies','books',
                      'key','closedAt','seasonId','payTypes','bankName','bookOrder',
                      'sellerKey','sellerScope','hidden'];

/* Append a region by column name, adding any column the sheet is missing.

   Rows were written by position, so a region created before this ran ended up
   without a season and belonged to none — the same silent drop that lost the
   change-owed figure. Writing by name closes it for good. */
function appendRegion_(row) {
  dbAddCols_('_regions', REGION_HEADERS);
  dbInsert_('_regions', row);
}

function seasonsAll_() {
  /* Create the sheet if it isn't there. Without this, every request on a tour
     that hasn't been re-initialized failed at the first mention of a season —
     and a failure this early comes back as a page, not a message, which is why
     it read as "the server sent something unreadable". */
  if (!dbHas_('_seasons')) {
    dbCreate_('_seasons', ['seasonId','name','sort','createdAt','closedAt']);
    hideDataSheets_();
  }
  var rows = objectsOf_('_seasons').filter(function (x) { return x && x.seasonId; });
  if (!rows.length) {
    // First run, or an existing tour that predates seasons: adopt what is here.
    var id = 'sn_' + Utilities.getUuid().slice(0, 6);
    dbInsert_('_seasons', { seasonId: id, name: getSeasonName_(), sort: 0, createdAt: new Date(), closedAt: '' });
    /* Adopt everything that existed before seasons did. Done once, here, so no
       row is left unattached — an unattached region would otherwise appear in
       every season at once. */
    /* Adopt anything not attached to a season that exists — both regions from
       before seasons were introduced, and any left dangling if this sheet was
       ever lost. An unattached region belongs to no season and would simply
       disappear from the app, so this is the safety net for that. */
    dbUpdate_('_regions', function (r) { return String(r.seasonId || '') !== id; }, { seasonId: id });
    setMeta_('activeSeason', id);
    rows = objectsOf_('_seasons').filter(function (x) { return x && x.seasonId; });
  }
  return rows.map(function (x, i) {
    return { seasonId: String(x.seasonId), name: String(x.name || ''),
             sort: Number(x.sort) || 0, closedAt: x.closedAt || '', _i: i,
             // The exchange rates on the day it closed; its dollar figures stay at these.
             frozenRates: String(x.frozenRates || '') };
  }).sort(function (a, b) { return (a.sort - b.sort) || (a._i - b._i); });
}

/** Which season the app is currently showing. */
/* A share link is pinned to the season its own region belongs to.

   The active season is a single setting for the whole tour, so when the owner
   switched, every link followed — and a rep opened their page to find no
   region, no stock and no prices, because their region lived in the season that
   had just been left behind. A link should never move because someone else
   navigated. */
var _seasonOverride = '';
function setSeasonContext_(id) { _seasonOverride = String(id || ''); }

function activeSeasonId_() {
  if (_seasonOverride) return _seasonOverride;
  var want = String(getMeta_('activeSeason', ''));
  var all = seasonsAll_();
  for (var i = 0; i < all.length; i++) if (all[i].seasonId === want) return want;
  return all.length ? all[0].seasonId : '';
}
function seasonById_(id) {
  var all = seasonsAll_();
  for (var i = 0; i < all.length; i++) if (all[i].seasonId === String(id)) return all[i];
  return null;
}

function doSetSeason(p) {
  var id = String(p.seasonId || '');
  if (!seasonById_(id)) throw new Error('That season is no longer listed.');
  setMeta_('activeSeason', id);
  cacheClear_();
}

function doSaveSeason(p) {
  var name = String(p.name || '').trim();
  if (!name) throw new Error('Give the season a name.');
  var id = String(p.seasonId || '');
  if (id) {
    dbUpdate_('_seasons', { seasonId: id }, { name: name });
    cacheClear_(); markDirtyAll_();
    return id;
  }
  id = 'sn_' + Utilities.getUuid().slice(0, 6);
  dbInsert_('_seasons', { seasonId: id, name: name, sort: seasonsAll_().length, createdAt: new Date(), closedAt: '' });

  /* A new season is a genuinely blank slate: no regions, no events, no stock,
     no money, no prices carried over. Only the book catalog is shared, since
     the titles themselves don't belong to any one tour. Everything else is
     built fresh, which is the point of starting a season. */

  setMeta_('activeSeason', id);
  cacheClear_(); markDirtyAll_();
  return id;
}

function doDeleteSeason(p) {
  var id = String(p.seasonId || '');
  var all = seasonsAll_();
  if (all.length <= 1) throw new Error('This is the only season — there must always be one.');
  if (String(p.confirmName || '').trim() !== (seasonById_(id) || {}).name) {
    throw new Error('Type the season name exactly to confirm.');
  }
  // Every region at once, with everything that belongs to them.
  purgeRegions_(regionsOrdered_(id).map(function (r) { return r.regionId; }));
  dbDelete_('_seasons', { seasonId: id });
  setMeta_('seasonSheetId:' + id, '');
  setMeta_('activeSeason', seasonsAll_()[0].seasonId);
  cacheClear_(); markDirtyAll_();
}

function regionsOrdered_(seasonId) {
  var want = String(seasonId || activeSeasonId_());
  return objectsOf_('_regions').filter(function (r) {
    return String(r.seasonId || '') === want;
  }).map(function (r, i) {
    return { regionId: String(r.regionId), name: String(r.name),
             whLoc: String(r.whLoc || ''), sort: Number(r.sort) || 0,
             currencies: parseCurList_(r.currencies),
             books: parseBookList_(r.books), closedAt: r.closedAt || '',
             payTypes: String(r.payTypes || ''),
             bookOrder: String(r.bookOrder || ''), hidden: String(r.hidden || ''), _i: i };
  }).sort(function (a, b) { return (a.sort - b.sort) || (a._i - b._i); })
    // Keep payTypes here too, or the region's own list never reaches the app.
    .map(function (r) { return { regionId: r.regionId, name: r.name, whLoc: r.whLoc,
                                 sort: r.sort, currencies: r.currencies, books: r.books,
                                 closedAt: r.closedAt, payTypes: r.payTypes || '',
                                 bookOrder: r.bookOrder || '', hidden: String(r.hidden || '') }; });
}
/* A region's currencies are stored as a simple comma list ("PLN,EUR,USD").
   USD is always present — it's the common translation currency every region
   reports back in, even once PLN and EUR disappear from the tour. */
/* Which titles a region carries. Empty means "all of them" — so every existing
   region keeps its full catalog without needing to be edited. */
function parseBookList_(raw) {
  var list = String(raw || '').split(',')
    .map(function (b) { return b.trim(); })
    .filter(function (b) { return b && bookById_(b); });
  return list;
}


function parseCurList_(raw) {
  var list = String(raw || '').split(',')
    .map(function (c) { return c.trim().toUpperCase(); })
    .filter(function (c) { return /^[A-Z]{3}$/.test(c); });
  if (list.indexOf('USD') < 0) list.push('USD');
  var seen = {}, out = [];
  list.forEach(function (c) { if (!seen[c]) { seen[c] = 1; out.push(c); } });
  return out;
}
/** Currencies a given region actually deals in. */
function currenciesOf_(regionId) {
  var r = regionById_(regionId);
  return r && r.currencies && r.currencies.length ? r.currencies : ['USD'];
}
/** Every currency anywhere in the season — what FX needs to fetch and what the
    cash ledger will accept. */
function allCurrencies_() {
  var seen = { USD: 1 }, out = ['USD'];
  /* At Earthly HQ every season's money is added up, so every currency in use
     anywhere is needed — for the columns and for the exchange rates. */
  var regs = isHQ_()
    ? objectsOf_('_regions').map(function (r) { return { currencies: parseCurList_(r.currencies) }; })
    : regionsOrdered_();
  regs.forEach(function (r) {
    (r.currencies || []).forEach(function (c) { if (!seen[c]) { seen[c] = 1; out.push(c); } });
  });
  return out;
}

/* ============================ EARTHLY HQ ============================ */
function isHQ_() { return activeSeasonId_() === HQ_ID; }

/* Made the first time anyone opens HQ — never on a spreadsheet that has not
   asked for it. Under the lock, so two devices cannot make two. */
function ensureHQ_() {
  if (regionById_(HQ_REGION)) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    ensureReady();
    sheetMemoClear_();
    if (regionById_(HQ_REGION)) return;
    appendRegion_({ regionId: HQ_REGION, name: 'Earthly HQ', whLoc: HQ_WH, sort: 0,
                    createdAt: new Date(), currencies: 'INR,USD', books: '', bookOrder: '',
                    key: '', closedAt: '', seasonId: HQ_ID });
    cacheClear_();
    bumpRev_();
  } finally {
    lock.releaseLock();
  }
}

/* Everything, from every season and from HQ itself, for the Summaries Portal.
   Only admins at HQ get this; the Sales Portal uses the ordinary (HQ-scoped)
   state beside it. A closed season carries the rates it was frozen at, so its
   dollar figures add up at HQ exactly as they do in the season itself. */
function everywhere_(sales, inv) {
  return {
    seasons: seasonsAll_().map(function (x) {
      var rates = null;
      if (x.closedAt && x.frozenRates) { try { rates = (JSON.parse(x.frozenRates) || {}).RATES || null; } catch (e) {} }
      return { seasonId: x.seasonId, name: x.name, closedAt: x.closedAt ? dateText_(x.closedAt) : '', rates: rates };
    }),
    regions: objectsOf_('_regions').filter(function (r) { return r && r.regionId; }).map(function (r) {
      return { regionId: String(r.regionId), name: String(r.name), whLoc: String(r.whLoc || ''),
               seasonId: String(r.seasonId || ''), currencies: parseCurList_(r.currencies),
               closedAt: r.closedAt ? dateText_(r.closedAt) : '', rates: regionFrozenRates_(r) };
    }),
    events: objectsOf_('_events').filter(function (e) { return e && e.eventId; }).map(function (e) {
      return { eventId: String(e.eventId), name: String(e.name), regionId: String(e.regionId || '') };
    }),
    holders: objectsOf_('_holders').filter(function (h) { return h && h.holderId && !truthyCell_(h.archived); })
      .map(function (h) { return { holderId: String(h.holderId), regionId: String(h.regionId), name: String(h.name || '') }; }),
    partners: partnersAll_().map(function (pt) { return { partnerId: pt.partnerId, regionId: pt.regionId, name: pt.name }; }),
    shipments: shipmentsAll_(),
    costs: objectsOf_('_costs').filter(function (x) { return x && x.id; }).map(function (x) {
      return { id: String(x.id), location: String(x.location || ''), cur: String(x.cur || ''),
               amt: Number(x.amt) || 0, partnerId: String(x.partnerId || ''), category: String(x.category || '') };
    }),
    sales: sales,
    inventory: inv,
    currencies: allCurrencies_()
  };
}
/* ---- Per-region pricing ----
   `_prices` holds one row per region/book/currency. Falls back to the built-in
   BOOKS figures so a region with no prices set yet still sells at something
   sensible rather than zero. */
var _priceMemo = null;
function priceMap_() {
  if (_priceMemo) return _priceMemo;
  var m = {};
  objectsOf_('_prices').forEach(function (r) {
    var rid = String(r.regionId || ''), bid = String(r.bookId || '');
    var cur = String(r.cur || '').toUpperCase();
    var amt = Number(r.price);
    if (!rid || !bid || !cur || isNaN(amt)) return;
    m[rid + '|' + bid + '|' + cur] = amt;
  });
  _priceMemo = m;
  return m;
}
function priceFor_(regionId, bookId, cur) {
  cur = String(cur || '').toUpperCase();
  var hit = priceMap_()[String(regionId) + '|' + String(bookId) + '|' + cur];
  if (hit !== undefined) return hit;
  var b = bookById_(bookId);
  if (!b) return 0;
  if (cur === 'USD') return Number(b.usd) || 0;
  if (cur === 'PLN') return Number(b.pln) || 0;
  if (cur === 'EUR') return Number(b.eur) || 0;
  return 0;   // a currency this region hasn't priced yet
}
/** Prices for the whole season, shaped for the client: {regionId:{bookId:{cur:amt}}} */
function pricesForState_() {
  var out = {};
  regionsOrdered_().forEach(function (r) {
    out[r.regionId] = {};
    allBooks_().forEach(function (b) {
      var row = {};
      (r.currencies || []).forEach(function (c) { row[c] = priceFor_(r.regionId, b.id, c); });
      out[r.regionId][b.id] = row;
    });
  });
  return out;
}

/** Currencies valid for a location (warehouse or event), via its region. */
function currenciesForLoc_(loc) {
  var rid = regionOfLoc_(loc);
  return rid ? currenciesOf_(rid) : allCurrencies_();
}

/* Looks across every season, not just the one being shown.

   Listing regions is season-scoped, but resolving one by id must not be:
   deleting a season has to reach regions that belong to it while you are
   standing somewhere else. */
function regionById_(id) {
  var rows = objectsOf_('_regions');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].regionId) !== String(id)) continue;
    var r = rows[i];
    return { regionId: String(r.regionId), name: String(r.name),
             whLoc: String(r.whLoc || ''), sort: Number(r.sort) || 0,
             currencies: parseCurList_(r.currencies), books: parseBookList_(r.books),
             closedAt: r.closedAt || '', seasonId: String(r.seasonId || ''),
             payTypes: String(r.payTypes || '') };
  }
  return null;
}
/** Which region does a location belong to? Works for a warehouse or an event. */
function regionOfLoc_(loc) {
  loc = String(loc);
  var regs = regionsOrdered_();
  for (var i = 0; i < regs.length; i++) if (regs[i].whLoc === loc) return regs[i].regionId;
  var evs = objectsOf_('_events');
  for (var j = 0; j < evs.length; j++) {
    if (String(evs[j].eventId) === loc) return String(evs[j].regionId || '');
  }
  return '';
}
/** Every location inside one region: its warehouse plus all of its events. */
/* ---- Books that aren't at a warehouse or an event -------------------------

   Two things the tour does constantly, and they turn out to be the same idea:
   stock sitting somewhere other than the obvious places.

   • A HOLDER is a devotee storing books at home. Those books are genuinely in
     the region — they just aren't centralised.
   • A SHIPMENT is books between regions, with a porter or a courier. Those books
     have LEFT the sending region and haven't ARRIVED at the receiving one, so
     they belong to neither until they land.

   Both are ordinary inventory locations, so selling, transferring and counting
   all work on them without special cases. What differs is only how they're
   totaled up, which is the point of holdersOfRegion_ / shipmentsInbound_.   */
/* One devotee who is storing books, by id.

   This was being called from the cash checks but never existed, so every cash
   move crashed with "holderById_ is not defined" before it could save. */
function holderById_(id) {
  id = String(id || '');
  if (!id) return null;
  var rows = objectsOf_('_holders');
  for (var i = 0; i < rows.length; i++) {
    var h = rows[i];
    if (h && String(h.holderId) === id && !truthyCell_(h.archived)) {
      return { holderId: String(h.holderId), regionId: String(h.regionId || ''),
               name: String(h.name || ''), phone: String(h.phone || ''),
               note: String(h.note || '') };
    }
  }
  return null;
}

function holdersOfRegion_(regionId) {
  return objectsOf_('_holders')
    .filter(function (h) {
      return h && h.holderId && String(h.regionId) === String(regionId) && !truthyCell_(h.archived);
    })
    .map(function (h) {
      return { holderId: String(h.holderId), regionId: String(h.regionId),
               name: String(h.name || ''), phone: String(h.phone || ''),
               note: String(h.note || '') };
    });
}
function truthyCell_(v) { return v === true || v === 'true' || v === 'TRUE'; }

function parseManifest_(raw) {
  if (!raw) return {};
  try { var o = JSON.parse(String(raw)); return (o && typeof o === 'object') ? o : {}; }
  catch (e) { return {}; }
}

function shipmentRows_() { return objectsOf_('_shipments').filter(function (x) { return x && x.shipId; }); }
function shipmentsAll_() {
  /* Never one on its way to or from a region that no longer exists: its books
     went with the region (purgeRegions_ removes such rows; this hides any an
     older build left behind until the sweep does). */
  var live = {};
  objectsOf_('_regions').forEach(function (r) { live[String(r.regionId)] = 1; });
  var ok = function (id) { id = String(id || ''); return !id || id === OUTSIDE_ORIGIN || !!live[id]; };
  return shipmentRows_().filter(function (x) { return ok(x.fromRegion) && ok(x.toRegion); })
    .map(function (x) {
      return { shipId: String(x.shipId), fromRegion: String(x.fromRegion || ''),
               toRegion: String(x.toRegion || ''), mode: String(x.mode || 'devotee'),
               carrier: String(x.carrier || ''), phone: String(x.phone || ''),
               tracking: String(x.tracking || ''), trackingUrl: String(x.trackingUrl || ''),
               eta: x.eta || '', note: String(x.note || ''),
               status: String(x.status || 'IN_TRANSIT'),
               createdAt: x.createdAt || '', arrivedAt: x.arrivedAt || '',
               // What was handed over at the start, so a part-delivered batch can
               // still say "4 of the 5 arrived" rather than only "1 left".
               manifest: parseManifest_(x.manifest),
               toLoc: String(x.toLoc || ''),
               // Where a batch came from when it started outside the tour — a
               // printer, a temple, another country we don't track as a region.
               origin: String(x.origin || '') };
    });
}
/** Shipments still on their way TO a region. */
function shipmentsInbound_(regionId) {
  return shipmentsAll_().filter(function (x) {
    return x.toRegion === String(regionId) && x.status !== 'ARRIVED';
  });
}
function shipmentById_(id) {
  var all = shipmentsAll_();
  for (var i = 0; i < all.length; i++) if (all[i].shipId === String(id)) return all[i];
  return null;
}

function locsInRegion_(regionId) {
  var out = [];
  var r = regionById_(regionId);
  if (r && r.whLoc) out.push(r.whLoc);
  objectsOf_('_events').forEach(function (e) {
    if (String(e.regionId || '') === String(regionId)) out.push(String(e.eventId));
  });
  // Books at a devotee's home are still the region's books.
  holdersOfRegion_(regionId).forEach(function (h) { out.push(h.holderId); });
  return out;
}


/* ============================ DATA STORE ============================
   Every read and write of the app's own records goes through this section.
   Nothing else in the file touches the hidden data sheets, the script
   properties or the script cache — so the records can move to a real
   database by replacing only what is here.

   The rest of the file speaks in rows as plain objects:
     objectsOf_(t)             every row of table t, in stored order
     dbHas_(t)                 does the table exist yet?
     dbCreate_(t, cols)        create it if it does not exist yet
     dbAddCols_(t, cols)       add any of these columns it lacks
     dbEnsure_(t, cols)        both
     dbInsert_(t, rows)        append one row or several, by column name
     dbUpdate_(t, match, set)  change fields on the matching rows only
     dbDelete_(t, match)       remove the matching rows only
     dbSave_(t, rows, cols)    make the table hold exactly these rows
   `match` is { column: value, … } (all must equal, compared as text) or a
   function(row) → true/false.

   Changing a row touches that row alone. Rewriting a whole sheet to change
   one field was the slowest part of every save, and the reason two people
   saving at once had to wait for each other for so long. */

/* Which column(s) name a row. dbSave_ uses it to work out which rows actually
   changed; a table whose rows cannot be told apart by it (old data with a
   repeated or missing id) is written out whole, exactly as it used to be. */
var TABLE_KEYS_ = {
  _meta: ['key'], _books: ['id'], _custombooks: ['id'], _partners: ['partnerId'],
  _payouts: ['id'], _costs: ['id'], _change: ['id'], _labels: ['key'], _qr: ['id'],
  _holders: ['holderId'], _shipments: ['shipId'], _regions: ['regionId'],
  _seasons: ['seasonId'], _prices: ['regionId', 'bookId', 'cur'], _events: ['eventId'],
  _inventory: ['location', 'bookId'], _sales: ['saleId'], _cash: ['id'], _org: ['id'],
  _stockmoves: ['id'], _activity: ['id']
};

/* Rows read during this request, per table. Any write drops the lot, so a
   read never sees data older than the last change. */
var _sheetMemo = {};
function sheetMemoClear_() { _sheetMemo = {}; bookMemoClear_(); _locFxMemo = null; _seasonFxMemo = null; }

/* { cols: [...], rows: [ {col: value} ] } for one table, read once per request. */
function storeRead_(t) {
  // Never read the movement log with entries still sitting in the buffer.
  if (t === '_stockmoves' && _moveBuffer.length) flushStockMoves_();
  if (_sheetMemo[t]) return _sheetMemo[t];
  var got = STORE_.read(t);
  var cols = got.cols.map(String);
  var rows = got.rows.map(function (arr) {
    var o = {};
    cols.forEach(function (h, i) { o[h] = arr[i]; });
    return o;
  });
  _sheetMemo[t] = { cols: cols, rows: rows };
  return _sheetMemo[t];
}

/** Every row of a table, as fresh objects (safe to change). [] if it doesn't exist yet. */
function objectsOf_(t) {
  if (!STORE_.has(t)) return [];
  return storeRead_(t).rows.map(function (r) {
    var o = {}; for (var k in r) o[k] = r[k]; return o;
  });
}
function dbHas_(t) { return STORE_.has(t); }
/** The table's own column order. */
function dbCols_(t) { return STORE_.has(t) ? storeRead_(t).cols.filter(function (h) { return h !== ''; }) : []; }

/** Create the table, with these columns, if it does not exist yet. */
function dbCreate_(t, cols) {
  if (!STORE_.has(t)) { STORE_.create(t, cols); sheetMemoClear_(); }
}
/** Add any of these columns an existing table lacks, after the ones it has.
    Rows written before a column existed simply read back blank, so this
    upgrades a live table without rewriting a single row. */
function dbAddCols_(t, cols) {
  if (!STORE_.has(t)) return;
  var live = storeRead_(t).cols.map(String);
  var missing = cols.filter(function (h) { return live.indexOf(h) < 0; });
  if (missing.length) { STORE_.addCols(t, missing); sheetMemoClear_(); }
}
/** Both: the table exists and carries at least these columns. */
function dbEnsure_(t, cols) { dbCreate_(t, cols); dbAddCols_(t, cols); }

/** Append rows by column name. A field with no column is left out — ensure it first. */
function dbInsert_(t, rows) {
  rows = Array.isArray(rows) ? rows : [rows];
  if (!rows.length) return;
  var cols = storeRead_(t).cols;
  STORE_.append(t, rows.map(function (o) {
    return cols.map(function (h) { return (o[h] === undefined || o[h] === null) ? '' : o[h]; });
  }));
  sheetMemoClear_();
}

function dbMatcher_(match) {
  if (typeof match === 'function') return match;
  var keys = Object.keys(match);
  return function (o) {
    for (var i = 0; i < keys.length; i++) if (String(o[keys[i]]) !== String(match[keys[i]])) return false;
    return true;
  };
}

/** A match that stops at the first row it hits — for code that has always
    changed only the first of several rows sharing an id. */
function firstOnly_(match) {
  var test = dbMatcher_(match), done = false;
  return function (o) { if (done || !test(o)) return false; done = true; return true; };
}

/** A match for only the last row it hits (where the same id could, in old
    data, appear twice and the code has always meant the later one). */
function lastOnly_(t, match) {
  var test = dbMatcher_(match), want = -1;
  return function (o, i) {
    if (i === 0) { want = -1; storeRead_(t).rows.forEach(function (r, j) { if (test(r)) want = j; }); }
    return i === want;
  };
}

/** Set fields on every matching row. Only the fields that differ are written;
    a field whose column does not exist is skipped. Returns how many rows matched. */
function dbUpdate_(t, match, fields) {
  if (!STORE_.has(t)) return 0;
  var r = storeRead_(t), test = dbMatcher_(match), n = 0, edits = [];
  r.rows.forEach(function (o, i) {
    if (!test(o, i)) return;
    n++;
    var cells = {};
    var f = (typeof fields === 'function') ? fields(o) : fields;
    Object.keys(f || {}).forEach(function (k) {
      var c = r.cols.indexOf(k);
      if (c >= 0 && !dbSame_(o[k], f[k])) cells[c] = f[k];
    });
    if (Object.keys(cells).length) edits.push({ i: i, cells: cells });
  });
  if (edits.length) { STORE_.setCells(t, edits); sheetMemoClear_(); }
  return n;
}

/** Remove every matching row. Returns how many went. */
function dbDelete_(t, match) {
  if (!STORE_.has(t)) return 0;
  var r = storeRead_(t), test = dbMatcher_(match), gone = [];
  r.rows.forEach(function (o, i) { if (test(o, i)) gone.push(i); });
  if (!gone.length) return 0;
  // Rows next to each other go in one call, so what counts is how many runs.
  var runs = gone.filter(function (i, k) { return k === 0 || gone[k - 1] !== i - 1; }).length;
  if (gone.length > DB_BULK_ || runs > DB_RUNS_) {
    STORE_.rewrite(t, r.cols, r.rows.filter(function (o, i) { return gone.indexOf(i) < 0; })
      .map(function (o) { return r.cols.map(function (h) { return h === '' ? '' : o[h]; }); }));
  } else {
    STORE_.removeRows(t, gone);
  }
  sheetMemoClear_();
  return gone.length;
}
/* Past this many rows at once, one rewrite is cheaper than row-by-row. */
var DB_BULK_ = 25;
/* ...or past this many separate stretches of rows: each is its own slow call. */
var DB_RUNS_ = 8;

/* Equal as stored: blank is blank, a date is its moment, anything else exact. */
function dbSame_(a, b) {
  if (a === undefined || a === null) a = '';
  if (b === undefined || b === null) b = '';
  if (a instanceof Date || b instanceof Date) {
    return (a instanceof Date) && (b instanceof Date) && a.getTime() === b.getTime();
  }
  return a === b;
}

/** Make the table hold exactly `rows` (columns as `cols`, plus any the table
    already has). Only what differs is written: changed fields, removed rows,
    rows added at the end. When the change is not that shape — rows reordered,
    ids repeated — the table is written out whole instead. */
function dbSave_(t, rows, cols) {
  var r = storeRead_(t);
  var want = r.cols.filter(function (h) { return h !== ''; });
  (cols || []).forEach(function (h) { if (want.indexOf(h) < 0) want.push(h); });
  var key = TABLE_KEYS_[t];
  var plan = key ? dbDiff_(r.rows, rows, key, want) : null;
  /* Written whole when the columns themselves change or have gaps, as well —
     so the names always sit over their own data. */
  if (!plan || plan.gone.length > DB_BULK_ || want.length !== r.cols.length ||
      want.some(function (h, i) { return r.cols[i] !== h; })) {
    STORE_.rewrite(t, want, rows.map(function (o) {
      return want.map(function (h) { return (o[h] === undefined || o[h] === null) ? '' : o[h]; });
    }));
    sheetMemoClear_();
    return;
  }
  if (plan.edits.length) STORE_.setCells(t, plan.edits);
  if (plan.gone.length) STORE_.removeRows(t, plan.gone);
  if (plan.added.length) STORE_.append(t, plan.added.map(function (o) {
    return want.map(function (h) { return (o[h] === undefined || o[h] === null) ? '' : o[h]; });
  }));
  sheetMemoClear_();
}

/* The row-level changes that turn `old` into `now`, or null when rows cannot
   be told apart (an id repeated or missing). Rows keep their places for as
   long as `now` lists them in their stored order; from the first one out of
   order (or new), the rest are written at the end — the same order a full
   rewrite would leave. */
function dbDiff_(old, now, key, cols) {
  var id = function (o) { return key.map(function (k) { return String(o[k] === undefined || o[k] === null ? '' : o[k]); }).join('\u0001'); };
  var blank = key.map(function () { return ''; }).join('\u0001');
  var at = {};
  for (var i = 0; i < old.length; i++) {
    var k = id(old[i]);
    if (k === blank || at[k] !== undefined) return null;
    at[k] = i;
  }
  var seen = {}, kept = {}, edits = [], added = [], last = -1, tail = false;
  for (var j = 0; j < now.length; j++) {
    var kn = id(now[j]);
    if (kn === blank || seen[kn]) return null;
    seen[kn] = 1;
    var oi = at[kn];
    if (!tail && oi !== undefined && oi > last) {
      last = oi; kept[oi] = 1;
      var cells = {};
      cols.forEach(function (h, c) { if (!dbSame_(old[oi][h], now[j][h])) cells[c] = now[j][h]; });
      if (Object.keys(cells).length) edits.push({ i: oi, cells: cells });
      continue;
    }
    tail = true;
    added.push(now[j]);
  }
  var gone = [];
  old.forEach(function (o, i) { if (!kept[i]) gone.push(i); });
  return { edits: edits, gone: gone, added: added };
}

/* ---- Small settings and short-lived memory ----
   Script properties hold settings that must last (the revision, what is
   waiting to be redrawn, deleted ids); the cache holds what may vanish
   (saves already done, the state snapshot). */
function propGet_(k) { return KV_.getProp(k); }
function propSet_(k, v) { KV_.setProp(k, String(v)); }
function propDel_(k) { KV_.delProp(k); }
function propAll_() { return KV_.allProps(); }
function tempGet_(k) { try { return KV_.getTemp(k); } catch (e) { return null; } }
function tempPut_(k, v, secs) { try { KV_.putTemp(k, v, secs); } catch (e) {} }
function tempDel_(k) { try { KV_.delTemp(k); } catch (e) {} }

/* ============================ GOOGLE SHEETS BACKEND ============================
   The one place that knows the records live in hidden sheets of this
   spreadsheet. Row i of a table is sheet row i + 2 (row 1 holds the column
   names). Replacing STORE_ and KV_ moves the data somewhere else. */
var STORE_ = {
  isSheets: true,                        // (the Sheets-only repairs check this)
  has: function (t) { return !!getSheet_(t); },
  read: function (t) {
    var sh = getSheet_(t);
    var last = sh.getLastRow(), width = sh.getLastColumn();
    if (width < 1) return { cols: [], rows: [] };
    var cols = sh.getRange(1, 1, 1, width).getValues()[0];
    return { cols: cols, rows: last < 2 ? [] : sh.getRange(2, 1, last - 1, width).getValues() };
  },
  create: function (t, cols) {
    var sh = SpreadsheetApp.getActive().insertSheet(t);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.hideSheet();
  },
  addCols: function (t, cols) {
    var sh = getSheet_(t);
    var at = Math.max(sh.getLastColumn(), 1);             // after everything, data included
    if (sh.getMaxColumns() < at + cols.length) sh.insertColumnsAfter(sh.getMaxColumns(), at + cols.length - sh.getMaxColumns());
    sh.getRange(1, at + 1, 1, cols.length).setValues([cols]);
  },
  append: function (t, arrays) {
    var sh = getSheet_(t);
    if (arrays.length === 1) { sh.appendRow(arrays[0]); return; }
    var start = sh.getLastRow() + 1, width = arrays[0].length;
    if (sh.getMaxRows() < start + arrays.length) sh.insertRowsAfter(sh.getMaxRows(), arrays.length + 10);
    sh.getRange(start, 1, arrays.length, width).setValues(arrays);
  },
  // edits: [{ i: row index, cells: { colIndex: value } }]
  setCells: function (t, edits) {
    var sh = getSheet_(t);
    edits.forEach(function (e) {
      Object.keys(e.cells).forEach(function (c) {
        sh.getRange(e.i + 2, Number(c) + 1).setValue(e.cells[c]);
      });
    });
  },
  removeRows: function (t, indexes) {
    var sh = getSheet_(t);
    // Sheets refuses to delete every row below the frozen header; keep a spare.
    if (sh.getMaxRows() - indexes.length < 2) sh.insertRowsAfter(sh.getMaxRows(), 1);
    // Bottom up, a stretch of neighbouring rows at a time.
    var desc = indexes.slice().sort(function (a, b) { return b - a; });
    for (var k = 0; k < desc.length;) {
      var low = desc[k], n = 1;
      while (k + n < desc.length && desc[k + n] === low - 1) { low--; n++; }
      if (n > 1) sh.deleteRows(low + 2, n); else sh.deleteRow(low + 2);
      k += n;
    }
  },
  /* The whole table at once, column names included. Clears any stale column
     names beyond the current set, so values can never sit under the wrong one. */
  rewrite: function (t, cols, arrays) {
    var sh = getSheet_(t);
    var wide = Math.max(sh.getLastColumn(), cols.length);
    if (sh.getMaxColumns() < cols.length) sh.insertColumnsAfter(sh.getMaxColumns(), cols.length - sh.getMaxColumns());
    var last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, wide).clearContent();
    if (wide > cols.length) sh.getRange(1, cols.length + 1, 1, wide - cols.length).clearContent();
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    if (!arrays.length) return;
    if (sh.getMaxRows() < arrays.length + 1) sh.insertRowsAfter(sh.getMaxRows(), arrays.length + 1 - sh.getMaxRows());
    sh.getRange(2, 1, arrays.length, cols.length).setValues(arrays);
  }
};

var KV_ = {
  getProp: function (k) { return PropertiesService.getScriptProperties().getProperty(k); },
  setProp: function (k, v) { PropertiesService.getScriptProperties().setProperty(k, v); },
  delProp: function (k) { PropertiesService.getScriptProperties().deleteProperty(k); },
  allProps: function () { return PropertiesService.getScriptProperties().getProperties(); },
  getTemp: function (k) { return CacheService.getScriptCache().get(k); },
  putTemp: function (k, v, secs) { CacheService.getScriptCache().put(k, v, secs); },
  delTemp: function (k) { CacheService.getScriptCache().remove(k); },
  getTempAll: function (keys) { return CacheService.getScriptCache().getAll(keys); },
  putTempAll: function (obj, secs) { CacheService.getScriptCache().putAll(obj, secs); },
  delTempAll: function (keys) { CacheService.getScriptCache().removeAll(keys); }
};

function getSheet_(name) { return SpreadsheetApp.getActive().getSheetByName(name); }

/* Sheets-only housekeeping, run by ensureReady: phone columns as plain text
   (Sheets reads a leading "+" as a formula and eats the country code), and
   every data sheet hidden. A database has neither problem. */
function sheetsPrepare_() {
  if (!STORE_.isSheets) return;          // a Sheets repair; a database needs none
  [['_sales', 'phone'], ['_org', 'phone'], ['_holders', 'phone']].forEach(function (pair) {
    var sh = getSheet_(pair[0]);
    if (!sh) return;
    var c = dbCols_(pair[0]).indexOf(pair[1]) + 1;
    if (c < 1) return;
    sh.getRange(2, c, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  });
}
function hideDataSheets_() {
  if (!STORE_.isSheets) return;          // a Sheets repair; a database needs none
  ['_meta','_seasons','_books','_custombooks','_partners','_payouts','_costs','_change','_labels','_qr','_holders','_shipments','_regions','_prices','_events','_inventory','_sales','_cash','_org','_stockmoves'].forEach(function (n) {
    var sh = getSheet_(n);
    if (sh && !sh.isSheetHidden()) sh.hideSheet();
  });
}

/* Keeps the _sales column names canonical — a Sheets repair.

   SALES_HEADERS has only ever grown by appending, so rewriting row 1 in full is
   always correct and is safe to repeat. An earlier version appended only the
   missing names at getLastColumn() + 1, which was subtly wrong: appendRow
   writes a value for every column in SALES_HEADERS whether or not the header
   row knows about it, so the data ran ahead of the names and the new names
   landed one block too far right. Values then read back under an empty name
   and vanished — a partial payment's balance silently became zero. Rewriting
   the row puts the names back over their own data and recovers those records. */
function migrateSales_() {
  if (!STORE_.isSheets) return;          // a Sheets repair; a database needs none
  var sh = getSheet_('_sales');
  if (!sh) return;                      // not stored in sheets
  var width = Math.max(sh.getLastColumn(), SALES_HEADERS.length);
  var headers = sh.getRange(1, 1, 1, width).getValues()[0];
  var correct = true;
  for (var i = 0; i < SALES_HEADERS.length; i++) {
    if (String(headers[i] || '') !== SALES_HEADERS[i]) { correct = false; break; }
  }
  for (var j = SALES_HEADERS.length; j < width; j++) {
    if (String(headers[j] || '') !== '') { correct = false; break; }
  }
  if (correct) return;
  sh.getRange(1, 1, 1, SALES_HEADERS.length).setValues([SALES_HEADERS]).setFontWeight('bold');
  if (width > SALES_HEADERS.length) {
    sh.getRange(1, SALES_HEADERS.length + 1, 1, width - SALES_HEADERS.length).clearContent();
  }
  sheetMemoClear_();
}

/* ============================ STATE ============================ */

function getWarehouseName_() {
  var m = objectsOf_('_meta');
  for (var i = 0; i < m.length; i++) if (m[i].key === 'warehouseName') return m[i].value;
  return '';
}

/* ---- Meta helpers ---- */
function getMeta_(key, dflt) {
  var m = objectsOf_('_meta');
  for (var i = 0; i < m.length; i++) if (String(m[i].key) === key) return m[i].value;
  return dflt === undefined ? '' : dflt;
}
function setMeta_(key, value) {
  if (!dbUpdate_('_meta', { key: key }, { value: value })) dbInsert_('_meta', { key: key, value: value });
}

/* ---- Spreadsheet registry ----
   Data always lives in THIS spreadsheet. These extra files are presentation only:
   one per region (shared with that region's team) and one for the whole season.
   Created lazily and remembered by id, so we never make duplicates.            */
/* Opening a spreadsheet by id is a slow round-trip, and a single sync writes
   several tabs into the same file. Hold each open file for the run. */
var _fileMemo = {};
function fileMemoClear_() { _fileMemo = {}; }

/* Open (or create) one of the generated spreadsheets, keep its name current,
   and file it in the right Drive folder.

   Names now carry the season — "Croatia — Europe Tour — Book Sales" — because
   the same region exists in more than one season and the files were otherwise
   indistinguishable. An existing file is renamed in place, so nothing is lost
   and every link to it keeps working. */
function openOrCreateSheetFile_(metaKey, title, folderFn) {
  if (_fileMemo[metaKey]) return _fileMemo[metaKey];
  var id = String(getMeta_(metaKey, ''));
  var ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }   // deleted
  }
  var made = false;
  if (!ss) {
    ss = SpreadsheetApp.create(title);
    setMeta_(metaKey, ss.getId());
    made = true;
  }
  try { if (ss.getName() !== title) ss.rename(title); } catch (e) { /* keep going */ }
  if (folderFn) placeInFolder_(ss, folderFn);
  if (made) setMeta_('driveMapStamp', String(Date.now()));   // a new file belongs on the map
  _fileMemo[metaKey] = ss;
  return ss;
}

/* ---- Drive folders ----

   Every generated spreadsheet lives in a folder of your choosing (set in the
   app), with one folder per season inside it:

     Transcendental Book Sales /
       Europe Tour /           ← region files + the season summary
         Consignment /         ← each consignment group's file
       Year-Round /

   With no folder chosen, one called "Transcendental Book Sales" is made in My
   Drive. Filing never blocks a spreadsheet from being written: if Drive refuses
   (for instance before the new permission is granted), the file is still
   updated and simply stays where it is. */
var DRIVE_ROOT_NAME = 'Transcendental Book Sales';
var _driveRoot = null, _folderMemo = {};

/* Folder ids and names are remembered, because every Drive lookup is a
   separate round trip to Google. Drawing the folder map used to look each one
   up again on every open — the root, then each season's folder, then each
   Consignment folder — which is what made it so slow. */
function rememberFolder_(key, folder) {
  try {
    setMeta_('fid:' + key, folder.getId());
    setMeta_('fnm:' + key, folder.getName());
  } catch (e) {}
  return folder;
}
/** The id and name we already know for a folder, without asking Drive. */
function knownFolder_(key) {
  var id = String(getMeta_('fid:' + key, ''));
  if (!id) return null;
  return { id: id, name: String(getMeta_('fnm:' + key, '')) || 'Folder' };
}

function driveRoot_() {
  if (_driveRoot) return _driveRoot;
  var id = String(getMeta_('driveRootFolderId', ''));
  var f = null;
  if (id) { try { f = DriveApp.getFolderById(id); } catch (e) { f = null; } }
  if (!f) {
    var it = DriveApp.getFoldersByName(DRIVE_ROOT_NAME);
    f = it.hasNext() ? it.next() : DriveApp.createFolder(DRIVE_ROOT_NAME);
    setMeta_('driveRootFolderId', f.getId());
    setMeta_('driveRootFolderName', f.getName());
  }
  return (_driveRoot = f);
}
function subFolder_(parent, name) {
  var key = parent.getId() + '/' + name;
  if (_folderMemo[key]) return _folderMemo[key];
  var it = parent.getFoldersByName(name);
  var f = it.hasNext() ? it.next() : parent.createFolder(name);
  rememberFolder_(key, f);
  return (_folderMemo[key] = f);
}
function seasonName_(sid) { return String((seasonById_(sid) || {}).name || getSeasonName_() || 'Season'); }

/* A season's folder, and its Consignment folder, can each be pointed at a
   folder of your choosing. Otherwise they are found (or made) by name inside
   the top folder — so changing the top folder carries them along with it. */
function chosenFolder_(key) {
  var id = String(getMeta_(key, ''));
  if (!id) return null;
  try { return DriveApp.getFolderById(id); } catch (e) { return null; }   // gone: fall back
}
function seasonFolder_(sid) {
  return chosenFolder_('seasonFolderOverride:' + sid) || subFolder_(driveRoot_(), seasonName_(sid));
}
function consignFolder_(sid) {
  return chosenFolder_('consignFolderOverride:' + sid) || subFolder_(seasonFolder_(sid), 'Consignment');
}
/** Find a folder by name without creating it (for the map). */
function findSubFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : null;
}
function folderUrl_(f) { return 'https://drive.google.com/drive/folders/' + f.getId(); }
function sheetUrl_(id) { return 'https://docs.google.com/spreadsheets/d/' + id + '/edit'; }

/* The map shown in the app: the top folder, each season's folder and its
   Consignment folder, and every spreadsheet with its link. Spreadsheet links
   come straight from the ids the app already keeps, so they appear even if
   Drive filing has not been set up yet. Nothing is created by looking. */
function driveMap_() {
  // The finished map, kept for a few minutes: reopening it then costs nothing.
  /* Keyed by the folder only, NOT by the data revision: folders change when you
     move them, not every time a book is sold. Keying it to the revision meant
     any save threw the map away, so it was rebuilt on almost every open. */
  var ck = 'drivemap_' + String(getMeta_('driveRootFolderId', '')) + '_' + String(getMeta_('driveMapStamp', '0'));
  try { var hit = tempGet_(ck); if (hit) return JSON.parse(hit); } catch (e) {}

  var out = { root: null, driveOk: true, seasons: [] };
  var root = null, rootId = String(getMeta_('driveRootFolderId', ''));
  var rootName = String(getMeta_('driveRootFolderName', ''));
  if (rootId && rootName) {
    // Known already — no need to ask Drive at all.
    out.root = { name: rootName, url: 'https://drive.google.com/drive/folders/' + rootId };
  } else {
    try {
      root = driveRoot_();
      rootId = root.getId();
      out.root = { name: root.getName(), url: folderUrl_(root) };
    } catch (e) { out.driveOk = false; }
  }
  /* Fetched only if some folder is not yet remembered — a folder made by an
     older version still needs finding, and would otherwise be reported as not
     created yet. Everything remembered means no lookup at all. */
  function rootFolder_() {
    if (root) return root;
    try { root = DriveApp.getFolderById(rootId); } catch (e) { root = null; }
    return root;
  }

  var parts = objectsOf_('_partners');
  seasonsAll_().forEach(function (se) {
    var sid = String(se.seasonId), nm = seasonName_(sid);
    var entry = { seasonId: sid, name: nm, folder: null, consign: null,
                  folderChosen: !!getMeta_('seasonFolderOverride:' + sid, ''),
                  consignChosen: !!getMeta_('consignFolderOverride:' + sid, ''),
                  files: [], consignFiles: [] };
    if (rootId) {
      try {
        // What we already know first; Drive is asked only for what we don't.
        var ov = String(getMeta_('seasonFolderOverride:' + sid, ''));
        var known = ov ? { id: ov, name: nm } : knownFolder_(rootId + '/' + nm);
        var sfId = known ? known.id : '';
        if (known) entry.folder = { name: known.name, url: 'https://drive.google.com/drive/folders/' + known.id };
        else if (rootFolder_()) {
          var sf = findSubFolder_(root, nm);
          if (sf) { rememberFolder_(rootId + '/' + nm, sf); sfId = sf.getId();
                    entry.folder = { name: sf.getName(), url: folderUrl_(sf) }; }
        }
        if (sfId) {
          var cov = String(getMeta_('consignFolderOverride:' + sid, ''));
          var kc = cov ? { id: cov, name: 'Consignment' } : knownFolder_(sfId + '/Consignment');
          if (kc) entry.consign = { name: kc.name, url: 'https://drive.google.com/drive/folders/' + kc.id };
          else {
            var parent = null;
            try { parent = DriveApp.getFolderById(sfId); } catch (e2) {}
            var cf = parent ? findSubFolder_(parent, 'Consignment') : null;
            if (cf) { rememberFolder_(sfId + '/Consignment', cf);
                      entry.consign = { name: cf.getName(), url: folderUrl_(cf) }; }
          }
        }
      } catch (e) { /* show what we can */ }
    }
    var file = function (metaKey, title) {
      var id = String(getMeta_(metaKey, ''));
      return { name: title, url: id ? sheetUrl_(id) : '' };
    };
    entry.files.push(file('seasonSheetId:' + sid, nm + ' — Season Summary'));
    var regs = regionsOrdered_(sid);
    var regIds = {};
    regs.forEach(function (r) {
      regIds[r.regionId] = 1;
      entry.files.push(file('regionSheetId:' + r.regionId, r.name + ' — ' + nm + ' — Book Sales'));
    });
    parts.forEach(function (pt) {
      if (!pt || !pt.partnerId || !regIds[String(pt.regionId)] || truthyCell_(pt.archived)) return;
      entry.consignFiles.push(file('partnerSheetId:' + pt.partnerId,
        String(pt.name) + ' — ' + nm + ' — Consignment Sales'));
    });
    out.seasons.push(entry);
  });
  // Earthly HQ's own file, at the top of the folder (once HQ has been opened).
  if (regionById_(HQ_REGION)) {
    var hqId = String(getMeta_('regionSheetId:' + HQ_REGION, ''));
    out.hq = { name: '0 — Earthly HQ — Book Sales', url: hqId ? sheetUrl_(hqId) : '' };
  }
  tempPut_(ck, JSON.stringify(out), 1800);   // half an hour
  return out;
}

/** Point one season's folder, or its Consignment folder, somewhere else — or back to the default. */
function doSetSeasonFolder(p) {
  setMeta_('driveMapStamp', String(Date.now()));   // the map must be rebuilt
  var sid = String(p.seasonId || '');
  if (!seasonById_(sid)) throw new Error('That season is no longer listed.');
  var key = (String(p.which) === 'consign' ? 'consignFolderOverride:' : 'seasonFolderOverride:') + sid;
  if (String(p.reset) === 'true') { setMeta_(key, ''); _folderMemo = {}; markDirtyAll_(); return ''; }
  var raw = String(p.folder || '').trim();
  var m = raw.match(/folders\/([A-Za-z0-9_\-]{10,})/) || raw.match(/^([A-Za-z0-9_\-]{10,})$/);
  if (!m) throw new Error('Paste the link to a Google Drive folder.');
  var f;
  try { f = DriveApp.getFolderById(m[1]); }
  catch (e) { throw new Error('That folder could not be opened. Check the link, and that this account can edit it.'); }
  setMeta_(key, f.getId());
  _folderMemo = {};
  markDirtyAll_();               // the next sync moves that season's files there
  return f.getName();
}

/** Move a spreadsheet into its folder — once; a note is kept so it is not re-checked. */
function placeInFolder_(ss, folderFn) {
  try {
    var folder = folderFn();
    var key = 'placed:' + ss.getId();
    if (String(getMeta_(key, '')) === folder.getId()) return;
    DriveApp.getFileById(ss.getId()).moveTo(folder);
    setMeta_(key, folder.getId());
  } catch (e) {
    try { console.warn('Could not file spreadsheet in its folder:', e && e.message); } catch (e2) {}
  }
}

/* The spreadsheet of the app's own wording, for you to rewrite.

   The app sends what it actually shows on screen, so the list can never drift
   from the real thing. The file is named to sort near the top of the folder. */
function doDescriptionsSheet(p) {
  var rows = [];
  try { rows = JSON.parse(String(p.rows || '[]')); } catch (e) { rows = []; }
  if (!rows.length) throw new Error('Nothing to write — the app sent no wording.');

  var ss = openOrCreateSheetFile_('descSheetId', 'AI Descriptions',
    function () { return driveRoot_(); });
  var sh = ss.getSheetByName('Descriptions') || ss.insertSheet('Descriptions');
  sh.clear();
  var grid = [['Where it appears', 'Kind', 'Description', 'Your new wording']];
  rows.forEach(function (r) {
    grid.push([String(r.where || ''), String(r.kind || ''), String(r.text || ''), '']);
  });
  sh.getRange(1, 1, grid.length, 4).setValues(grid);
  sh.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#3B2A45').setFontColor('#F6E7C1');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 230); sh.setColumnWidth(2, 90);
  sh.setColumnWidth(3, 620); sh.setColumnWidth(4, 620);
  sh.getRange(2, 3, Math.max(grid.length - 1, 1), 2).setWrap(true);
  // A blank first sheet from a new file would otherwise sit beside it.
  ss.getSheets().forEach(function (other) {
    if (other.getName() !== 'Descriptions' && ss.getSheets().length > 1 && other.getLastRow() === 0) {
      try { ss.deleteSheet(other); } catch (e) {}
    }
  });
  return ss.getUrl();
}

/** Choose the top folder, from a Drive link or a folder id pasted in the app. */
function doSetDriveFolder(p) {
  setMeta_('driveMapStamp', String(Date.now()));   // the map must be rebuilt
  var raw = String(p.folder || '').trim();
  var m = raw.match(/folders\/([A-Za-z0-9_\-]{10,})/) || raw.match(/^([A-Za-z0-9_\-]{10,})$/);
  if (!m) throw new Error('Paste the link to a Google Drive folder.');
  var f;
  try { f = DriveApp.getFolderById(m[1]); }
  catch (e) { throw new Error('That folder could not be opened. Check the link, and that this account can edit it.'); }
  setMeta_('driveRootFolderId', f.getId());
  setMeta_('driveRootFolderName', f.getName());
  _driveRoot = null; _folderMemo = {};
  tempDel_('drivemap_' + f.getId() + '_' + getRev_());
  markDirtyAll_();               // the next sync files everything into the new place
  return f.getName();
}
function seasonSpreadsheet_() {
  var sid = activeSeasonId_();
  var nm = (seasonById_(sid) || {}).name || getSeasonName_();
  // One file per season, so last year's roll-up is not overwritten by this one.
  /* Named to sort first in the folder: Drive lists by name, and the summary is
     the file you want at the top of a season's folder. */
  return openOrCreateSheetFile_('seasonSheetId:' + sid, '1 — ' + nm + ' — Season Summary',
    function () { return seasonFolder_(sid); });
}
function regionSpreadsheet_(regionId) {
  /* Earthly HQ has one file of its own, at the top of the folder: every season
     added up, then HQ's own warehouse and sales. */
  if (String(regionId) === HQ_REGION) {
    return openOrCreateSheetFile_('regionSheetId:' + HQ_REGION, '0 — Earthly HQ — Book Sales',
      function () { return driveRoot_(); });
  }
  var r = regionById_(regionId);
  var name = r ? r.name : String(regionId);
  var sid = r ? r.seasonId : activeSeasonId_();
  return openOrCreateSheetFile_('regionSheetId:' + regionId,
    name + ' — ' + seasonName_(sid) + ' — Book Sales',
    function () { return seasonFolder_(sid); });
}
/** Shareable links, so the team can be pointed at their own file. */
function sheetLinks_() {
  var out = { season: String(getMeta_('seasonSheetId', '')), regions: {} };
  regionsOrdered_().forEach(function (r) {
    out.regions[r.regionId] = String(getMeta_('regionSheetId:' + r.regionId, ''));
  });
  return out;
}

function getSeasonName_() {
  var m = objectsOf_('_meta');
  for (var i = 0; i < m.length; i++) if (m[i].key === 'seasonName') return m[i].value;
  return 'First Season';
}

/* Single source of truth for event order: oldest first, so the tabs read
   left-to-right in the order they were created and a rename or a deletion can
   never shuffle them. Row order is the tie-break, for events created in the
   same second or predating the createdAt column. */
function eventsOrdered_() {
  return objectsOf_('_events').map(function (e, i) {
    var t = e.createdAt instanceof Date ? e.createdAt.getTime() : Number(new Date(e.createdAt));
    return { eventId: String(e.eventId), name: String(e.name), createdAt: e.createdAt,
             payTypes: parsePayList_(e.payTypes),
             hidden: String(e.hidden || ''),          // titles not offered here
             regionId: String(e.regionId || ''), closedAt: e.closedAt || '',
             sort: (e.sort === '' || e.sort === null || e.sort === undefined) ? '' : Number(e.sort),
             _t: isNaN(t) ? 0 : t, _i: i };
  }).sort(function (a, b) {
    // A hand-picked order wins; anything unranked keeps its creation order
    // behind the ranked ones, so a new event appears at the end rather than
    // jumping to the top.
    var as = (a.sort === '' || a.sort === null || a.sort === undefined) ? null : Number(a.sort);
    var bs = (b.sort === '' || b.sort === null || b.sort === undefined) ? null : Number(b.sort);
    if (as !== null && bs !== null && as !== bs) return as - bs;
    if (as !== null && bs === null) return -1;
    if (as === null && bs !== null) return 1;
    return (a._t - b._t) || (a._i - b._i);
  }).map(function (e) {
    // Every field must be named here or the app never sees it — payTypes, and
    // hidden, which says which titles this event is not offering.
    return { eventId: e.eventId, name: e.name, createdAt: e.createdAt,
             payTypes: e.payTypes || [], hidden: e.hidden || '',
             regionId: e.regionId, closedAt: e.closedAt, sort: e.sort };
  });
}

function readState() {
  ensureReady();
  var events = eventsOrdered_();
  // Books on a shipment that no longer exists are nowhere: never shown.
  var strayShip = strayShipLocs_();
  var inv = objectsOf_('_inventory').filter(function (r) { return !strayShip[String(r.location)]; }).map(function (r) {
    return { location: String(r.location), bookId: String(r.bookId), qty: Number(r.qty) || 0 };
  });
  var sales = objectsOf_('_sales').map(function (s) {
    return {
      saleId: String(s.saleId), ts: s.ts, location: String(s.location), type: String(s.type),
      bookId: String(s.bookId || ''), qty: Number(s.qty) || 0,
      p1type: String(s.p1type || ''), p1cur: String(s.p1cur || ''), p1amt: Number(s.p1amt) || 0,
      p2type: String(s.p2type || ''), p2cur: String(s.p2cur || ''), p2amt: Number(s.p2amt) || 0,
      pending: s.pending === true || s.pending === 'true' || s.pending === 'TRUE',
      paid: s.paid === true || s.paid === 'true' || s.paid === 'TRUE',
      delivered: s.delivered === true || s.delivered === 'true' || s.delivered === 'TRUE',
      dsource: String(s.dsource || ''),
      soldBy: String(s.soldBy || ''),
      changeamt: Number(s.changeamt) || 0,
      changecur: String(s.changecur || ''),
      usdActual: (s.usdActual === '' || s.usdActual === null || s.usdActual === undefined)
        ? '' : Number(s.usdActual),        // dollars actually received, where entered
      partnerId: partnerOfBook_(String(s.bookId || '')),
      dueamt: Number(s.dueamt) || 0,
      duecur: String(s.duecur || ''),
      name: String(s.name || ''), phone: phoneRead_(s.phone), comments: String(s.comments || ''),
      bundle: String(s.bundle || ''),
      fulfilBy: String(s.fulfilBy || ''), fulfilLoc: String(s.fulfilLoc || ''), fulfilAt: s.fulfilAt || '',
      fulfilDeclined: String(s.fulfilDeclined || ''),
      pmore: pmoreRead_(s.pmore)
    };
  });
  return {
    warehouseName: getWarehouseName_(),
    books: allBooks_(),
    qr: objectsOf_('_qr').filter(function (q) { return q && q.id && q.src; })
      .map(function (q) {
        return { id: String(q.id), scope: String(q.scope || ''), label: String(q.label || ''),
                 caption: String(q.caption || ''), src: String(q.src || ''), sort: Number(q.sort) || 0 };
      }).sort(function (a, b) { return a.sort - b.sort; }),
    payTypes: PAY_TYPES,
    closeDrafts: closeDrafts_(),
    rates: (function () { var r = getRates_();
      var R = r.RATES || {};
      return { perUsd: R, plnPerUsd: R.PLN || RATE_PLN_PER_USD, eurPerUsd: R.EUR || RATE_EUR_PER_USD,
               live: !!r.live, asOf: r.asOf || '', frozen: !!r.frozen }; })(),
    seasonName: isHQ_() ? 'Earthly HQ' : ((seasonById_(activeSeasonId_()) || {}).name || getSeasonName_()),
    seasons: seasonsAll_().map(function (x) {
      return { seasonId: x.seasonId, name: x.name, closedAt: x.closedAt };
    }),
    // Every consignment group in every season, so a title is only "left over"
    // when its group is truly gone — not merely in another season.
    allPartnerIds: partnersAll_().map(function (pt) { return pt.partnerId; }),
    activeSeason: activeSeasonId_(),
    allRegions: allRegionsEverywhere_(),
    // Every season's events, only so that a place in another season can be named.
    allEvents: objectsOf_('_events').filter(function (e) { return e && e.eventId; })
      .map(function (e) { return { eventId: String(e.eventId), name: String(e.name), regionId: String(e.regionId || ''),
                                   closedAt: e.closedAt ? dateText_(e.closedAt) : '' }; }),
    holders: objectsOf_('_holders').filter(function (h) { return h && h.holderId && !truthyCell_(h.archived); })
      .map(function (h) {
        return { holderId: String(h.holderId), regionId: String(h.regionId),
                 name: String(h.name || ''), phone: String(h.phone || ''), note: String(h.note || '') };
      }),
    shipments: shipmentsAll_(),
    partners: partnersAll_().map(function (pt) {
      var t = partnerTally_(pt.partnerId);
      return { partnerId: pt.partnerId, regionId: pt.regionId, name: pt.name, note: pt.note,
               took: t.took, paid: t.paid, owed: t.owed, byMethod: t.byMethod,
               sold: t.sold, preordered: t.preordered };
    }),
    /* Change taken out to give to buyers: where it came from, where it is now,
       and whether it has gone back. Kept apart from the cash movements so it
       stays a distinct thing wherever the money travels. */
    change: objectsOf_('_change').filter(function (c) { return c && c.id; })
      .map(function (c) {
        return { id: String(c.id), ts: c.ts, amt: Number(c.amt) || 0, cur: String(c.cur || ''),
                 source: String(c.source || ''), sourceName: String(c.sourceName || ''),
                 loc: String(c.loc || ''), returnedAt: c.returnedAt ? dateText_(c.returnedAt) : '',
                 by: String(c.by || '') };
      }),
    // Where the generated spreadsheets are filed (shown in the app's settings).
    serverBuild: SERVER_BUILD,
    // The season's own book order, used where a region has not set one.
    seasonBookOrder: String(getMeta_('bookOrder:' + activeSeasonId_(), '') || ''),
    /* Wording you have rewritten in the app, keyed by the words it replaces.
       Anything not rewritten simply is not here. */
    labels: (function () {
      var out = {};
      objectsOf_('_labels').forEach(function (r) {
        if (r && String(r.key)) out[String(r.key)] = String(r.text == null ? '' : r.text);
      });
      return out;
    })(),
    driveFolder: String(getMeta_('driveRootFolderName', '') || ''),
    // Money spent to make sales — card-machine fees and the like.
    // Read only if the sheet exists: a new sheet must never stop the app loading
    // on a deployment where initialize has not been run yet.
    costs: objectsOf_('_costs').filter(function (x) { return x && x.id; })
      .map(function (x) {
        return { id: String(x.id), ts: x.ts, location: String(x.location || ''),
                 category: String(x.category || 'Other'), payType: String(x.payType || ''),
                 cur: String(x.cur || ''), amt: Number(x.amt) || 0, note: String(x.note || ''),
                 partnerId: String(x.partnerId || '') };
      }),
    payouts: objectsOf_('_payouts').filter(function (x) { return x && x.id; })
      .map(function (x) {
        return { id: String(x.id), partnerId: String(x.partnerId), ts: x.ts,
                 cur: String(x.cur), amt: Number(x.amt) || 0, note: String(x.note || '') };
      }),
    outstanding: (function () {
      // Sales still owed or still to deliver, bucketed by location — so the app
      // can mark a closed place as finished or as still having work attached.
      var out = {};
      objectsOf_('_sales').forEach(function (r) {
        var loc = String(r.location);
        var o = out[loc] || (out[loc] = { owed: 0, undelivered: 0 });
        if (pendingFlag_(r) || (Number(r.dueamt) || 0) > 0) o.owed++;
        if (String(r.type) === 'PREORDER' && !isDelivered_(r)) o.undelivered++;
      });
      return out;
    })(),
    regions: (function () {
      var im = regionImpacts_();          // one pass for the whole tour
      return regionsOrdered_().map(function (r) {
        return { regionId: r.regionId, name: r.name, whLoc: r.whLoc, sort: r.sort,
                 currencies: r.currencies, books: r.books || [],
                 // Without this the app never learned a region was closed, so
                 // closing one appeared to do nothing at all.
                 closedAt: r.closedAt || '',
                 payTypes: parsePayList_(r.payTypes),
                 bookOrder: parsePayList_(r.bookOrder),
                 hidden: String(r.hidden || ''),      // titles this region does not offer
                 counts: im[r.regionId] || { events: 0, sales: 0, books: 0 } };
      }).map(function (r) {
        // A closed region's dollars are counted at the rates of its closing day.
        var fx = ratesForLoc_(r.whLoc);
        if (fx) r.rates = fx;
        return r;
      });
    })(),
    prices: pricesForState_(),
    sheetLinks: sheetLinks_(),
    keys: (function () {
      var out = { regions: {}, events: {} };
      objectsOf_('_regions').forEach(function (r) {
        out.regions[String(r.regionId)] = String(r.key || '');
        out.sellers = out.sellers || {};
        out.sellers[String(r.regionId)] = { key: String(r.sellerKey || ''),
                                            scope: String(r.sellerScope || '') };
      });
      objectsOf_('_events').forEach(function (e) { out.events[String(e.eventId)] = String(e.key || ''); });
      return out;
    })(),
    role: 'admin',
    currencies: allCurrencies_(),
    events: events,
    inventory: inv,
    sales: sales,
    /* Pre-orders another region was asked to deliver, from any season, with a
       readable "where it was ordered". Trimmed to the fulfilling season below. */
    remote: sales.filter(function (x) { return x.fulfilBy; }).map(function (x) {
      var o = {}; Object.keys(x).forEach(function (k) { o[k] = x[k]; });
      o.origin = placePath_(x.location); o.fulfilLabel = x.fulfilLoc ? locLabel_(x.fulfilLoc) : '';
      return o;
    }),
    // NOTE: everything above and below is trimmed to the active season by
    // scopeToSeason_() before it leaves. Regions are already filtered; the rest
    // hangs off locations, which is what that pass uses.

    org: objectsOf_('_org').map(function (r) {
      return { id: String(r.id), scope: String(r.scope || ''), category: String(r.category),
               sort: Number(r.sort) || 0,
               name: String(r.name || ''), phone: String(r.phone || '') };
    }),
    cash: objectsOf_('_cash')
      // Keep any row that carries a real amount + currency. REPAIR rather than drop:
      // backfill a missing id or kind so the movement still shows and stays editable.
      .filter(function (c) { return c && c.cur && (Number(c.amt) || 0) !== 0; })
      .map(function (c) {
        var kind = String(c.kind || '') || (String(c.fromAcct || '') ? 'MOVE' : 'ADJUST');
        return { id: String(c.id || ('C' + Utilities.getUuid().slice(0, 7))),
                 ts: c.ts, kind: kind,
                 fromAcct: String(c.fromAcct || ''), toAcct: String(c.toAcct || ''),
                 cur: String(c.cur), amt: Number(c.amt) || 0, note: String(c.note || ''),
                 purpose: String(c.purpose || ''), by: String(c.by || ''),
                 changeAmt: Number(c.changeAmt) || 0, changeIds: String(c.changeIds || ''),
                 changeRef: String(c.changeRef || '') };
      }),
    stockMoves: objectsOf_('_stockmoves')
      // Same repair-not-drop approach as cash: keep anything with a real book +
      // quantity, backfilling id/kind so a stray row never disappears silently.
      .filter(function (m) { return m && m.bookId && (Number(m.qty) || 0) !== 0; })
      .map(function (m) {
        var kind = String(m.kind || '') || (String(m.fromLoc || '') ? 'TRANSFER' : 'ADJUST');
        return { id: String(m.id || ('M' + Utilities.getUuid().slice(0, 7))),
                 ts: m.ts, kind: kind,
                 fromLoc: String(m.fromLoc || ''), toLoc: String(m.toLoc || ''),
                 bookId: String(m.bookId), qty: Number(m.qty) || 0, note: String(m.note || ''),
                 fromBefore: m.fromBefore, fromAfter: m.fromAfter,
                 toBefore: m.toBefore, toAfter: m.toAfter };
      }),
    serverTime: new Date().toISOString()
  };
}

/* ============================ INVENTORY HELPERS ============================ */

function invKey_(loc, book) { return loc + '||' + book; }

function loadInvMap_() {
  var map = {};
  objectsOf_('_inventory').forEach(function (r) {
    map[invKey_(String(r.location), String(r.bookId))] = Number(r.qty) || 0;
  });
  return map;
}

function saveInvMap_(map) {
  var objs = [];
  Object.keys(map).forEach(function (k) {
    var parts = k.split('||');
    objs.push({ location: parts[0], bookId: parts[1], qty: map[k] });
  });
  dbSave_('_inventory', objs, ['location','bookId','qty']);
}

/* A pre-order that has not been handed over yet holds a copy back. On-hand
   always means "physically here"; available is what may still be sold to
   someone walking up to the table. */
function isDelivered_(s) { return s.delivered === true || s.delivered === 'true' || s.delivered === 'TRUE'; }

/* Where a delivered pre-order's copy came from. The wording changed once, so
   the older values are still recognized when reading. */
var DSRC_WAREHOUSE = 'Regional warehouse';
var DSRC_OUTSIDE   = 'Outside the region';
var DSRC_REMOTE    = 'Another region';
function fromOutside_(s) {
  var v = String(s.dsource || '');
  return v === DSRC_OUTSIDE || v === 'Other warehouse' || v === DSRC_REMOTE;
}
function isDelivery_(s) { return !!String(s.dsource || ''); }

/* Once delivered, a pre-order becomes an ordinary SALE row, so without a marker
   its history disappears. dsource is only ever set by a delivery, which makes it
   a reliable flag. */
function preorderNote_(s) {
  if (!isDelivery_(s)) return '';
  var from = deliveredFrom_(s);
  return 'Fulfilled pre-order — ' +
    (fromOutside_(s) ? 'sourced from outside the region'
                     : 'from ' + (from ? locLabel_(from) : 'the region\'s own stock'));
}

/* ---- No default warehouse ----
   Every region has its own warehouse; none of them is "the" warehouse. The
   original region still uses the literal id WAREHOUSE, but only as its id —
   nothing may treat it as a default. */

/** The warehouse of the region a place belongs to, in any season ('' if none). */
function homeWarehouse_(loc) {
  var r = regionById_(regionOfAnyLoc_(String(loc || '')));
  return r ? r.whLoc : '';
}
/** Is this place a region's warehouse (any season)? */
function isRegionWarehouse_(loc) {
  loc = String(loc || '');
  return !!loc && allRegionsEverywhere_().some(function (r) { return r.whLoc === loc; });
}
/** The shelf a delivered pre-order's copy came off: as recorded (dfrom, since
    b194), else its own region's warehouse — never another region's. */
function deliveredFrom_(s) {
  return String(s.dfrom || '') || homeWarehouse_(s.location);
}
/** The place a request names. There is no default warehouse to fall back on. */
function placeOf_(loc) {
  loc = String(loc || '');
  if (!loc) throw new Error('Pick where this happened.');
  return loc;
}
/** Where a deleted sale's copy goes back to: '' when it never came off one of
    our shelves (sourced from outside, or delivered by another region). */
function restoreLocOf_(s) {
  if (String(s.type) !== 'SALE' || !s.bookId || fromOutside_(s)) return '';
  return isDelivery_(s) ? deliveredFrom_(s) : String(s.location);
}

/**
 * Every undelivered pre-order is a claim on its OWN region's warehouse. An
 * event only takes pre-orders once it has sold out of that title, so there is
 * never event stock to hold back — the copy will come from that warehouse or
 * from outside the region. (It was a claim on the original region's warehouse
 * alone, wherever it was taken, so one region's shelf was held back for every
 * other region's pre-orders.)
 */
function reservedMap_(sales) {
  var m = {}, wh = {};
  sales.forEach(function (s) {
    if (String(s.type) !== 'PREORDER' || isDelivered_(s) || !s.bookId) return;
    var loc = String(s.location);
    if (!(loc in wh)) wh[loc] = homeWarehouse_(loc);
    if (!wh[loc]) return;
    var k = invKey_(wh[loc], String(s.bookId));
    m[k] = (m[k] || 0) + 1;
  });
  return m;
}
function getReserved_(rmap, loc, book) { var v = rmap[invKey_(loc, book)]; return v === undefined ? 0 : v; }

/**
 * How many pre-orders a warehouse would be unable to fill if it were left
 * holding `after` copies of a title. Pre-order holds are advisory, not a lock —
 * stock is sometimes needed elsewhere and that call is the user's to make. The
 * server refuses only until the warning has been seen and acknowledged.
 */
function shortfall_(rmap, bookId, after, wh) {
  var held = getReserved_(rmap, wh, bookId);
  return Math.max(0, held - Math.max(0, after));
}
function breaksPreorders_(bookId, after, rmap, wh) {
  var short = shortfall_(rmap, bookId, after, wh);
  if (!short) return '';
  var b = bookById_(bookId) || { name: bookId };
  var held = getReserved_(rmap, wh, bookId);
  return short + ' of the ' + held + ' pre-order' + (held === 1 ? '' : 's') +
         ' for ' + b.name + ' could no longer be filled from ' + locLabel_(wh) + '.';
}

function getQty_(map, loc, book) { var v = map[invKey_(loc, book)]; return v === undefined ? 0 : v; }
function setQty_(map, loc, book, qty) { map[invKey_(loc, book)] = Math.max(0, Math.round(qty)); }
function addQty_(map, loc, book, delta) { setQty_(map, loc, book, getQty_(map, loc, book) + delta); }

/* ============================ DIRTY TRACKING ============================ */
/* Writes are fast because they only flag which readable tabs need rebuilding. */

function markDirty_(loc) {
  var set = {};
  try { set = JSON.parse(propGet_('dirtyLocs') || '{}'); } catch (err) { set = {}; }
  if (loc) set[String(loc)] = 1;
  propSet_('dirtyLocs', JSON.stringify(set));
}

function markDirtyAll_() {
  var set = {};
  set[SUMMARY] = 1;
  regionsOrdered_().forEach(function (r) { if (r.whLoc) set[r.whLoc] = 1; });
  objectsOf_('_events').forEach(function (e) { set[String(e.eventId)] = 1; });
  propSet_('dirtyLocs', JSON.stringify(set));
}

/* Flag only the regions a change actually touched.

   markDirtyAll_ queues every tab in every regional file plus the season roll-up,
   and each of those files is a separate spreadsheet that has to be opened —
   seconds apiece. A shipment concerns two regions, so saying so keeps the
   background rebuild proportionate instead of redoing the whole tour. */
function markDirtyRegions_(regionIds) {
  var set = {};
  try { set = JSON.parse(propGet_('dirtyLocs') || '{}'); } catch (e) { set = {}; }
  // Deliberately NOT flagging SUMMARY: the sync reads that as "every region",
  // which would rebuild the whole tour. The season file is rewritten at the end
  // of every run anyway, so it stays current without asking.
  (regionIds || []).forEach(function (rid) {
    if (!rid) return;
    locsInRegion_(rid).forEach(function (l) { set[l] = 1; });
  });
  propSet_('dirtyLocs', JSON.stringify(set));
}

/**
 * Runs every minute from a trigger, and on demand from the "Sync sheet" button.
 * Deliberately does NOT take the script lock — rebuilding a big tab can take a
 * few seconds and must never make someone wait to record a sale. The readable
 * tabs are a report; the hidden data sheets are the truth.
 */
var QUIET_MS = 25 * 1000;   // how long after a save to leave the sheets alone

/* The minute-by-minute background redraw, for EVERY season.

   It used to run under whichever single season was current on the server. It
   cleared the whole queue and redrew only that season's places — so anything
   waiting from another season was silently dropped, and a Year-Round change
   could never reach its spreadsheet except by a manual Sync from Year-Round.
   Now the queue is taken once, split by season, and each season's changes are
   redrawn under that season, sharing one time budget. */
var _presetDirty = null, _syncStarted = 0;
function syncEverySeason_() {
  /* Now and then, fill in the frozen rates of regions that closed before they
     were kept. At most once an hour, and only when nobody is saving. */
  if (!MIRROR_ && !tempGet_('orphan_sweep')) {
    tempPut_('orphan_sweep', '1', 3600);
    var ol = LockService.getScriptLock();
    if (ol.tryLock(1000)) { try { purgeOrphans_(); } catch (e) {} finally { ol.releaseLock(); } }
  }
  if (!MIRROR_ && !tempGet_('fx_backfill')) {
    tempPut_('fx_backfill', '1', 3600);
    var bl = LockService.getScriptLock();
    if (bl.tryLock(1000)) { try { backfillRegionRates_(); } catch (e) {} finally { bl.releaseLock(); } }
  }
  var raw = propGet_('dirtyLocs');
  if (!raw || raw === '{}') return;
  var lastWrite = Number(propGet_('lastWriteAt') || 0);
  if (lastWrite && (Date.now() - lastWrite) < QUIET_MS) return;     // someone is working
  if (tempGet_('tbs_rendering')) return;   // already running
  var set = {};
  try { set = JSON.parse(raw); } catch (e) { return; }
  propSet_('dirtyLocs', '{}');          // anything written from here on re-flags

  var events = objectsOf_('_events');
  var groups = [];
  var hasHQ = !!regionById_(HQ_REGION);
  seasonsAll_().concat(hasHQ ? [{ seasonId: HQ_ID }] : []).forEach(function (se) {
    setSeasonContext_(se.seasonId);
    var mine = {};
    regionsOrdered_().forEach(function (r) {
      if (r.whLoc) mine[r.whLoc] = 1;
      events.forEach(function (e) { if (String(e.regionId) === r.regionId) mine[String(e.eventId)] = 1; });
    });
    var group = {};
    Object.keys(set).forEach(function (k) { if (mine[k]) group[k] = 1; });
    // Earthly HQ adds up every season: whatever was redrawn, redraw it too.
    if (se.seasonId === HQ_ID && groups.length) group[SUMMARY] = 1;
    if (Object.keys(group).length) groups.push({ sid: se.seasonId, set: group });
  });
  setSeasonContext_('');

  _syncStarted = Date.now();
  try {
    groups.forEach(function (g) {
      _presetDirty = g.set;
      setSeasonContext_(g.sid);
      try { syncSheets(false); }
      catch (err) { console.error('Background redraw failed for a season: ' + err); }
    });
  } finally {
    _presetDirty = null; _syncStarted = 0;
    setSeasonContext_('');
  }
}

function syncSheets(force) {
  /* Only an explicit call counts as "force". A time-driven trigger passes an
     event object, which is truthy — so the minute job had been doing a FULL
     rebuild of every spreadsheet, every minute, skipping the wait-until-quiet
     rule meant to keep it out of the way of your saves. */
  force = (force === true);
  /* Connected to the Cloudflare server: the records live there, and the
     spreadsheets are drawn from a copy of them (see cfTick_). */
  if (!MIRROR_ && cfLive_()) return cfTick_(force);
  if (!force && !_presetDirty) return syncEverySeason_();

  flushStockMoves_();                    // nothing left waiting before we render
  var dirtyRaw = _presetDirty ? JSON.stringify(_presetDirty) : propGet_('dirtyLocs');
  // A manual "Sync sheet" (and the first run after an update) rebuilds
  // everything: nothing is flagged dirty then, and silently doing nothing looks
  // exactly like a broken sync — which is how a new event's tab went missing.
  if (force) {
    var all = {};
    regionsOrdered_().forEach(function (r) { all[r.whLoc] = 1; });
    objectsOf_('_events').forEach(function (e) { all[String(e.eventId)] = 1; });
    all[SUMMARY] = 1;
    dirtyRaw = JSON.stringify(all);
  }
  if (!dirtyRaw || dirtyRaw === '{}') return;

  /* Never render while someone is working.

     Apps Script runs one execution at a time per user, so a rebuild that takes
     several seconds makes the next save queue behind it. Sending books in
     transit flags two regions, which is a bigger rebuild than a sale — which is
     why that in particular felt slow. Rendering waits for a quiet moment
     instead; nothing is lost, because the work stays flagged.

     Checked BEFORE claiming the in-flight flag: standing aside is not the same
     as rendering, and claiming it here would block the catch-up run. */
  // (A per-season pass skips this: the loop already checked, and bailing here
  // would lose the share of the queue it was handed.)
  if (!force && !_presetDirty) {
    var lastWrite = Number(propGet_('lastWriteAt') || 0);
    if (lastWrite && (Date.now() - lastWrite) < QUIET_MS) return;
  }

  if (!force && !_presetDirty && tempGet_('tbs_rendering')) return;   // a render is already in flight
  tempPut_('tbs_rendering', '1', 300);

  // Apps Script kills a script at six minutes. Stop well short of that and hand
  // the remainder back to the next pass, so a big tour finishes across a few
  // runs instead of dying part-way and losing the queue.
  fileMemoClear_();                      // fresh handles for this run
  var started = _syncStarted || Date.now();     // one budget across every season
  var BUDGET_MS = 4 * 60 * 1000;
  var ranOut = false;
  function timeLeft() { return (Date.now() - started) < BUDGET_MS; }

  try {
    // A per-season pass was handed its share; the queue was already cleared once.
    if (!_presetDirty) propSet_('dirtyLocs', '{}');   // anything written from here on re-flags
    var set = {};
    try { set = JSON.parse(dirtyRaw); } catch (err) { set = {}; }
    var live = {};
    objectsOf_('_events').forEach(function (e) { live[String(e.eventId)] = 1; });

    // The Summary aggregates everything, so any change touches it.
    set[SUMMARY] = 1;

    // Summary first: it is the largest tab, so if anything is going to run out
    // of time it must not be this one.
    var order = Object.keys(set).sort(function (a, b) {
      return (a === SUMMARY ? -1 : 0) - (b === SUMMARY ? -1 : 0);
    });

    var regions = regionsOrdered_();
    var whOf = {};                       // warehouse loc -> region
    regions.forEach(function (r) { whOf[r.whLoc] = r; });

    // Which region does a dirty location belong to? Summary means "every region".
    function regionFor(loc) {
      if (whOf[loc]) return whOf[loc];
      var rid = regionOfLoc_(loc);
      return rid ? regionById_(rid) : null;
    }

    var failed = {}, lastErr = '';
    var touched = {};                    // regions needing their Summary rebuilt
    order.forEach(function (loc) {
      if (!timeLeft()) { failed[loc] = 1; ranOut = true; return; }   // finish next pass
      if (loc === SUMMARY) { regions.forEach(function (r) { touched[r.regionId] = 1; }); return; }
      if (!whOf[loc] && !live[loc]) return;                 // event was deleted
      var reg = regionFor(loc);
      if (!reg) return;
      touched[reg.regionId] = 1;
      try {
        renderView_(loc, reg.regionId);
      } catch (err) {
        failed[loc] = 1;
        lastErr = String(err && err.message ? err.message : err);
        console.error('renderView_ failed for ' + loc + ': ' + lastErr);
      }
    });

    // Each touched region's own Summary, in that region's own file.
    Object.keys(touched).forEach(function (rid) {
      if (!timeLeft()) { failed[SUMMARY] = 1; ranOut = true; return; }
      try { renderView_(SUMMARY, rid); }
      catch (err) {
        failed[SUMMARY] = 1;
        lastErr = String(err && err.message ? err.message : err);
        console.error('region summary failed for ' + rid + ': ' + lastErr);
      }
      try { orderTabs_(rid); } catch (err) { console.error('orderTabs_ failed: ' + err); }
    });

    // Each consignment partner gets their own file.
    partnersAll_().forEach(function (pt) {
      if (!timeLeft()) { ranOut = true; return; }
      try { renderPartnerSheet_(pt.partnerId); }
      catch (err) { console.error('partner sheet failed for ' + pt.name + ': ' + err); }
    });

    // The season file rolls everything up. If that fails, say so IN the sheet —
    // a silently blank summary is worse than an honest error message.
    try { if (!timeLeft()) { ranOut = true; throw new Error('Out of time — will finish on the next pass.'); }
          if (isHQ_()) renderHQSheet_(); else renderSeasonSheet_();
          // Earthly HQ adds up every season, so a full sync of one refreshes it.
          if (force && !isHQ_() && regionById_(HQ_REGION) && timeLeft()) {
            var ctxHQ = _seasonOverride;
            try { setSeasonContext_(HQ_ID); renderHQSheet_(); }
            catch (e3) { console.error('HQ sheet failed: ' + e3); }
            finally { setSeasonContext_(ctxHQ); }
          } }
    catch (err) {
      lastErr = String(err && err.message ? err.message : err);
      console.error('renderSeasonSheet_ failed: ' + lastErr);
      try {
        var ss = isHQ_() ? regionSpreadsheet_(HQ_REGION) : seasonSpreadsheet_();
        var sh = ss.getSheetByName('Summary') || ss.insertSheet('Summary');
        if (sh.getLastRow() < 2) {          // only if it is empty anyway
          sh.getRange(1, 1, 3, 1).setValues([
            ['Could not build the season summary'],
            [lastErr],
            ['Press "Sync sheet" in the app to try again. The regional files are unaffected.']
          ]);
        }
      } catch (e2) { /* nothing more we can do */ }
    }

    if (lastErr) propSet_('lastRenderError', lastErr);
    else propDel_('lastRenderError');

    if (Object.keys(failed).length) {
      var still = {};
      try { still = JSON.parse(propGet_('dirtyLocs') || '{}'); } catch (e2) { still = {}; }
      Object.keys(failed).forEach(function (k) { still[k] = 1; });
      propSet_('dirtyLocs', JSON.stringify(still));
    }
  } finally {
    tempDel_('tbs_rendering');
  }
}

/* ============ PHASE 2: THE SPREADSHEETS, FOR THE CLOUDFLARE SERVER ============

   Once the records move to the Cloudflare server (server/), this script
   still builds the readable spreadsheets, with exactly the same code: it asks
   the server for a copy of the records, holds it in memory in place of the
   hidden sheets (MIRROR_), draws, and sends back only what it learned — the
   spreadsheet and folder ids, the Activity Log lines of spreadsheet actions,
   the last error, and any place it could not finish. See server/src/core.js,
   "the bridge", for the other side.

   Connected by two Script Properties (Project Settings › Script properties):
     CF_URL     the Cloudflare server's address
     CF_SECRET  the same secret the server was given as REPORT_SECRET
   The spreadsheets are drawn from the server only once switched (CF_LIVE,
   see PHASE 3 below); until then the app works on the sheets as ever. */
var MIRROR_ = false;

function cfConfig_() {
  var url = String(propGet_('CF_URL') || ''), secret = String(propGet_('CF_SECRET') || '');
  return (url && secret) ? { url: url, secret: secret } : null;
}
function cfCall_(cfg, body) {
  var resp = UrlFetchApp.fetch(cfg.url, { method: 'post', contentType: 'text/plain', muteHttpExceptions: true,
    payload: JSON.stringify(Object.assign({ secret: cfg.secret }, body)) });
  var d = JSON.parse(resp.getContentText());
  if (!d.ok) throw new Error('Cloudflare server: ' + (d.error || 'refused'));
  return d.result;
}

/* A table store over the copy, in memory — the same contract as STORE_. */
function cfDecode_(v) {
  return (v && typeof v === 'object' && '$d' in v) ? (v.$d === null ? new Date(NaN) : new Date(v.$d)) : v;
}
function cfEncode_(v) {
  if (v instanceof Date) return { $d: isNaN(v) ? null : v.toISOString() };
  return (v === null || v === undefined) ? '' : v;
}
function mirrorStore_(tables) {
  var t = {};
  Object.keys(tables || {}).forEach(function (n) {
    t[n] = { cols: tables[n].cols.slice(), rows: tables[n].rows.map(function (r) { return r.map(cfDecode_); }) };
  });
  var pad = function (row, n) { var r = row.slice(); while (r.length < n) r.push(''); return r; };
  return {
    tables: t,
    has: function (n) { return !!t[n]; },
    read: function (n) { return { cols: t[n].cols.slice(), rows: t[n].rows.map(function (r) { return r.slice(); }) }; },
    create: function (n, cols) { t[n] = { cols: cols.slice(), rows: [] }; },
    addCols: function (n, cols) { t[n].cols = t[n].cols.concat(cols); t[n].rows = t[n].rows.map(function (r) { return pad(r, t[n].cols.length); }); },
    append: function (n, arrays) { arrays.forEach(function (a) { t[n].rows.push(pad(a, t[n].cols.length)); }); },
    setCells: function (n, edits) { edits.forEach(function (e) { Object.keys(e.cells).forEach(function (c) { t[n].rows[e.i][Number(c)] = e.cells[c]; }); }); },
    removeRows: function (n, idx) { idx.slice().sort(function (a, b) { return b - a; }).forEach(function (i) { t[n].rows.splice(i, 1); }); },
    rewrite: function (n, cols, arrays) { t[n] = { cols: cols.slice(), rows: arrays.map(function (a) { return pad(a, cols.length); }) }; }
  };
}

/* Run fn with the server's copy in place of the hidden sheets; returns fn's
   answer and what to send back. */
function withMirror_(ex, fn) {
  var saved = { store: STORE_, kv: KV_ };
  var props = {}; Object.keys(ex.props || {}).forEach(function (k) { props[k] = String(ex.props[k]); });
  var metaBefore = {}, actBefore = {};
  var mirror = mirrorStore_(ex.tables);
  if (mirror.has('_meta')) {
    var mc = mirror.tables._meta.cols, ki = mc.indexOf('key'), vi = mc.indexOf('value');
    mirror.tables._meta.rows.forEach(function (r) { metaBefore[String(r[ki])] = String(r[vi]); });
  }
  STORE_ = mirror;
  KV_ = {
    getProp: function (k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; },
    setProp: function (k, v) { props[k] = String(v); },
    delProp: function (k) { delete props[k]; },
    allProps: function () { return Object.assign({}, props); },
    // Short-lived memory stays this script's own.
    getTemp: saved.kv.getTemp, putTemp: saved.kv.putTemp, delTemp: saved.kv.delTemp,
    getTempAll: saved.kv.getTempAll, putTempAll: saved.kv.putTempAll, delTempAll: saved.kv.delTempAll
  };
  MIRROR_ = true;
  sheetMemoClear_(); fileMemoClear_(); _priceMemo = null;
  var out, back;
  try {
    if (mirror.has('_activity')) objectsOf_('_activity').forEach(function (r) { actBefore[String(r.id)] = 1; });
    out = fn();
    flushStockMoves_();
    var meta = {};
    if (mirror.has('_meta')) objectsOf_('_meta').forEach(function (r) {
      var k = String(r.key); if (k && metaBefore[k] !== String(r.value)) meta[k] = String(r.value);
    });
    var activity = [];
    if (mirror.has('_activity')) {
      var cols = mirror.tables._activity.cols;
      mirror.tables._activity.rows.forEach(function (r) {
        var o = {}; cols.forEach(function (c, i) { if (c) o[c] = cfEncode_(r[i]); });
        if (o.id && !actBefore[String(o.id)]) activity.push(o);
      });
    }
    var failed = {}; try { failed = JSON.parse(props.dirtyLocs || '{}'); } catch (e) {}
    back = { claim: ex.claim || '', meta: meta, activity: activity, failed: failed,
             props: { lastRenderError: props.lastRenderError || '' } };
  } finally {
    STORE_ = saved.store; KV_ = saved.kv; MIRROR_ = false;
    sheetMemoClear_(); fileMemoClear_(); _priceMemo = null;
  }
  return { out: out, back: back };
}

/* The minute trigger, and "Sync sheet", when connected: draw what the server
   says needs drawing (or everything, for Sync sheet), and report back. */
function cfTick_(force) {
  var cfg = cfConfig_();
  var ex = cfCall_(cfg, { action: 'reportExport', mode: force ? 'sync' : 'tick' });
  if (ex.idle) return;
  var r = withMirror_(ex, function () { return force ? syncSheets(true) : syncEverySeason_(); });
  cfCall_(cfg, { action: 'reportWriteBack', back: r.back });
}

/* A spreadsheet request from the app, passed on by the server with the shared
   secret: done here on a fresh copy, answered as the app expects. */
function cfForwarded_(p) {
  var cfg = cfConfig_();
  if (!cfg || String(p.secret || '') !== cfg.secret) return JSON.stringify({ ok: false, error: 'Not allowed.' });
  var inner = p.params || {};
  var ex = cfCall_(cfg, { action: 'reportExport', mode: inner.action === 'syncSheets' ? 'sync' : 'forward' });
  var r = withMirror_(ex, function () {
    return handle({ postData: { contents: JSON.stringify(inner) } }).getContent();
  });
  cfCall_(cfg, { action: 'reportWriteBack', back: r.back });
  return r.out;
}

/* ============ PHASE 3: MOVING THE RECORDS TO THE CLOUDFLARE SERVER ============

   Run from the Apps Script editor (choose the function, press Run; the
   Execution log shows what happened). Needs CF_URL and CF_SECRET in Script
   properties (see PHASE 2 above).

     copyToCloudflare()      Copy every record to the server, replacing what
                             is there, and compare every season. A rehearsal:
                             the app keeps working on Google. Run it as often
                             as you like, until the switch.
     compareWithCloudflare() Compare every season again, without copying.
     switchToCloudflare()    The switch: a last copy and comparison, holding
                             every save back while it runs. From then on,
                             phones still pointed here are passed on to the
                             server (relayed), so nothing is lost while they
                             catch up; the spreadsheets are drawn from the
                             server's records. If the copy does not match,
                             nothing switches.
     copyBackFromCloudflare() The way back: every record copied from the
                             server into these sheets, and the relay turned
                             off. (Point config.js back at Google first.)

   CF_LIVE = "yes" in Script properties is what "switched" means. */
function cfLive_() { return !!cfConfig_() && String(propGet_('CF_LIVE') || '') === 'yes'; }

function copyToCloudflare() {
  var cfg = cfConfig_();
  if (!cfg) throw new Error('First add CF_URL and CF_SECRET in Project Settings › Script properties.');
  if (cfLive_()) throw new Error('Already switched: the server has newer records than these sheets, and copying would erase them. (To go back to Google, run copyBackFromCloudflare.)');
  var got = cfCopy_(cfg);
  Logger.log('Copied ' + got.rows + ' records in ' + got.tables + ' tables to ' + cfg.url);
  var cmp = compareWithCloudflare();
  return cmp.ok ? 'Copied and identical.' : 'Copied, but NOT identical — see the log.';
}

/* Every hidden table and setting, sent to the server to replace its own. */
function cfCopy_(cfg) {
  ensureReady(); flushStockMoves_(); sheetMemoClear_();
  var tables = {};
  Object.keys(TABLE_KEYS_).forEach(function (t) {
    if (!dbHas_(t)) return;
    var r = STORE_.read(t);
    tables[t] = { cols: r.cols.map(String), rows: r.rows.map(function (row) { return row.map(cfEncode_); }) };
  });
  var props = Object.assign({}, propAll_());
  ['CF_URL', 'CF_SECRET', 'CF_LIVE'].forEach(function (k) { delete props[k]; });
  return cfCall_(cfg, { action: 'reportImport', tables: tables, props: props });
}

/* Season by season, what the owner's app is shown here and there: every
   sale, every count, every total — the same, or where they first differ.
   (Exchange rates are left out: each side fetches today's for itself.) */
function compareWithCloudflare() {
  var cfg = cfConfig_();
  if (!cfg) throw new Error('First add CF_URL and CF_SECRET in Project Settings › Script properties.');
  var clean = function (st) {
    var o = JSON.parse(JSON.stringify(st));
    delete o.serverTime; delete o.rates;
    return o;
  };
  // Up to three places where they differ, each with both values.
  var show = function (v) { var t = JSON.stringify(v); return t === undefined ? '(missing)' : (t.length > 120 ? t.slice(0, 120) + '…' : t); };
  var diffs = function (a, b, at, out) {
    if (out.length >= 3 || a === b) return out;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
      out.push((at || '(top)') + ' — here ' + show(a) + ', there ' + show(b));
      return out;
    }
    var keys = {}; Object.keys(a).concat(Object.keys(b)).forEach(function (k) { keys[k] = 1; });
    for (var k in keys) diffs(a[k], b[k], at + (Array.isArray(a) ? '[' + k + ']' : '.' + k), out);
    return out;
  };
  var ids = seasonsAll_().map(function (s) { return { id: s.seasonId, name: s.name }; });
  if (regionById_(HQ_REGION)) ids.push({ id: HQ_ID, name: 'Earthly HQ' });
  var lines = [], ok = true;
  ids.forEach(function (s) {
    setSeasonContext_(s.id); sheetMemoClear_();
    var mine = JSON.parse(stateJson_());
    var theirs = cfCall_(cfg, { action: 'reportState', season: s.id });
    var found = diffs(clean(mine), clean(theirs), '', []);
    // What a person would check: how many sales, and the money in each currency.
    var money = {};
    (mine.sales || []).forEach(function (x) {
      if (!received_(x)) return;
      eachLeg_(x, function (l) { if (l.amt) money[l.cur] = (money[l.cur] || 0) + l.amt; });
    });
    var sum = plural_((mine.sales || []).length, 'sale') + Object.keys(money).sort().map(function (c) {
      return ' · ' + round2_(money[c]) + ' ' + c; }).join('');
    if (found.length) ok = false;
    lines.push(s.name + ': ' + (found.length ? 'DIFFERENT' : 'identical') + ' — ' + sum);
    found.forEach(function (f) { lines.push('    ' + f); });
  });
  setSeasonContext_(''); sheetMemoClear_();
  Logger.log((ok ? 'Every season is identical on the server.' : 'NOT identical:') + '\n' + lines.join('\n'));
  return { ok: ok, lines: lines };
}

function switchToCloudflare() {
  var cfg = cfConfig_();
  if (!cfg) throw new Error('First add CF_URL and CF_SECRET in Project Settings › Script properties.');
  if (cfLive_()) { Logger.log('Already switched to Cloudflare.'); return 'Already switched.'; }
  // Every save waits while the last copy is made, so none can fall between.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    propSet_('CF_LIVE', 'yes');
    try {
      var got = cfCopy_(cfg);
      Logger.log('Copied ' + got.rows + ' records in ' + got.tables + ' tables.');
      var cmp = compareWithCloudflare();
      if (!cmp.ok) throw new Error('The copy did not match, so nothing was switched. See the log.');
    } catch (e) {
      propDel_('CF_LIVE');                     // still on Google, exactly as before
      throw e;
    }
  } finally {
    lock.releaseLock();
  }
  Logger.log('Switched. The records now live on ' + cfg.url + '. Point config.js at it; ' +
             'until each phone reloads, its requests are passed on from here.');
  return 'Switched.';
}

/* A request from a phone still pointed at Google, once switched: passed on to
   the server and its answer handed back, so the phone works as before. It
   waits for a switch in progress (which holds the lock while it copies). */
function cfRelay_(params) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(30000); lock.releaseLock(); } catch (e) { /* go on; the server decides */ }
  var cfg = cfConfig_();
  var resp = UrlFetchApp.fetch(cfg.url, { method: 'post', contentType: 'text/plain', muteHttpExceptions: true,
    payload: JSON.stringify({ action: 'relay', secret: cfg.secret, params: params }) });
  return resp.getContentText();
}

function copyBackFromCloudflare() {
  var cfg = cfConfig_();
  if (!cfg) throw new Error('First add CF_URL and CF_SECRET in Project Settings › Script properties.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ex = cfCall_(cfg, { action: 'reportExport', mode: 'forward' });
    var rows = 0;
    Object.keys(ex.tables || {}).forEach(function (t) {
      var tb = ex.tables[t];
      if (!STORE_.has(t)) STORE_.create(t, tb.cols);
      STORE_.rewrite(t, tb.cols, tb.rows.map(function (r) { rows++; return r.map(cfDecode_); }));
    });
    var theirRev = Number((ex.props || {}).rev || 0);
    Object.keys(ex.props || {}).forEach(function (k) {
      if (k === 'rev' || k === 'dirtyLocs' || k === 'cfInFlight' || /^CF_/.test(k)) return;
      propSet_(k, ex.props[k]);
    });
    propSet_('rev', String(Math.max(getRev_(), theirRev) + 1));
    propDel_('CF_LIVE');
    sheetMemoClear_(); cacheClear_(); markDirtyAll_();
    Logger.log('Copied ' + rows + ' records back from the server. The app works on these sheets again.');
  } finally {
    lock.releaseLock();
  }
  return 'Copied back.';
}

/* ============================ ACTION HANDLERS ============================ */

/* ============================ CASH LEDGER ============================
   A running record of physical cash and bank balances. Every entry is a signed
   movement, so balances are just the fold of all entries. Accounts are:
   'WAREHOUSE', 'BANK', or an event id. Currencies match the rest of the app.  */


/* Two banks, deliberately.

   A region keeps its own account — the one its coordinator actually pays into —
   and the tour keeps a global account where money finally lands. A regional
   bank belongs to its region and is shown nowhere else; the global bank is
   visible everywhere because it concerns everyone. */
function regionBankId_(regionId) { return 'BANK_' + String(regionId); }
function isRegionBank_(acct) { return String(acct).indexOf('BANK_') === 0; }
function regionOfBank_(acct) { return String(acct).slice(5); }

function bankLabel_(acct) {
  if (String(acct) === 'BANK') return 'Global bank';
  if (isRegionBank_(acct)) {
    var r = regionById_(regionOfBank_(acct));
    var nm = r ? String(r.bankName || '').trim() : '';
    return nm || ((r ? r.name : 'Region') + ' bank');
  }
  return '';
}

function cashValidAcct_(a) {
  a = String(a || '');
  if (a === 'BANK') return true;
  if (isRegionBank_(a)) return !!regionById_(regionOfBank_(a));
  // Every region has its own warehouse, not just the original one.
  var isWh = regionsOrdered_().some(function (r) { return r.whLoc === a; });
  if (isWh) return true;
  if (holderById_(a)) return true;          // a devotee can hold money too
  return !!eventById_(a);
}
/* Read cash rows as objects keyed by the sheet's own headers, and write them
   back the same way.

   Every one of these used to rebuild rows from fixed column positions, so a
   column added later was wiped from the entire sheet by any edit or delete.
   Doing it by name means the sheet can grow without old code quietly destroying
   the new field. */
function cashRows_() {
  dbAddCols_('_cash', CASH_HEADERS);
  return objectsOf_('_cash');
}

/* 'by' records who made the entry. Without it, a movement nobody recognized
   could not be traced to a person or a link — which is exactly the position a
   transfer into a regional account left us in. */
var CASH_HEADERS = ['id','ts','kind','fromAcct','toAcct','cur','amt','note','purpose','by','changeAmt','changeIds','changeRef'];
var _cashBy = '';

/* What has been deliberately deleted, and must never come back.

   A save can arrive twice — a retry, or a page that closed before the reply and
   re-sent on opening. If it arrives AFTER the thing was deleted, the id is free
   again and the row would be written a second time: a deleted movement
   reappearing, and its money counted twice. These ids are remembered so a late
   arrival is recognized as something already dealt with. */
var TOMB_KEY = 'deletedIds';
function tombstones_() {
  try { return JSON.parse(propGet_(TOMB_KEY) || '[]'); }
  catch (e) { return []; }
}
function tombstone_(id) {
  if (!id) return;
  var list = tombstones_();
  if (list.indexOf(String(id)) >= 0) return;
  list.push(String(id));
  if (list.length > 800) list = list.slice(list.length - 800);   // keep it small
  try { propSet_(TOMB_KEY, JSON.stringify(list)); } catch (e) {}
}
function isDeleted_(id) { return !!id && tombstones_().indexOf(String(id)) >= 0; }

/* Editing a transaction deletes its members and builds them again under the
   same ids. Those deletions are part of the edit, not a removal, so they must
   NOT be remembered as deleted — otherwise the rebuild is refused and the
   transaction comes back empty. */
var _rebuilding = false;

function cashAppend_(o) {
  // Written by name against the sheet's own columns, adding any that are
  // missing — the same self-healing as sales, so a new field can never be
  // silently dropped for want of running initialize.
  dbAddCols_('_cash', CASH_HEADERS);
  /* The app may name the row itself. Without that, a movement made moments ago
     still carried a temporary name, so the first attempt to remove it was
     refused — "no longer in the ledger" — and only worked on a second try. */
  var wanted = String(o.id || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 40);
  if (wanted) {
    if (isDeleted_(wanted)) return wanted;          // deleted on purpose: never write it again
    var have = cashRows_();
    for (var i = 0; i < have.length; i++) if (String(have[i].id) === wanted) return wanted;
  }
  var row = {
    id: wanted || ('C' + Utilities.getUuid().slice(0, 7)),
    ts: o.ts ? new Date(o.ts) : new Date(),
    kind: String(o.kind),
    fromAcct: String(o.fromAcct || ''),
    toAcct: String(o.toAcct || ''),
    cur: String(o.cur),
    amt: Math.round((Number(o.amt) || 0) * 100) / 100,
    note: String(o.note || ''),
    by: String(o.by || _cashBy || ''),
    changeAmt: Number(o.changeAmt) || 0,     // how much of this movement was change
    changeIds: String(o.changeIds || ''),    // which change traveled with it
    changeRef: String(o.changeRef || ''),    // the change this row withdrew or returned
    purpose: String(o.purpose || '')
  };
  _cashIds.push(row.id);             // for the activity log's undo
  dbInsert_('_cash', row);
}

/* ============================ STOCK MOVEMENTS ============================
   A running record of where physical books came from and went — mirrors the
   cash ledger's shape. Two kinds:
     • ADJUST — stock entering or leaving the system at one location (new
       stock arriving, a recount, damage/loss). fromLoc is blank; qty is signed
       (positive = added, negative = removed).
     • TRANSFER — stock moving between two locations (warehouse ↔ event).
       qty is always positive; fromLoc/toLoc are both set.                   */
/* Undo a movement: put the books back where they were and drop the log entry.
   Only TRANSFER and ADJUST can be reversed — an EXTERNAL send has no second side
   inside the tour to take the books back from. */
function doUndoStockMove(p) {
  var id = String(p.id || '');
  var rows = objectsOf_('_stockmoves');
  var target = null;
  rows.forEach(function (m) { if (String(m.id) === id) target = m; });
  if (!target) throw new Error('That movement is no longer in the log.');

  var kind = String(target.kind || '');
  var bookId = String(target.bookId);
  var qty = Math.round(Number(target.qty) || 0);
  var map = loadInvMap_();

  if (kind === 'TRANSFER') {
    var to = String(target.toLoc), from = String(target.fromLoc);
    if (getQty_(map, to, bookId) < qty) {
      throw new Error('Only ' + getQty_(map, to, bookId) + ' left at ' + locLabel_(to) +
        ' — not enough to undo a move of ' + qty + '. Nothing was changed.');
    }
    addQty_(map, to, bookId, -qty);
    addQty_(map, from, bookId, qty);
    markDirty_(from); markDirty_(to);
  } else if (kind === 'ADJUST') {
    var loc = String(target.toLoc);
    if (qty > 0 && getQty_(map, loc, bookId) < qty) {
      throw new Error('Only ' + getQty_(map, loc, bookId) + ' left at ' + locLabel_(loc) +
        ' — not enough to undo adding ' + qty + '. Nothing was changed.');
    }
    addQty_(map, loc, bookId, -qty);
    markDirty_(loc);
  } else {
    throw new Error('A transfer out of the tour cannot be undone here — record a matching one back in instead.');
  }
  saveInvMap_(map);

  dbDelete_('_stockmoves', { id: id });
  markDirtyAll_();
}

/* Movement entries are buffered and written in one go.

   Each row used to be appended on its own, and every append is a separate
   round-trip to Sheets — so a nine-title shipment paid for ten of them and felt
   noticeably slower than a single sale. Collecting them costs nothing and turns
   the whole batch into one write. */
var _moveBuffer = [];

function stockMoveAppend_(o) {
  var qty = Math.round(Number(o.qty) || 0);
  if (!qty) return;   // nothing actually moved — don't log a no-op
  var blank = function (v) { return (v === undefined || v === null) ? '' : v; };
  /* The app may name the movement, so it can appear in the log the instant it
     is made — and be undone straight away — instead of waiting for a refresh
     to learn what the server called it. */
  var wanted = String(o.id || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 40);
  _moveBuffer.push([
    wanted || ('M' + Utilities.getUuid().slice(0, 7)),
    o.ts ? new Date(o.ts) : new Date(),
    String(o.kind),
    String(o.fromLoc || ''),
    String(o.toLoc || ''),
    String(o.bookId),
    qty,
    String(o.note || ''),
    // Counts either side of the move, so the log can show 2 → 1 / 6 → 7 and you
    // can see at a glance that it really happened.
    blank(o.fromBefore), blank(o.fromAfter), blank(o.toBefore), blank(o.toAfter)
  ]);
}

/* The buffer holds each movement as a list in this order. */
var MOVE_FIELDS_ = ['id','ts','kind','fromLoc','toLoc','bookId','qty','note','fromBefore','fromAfter','toBefore','toAfter'];

/** Write everything buffered so far. Safe to call at any time. */
function flushStockMoves_() {
  if (!_moveBuffer.length) return;
  var rows = _moveBuffer;
  _moveBuffer = [];                       // cleared first, so a failure can't double-write
  if (!dbHas_('_stockmoves')) return;
  dbInsert_('_stockmoves', rows.map(function (r) {
    var o = {}; MOVE_FIELDS_.forEach(function (h, i) { o[h] = r[i]; }); return o;
  }));
}
/** Physical cash actually collected at a location — the same basis as the
    Collections figures, but limited to Cash payments (Zelle/PayPal/Wise are not
    physical cash, and Gift is nothing). This is the baseline every account's
    cash balance builds on. The bank has no sales, so its baseline is zero. */
function cashCollected_(acct, cur) {
  if (acct === 'BANK') return 0;
  var total = 0;
  objectsOf_('_sales').forEach(function (s) {
    /* Consignment notes go into the same box, so they are counted here — the
       box really does hold them. Honesty comes from the other end: handing that
       money over is recorded as cash leaving, so the balance drops when it
       does. The app used to count it and the server not, which is why moving
       all cash left a residue that looked like money appearing from nowhere. */
    if (String(s.location) !== acct) return;
    if (!received_(s)) return;                 // pending: nothing in hand yet
    eachLeg_(s, function (leg) {
      if (leg.type === 'Cash' && leg.cur === cur) total += leg.amt;
    });
  });
  return total;
}

/** An account's cash balance: what was collected there, plus every cash
    movement in, minus movements out, plus manual corrections. */
/* What one region has handed to the bank, per currency.

   The bank account belongs to the whole tour, so quoting its balance on a
   region's own sheet mixed in money that had nothing to do with that region.
   This is that region's contribution and nothing else. */
function bankFromRegion_(regionId, cur) {
  var mine = {};
  locsInRegion_(regionId).forEach(function (l) { mine[String(l)] = 1; });
  var total = 0;
  objectsOf_('_cash').forEach(function (c) {
    if (!c || String(c.kind) !== 'MOVE' || String(c.cur) !== cur) return;
    // Change withdrawn for the till is reported separately, not as money sent.
    var purpose = String(c.purpose || '');
    if (purpose === 'FLOAT' || purpose === 'FLOAT_BACK') return;
    var amt = Number(c.amt) || 0;
    if (String(c.toAcct) === 'BANK' && mine[String(c.fromAcct)]) total += amt;
    if (String(c.fromAcct) === 'BANK' && mine[String(c.toAcct)]) total -= amt;
  });
  return round2_(total);
}

/* Which region an account belongs to, for scoping. A regional bank belongs to
   its own region; the global bank belongs to no one region. */
function regionOfAcct_(acct) {
  if (isRegionBank_(acct)) return regionOfBank_(acct);
  return regionOfLoc_(String(acct));
}

function cashBalance_(acct, cur) {
  var bal = cashCollected_(acct, cur);
  objectsOf_('_cash').forEach(function (c) {
    if (String(c.cur) !== cur) return;
    var amt = Number(c.amt) || 0;
    if (String(c.kind) === 'MOVE') {
      if (String(c.fromAcct) === acct) bal -= amt;
      if (String(c.toAcct) === acct) bal += amt;
    } else { // ADJUST
      if (String(c.toAcct) === acct) bal += amt;
    }
  });
  return Math.round(bal * 100) / 100;
}

/** Move cash from one account to another. */
/* A change float: cash drawn from the bank purely to make change, which goes
   straight back once the selling is done.

   It is an ordinary move, marked so the app can say how much is still out. That
   matters because the money is sitting in the box looking like takings when it
   is really the bank's. */
/* A withdrawal or deposit of change, in as many currencies as you like, as ONE
   request.

   It used to be one call per currency, which meant the confirmation appeared
   again for each, and balances were re-checked against a moving target between
   them — so a perfectly good deposit could be refused for want of cash that the
   previous call had just moved. */
function doFloat(p) {
  var loc = String(p.loc || '');
  var back = String(p.back) === 'true';
  if (!cashValidAcct_(loc)) throw new Error('Pick where the change is going.');

  var items = (p.items && p.items.length) ? p.items : [{ cur: p.cur, amt: p.amt }];
  var clean = items.map(function (it) {
    return { cur: String(it.cur || '').toUpperCase(),
             amt: Math.round((Number(it.amt) || 0) * 100) / 100 };
  }).filter(function (it) { return it.amt > 0; });
  if (!clean.length) throw new Error('Enter an amount greater than zero.');

  var known = allCurrencies_();
  clean.forEach(function (it) {
    if (known.indexOf(it.cur) < 0) throw new Error(it.cur + ' is not one of the tour currencies.');
  });

  clean.forEach(function (it) {
    cashAppend_({
      kind: 'MOVE',
      fromAcct: back ? loc : 'BANK',
      toAcct:   back ? 'BANK' : loc,
      cur: it.cur, amt: it.amt,
      note: (p.note ? p.note + ' — ' : '') + (back ? 'Change deposited back' : 'Change withdrawn'),
      purpose: back ? 'FLOAT_BACK' : 'FLOAT',
      ts: p.ts
    });
  });
  markDirtyRegions_([regionOfLoc_(loc)]);
}

/** How much float is still out, per currency, for these locations. */
function floatOutstanding_(locs) {
  var mine = {}; (locs || []).forEach(function (l) { mine[String(l)] = 1; });
  var out = {};
  objectsOf_('_cash').forEach(function (c) {
    if (!c) return;
    var purpose = String(c.purpose || '');
    if (purpose !== 'FLOAT' && purpose !== 'FLOAT_BACK') return;
    var cur = String(c.cur), amt = Number(c.amt) || 0;
    if (purpose === 'FLOAT'      && mine[String(c.toAcct)])   out[cur] = (out[cur] || 0) + amt;
    if (purpose === 'FLOAT_BACK' && mine[String(c.fromAcct)]) out[cur] = (out[cur] || 0) - amt;
  });
  Object.keys(out).forEach(function (c) { if (Math.abs(out[c]) < 0.005) delete out[c]; });
  return out;
}

function doCashMove(p) {
  var from = String(p.fromAcct || ''), to = String(p.toAcct || '');
  var cur = String(p.cur || ''), amt = Math.round((Number(p.amt) || 0) * 100) / 100;
  if (!cashValidAcct_(from) || !cashValidAcct_(to)) throw new Error('Pick both a source and a destination.');
  if (from === to) throw new Error('The source and destination are the same.');
  if (allCurrencies_().indexOf(cur) < 0) throw new Error('Pick a currency.');
  if (amt <= 0) throw new Error('Enter an amount greater than zero.');
  // The bank is the tour's own account and may legitimately run negative on
  // paper; a physical cash box cannot hand over more than it holds.
  if (from !== 'BANK') {
    var have = cashBalance_(from, cur);
    if (amt > have + 0.005) {
      throw new Error(locLabel_(from) + ' only has ' + fmtMoney_(have, cur) +
        ' — you asked to move ' + fmtMoney_(amt, cur) + '.');
    }
  }
  cashAppend_({ id: p.cashId, kind: 'MOVE', fromAcct: from, toAcct: to, cur: cur, amt: amt,
                note: p.note, ts: p.ts });
  markDirtyAll_();
}

function fmtMoney_(n, cur) { return (Math.round(n * 100) / 100) + ' ' + cur; }

/** Move ALL cash — every currency with a positive balance — from one account to
    another in a single action. Skips currencies that are empty. */
function doCashMoveAll(p) {
  var from = String(p.fromAcct || ''), to = String(p.toAcct || '');
  if (!cashValidAcct_(from) || !cashValidAcct_(to)) throw new Error('Pick both a source and a destination.');
  if (from === to) throw new Error('The source and destination are the same.');

  /* Read every balance BEFORE writing anything.

     Each append invalidates the cached read of the cash sheet, so working out
     the next currency's balance mid-loop was measuring a moving target — which
     is how this could report "no cash to move" for an account that plainly had
     some. */
  var plan = [];
  allCurrencies_().forEach(function (cur) {
    var bal = cashBalance_(from, cur);
    if (bal > 0.005) plan.push({ cur: cur, amt: bal });
  });
  if (!plan.length) throw new Error(locLabel_(from) + ' has no cash to move.');

  /* Change swept along with the takings stays marked as change: the movement
     records how much of it was change, and the change itself now lives at the
     destination — or is home, if that is where it came from. */
  var ids = String(p.changeIds || '').split(',').map(function (x) { return x.trim(); })
    .filter(function (x) { return x; });
  var chgBy = {};
  if (ids.length) {
    objectsOf_('_change').forEach(function (r) {
      if (ids.indexOf(String(r.id)) < 0 || String(r.returnedAt || '')) return;
      chgBy[String(r.cur)] = (chgBy[String(r.cur)] || 0) + (Number(r.amt) || 0);
    });
  }
  plan.forEach(function (it) {
    cashAppend_({ id: p.idPrefix ? (p.idPrefix + '_' + it.cur) : '',
                  kind: 'MOVE', fromAcct: from, toAcct: to, cur: it.cur, amt: it.amt,
                  changeAmt: chgBy[it.cur] || 0,
                  changeIds: (chgBy[it.cur] ? ids.join(',') : ''),
                  note: p.note || 'Moved all cash', ts: p.ts });
  });
  if (ids.length) doChangeMove({ ids: ids, toLoc: to });
  markDirtyAll_();
}

/** Reset the whole tracker: remove every manual entry so all balances fall back
    to exactly what was collected. Collections (from sales) are never touched. */
function doCashResetAll(p) {
  cashRows_();
  dbDelete_('_cash', function () { return true; });
  markDirtyAll_();
}

/** Add to or subtract from one account (a correction, found/lost cash). */
function doCashAdjust(p) {
  var acct = String(p.toAcct || '');
  var cur = String(p.cur || ''), amt = Math.round((Number(p.amt) || 0) * 100) / 100;
  if (!cashValidAcct_(acct)) throw new Error('Pick an account.');
  if (allCurrencies_().indexOf(cur) < 0) throw new Error('Pick a currency.');
  if (!amt) throw new Error('Enter an amount (use a minus sign to remove cash).');
  cashAppend_({ kind: 'ADJUST', toAcct: acct, cur: cur, amt: amt, note: p.note, ts: p.ts });
  markDirtyAll_();
}

/** Set an account's balance to an exact figure — recorded as the adjustment
    needed to get there, so the fold stays simple and the history is honest. */
function doCashSet(p) {
  var acct = String(p.toAcct || ''), cur = String(p.cur || '');
  var target = Math.round((Number(p.amt) || 0) * 100) / 100;
  if (!cashValidAcct_(acct)) throw new Error('Pick an account.');
  if (allCurrencies_().indexOf(cur) < 0) throw new Error('Pick a currency.');
  var delta = Math.round((target - cashBalance_(acct, cur)) * 100) / 100;
  if (delta === 0) return;
  cashAppend_({ kind: 'ADJUST', toAcct: acct, cur: cur, amt: delta,
    note: p.note || ('Set to ' + target + ' ' + cur), ts: p.ts });
  markDirtyAll_();
}

/* Edit an existing ledger entry in place — change its kind, accounts, currency,
   amount or note. Balances recompute from the ledger, so the change ripples
   through instantly. */
function doCashEdit(p) {
  var id = String(p.id);
  var kind = String(p.kind || 'MOVE');
  var cur = String(p.cur || '');
  var amt = Math.round((Number(p.amt) || 0) * 100) / 100;
  if (allCurrencies_().indexOf(cur) < 0) throw new Error('Pick a currency.');
  if (kind === 'MOVE') {
    if (!cashValidAcct_(p.fromAcct) || !cashValidAcct_(p.toAcct)) throw new Error('Pick both accounts.');
    if (String(p.fromAcct) === String(p.toAcct)) throw new Error('The source and destination are the same.');
    if (amt <= 0) throw new Error('Enter an amount greater than zero.');
  } else {
    if (!cashValidAcct_(p.toAcct)) throw new Error('Pick an account.');
    if (!amt) throw new Error('Enter an amount.');
  }
  /* Read and write by COLUMN NAME.

     This rebuilt every row from fixed positions, so any column added later was
     silently dropped from the whole sheet — editing one note erased 'purpose'
     from every entry, which is exactly why change withdrawn from the bank
     stopped showing. Reading by name keeps whatever the sheet carries, now and
     in future. */
  dbAddCols_('_cash', CASH_HEADERS);
  // purpose, and anything else on the row, is left exactly as it was.
  var found = dbUpdate_('_cash', { id: id }, {
    kind: kind, fromAcct: (kind === 'MOVE' ? String(p.fromAcct) : ''), toAcct: String(p.toAcct),
    cur: cur, amt: amt, note: String(p.note || '') });
  if (!found) throw new Error('That entry is no longer in the ledger.');
  var touched = [regionOfLoc_(String(p.toAcct))];
  if (p.fromAcct) touched.push(regionOfLoc_(String(p.fromAcct)));
  markDirtyRegions_(touched);
}

function doCashDelete(p) {
  var id = String(p.id);
  var gone = null;
  cashRows_().forEach(function (o) { if (String(o.id) === id) gone = o; });
  if (!gone) return;                       // already removed — a resend, not a failure
  dbDelete_('_cash', { id: id });
  tombstone_(id);                          // and it must not come back on a resend

  /* Change is change wherever it goes, so removing a movement puts it back the
     way it was: a withdrawal undone removes the change entirely, a return
     undone makes it outstanding again, and a transfer undone brings the change
     back to where it started. */
  var ref = String(gone.changeRef || '');
  var ids = String(gone.changeIds || '').split(',').map(function (x) { return x.trim(); })
    .filter(function (x) { return x; });
  if (ref || ids.length) {
    changeRows_();
    // A withdrawal undone: the change was never taken.
    if (ref && String(gone.purpose) === 'FLOAT') dbDelete_('_change', { id: ref });
    // A return undone: out again. A transfer undone: back where it was.
    dbUpdate_('_change', function (r) {
      return (ref && String(r.id) === ref && String(gone.purpose) === 'FLOAT_BACK') ||
             ids.indexOf(String(r.id)) >= 0;
    }, function (r) { return { returnedAt: '', loc: String(gone.fromAcct || r.loc) }; });
  }
  markDirtyAll_();
}

/* Remove every manual ledger entry that touches the bank, so the bank falls back
   to what the tracker has actually moved into it. Collections and event/
   warehouse transfers are untouched. */
/* Reset a single account to what the tracker collected: drop every manual entry
   that touches it, leaving collections as the only source. */
function doCashResetAcct(p) {
  var acct = String(p.acct || '');
  if (!cashValidAcct_(acct)) throw new Error('Pick an account.');
  cashRows_();
  dbDelete_('_cash', function (o) { return String(o.fromAcct) === acct || String(o.toAcct) === acct; });
  markDirtyAll_();
}

function doCashResetBank(p) {
  cashRows_();
  dbDelete_('_cash', function (o) { return String(o.fromAcct) === 'BANK' || String(o.toAcct) === 'BANK'; });
  markDirtyAll_();
}

/* The org chart / contact list. Edited and saved as a whole, since it is small
   and changes rarely — the client sends the full set of rows, we rewrite. */
function doOrgSave(p) {
  var scope = String(p.scope || SEASON);
  // Every page keeps its own chart, so a save only replaces this scope's rows and
  // leaves every other level untouched.
  var kept = objectsOf_('_org')
    .filter(function (r) { return String(r.scope || '') !== scope; })
    .map(function (r) {
      return { id: String(r.id), scope: String(r.scope || ''), category: String(r.category),
               sort: Number(r.sort) || 0, name: String(r.name || ''), phone: String(r.phone || '') };
    });
  var mine = (p.rows || []).map(function (r, i) {
    return {
      id: String(r.id || ('O' + Utilities.getUuid().slice(0, 7))),
      scope: scope,
      category: String(r.category || '').trim(),
      sort: Number(r.sort) || i,
      name: String(r.name || '').trim(),
      phone: String(r.phone || '').trim()
    };
  }).filter(function (r) { return r.category && (r.name || r.phone); });
  dbSave_('_org', kept.concat(mine), ['id','scope','category','sort','name','phone']);
  markDirtyAll_();
}

/* ---- Regions ---- */
function doCreateRegion(p) {
  if (isHQ_()) throw new Error('Regions belong to a season — choose a season first.');
  var name = String(p.name || '').trim();
  if (!name) throw new Error('Give the region a name.');
  var curs = parseCurList_(p.currencies);
  // Named by the app where it supplied one; a repeat of the same request is ignored.
  var wantR = String(p.regionId || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 40);
  if (wantR && regionById_(wantR)) return wantR;
  var regionId = wantR || ('rg_' + Utilities.getUuid().slice(0, 6));
  // A book order may be set as the region is made, rather than afterwards.
  var order = String(p.bookOrder || '').split(',').map(function (x) { return x.trim(); })
    .filter(function (x) { return x; }).join(',');
  var whLoc = String(p.whLoc || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 40)
              || ('wh_' + Utilities.getUuid().slice(0, 6));
  var sort = regionsOrdered_().length;
  var bookIds = parseBookList_(p.books);
  appendRegion_({ regionId: regionId, name: name, whLoc: whLoc, sort: sort,
                  createdAt: new Date(), currencies: curs.join(','), books: bookIds.join(','),
                  bookOrder: order,
                  key: '', closedAt: '', seasonId: activeSeasonId_() });

  // Prices for the new region, if supplied: { bookId: { CUR: amount } }
  savePrices_(regionId, p.prices || {});
  markDirtyAll_();
  return regionId;
}

function doEditRegion(p) {
  var regionId = String(p.regionId || '');
  var r = regionById_(regionId);
  if (!r) throw new Error('That region no longer exists.');
  var name = String(p.name || '').trim();
  if (!name) throw new Error('Give the region a name.');
  var curs = parseCurList_(p.currencies);

  var bookIds = (p.books === undefined) ? null : parseBookList_(p.books);
  var rSet = { name: name, currencies: curs.join(',') };
  if (bookIds) rSet.books = bookIds.join(',');
  dbUpdate_('_regions', { regionId: regionId }, rSet);
  if (p.prices) savePrices_(regionId, p.prices);
  markDirtyAll_();
}

/* Switch existing titles on for a region — what ticking them in Edit region
   does, and nothing else: names, currencies and prices are left alone, so the
   title picks up whatever price the region already has for it. A region whose
   list is blank already carries every title, so there is nothing to add. */
/* Make sure the region holding this place carries the title (b218). A region
   that has never narrowed its list already carries everything; a consignment
   title stays with its own group's region. */
function offerTitleInRegion_(loc, bookId) {
  var regionId = regionOfLoc_(loc);
  var book = bookById_(bookId);
  if (!regionId || !book || book.partnerId) return;
  var reg = regionById_(regionId);
  if (!reg || !reg.books || !reg.books.length || reg.books.indexOf(bookId) >= 0) return;
  doRegionAddBooks({ regionId: regionId, bookIds: bookId });
}

function doRegionAddBooks(p) {
  var regionId = String(p.regionId || '');
  if (!regionById_(regionId)) throw new Error('That region no longer exists.');
  var add = parseBookList_(p.bookIds).filter(function (id) { return bookById_(id); });
  if (!add.length) return;
  if (dbCols_('_regions').indexOf('books') < 0) return;
  dbUpdate_('_regions', { regionId: regionId }, function (row) {
    var have = parseBookList_(row.books);
    if (!have.length) return {};                    // blank = every title already
    add.forEach(function (id) { if (have.indexOf(id) < 0) have.push(id); });
    return { books: have.join(',') };
  });
  markDirtyRegions_([regionId]);
}

/* Delete a whole region: its warehouse, its events, and every record attached to
   them. This is the most destructive action in the app, so it is deliberately
   hard to trigger by accident:
     • the exact region name must be typed back,
     • the last remaining region can never be deleted,
     • leftover physical books can be moved to another region rather than
       vanishing, because the books still exist even if the record doesn't.   */
function doDeleteRegion(p) {
  var regionId = String(p.regionId || '');
  if (regionId === HQ_REGION) throw new Error('Earthly HQ is always there; it cannot be deleted.');
  var reg = regionById_(regionId);
  if (!reg) throw new Error('That region no longer exists.');

  var all = regionsOrdered_();
  // A season being deleted takes its regions with it, including the last one.
  if (all.length <= 1 && String(p.force) !== 'true' && p.force !== true) {
    throw new Error('This is the only region — the tour needs at least one.');
  }

  if (String(p.confirmName || '').trim().toLowerCase() !== reg.name.trim().toLowerCase()) {
    throw new Error('Type the region name exactly to confirm.');
  }

  var locs = locsInRegion_(regionId);
  var isMine = {}; locs.forEach(function (l) { isMine[l] = true; });

  // Optionally hand the remaining physical stock to another region first.
  var moveTo = String(p.moveStockTo || '');
  var map = loadInvMap_();
  if (moveTo) {
    var target = regionById_(moveTo);
    if (!target || !target.whLoc) throw new Error('Pick a region to move the books to.');
    if (moveTo === regionId) throw new Error('Pick a different region to move the books to.');
    // Books still on their way to or from it go to the chosen region as well.
    var moving = locs.concat(shipmentRows_().filter(function (x) {
      return (String(x.fromRegion) === regionId || String(x.toRegion) === regionId) && String(x.status) !== 'ARRIVED';
    }).map(function (x) { return String(x.shipId); }));
    allBooks_().forEach(function (b) {
      var total = 0;
      moving.forEach(function (l) {
        var q = getQty_(map, l, b.id);
        if (q > 0) { total += q; setQty_(map, l, b.id, 0); }
      });
      if (total > 0) {
        addQty_(map, target.whLoc, b.id, total);
        // Record against the region NAME, not its location id: the id is about to
        // be purged, and a rescue of real books must leave a trace that survives.
        stockMoveAppend_({ kind: 'EXTERNAL', fromLoc: reg.name, toLoc: target.whLoc,
          bookId: b.id, qty: total, note: 'Region "' + reg.name + '" closed' });
      }
    });
    saveInvMap_(map);
  }
  purgeRegions_([regionId]);
  /* Only the season roll-up and wherever the stock went need rebuilding. Asking
     for the whole tour meant deleting one region rewrote every other region's
     file as well, which is what made it slow. */
  markDirtyRegions_(p.moveStockTo ? [String(p.moveStockTo)] : []);
}

/* Remove regions and EVERYTHING that belongs to them, in one pass per table.

   Its warehouse, events and devotees' shelves, and every book on them; books in
   transit to or from it (they were on their way to a place that no longer
   exists); its sales, cash, costs, change, stock movements, contacts, prices,
   consignment groups and their payouts. Deleting a season used to do this one
   region at a time, deleting rows one by one — minutes of work — and it left
   the books in transit, the devotees and the costs behind, which is why a
   deleted test season's shipments still showed at Earthly HQ. Works from ids
   alone, so it also sweeps up after regions deleted before it existed. */
function purgeRegions_(regionIds) {
  var gone = {}; (regionIds || []).forEach(function (id) { if (id && id !== HQ_REGION) gone[String(id)] = 1; });
  if (!Object.keys(gone).length) return 0;
  var loc = {};                         // every place that goes with them
  objectsOf_('_regions').forEach(function (r) { if (gone[String(r.regionId)] && r.whLoc) loc[String(r.whLoc)] = 1; });
  objectsOf_('_events').forEach(function (e) { if (gone[String(e.regionId || '')]) loc[String(e.eventId)] = 1; });
  objectsOf_('_holders').forEach(function (h) { if (gone[String(h.regionId || '')]) loc[String(h.holderId)] = 1; });
  var ships = {};
  shipmentRows_().forEach(function (x) {
    if (gone[String(x.fromRegion || '')] || gone[String(x.toRegion || '')] || loc[String(x.toLoc || '')]) {
      ships[String(x.shipId)] = 1; loc[String(x.shipId)] = 1;
    }
  });
  var partners = {};
  objectsOf_('_partners').forEach(function (pt) { if (gone[String(pt.regionId || '')]) partners[String(pt.partnerId)] = 1; });
  var here = function (v) { return !!loc[String(v || '')]; };

  dbDelete_('_inventory', function (r) { return here(r.location); });
  if (dbHas_('_sales')) dbDelete_('_sales', function (r) { return here(r.location); });
  if (dbHas_('_cash')) dbDelete_('_cash', function (c) { return here(c.fromAcct) || here(c.toAcct); });
  flushStockMoves_();
  dbDelete_('_stockmoves', function (m) { return here(m.fromLoc) || here(m.toLoc); });
  dbDelete_('_costs', function (c) { return here(c.location) || !!partners[String(c.partnerId || '')]; });
  dbDelete_('_change', function (c) { return here(c.loc); });
  dbDelete_('_org', function (r) { return here(r.scope) || !!gone[String(r.scope || '')]; });
  dbDelete_('_prices', function (r) { return !!gone[String(r.regionId || '')]; });
  dbDelete_('_payouts', function (r) { return !!partners[String(r.partnerId || '')]; });
  dbDelete_('_partners', function (r) { return !!partners[String(r.partnerId)]; });
  dbDelete_('_holders', function (r) { return !!gone[String(r.regionId || '')]; });
  dbDelete_('_shipments', function (r) { return !!ships[String(r.shipId)]; });
  dbDelete_('_events', function (e) { return !!gone[String(e.regionId || '')]; });
  dbDelete_('_regions', function (r) { return !!gone[String(r.regionId)]; });

  // Forget their spreadsheets and half-finished closings.
  Object.keys(gone).forEach(function (id) {
    setMeta_('regionSheetId:' + id, '');
    propDel_(CLOSE_DRAFT_PREFIX + 'region:' + id);
  });
  Object.keys(partners).forEach(function (id) { setMeta_('partnerSheetId:' + id, ''); });
  Object.keys(loc).forEach(function (l) { propDel_(CLOSE_DRAFT_PREFIX + 'event:' + l); });
  _priceMemo = null;
  return Object.keys(gone).length;
}

/* Records that still point at a region that no longer exists — left behind by
   deletions before purgeRegions_ — are removed. Cheap when there are none. */
function purgeOrphans_() {
  var live = {};
  objectsOf_('_regions').forEach(function (r) { live[String(r.regionId)] = 1; });
  var dead = {};
  // (OUTSIDE is not a region: books from beyond the tour, e.g. a printer.)
  var check = function (id) { id = String(id || ''); if (id && id !== OUTSIDE_ORIGIN && !live[id]) dead[id] = 1; };
  shipmentRows_().forEach(function (x) { check(x.fromRegion); check(x.toRegion); });
  objectsOf_('_events').forEach(function (e) { check(e.regionId); });
  objectsOf_('_holders').forEach(function (h) { check(h.regionId); });
  objectsOf_('_partners').forEach(function (pt) { check(pt.regionId); });
  var ids = Object.keys(dead);
  if (ids.length) purgeRegions_(ids);
  // Books left on a shipment whose record is gone (a season deleted before b200).
  var stray = strayShipLocs_();
  var n = Object.keys(stray).length ? dbDelete_('_inventory', function (r) { return !!stray[String(r.location)]; }) : 0;
  if (!ids.length && !n) return 0;
  cacheClear_(); bumpRev_();
  return ids.length + n;
}

/* Shipment places ("sh_…") holding books with no shipment to go with them, or
   only one to or from a region that no longer exists. */
function strayShipLocs_() {
  var live = {};
  shipmentsAll_().forEach(function (x) { live[String(x.shipId)] = 1; });
  var out = {};
  objectsOf_('_inventory').forEach(function (r) {
    var l = String(r.location);
    if (/^sh_/.test(l) && !live[l]) out[l] = 1;
  });
  return out;
}

/** What deleting a region would destroy — shown to the user before they commit. */
/* Impact figures for EVERY region in one pass.

   The per-region version re-read the events, inventory and sales sheets once
   per region, so a three-region tour paid for nine full sheet reads every time
   the app fetched its state — and the app fetches its state after every save.
   One pass over each sheet, results bucketed by region. */
function regionImpacts_() {
  var out = {};
  var ofLoc = {};                       // location -> regionId
  regionsOrdered_().forEach(function (r) {
    out[r.regionId] = { events: 0, sales: 0, books: 0 };
    if (r.whLoc) ofLoc[r.whLoc] = r.regionId;
  });
  objectsOf_('_events').forEach(function (e) {
    var rid = String(e.regionId || '');
    if (!out[rid]) return;
    out[rid].events++;
    ofLoc[String(e.eventId)] = rid;
  });
  objectsOf_('_inventory').forEach(function (r) {
    var rid = ofLoc[String(r.location)];
    if (rid) out[rid].books += Number(r.qty) || 0;
  });
  objectsOf_('_sales').forEach(function (r) {
    var rid = ofLoc[String(r.location)];
    if (rid) out[rid].sales++;
  });
  return out;
}
function regionImpact_(regionId) {
  return regionImpacts_()[String(regionId)] || { events: 0, sales: 0, books: 0 };
}

/** Replace one region's price rows, leaving every other region's alone. */
/* Set the price of one or two titles without disturbing the rest.

   savePrices_ replaces a region's whole price list, which is right when the
   region editor submits every book at once — but would silently wipe every
   other title if used to price a single one. */
function doSetPrices(p) {
  var regionId = String(p.regionId || '');
  if (!regionById_(regionId)) throw new Error('Pick a region.');
  var incoming = p.prices || {};
  var rows = objectsOf_('_prices').map(function (r) {
    return { regionId: String(r.regionId), bookId: String(r.bookId),
             cur: String(r.cur), price: Number(r.price) || 0 };
  });
  Object.keys(incoming).forEach(function (bookId) {
    var row = incoming[bookId] || {};
    Object.keys(row).forEach(function (cur) {
      var amt = Number(row[cur]);
      if (isNaN(amt)) return;
      cur = String(cur).toUpperCase();
      var found = false;
      rows.forEach(function (r) {
        if (r.regionId === regionId && r.bookId === String(bookId) && r.cur === cur) {
          r.price = amt; found = true;
        }
      });
      if (!found) rows.push({ regionId: regionId, bookId: String(bookId), cur: cur, price: amt });
    });
  });
  dbSave_('_prices', rows, ['regionId','bookId','cur','price']);
  _priceMemo = null;
  markDirtyRegions_([regionId]);
}

function savePrices_(regionId, prices) {
  var kept = objectsOf_('_prices')
    .filter(function (r) { return String(r.regionId || '') !== String(regionId); })
    .map(function (r) {
      return { regionId: String(r.regionId), bookId: String(r.bookId),
               cur: String(r.cur), price: Number(r.price) || 0 };
    });
  var mine = [];
  Object.keys(prices || {}).forEach(function (bookId) {
    var row = prices[bookId] || {};
    Object.keys(row).forEach(function (cur) {
      var amt = Number(row[cur]);
      if (isNaN(amt)) return;
      mine.push({ regionId: String(regionId), bookId: String(bookId),
                  cur: String(cur).toUpperCase(), price: amt });
    });
  });
  dbSave_('_prices', kept.concat(mine), ['regionId','bookId','cur','price']);
  _priceMemo = null;
}

function doSetWarehouseName(p) {
  var name = String(p.name || '').trim();
  if (!name) throw new Error('Enter a warehouse name.');
  setMeta_('warehouseName', name);
  markDirtyAll_();
}

/** Absolute counts: "this location now holds exactly N of each." */
/* Shared advisory check for anything that reduces warehouse stock. */
function warnPreorders_(p, loc, items, afterFn, verbs) {
  if (p.override || !isRegionWarehouse_(loc)) return;
  var rmap = reservedMap_(objectsOf_('_sales'));
  var warnings = [];
  (items || []).forEach(function (it) {
    if (!bookById_(String(it.bookId))) return;
    var why = breaksPreorders_(String(it.bookId), afterFn(it), rmap, loc);
    if (why) warnings.push(why);
  });
  if (warnings.length) {
    var one = warnings.length === 1;
    throw new Error('There are currently pre-orders for ' + (one ? 'this book' : 'these books') +
      ' that you would no longer be able to fulfill if you ' + (one ? verbs[0] : verbs[1]) + '. ' +
      warnings.join(' '));
  }
}

function doSetStockBulk(p) {
  var loc = placeOf_(p.location);
  var items = p.items || [];
  var map = loadInvMap_();

  warnPreorders_(p, loc, items, function (it) {
    return Math.max(0, Math.round(Number(it.qty)));
  }, ['set this count', 'set these counts']);
  items.forEach(function (it) {
    var b = bookById_(String(it.bookId));
    if (!b) return;
    var before = getQty_(map, loc, b.id);
    var after = Math.max(0, Math.round(Number(it.qty)));
    setQty_(map, loc, b.id, after);
    stockMoveAppend_({ kind: 'ADJUST', toLoc: loc, bookId: b.id, qty: after - before,
      note: p.note || ('Set to ' + after), toBefore: before, toAfter: after });
  });
  saveInvMap_(map);
  markDirty_(loc);
}

/** Relative counts: "add 12 to what's already there" (negative to remove). */
function doAdjustStockBulk(p) {
  var loc = placeOf_(p.location);
  var items = p.items || [];
  var map = loadInvMap_();

  // Validate the whole batch before touching anything.
  items.forEach(function (it) {
    var b = bookById_(String(it.bookId));
    if (!b) return;
    var delta = Math.round(Number(it.delta) || 0);
    if (delta < 0 && getQty_(map, loc, b.id) + delta < 0) {
      throw new Error('Cannot remove ' + Math.abs(delta) + ' × ' + b.name +
        ' — only ' + getQty_(map, loc, b.id) + ' on hand at ' + locLabel_(loc) + '.');
    }
  });

  warnPreorders_(p, loc, items, function (it) {
    return getQty_(map, loc, String(it.bookId)) + Math.round(Number(it.delta) || 0);
  }, ['remove it', 'remove them']);

  var changed = false;
  items.forEach(function (it) {
    var b = bookById_(String(it.bookId));
    if (!b) return;
    var delta = Math.round(Number(it.delta) || 0);
    if (!delta) return;
    var tB = getQty_(map, loc, b.id);
    addQty_(map, loc, b.id, delta);
    stockMoveAppend_({ id: p.movePrefix ? (p.movePrefix + '_' + b.id) : '',
      kind: 'ADJUST', toLoc: loc, bookId: b.id, qty: delta, note: p.note,
      toBefore: tB, toAfter: getQty_(map, loc, b.id) });
    changed = true;
  });
  if (!changed) throw new Error('Nothing to change — enter at least one amount.');
  saveInvMap_(map);
  markDirty_(loc);
}

function doSell(p) {
  /* Already recorded? A save can be sent twice — a retry, or a page closed
     before the reply arrived and re-sent on reopening. The sale's own name
     tells us, however much later it comes, so it is never recorded twice. */
  if (p.saleId && (saleIdTaken_(String(p.saleId)) ||
      (!_rebuilding && isDeleted_(String(p.saleId))))) return;
  var loc = placeOf_(p.location);
  var bookId = String(p.bookId);
  var isPreorder = !!p.isPreorder;
  var book = bookById_(bookId);
  if (!book) throw new Error('Unknown book.');

  if (!isPreorder) {
    var map = loadInvMap_();
    var rmap = reservedMap_(objectsOf_('_sales'));
    var onHand = getQty_(map, loc, bookId);
    var held = getReserved_(rmap, loc, bookId);
    // Server-side guard. The page's copy of stock can be up to a poll old, so
    // two devices could both believe they hold the last copy.
    // Physical stock is absolute — you cannot sell a book that is not there.
    if (onHand <= 0) {
      throw new Error('No copies of ' + book.name + ' left at ' + locLabel_(loc) +
        '. Someone else may have just sold it — refresh to see current stock.');
    }
    // Pre-order holds are advisory. Refuse once, with the reason, so that a page
    // which has not shown the warning cannot quietly break a promise.
    if (!p.override && isRegionWarehouse_(loc) && held > 0) {
      var why = breaksPreorders_(bookId, onHand - 1, rmap, loc);
      if (why) {
        throw new Error('There are currently pre-orders for this book that you would no longer ' +
          'be able to fulfill if you sell it. ' + why);
      }
    }
    addQty_(map, loc, bookId, -1);
    saveInvMap_(map);
  }

  /* A pre-order for a title this region does not carry (b218: "Pre-Orders
     (Unlisted Titles)" offers the whole catalogue) switches it on here, as
     ordering a hidden title puts it back on the shelf: someone here wants it,
     so it belongs on the region's list, its shelf, its totals and its sheet.
     Part of the sale itself, so a sales link may do it too. */
  if (isPreorder) offerTitleInRegion_(loc, bookId);

  appendSale_({
    saleId: p.saleId,               // the app's own name for it, if it gave one
    soldBy: p.by,
    changeamt: p.changeamt, changecur: p.changecur,
    location: loc,
    type: isPreorder ? 'PREORDER' : 'SALE',
    bookId: bookId,
    qty: 1,
    legs: p.legs || [],
    pending: !!p.pending,
    dueamt: p.dueamt, duecur: p.duecur,
    name: p.name, phone: p.phone, comments: p.comments,
    ts: p.ts,
    usdActual: p.usdActual,
    // Another region asked to deliver it — one that exists, is not this one, and has a copy.
    fulfilBy: (isPreorder && p.fulfilBy) ? checkCanFulfill_(String(p.fulfilBy), bookId, loc) : ''
  });
  markDirty_(loc);
}

/**
 * Several books bought together in one transaction.
 *
 * On disk this is genuinely several sales — one row per book, so every existing
 * consumer (sold counts, stock, the sheet's per-book logs) works untouched. What
 * ties them together is a shared `bundle` id; the app groups rows sharing it into
 * a single "N Books" line, and the sheet stamps each row's comment "N book sale".
 *
 * The one payment is split across the books in proportion to their list price,
 * with any rounding remainder landing on the first book, so the parts always sum
 * back to exactly what was taken.
 */
function doSellBundle(p) {
  // Already recorded under this name (a resend)? Then there is nothing to do.
  if (!p.isEdit && p.keepBundleId &&
      (bundleIdTaken_(String(p.keepBundleId)) ||
       (!_rebuilding && isDeleted_(String(p.keepBundleId))))) return;
  var loc = placeOf_(p.location);

  // New format: items = [{bookId, pre}] — one entry per copy, each flagged buy
  // or pre-order, so a single transaction can mix the two. The old bookIds/
  // isPreorder format is still accepted for safety.
  var items = p.items;
  if (!items || !items.length) {
    items = (p.bookIds || []).map(function (id) {
      return { bookId: String(id), pre: !!p.isPreorder };
    });
  }
  items = items.map(function (it) {
    var b = bookById_(String(it.bookId));
    if (!b) throw new Error('Unknown book in the selection.');
    return { bookId: b.id, pre: !!it.pre, book: b };
  });
  if (items.length < 2) throw new Error('A multiple-book transaction needs at least two books.');

  // --- stock checks up front (only the BUY copies draw down stock) ---
  var map = loadInvMap_();
  var rmap = reservedMap_(objectsOf_('_sales'));
  var need = {};
  items.forEach(function (it) { if (!it.pre) need[it.bookId] = (need[it.bookId] || 0) + 1; });
  Object.keys(need).forEach(function (id) {
    var b = bookById_(id);
    var onHand = getQty_(map, loc, id);
    if (onHand < need[id]) {
      throw new Error('Only ' + onHand + ' \u00d7 ' + b.name + ' at ' + locLabel_(loc) +
        ', but the sale needs ' + need[id] + '. Nothing was recorded.');
    }
    if (!p.override && isRegionWarehouse_(loc)) {
      var why = breaksPreorders_(id, onHand - need[id], rmap, loc);
      if (why) {
        throw new Error('There are currently pre-orders for these books that you would no ' +
          'longer be able to fulfill if you sell them. ' + why);
      }
    }
  });
  items.forEach(function (it) { if (!it.pre) addQty_(map, loc, it.bookId, -1); });
  saveInvMap_(map);

  /* --- split the one payment across every copy ---

     Proportional to what each book costs IN THE CURRENCY PAID. Weighting by the
     USD figure gave each title the wrong share whenever local prices were not
     in the same proportion: the transaction total came out right, but the money
     credited to each title did not. */
  var legs = normalizeLegs_(p.legs || []);
  var payCur = (legs[0] && legs[0].cur) || 'USD';
  var regionForPrice = regionOfLoc_(loc);
  var weights = items.map(function (it) {
    return Number(priceFor_(regionForPrice, it.book.id, payCur)) || Number(it.book.usd) || 1;
  });
  var wSum = weights.reduce(function (a, c) { return a + c; }, 0) || items.length;
  var perItem = items.map(function () { return []; });
  legs.forEach(function (leg) {
    var running = 0;
    for (var i = 1; i < items.length; i++) {
      var share = Math.round((leg.amt * weights[i] / wSum) * 100) / 100;
      perItem[i].push({ type: leg.type, cur: leg.cur, amt: share });
      running += share;
    }
    perItem[0].push({ type: leg.type, cur: leg.cur, amt: Math.round((leg.amt - running) * 100) / 100 });
  });

  /* An edit keeps the transaction's own id. Minting a new one on every edit meant
     the id on screen went stale the moment the edit landed — open Edit again
     before the screen caught up and the server no longer recognized it ("no
     longer in the log"), which is why the second attempt always worked. */
  var bundleId = String(p.keepBundleId || '') || ('B' + Utilities.getUuid().slice(0, 7));
  /* The app now names a new transaction itself, so that what it shows and what
     is stored carry the same id from the first moment. The one thing that must
     never happen is two sales sharing an id — that would fuse them — so a
     fresh sale naming an id already in use is given a new one instead. An edit
     has already removed its own rows, so it is never caught by this. */

  var n = items.length;
  var noteBase = n + ' book sale';   // one label for the whole transaction
  var usdParts = splitUsdActual_(usdActualIn_(p.usdActual), perItem);

  items.forEach(function (it, i) {
    appendSale_({
      // Members are named from their transaction, so the app knows each one's
      // id without waiting to be told.
      saleId: bundleId + '_' + i,
      soldBy: p.by,
      // Change owed belongs to the transaction, not to each book in it, so it
      // rides on the first line and the bundle reports it once.
      changeamt: i === 0 ? p.changeamt : 0,
      changecur: i === 0 ? p.changecur : '',
      location: loc,
      type: it.pre ? 'PREORDER' : 'SALE',
      bookId: it.bookId,
      qty: 1,
      ts: p.ts,                       // preserved across a bundle edit; undefined = now
      legs: perItem[i],
      pending: !!p.pending,
      dueamt: i === 0 ? p.dueamt : 0,
      duecur: i === 0 ? p.duecur : '',
      name: p.name, phone: p.phone,
      comments: p.comments ? (noteBase + ' \u00b7 ' + p.comments) : noteBase,
      bundle: bundleId,
      usdActual: usdParts[i]
    });
  });
  markDirty_(loc);
}

/* Fan a bundle action out over its member rows. Each member is a normal sale,
   so these just reuse the single-row handlers, then rebuild once. */
/** Is this transaction id already in use? (Unlike bundleMembers_, never throws.) */
function bundleIdTaken_(id) {
  var rows = objectsOf_('_sales');
  for (var i = 0; i < rows.length; i++) if (String(rows[i].bundle) === String(id)) return true;
  return false;
}

function bundleMembers_(bundle) {
  var out = [];
  objectsOf_('_sales').forEach(function (s) { if (String(s.bundle) === String(bundle)) out.push(s); });
  if (!out.length) throw new Error('That transaction is no longer in the log.');
  return out;
}

/* Editing a multi-book transaction: throw the old rows away (returning their
   bought copies to stock) and write the new selection. Same net effect as delete
   + re-add, but in one action so the sheet only rebuilds once. */
function doEditBundle(p) {
  var members = bundleMembers_(p.bundle);
  if (!members.length) throw new Error('That transaction is no longer in the log.');

  // Keep the original transaction time — the answer to "when did I sell this?"
  // must survive an edit. The earliest member's timestamp is the sale time.
  var origTs = members.reduce(function (min, m) {
    var t = m.ts ? new Date(m.ts).getTime() : Infinity;
    return t < min ? t : min;
  }, Infinity);
  if (origTs !== Infinity && !p.ts) p.ts = new Date(origTs);

  /* Check the replacement BEFORE destroying the original.

     This deleted the old members first and then built the new ones. Anything
     that made the rebuild fail — editing down to a single book, a stock
     shortfall, a bad amount — left the original already deleted and nothing put
     back. The transaction simply vanished, and the error message gave no hint
     that it had just been destroyed. Nothing is removed until the replacement
     is known to be sound. */
  /* What this transaction is holding: those copies come back when its members
     are deleted, so they are available to the replacement. */
  var releases = {};
  members.forEach(function (m) {
    var back = restoreLocOf_(m);
    if (!back) return;
    if (back !== String(p.location || '')) return;   // freed somewhere else, no help here
    releases[String(m.bookId)] = (releases[String(m.bookId)] || 0) + 1;
  });
  validateBundle_(p, releases);

  /* The transaction keeps its own id through an edit.

     Every edit used to mint a new one. The screen still held the old id until
     it next refreshed, so editing again in that window aimed at an id that no
     longer existed: "that transaction is no longer in the log", then success on
     the second try once the screen had caught up. */
  p.keepBundleId = String(p.bundle);
  p.isEdit = true;
  // The dollars received survive an edit that does not speak to them.
  if (p.usdActual === undefined) {
    var had = members.filter(function (m) { return usdActualIn_(m.usdActual) !== ''; });
    p.usdActual = had.length ? had.reduce(function (t, m) { return t + (Number(m.usdActual) || 0); }, 0) : '';
  }

  _rebuilding = true;                         // these deletions are part of the edit
  try {
    members.forEach(function (m) { doDeleteSale({ saleId: String(m.saleId) }); });
  } finally { _rebuilding = false; }
  p.keepBundleId = String(p.bundle);          // the same transaction, the same id
  try {
    _rebuilding = true;                       // and so is writing them back
    doSellBundle(p);
  } catch (err) {
    /* The rebuild failed after the delete despite the check. Put the original
       back rather than leaving a hole in the record. */
    restoreSales_(members);
    throw new Error(err && err.message
      ? err.message + ' — the original transaction has been left as it was.'
      : 'That edit could not be applied; the original has been left as it was.');
  } finally {
    _rebuilding = false;
  }
}

/** The same guards doSellBundle applies, run before anything is deleted. */
function validateBundle_(p, releases) {
  var items = p.items || [];
  if (items.length < 2) throw new Error('A multiple-book transaction needs at least two books.');
  items.forEach(function (it) {
    if (!it || !it.bookId || !bookById_(String(it.bookId)))
      throw new Error('One of those titles is no longer in the catalog.');
  });

  /* Enough books to do it? Checked HERE, before the original is touched.

     Without this the original was deleted first and the rebuild then failed on
     a shortfall — and the copies the delete had put back on the shelf stayed
     there, so every failed attempt invented a book that does not exist. */
  if (String(p.override) === 'true') return;         // an explicit override still wins
  var loc = String(p.location || '');
  if (!loc) return;
  var map = loadInvMap_();
  var need = {};
  items.forEach(function (it) {
    if (it.pre) return;                              // a pre-order takes nothing off the shelf
    var id = String(it.bookId);
    need[id] = (need[id] || 0) + 1;
  });
  // An edit frees the books its own transaction is holding, so they count as available.
  var freed = releases || {};
  Object.keys(need).forEach(function (id) {
    var have = getQty_(map, loc, id) + (freed[id] || 0);
    if (need[id] > have) {
      var b = bookById_(id);
      throw new Error('Only ' + have + ' × ' + (b ? b.name : id) + ' available at ' +
        locLabel_(loc) + ', but the transaction needs ' + need[id] + '.');
    }
  });
}

/** Write a set of previously-deleted sale rows back exactly as they were. */
function restoreSales_(rows) {
  if (!rows || !rows.length) return;
  dbAddCols_('_sales', SALES_HEADERS);
  dbInsert_('_sales', rows);
  /* And take the copies back off the shelf.

     Deleting a sale puts its copy back; restoring the sale must take it off
     again, or a failed edit leaves a book on the shelf that was never there.
     That is how one Russian Adventures became two, and then four. */
  var map = loadInvMap_(), touched = false;
  rows.forEach(function (r) {
    var from = restoreLocOf_(r);
    if (!from) return;
    addQty_(map, from, String(r.bookId), -1);
    touched = true;
    markDirty_(from);
  });
  if (touched) saveInvMap_(map);
  sheetMemoClear_();
  markDirtyAll_();
}

function doDeleteBundle(p) {
  var members = bundleMembers_(p.bundle);
  members.forEach(function (m) { doDeleteSale({ saleId: String(m.saleId) }); });
}

function doMarkPaidBundle(p) {
  var members = bundleMembers_(p.bundle);
  members.forEach(function (m) { doMarkPaid({ saleId: String(m.saleId) }); });
}

function doMarkDeliveredBundle(p) {
  var members = bundleMembers_(p.bundle);
  // Deliver each undelivered pre-order in the bundle from the chosen source.
  members.forEach(function (m) {
    if (String(m.type) === 'PREORDER' && !isDelivered_(m)) {
      doMarkDelivered({ saleId: String(m.saleId), fromStock: !!p.fromStock, fromLoc: p.fromLoc });
    }
  });
}

function doDonate(p) {
  if (p.saleId && (saleIdTaken_(String(p.saleId)) ||
      (!_rebuilding && isDeleted_(String(p.saleId))))) return;   // already recorded
  var loc = placeOf_(p.location);
  appendSale_({
    saleId: p.saleId,               // the app's own name for it, if it gave one
    soldBy: p.by,
    changeamt: p.changeamt, changecur: p.changecur,
    location: loc, type: 'DONATION', bookId: '', qty: 0,
    legs: p.legs || [], pending: !!p.pending,
    dueamt: p.dueamt, duecur: p.duecur,
    name: p.name, phone: p.phone, comments: p.comments,
    ts: p.ts
  });
  markDirty_(loc);
}

/** Is this sale id already in the log? */
function saleIdTaken_(id) {
  var rows = objectsOf_('_sales');
  for (var i = 0; i < rows.length; i++) if (String(rows[i].saleId) === String(id)) return true;
  return false;
}

function appendSale_(o) {
  sheetMemoClear_();
  var legs = normalizeLegs_(o.legs);
  var pending = !!o.pending;
  /* The app may name a sale itself, so the id on screen and the id stored are
     the same from the first moment — which is what lets a sale be edited
     before its save has even come back. A supplied id is only adopted if it is
     free: two sales must never share one. */
  var wanted = String(o.saleId || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 40);
  if (wanted && !_rebuilding && isDeleted_(wanted)) return wanted;   // deleted on purpose
  if (wanted && saleIdTaken_(wanted)) wanted = '';
  var row = {
    saleId: wanted || Utilities.getUuid().slice(0, 8),
    ts: o.ts ? new Date(o.ts) : new Date(),
    // Who recorded it. Self-declared on a share link, so it's a trail to follow
    // up, not proof — but it answers "who should I ask about this?".
    soldBy: String(o.soldBy || '').trim().slice(0, 40),
    /* The reverse of a pending payment: they handed over more than the price
       and we could not break it, so we owe them the difference. */
    changeamt: Number(o.changeamt) || 0,
    changecur: String(o.changecur || ''),
    location: o.location,
    type: o.type,
    bookId: o.bookId || '',
    qty: o.qty || 0,
    p1type: legs[0] ? legs[0].type : '',
    p1cur:  legs[0] ? legs[0].cur  : '',
    p1amt:  legs[0] ? legs[0].amt  : 0,
    p2type: legs[1] ? legs[1].type : '',
    p2cur:  legs[1] ? legs[1].cur  : '',
    p2amt:  legs[1] ? legs[1].amt  : 0,
    pmore:  pmoreJson_(legs),
    pending: pending,
    paid: !pending && !(Number(o.dueamt) > 0),
    delivered: o.type === 'PREORDER' ? false : true,
    dsource: '',
    dueamt: pending ? 0 : Math.max(0, Number(o.dueamt) || 0),
    duecur: pending ? '' : String(o.duecur || ''),
    name: o.name || '', phone: o.phone || '', comments: o.comments || '',
    bundle: o.bundle || '',
    fulfilBy: String(o.fulfilBy || ''), fulfilLoc: '', fulfilAt: '',
    usdActual: usdActualIn_(o.usdActual)
  };
  /* Written by position, so the sheet must carry every column first. */
  dbAddCols_('_sales', SALES_HEADERS);
  dbInsert_('_sales', row);
  return row.saleId;
}

/* Payments past the second, as stored in the pmore column. */
function pmoreJson_(legs) { return legs.length > 2 ? JSON.stringify(legs.slice(2)) : ''; }
function pmoreRead_(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  try { var a = JSON.parse(String(v)); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

function normalizeLegs_(legs) {
  var out = [];
  (legs || []).forEach(function (l) {
    if (!l) return;
    var t = String(l.type || '');
    if (t === '') return;
    var amt = Number(l.amt);
    if (isNaN(amt)) amt = 0;
    out.push({ type: t, cur: String(l.cur || 'USD'), amt: amt });
  });
  if (!out.length) out.push({ type: 'Cash', cur: 'USD', amt: 0 });
  return out.slice(0, 8);
}

/* ---- Payment types per place --------------------------------------------

   The tour has a default list, a region may narrow or widen it, and a single
   event may do the same. Blank means "use whatever the level above offers", so
   nothing has to be set up in advance — you only record a difference when there
   IS one. That matters at a festival where a card machine turns up unannounced:
   you add Card there and then, without touching anywhere else. */
function parsePayList_(v) {
  return String(v || '').split(',').map(function (x) { return x.trim(); })
    .filter(function (x) { return x; });
}

/** What can be taken at this place, following the chain upwards. */
function payTypesFor_(loc) {
  var ev = eventById_(String(loc));
  if (ev) {
    var own = parsePayList_(ev.payTypes);
    if (own.length) return own;
  }
  var regionId = ev ? String(ev.regionId) : regionOfLoc_(String(loc));
  var reg = regionById_(regionId);
  if (reg) {
    var rOwn = parsePayList_(reg.payTypes);
    if (rOwn.length) return rOwn;
  }
  return PAY_TYPES.slice();
}

/* The currency each payment type always arrives in, across the whole tour —
   Zelle in dollars, UPI in rupees. A type with a currency is a digital
   account; one without (cash, card) is not. Only for a dollar account is the
   amount actually received worth entering: that is what the app offers
   "$ Received" for. Kept as { type: 'USD' | ... | 'none' }; 'none' overrides the
   app's own starting guesses (see PAY_CUR_DEFAULTS in index.html). */
function payTypeCurrencies_() {
  try { return JSON.parse(String(getMeta_('payTypeCur', '') || '{}')) || {}; } catch (e) { return {}; }
}
function doSetPayTypeCurrency(p) {
  var type = String(p.type || '').trim().slice(0, 40);
  if (!type) throw new Error('Which payment type?');
  var cur = String(p.cur || '').trim().toUpperCase();
  if (cur && cur !== 'NONE' && !/^[A-Z]{3}$/.test(cur)) throw new Error('Choose a currency.');
  var map = payTypeCurrencies_();
  map[type] = cur && cur !== 'NONE' ? cur : 'none';
  setMeta_('payTypeCur', JSON.stringify(map));
  return map;
}

function doSetPayTypes(p) {
  var kind = String(p.kind || '');
  var id = String(p.id || '');
  var list = (p.types || []).map(function (x) { return String(x).trim(); })
    .filter(function (x) { return x; });
  /* The order given is the order kept.

     This used to re-sort the list into the tour's own order, so arranging the
     payment types in a region silently came back exactly as it was. */
  var seen = {};
  var ordered = list.filter(function (t) {
    var k = t.toLowerCase();
    if (seen[k]) return false;
    seen[k] = 1;
    return true;
  });
  var value = ordered.join(',');

  var sheetName = (kind === 'event') ? '_events' : '_regions';
  var idField   = (kind === 'event') ? 'eventId' : 'regionId';
  if (dbCols_(sheetName).indexOf('payTypes') < 0) {
    dbAddCols_(sheetName, sheetName === '_events'
      ? ['eventId','name','createdAt','regionId','key','closedAt','sort','payTypes']
      : REGION_HEADERS);
  }
  var match = {}; match[idField] = id;
  if (!dbUpdate_(sheetName, match, { payTypes: value })) throw new Error('That place is no longer listed.');
  markDirtyRegions_([kind === 'event' ? regionOfLoc_(id) : id]);
}

/* Titles an event is not offering.

   Hidden only for selling: a hidden title can still be pre-ordered, because
   people ask for books that were never on the table. */
/* Titles a REGION does not offer. The same idea as an event's, kept on the
   region so its warehouse shelf matches what is actually sold there. */
function doSetRegionHidden(p) {
  var regionId = String(p.regionId || '');
  var reg = regionById_(regionId);
  if (!reg) throw new Error('That region is no longer listed.');
  var ids = String(p.hidden || '').split(',').map(function (x) { return String(x).trim(); })
    .filter(function (x) { return x; });
  dbAddCols_('_regions', REGION_HEADERS);
  dbUpdate_('_regions', { regionId: regionId }, { hidden: ids.join(',') });
  markDirtyAll_();
  return ids.join(',');
}

function doSetEventHidden(p) {
  var id = String(p.eventId || '');
  var ev = eventById_(id);
  if (!ev) throw new Error('That event is no longer listed.');
  var ids = String(p.hidden || '').split(',').map(function (x) { return x.trim(); })
    .filter(function (x) { return x; });
  dbAddCols_('_events', ['hidden']);
  dbUpdate_('_events', { eventId: id }, { hidden: ids.join(',') });
  markDirty_(id);
  return ids.join(',');
}

function doCreateEvent(p) {
  var name = String(p.name || '').trim();
  if (!name) throw new Error('Enter an event name.');
  // An event belongs to a region, so the same name may exist in two regions —
  // only clash-check within the region we're adding to.
  var regionId = String(p.regionId || '');
  if (!regionId) {
    var first = regionsOrdered_()[0];
    regionId = first ? first.regionId : '';
  }
  if (regionId === HQ_REGION) throw new Error('Earthly HQ has no events; it sells from its own warehouse.');
  var events = objectsOf_('_events');
  for (var i = 0; i < events.length; i++) {
    if (String(events[i].regionId || '') === regionId &&
        String(events[i].name).toLowerCase() === name.toLowerCase())
      throw new Error('An event called "' + name + '" already exists in this region.');
  }
  /* The app may name the event itself, so it can appear at once and save in
     the background — it no longer waits for the whole tour's data to come
     back, which is what made this slow enough to time out. A name already in
     use means this is the same request arriving twice. */
  var wanted = String(p.eventId || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 40);
  if (wanted) {
    for (var j = 0; j < events.length; j++) if (String(events[j].eventId) === wanted) return wanted;
  }
  var eventId = wanted || ('ev_' + Utilities.getUuid().slice(0, 6));
  dbInsert_('_events', { eventId: eventId, name: name, createdAt: new Date(), regionId: regionId });
  markDirty_(eventId);
  return eventId;
}

function doRenameEvent(p) {
  var eventId = String(p.eventId);
  var name = String(p.name || '').trim();
  if (!name) throw new Error('Enter an event name.');
  // Change only the name; every other field on the row travels untouched, so a
  // rename can't quietly discard the event's region or its share link.
  var oldName = '';
  objectsOf_('_events').forEach(function (e) { if (String(e.eventId) === eventId) oldName = String(e.name); });
  dbUpdate_('_events', { eventId: eventId }, { name: name });
  if (REPORTS_HERE_) {
    var ss = SpreadsheetApp.getActive();
    var old = ss.getSheetByName(displayTabName_(oldName));
    if (old) ss.deleteSheet(old);
  }
  markDirty_(eventId);
}

function doDeleteEvent(p) {
  var eventId = String(p.eventId);
  var ev = eventById_(eventId);
  if (!ev) throw new Error('Event not found.');

  // Books come home to THIS event's own regional warehouse.
  var evRegion = String(ev.regionId || regionOfLoc_(eventId) || '');
  var evReg = evRegion ? regionById_(evRegion) : null;
  var homeWh = evReg ? evReg.whLoc : '';
  if (!homeWh) throw new Error('That event belongs to no region, so there is nowhere to send its books.');

  var map = loadInvMap_();

  // Books sold at the event left the shelf for good, so by default they stay
  // gone and only what is left over comes home. Deleting a test event is the
  // opposite case: nothing really moved, so every copy is put back.
  if (p.restoreSold) {
    objectsOf_('_sales').forEach(function (s) {
      if (String(s.location) !== eventId) return;
      if (String(s.type) !== 'SALE' || !s.bookId) return;
      if (fromOutside_(s)) return;                       // never came off our shelves
      // A delivered pre-order was taken off the warehouse shelf; an ordinary
      // sale came off the event's table. Put each back where it came from.
      if (isDelivery_(s)) addQty_(map, homeWh, String(s.bookId), 1);
      else addQty_(map, eventId, String(s.bookId), 1);
    });
  }

  allBooks_().forEach(function (b) {
    var q = getQty_(map, eventId, b.id);
    if (q > 0) { addQty_(map, homeWh, b.id, q); setQty_(map, eventId, b.id, 0); }
  });
  saveInvMap_(map);

  // Whole rows, untouched — rebuilding them field by field is what used to wipe
  // the share links stored alongside them.
  dbDelete_('_events', { eventId: eventId });
  dbAddCols_('_sales', SALES_HEADERS);
  dbDelete_('_sales', { location: eventId });

  // The tab lives in that region's own spreadsheet.
  if (REPORTS_HERE_) try {
    var ss = evReg ? regionSpreadsheet_(evReg.regionId) : SpreadsheetApp.getActive();
    var tab = ss.getSheetByName(displayTabName_(ev.name));
    if (tab) ss.deleteSheet(tab);
  } catch (err) { /* the file may not exist yet — nothing to clean up */ }
  markDirty_(homeWh);
}

/** One trip moves many titles at once. All-or-nothing: nothing moves if any line is short. */
function doTransferBulk(p) {
  var from = String(p.from);
  var to = String(p.to);
  var items = p.items || [];
  if (from === to) throw new Error('Pick two different locations.');

  var map = loadInvMap_();
  var moves = [];
  items.forEach(function (it) {
    var b = bookById_(String(it.bookId));
    if (!b) return;
    var qty = Math.max(0, Math.round(Number(it.qty) || 0));
    if (!qty) return;
    var have = getQty_(map, from, b.id);
    if (have < qty) {
      throw new Error('Only ' + have + ' × ' + b.name + ' at ' + locLabel_(from) +
        ' — you asked for ' + qty + '. Nothing was moved.');
    }
    moves.push({ id: b.id, qty: qty });
  });
  if (!moves.length) throw new Error('Enter a quantity for at least one title.');

  // Moving stock out of the warehouse can strand pre-orders. Advisory only.
  if (!p.override && isRegionWarehouse_(from)) {
    var rmap = reservedMap_(objectsOf_('_sales'));
    var warnings = [];
    moves.forEach(function (m) {
      var why = breaksPreorders_(m.id, getQty_(map, from, m.id) - m.qty, rmap, from);
      if (why) warnings.push(why);
    });
    if (warnings.length) {
      var oneT = warnings.length === 1;
      throw new Error('There are currently pre-orders for ' + (oneT ? 'this book' : 'these books') +
        ' that you would no longer be able to fulfill if you ' +
        (oneT ? 'transfer it' : 'transfer them') + '. ' + warnings.join(' '));
    }
  }

  moves.forEach(function (m) {
    var fB = getQty_(map, from, m.id), tB = getQty_(map, to, m.id);
    addQty_(map, from, m.id, -m.qty);
    addQty_(map, to,   m.id,  m.qty);   // adds to what's already there, never resets
    stockMoveAppend_({ id: p.movePrefix ? (p.movePrefix + '_' + m.id) : '',
      kind: 'TRANSFER', fromLoc: from, toLoc: to, bookId: m.id, qty: m.qty, note: p.note,
      fromBefore: fB, fromAfter: getQty_(map, from, m.id),
      toBefore: tB,   toAfter: getQty_(map, to, m.id) });
  });
  saveInvMap_(map);
  markDirty_(from);
  markDirty_(to);
}

/* Send stock out of THIS warehouse to another warehouse outside the system, or
   receive stock back in from one — before those warehouses are connected here,
   this is just a labeled entry/exit against our own stock. Only this
   warehouse's inventory changes; there is no bucket for the other warehouse
   to add to (or subtract from) yet. */
function doTransferExternal(p) {
  var dir = String(p.direction || 'out');
  // Sending to a region that IS in this season is a real two-sided move: books
  // leave here and arrive there. "Other" still just records the departure,
  // because there's nowhere in the system for them to land yet.
  var toRegionId = String(p.toRegionId || '');
  var target = toRegionId ? regionById_(toRegionId) : null;
  var here = regionById_(regionOfLoc_(placeOf_(p.fromLoc)));
  if (!here) throw new Error('Pick which warehouse the books leave from.');
  var hereWh = here.whLoc;
  if (target && target.regionId === (here && here.regionId)) {
    throw new Error('That is this same region — pick another one.');
  }
  var label = target ? target.name : String(p.label || '').trim();
  if (!label) throw new Error("Enter the other warehouse's name.");
  var items = p.items || [];
  var map = loadInvMap_();

  var moves = [];
  items.forEach(function (it) {
    var b = bookById_(String(it.bookId));
    if (!b) return;
    var qty = Math.max(0, Math.round(Number(it.qty) || 0));
    if (!qty) return;
    if (dir === 'out') {
      var have = getQty_(map, hereWh, b.id);
      if (have < qty) {
        throw new Error('Only ' + have + ' × ' + b.name + ' at ' + locLabel_(hereWh) +
          ' — you asked to send ' + qty + '. Nothing was sent.');
      }
    }
    moves.push({ id: b.id, qty: qty });
  });
  if (!moves.length) throw new Error('Enter a quantity for at least one title.');

  // Sending stock away can strand pre-orders here. Advisory only, like a normal transfer.
  if (dir === 'out') {
    warnPreorders_(p, hereWh, moves.map(function (m) { return { bookId: m.id, delta: -m.qty }; }),
      function (it) { return getQty_(map, hereWh, it.bookId) + it.delta; },
      ['send it', 'send them']);
  }

  moves.forEach(function (m) {
    addQty_(map, hereWh, m.id, dir === 'out' ? -m.qty : m.qty);
    // Inside the season the books really land somewhere, so credit that warehouse.
    if (target) addQty_(map, target.whLoc, m.id, dir === 'out' ? m.qty : -m.qty);
    stockMoveAppend_({
      kind: target ? 'TRANSFER' : 'EXTERNAL',
      fromLoc: dir === 'out' ? hereWh : (target ? target.whLoc : label),
      toLoc:   dir === 'out' ? (target ? target.whLoc : label) : hereWh,
      bookId: m.id, qty: m.qty, note: p.note
    });
  });
  saveInvMap_(map);
  markDirty_(hereWh);
  if (target) markDirty_(target.whLoc);
}

function doDeleteSale(p) {
  var saleId = String(p.saleId);
  var target = null;
  objectsOf_('_sales').forEach(function (s) { if (String(s.saleId) === saleId) target = s; });
  // Already gone: the page's optimistic delete beat us here, or the write was
  // retried. Either way the end state is what the caller wanted, so succeed
  // quietly instead of throwing a scary error at them.
  if (!target) return;
  if (!_rebuilding) {                     // a late resend must not bring it back
    tombstone_(saleId);
    if (String(target.bundle || '')) tombstone_(String(target.bundle));
  }

  /* Put the copy back where it actually came from (restoreLocOf_):
       • sourced from outside, or by another region → nothing to restore
       • a delivered pre-order → the shelf it was taken off (was: always the
         original region's warehouse, whichever region it belonged to)
       • an ordinary sale → its own location's table */
  var restoreLoc = restoreLocOf_(target);
  if (restoreLoc) {
    var map = loadInvMap_();
    addQty_(map, restoreLoc, String(target.bookId), 1);
    saveInvMap_(map);
    if (restoreLoc !== String(target.location)) markDirty_(restoreLoc);
  }
  dbAddCols_('_sales', SALES_HEADERS);
  dbDelete_('_sales', { saleId: saleId });
  markDirty_(String(target.location));
}

function doEditSale(p) {
  var saleId = String(p.saleId);
  var old = null;
  var all = objectsOf_('_sales');
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].saleId) === saleId) { old = all[i]; break; }
  }
  if (!old) throw new Error('That sale is no longer in the log.');

  var newType = String(p.type || old.type);
  var newLoc = String(p.location || old.location);
  var newBook = (p.bookId !== undefined) ? String(p.bookId) : String(old.bookId || '');

  var oldWasPhysical = String(old.type) === 'SALE' && old.bookId;
  var newIsPhysical = newType === 'SALE' && newBook;
  if (oldWasPhysical || newIsPhysical) {
    var map = loadInvMap_();
    if (oldWasPhysical) addQty_(map, String(old.location), String(old.bookId), 1);
    if (newIsPhysical)  addQty_(map, newLoc, newBook, -1);
    saveInvMap_(map);
  }

  var legs = normalizeLegs_(p.legs || []);
  var pending = !!p.pending;
  var vals = {
    saleId: saleId,
    ts: p.ts ? new Date(p.ts) : (old.ts || new Date()),
    location: newLoc,
    type: newType,
    bookId: newType === 'DONATION' ? '' : newBook,
    qty: newType === 'DONATION' ? 0 : (Number(old.qty) || 1),
    p1type: legs[0] ? legs[0].type : '',
    p1cur:  legs[0] ? legs[0].cur  : '',
    p1amt:  legs[0] ? legs[0].amt  : 0,
    p2type: legs[1] ? legs[1].type : '',
    p2cur:  legs[1] ? legs[1].cur  : '',
    p2amt:  legs[1] ? legs[1].amt  : 0,
    pmore:  pmoreJson_(legs),
    pending: pending,
    paid: (pending || Number(p.dueamt) > 0) ? false : true,
    delivered: newType === 'PREORDER' ? isDelivered_(old) : true,
    dsource: old.dsource || '',
    dueamt: pending ? 0 : Math.max(0, Number(p.dueamt) || 0),
    duecur: pending ? '' : String(p.duecur || ''),
    name: p.name !== undefined ? p.name : old.name,
    phone: p.phone !== undefined ? p.phone : old.phone,
    comments: p.comments !== undefined ? p.comments : old.comments,
    // Who originally recorded it stays put — an edit shouldn't rewrite history.
    soldBy: old.soldBy || '',
    changeamt: p.changeamt !== undefined ? (Number(p.changeamt) || 0) : (Number(old.changeamt) || 0),
    changecur: p.changecur !== undefined ? String(p.changecur) : String(old.changecur || ''),
    usdActual: p.usdActual !== undefined ? usdActualIn_(p.usdActual) : old.usdActual
  };
  /* Written against the sheet's OWN column order, adding any it lacks. Writing
     by position here would scramble a sheet whose columns differ — the same
     fault that has cost us data before. */
  dbAddCols_('_sales', SALES_HEADERS);
  // Anything the edit does not speak to (the dollars actually received, the
  // transaction it belongs to, a request to another region) stays as it was.
  var set = {};
  Object.keys(vals).forEach(function (h) { if (vals[h] !== undefined) set[h] = vals[h]; });
  dbUpdate_('_sales', firstOnly_({ saleId: saleId }), set);

  markDirty_(String(old.location));
  if (newLoc !== String(old.location)) markDirty_(newLoc);
}

/* Handing the book over: the pre-order becomes an ordinary sale. Payment state
   is untouched — a pre-order can be delivered before it is paid, and paid
   before it is delivered, in either order.
   fromStock says where the physical copy came from. Delivered from this
   warehouse, a copy leaves the shelf. Delivered from somewhere else, stock here
   is correctly left alone — but the sale still counts, so the source is
   recorded or the numbers would look like they had drifted. */
function doMarkDelivered(p) {
  var saleId = String(p.saleId);
  var fromStock = (p.fromStock === undefined) ? true : !!p.fromStock;
  var all = objectsOf_('_sales');
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].saleId) !== saleId) continue;
    var o = all[i];
    if (String(o.type) !== 'PREORDER') throw new Error('That record is already a completed sale.');

    var loc = String(o.location), bookId = String(o.bookId);
    var book = bookById_(bookId) || { name: bookId };

    /* The copy comes off a shelf you choose — usually this region's warehouse,
       but the tour has many now, and a title may only be left in another one.
       Defaults to the home warehouse so older callers behave as before. */
    var src = String(p.fromLoc || '');
    if (fromStock) {
      if (!src) src = homeWarehouse_(loc);
      if (!src) throw new Error('Choose which shelf the copy comes from.');
      var map = loadInvMap_();
      if (getQty_(map, src, bookId) <= 0) {
        throw new Error('There are no copies of ' + book.name + ' left at ' +
          locLabel_(src) + '. Choose somewhere else, or source it from outside.');
      }
      addQty_(map, src, bookId, -1);
      saveInvMap_(map);
    }

    // The shelf is recorded, so a later delete puts the copy back on it.
    dbAddCols_('_sales', SALES_HEADERS);
    dbUpdate_('_sales', firstOnly_({ saleId: saleId }),
      { type: 'SALE', delivered: true, dsource: fromStock ? DSRC_WAREHOUSE : DSRC_OUTSIDE,
        dfrom: fromStock ? src : '' });
    markDirty_(loc);
    if (fromStock && src && src !== loc) markDirty_(src);
    return;
  }
  throw new Error('That pre-order is no longer in the log.');
}

/* Settling up. For a fully pending sale the legs already say what was owed, so
   clearing the flag is enough. For a partial, the outstanding amount has now
   arrived and has to join the money already banked, or collections would stay
   short by the balance. */
/* Change handed back, so the debt is cleared. */
function doGiveChange(p) {
  var saleId = String(p.saleId);
  dbAddCols_('_sales', SALES_HEADERS);
  if (dbCols_('_sales').indexOf('changeamt') < 0) return;   // nothing to clear
  var found = dbUpdate_('_sales', { saleId: saleId }, { changeamt: 0, changecur: '' });
  if (!found) return;                       // already cleared; nothing to do
  markDirtyRegions_([regionOfLoc_(String(p.location || ''))]);
}

function doMarkPaid(p) {
  var saleId = String(p.saleId);
  var all = objectsOf_('_sales');
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].saleId) !== saleId) continue;
    var o = all[i];
    var set = {};

    var due = dueAmt_(o), dueCur = dueCur_(o);
    if (!pendingFlag_(o) && due > 0) {
      if (String(o.p1cur) === dueCur) {
        set.p1amt = (Number(o.p1amt) || 0) + due;
      } else if (String(o.p2type) && String(o.p2cur) === dueCur) {
        set.p2amt = (Number(o.p2amt) || 0) + due;
      } else if (!String(o.p2type)) {
        set.p2type = String(o.p1type) || 'Cash';
        set.p2cur = dueCur;
        set.p2amt = due;
      } else {
        // Both slots taken and neither is in the right currency. Convert into
        // the first leg's currency so the money is not simply lost.
        // (Any currency: pounds used to be converted at the euro rate. b214)
        var conv = toUSD_(due, dueCur);
        var c1 = String(o.p1cur);
        var per = c1 === 'USD' ? 1 : c1 === 'PLN' ? plnPerUsd_() : c1 === 'EUR' ? eurPerUsd_() : perUsd_(c1);
        if (!(per > 0) || !(conv > 0)) throw new Error('No exchange rate for ' + (per > 0 ? dueCur : c1) + ' yet, so the balance cannot be added to this sale. Try again in a minute.');
        set.p1amt = round2_((Number(o.p1amt) || 0) + conv * per);
      }
    }

    set.pending = false;
    set.paid = true;
    set.dueamt = 0;
    set.duecur = '';
    dbUpdate_('_sales', firstOnly_({ saleId: saleId }), set);
    markDirty_(String(o.location));
    return;
  }
  throw new Error('That sale is no longer in the log.');
}

/* ============================ LOOKUPS ============================ */

/* Titles added after the app shipped — a Spanish edition, a Macedonian
   Adventures. They behave exactly like the built-in list from here on. */
/* ---- Consignment ----------------------------------------------------------

   Sometimes a local group prints their own translation and we sell it alongside
   ours: same table, same sellers, same cash box. The books are theirs, so their
   sales must stay out of every tour total, and their share of the takings has to
   be tracked until it is handed over.

   Modeled as ownership on the title itself, so a seller taps the book exactly
   as they would any other and the separation happens behind them. */
function partnersAll_() {
  return objectsOf_('_partners')
    .filter(function (x) { return x && x.partnerId && !truthyCell_(x.archived); })
    .map(function (x) {
      return { partnerId: String(x.partnerId), regionId: String(x.regionId || ''),
               name: String(x.name || ''), note: String(x.note || '') };
    });
}
function partnerById_(id) {
  var all = partnersAll_();
  for (var i = 0; i < all.length; i++) if (all[i].partnerId === String(id)) return all[i];
  return null;
}
/** Which partner owns this title, or '' when it is the tour's own. */
function partnerOfBook_(bookId) {
  var b = bookById_(bookId);
  return (b && b.partnerId) ? String(b.partnerId) : '';
}
function isPartnerBook_(bookId) { return !!partnerOfBook_(bookId); }
/** A sale that belongs to a consignment partner rather than the tour. */
function isPartnerSale_(sale) {
  return sale && sale.bookId ? isPartnerBook_(String(sale.bookId)) : false;
}
/** Only the tour's own sales — what every total should be built from. */
function tourSales_() {
  return objectsOf_('_sales').filter(function (r) { return !isPartnerSale_(r); });
}

/* Save a consignment title — name, kind, prices and stock — in ONE request.

   The dialog used to fire up to four separate calls in sequence: rename, then
   add, then prices, then stock. Each round trip to Apps Script costs a second
   or more, so a save that does milliseconds of work took several seconds, and
   any one of the four failing left the rest half-done. */
function doSaveConsignBook(p) {
  var bookId = String(p.bookId || '');
  var name = String(p.name || '').trim();
  if (!name) throw new Error('Give the title a name.');
  var cat = normCat_(p.cat);

  if (bookId) {
    doRenameBook({ bookId: bookId, name: name, cat: cat });
  } else {
    bookId = doAddBook({ name: name, cat: cat, partnerId: String(p.partnerId || '') });
  }

  if (p.prices && Object.keys(p.prices).length) {
    var pr = {}; pr[bookId] = p.prices;
    doSetPrices({ regionId: String(p.regionId || ''), prices: pr });
  }
  if (p.stock !== undefined && p.stock !== null && p.stock !== '') {
    doSetStockBulk({ location: String(p.location || ''),
                     items: [{ bookId: bookId, qty: Number(p.stock) || 0 }],
                     override: true });
  }
  return bookId;
}

function doSavePartner(p) {
  var name = String(p.name || '').trim();
  if (!name) throw new Error('Give the partner a name.');
  var regionId = String(p.regionId || '');
  if (!regionById_(regionId)) throw new Error('Pick a region.');
  var id = String(p.partnerId || '');
  if (id) {
    var pSet = { name: name, note: String(p.note || '').trim() };
    if (p.archived !== undefined) pSet.archived = !!p.archived;
    dbUpdate_('_partners', { partnerId: id }, pSet);
  } else {
    id = 'pt_' + Utilities.getUuid().slice(0, 6);
    dbInsert_('_partners', { partnerId: id, regionId: regionId, name: name, note: String(p.note || '').trim(),
                             createdAt: new Date(), archived: false });
  }
  markDirtyRegions_([regionId]);
  return id;
}

/** Record money handed over to a partner. */
/* Money handed to a consignment group — several currencies in one request, for
   the same reason as above. */
function doPartnerPayout(p) {
  var partnerId = String(p.partnerId || '');
  if (!partnerById_(partnerId)) throw new Error('That partner is no longer listed.');
  var items = (p.items && p.items.length) ? p.items : [{ cur: p.cur, amt: p.amt }];
  var known = allCurrencies_();
  var clean = items.map(function (it) {
    return { cur: String(it.cur || '').toUpperCase(), amt: Number(it.amt) || 0 };
  }).filter(function (it) { return it.amt > 0; });
  if (!clean.length) throw new Error('Enter an amount.');
  clean.forEach(function (it) {
    if (known.indexOf(it.cur) < 0) throw new Error(it.cur + ' is not one of the tour currencies.');
  });
  var pt = partnerById_(partnerId);
  var reg = pt ? regionById_(pt.regionId) : null;
  var fromLoc = String(p.fromLoc || (reg ? reg.whLoc : ''));
  var isCash = String(p.method || 'Cash') === 'Cash';

  /* Named by the app where it gave a name, so a hand-over re-sent after a slow
     reply is recognized rather than paid a second time. */
  var payBase = String(p.payoutId || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 40);
  clean.forEach(function (it, i) {
    var rowId = payBase ? (payBase + '_' + i) : ('P' + Utilities.getUuid().slice(0, 7));
    if (payBase) {
      var seen = objectsOf_('_payouts').some(function (x) { return String(x.id) === rowId; });
      if (seen) return;                      // already recorded — a resend
    }
    dbInsert_('_payouts', { id: rowId, partnerId: partnerId, ts: new Date(), cur: it.cur, amt: it.amt,
                            note: String(p.note || '').trim(), method: String(p.method || 'Cash') });
    /* Cash handed over physically leaves the box, so the tracker has to see it
       go. A digital hand-over never touched the box, so it doesn't. */
    if (isCash && fromLoc && cashValidAcct_(fromLoc)) {
      cashAppend_({ kind: 'MOVE', fromAcct: fromLoc, toAcct: 'BANK',
        cur: it.cur, amt: it.amt,
        note: 'Handed to ' + (pt ? pt.name : 'consignment') + (p.note ? ' — ' + p.note : ''),
        purpose: 'CONSIGN_OUT' });
    }
  });
  sheetMemoClear_();
  markDirtyRegions_(pt ? [pt.regionId] : []);
}

/** Taken in for a partner, handed over, and what is still owed to them. */
/* What a partner is owed, broken down by how the money arrived.

   Cash gets handed back as cash; a PayPal payment has to be sent on by PayPal.
   Tracking each method separately means the app can offer "Deliver Cash",
   "Deliver PayPal" and so on, and know what is outstanding on each. */
/* Every group's figures in one pass over the sales.

   partnerTally_ walks the whole sales list per group, so three groups meant
   three full passes. Building them together keeps it to one however many groups
   there are. */
var _tallyMemo = null;
function partnerTallies_() {
  if (_tallyMemo) return _tallyMemo;
  var out = {};
  partnersAll_().forEach(function (pt) {
    out[pt.partnerId] = { took: {}, paid: {}, owed: {}, byMethod: {}, sold: 0, preordered: 0 };
  });
  function bag(t, method) {
    return t.byMethod[method] || (t.byMethod[method] = { took: {}, paid: {}, owed: {} });
  }
  objectsOf_('_sales').forEach(function (r) {
    var pid = partnerOfBook_(String(r.bookId));
    var t = pid && out[pid];
    if (!t) return;
    if (String(r.type) === 'PREORDER') t.preordered++; else t.sold++;
    if (!received_(r)) return;
    eachLeg_(r, function (leg) {
      t.took[leg.cur] = (t.took[leg.cur] || 0) + leg.amt;
      var mm = bag(t, leg.type);
      mm.took[leg.cur] = (mm.took[leg.cur] || 0) + leg.amt;
    });
  });
  objectsOf_('_payouts').forEach(function (x) {
    var t = out[String(x.partnerId)];
    if (!t) return;
    var cur = String(x.cur), amt = Number(x.amt) || 0;
    t.paid[cur] = (t.paid[cur] || 0) + amt;
    var mm = bag(t, String(x.method || 'Cash'));
    mm.paid[cur] = (mm.paid[cur] || 0) + amt;
  });
  /* A cost that belongs to a consignment group — its share of a card fee, say —
     comes off what the group is owed, not off our own net. Tagged with a
     payment type, it also comes off that method's figure (a card fee against
     Card), which is what the Deliver buttons hand over. */
  objectsOf_('_costs').forEach(function (c) {
    var t = out[String(c.partnerId || '')];
    if (!t) return;
    var cur = String(c.cur), amt = Number(c.amt) || 0;
    t.costs = t.costs || {};
    t.costs[cur] = (t.costs[cur] || 0) + amt;
    if (c.payType) {
      var mm = bag(t, String(c.payType));
      mm.costs = mm.costs || {};
      mm.costs[cur] = (mm.costs[cur] || 0) + amt;
    }
  });
  Object.keys(out).forEach(function (pid) {
    var t = out[pid];
    var cost = t.costs || {};
    var owe = function (took, paid, cst) {
      var o2 = {};
      Object.keys(took).concat(Object.keys(paid), Object.keys(cst)).forEach(function (c) {
        o2[c] = (took[c] || 0) - (paid[c] || 0) - (cst[c] || 0);
      });
      return o2;
    };
    t.owed = owe(t.took, t.paid, cost);
    t.costs = cost;
    Object.keys(t.byMethod).forEach(function (mth) {
      var mm = t.byMethod[mth];
      mm.owed = owe(mm.took, mm.paid, mm.costs || {});
      mm.costs = mm.costs || {};
    });
  });
  _tallyMemo = out;
  return out;
}

function partnerTally_(partnerId) {
  return partnerTallies_()[String(partnerId)] ||
         { took: {}, paid: {}, owed: {}, byMethod: {}, sold: 0, preordered: 0 };
}

function customBooks_() {
  return objectsOf_('_custombooks').filter(function (b) { return b && b.id && b.name; })
    .map(function (b) {
      return { id: String(b.id), name: String(b.name),
               cat: normCat_(b.cat), usd: 0, pln: 0, eur: 0,
               partnerId: String(b.partnerId || '') };
    });
}
/* The catalog, built once per request and looked up by id.

   It used to be rebuilt on every single lookup, and every lookup then scanned
   it from the start. Consignment made that expensive: working out what a group
   is owed asks "whose book is this?" for every sale, so the whole catalog was
   reassembled once per sale per group. An index turns that into one build and a
   direct lookup. */
var _bookMemo = null, _bookIndex = null;
function bookMemoClear_() { _bookMemo = null; _bookIndex = null; _tallyMemo = null; }

/* The catalog in the order it should be shown.

   A book carries a 'sort' if it has been placed by hand; anything unplaced
   keeps its natural order behind the placed ones, so adding a title puts it at
   the end rather than somewhere arbitrary. */
function bookOrder_() {
  var o = {};
  objectsOf_('_books').forEach(function (b) {
    if (b && b.id && b.sort !== '' && b.sort !== null && b.sort !== undefined) o[String(b.id)] = Number(b.sort);
  });
  objectsOf_('_custombooks').forEach(function (b) {
    if (b && b.id && b.sort !== '' && b.sort !== null && b.sort !== undefined) o[String(b.id)] = Number(b.sort);
  });
  return o;
}

function allBooks_() {
  if (!_bookMemo) _bookMemo = BOOKS.concat(customBooks_());
  return _bookMemo;
}

/* The catalog as a given region wants it shown.

   Order lives on the region, so Poland can lead with what sells in Poland
   without rearranging Macedonia. A title the region has not placed keeps its
   natural position behind the ones it has. */
/* The titles a region offers, in the order it has chosen.

   Two functions of this name existed — one limiting a region to its chosen
   titles, one putting them in its chosen order — and the later silently
   replaced the earlier. This one does both. */
function booksForRegion_(regionId) {
  var reg = regionById_(String(regionId || ''));
  var list = allBooks_();
  if (reg && reg.books && reg.books.length) {
    list = list.filter(function (b) { return reg.books.indexOf(b.id) >= 0; });
  }
  var raw = reg ? String(reg.bookOrder || '') : '';
  if (!raw) return list;
  var rank = {};
  raw.split(',').forEach(function (id, i) { rank[String(id).trim()] = i; });
  return list.map(function (b, i) { return { b: b, i: i }; })
    .sort(function (x, y) {
      var a = rank[x.b.id], c = rank[y.b.id];
      var aHas = a !== undefined, cHas = c !== undefined;
      if (aHas && cHas && a !== c) return a - c;
      if (aHas && !cHas) return -1;
      if (!aHas && cHas) return 1;
      return x.i - y.i;
    })
    .map(function (x) { return x.b; });
}

/* Record a hand-picked order for the books, for ONE region.

   Each region sells differently — what moves in Poland is not what moves in
   Macedonia — so the order is kept per region rather than tour-wide. It is
   stored on the region itself, as a list of ids; anything not in that list
   keeps its natural place behind the ones that are. */
function doReorderBooks(p) {
  var ids = (p.ids || []).map(String);
  if (!ids.length) throw new Error('Nothing to reorder.');
  var regionId = String(p.regionId || '');
  /* No region means the whole season: the order every region falls back to
     when it has not set one of its own. */
  if (!regionId) {
    setMeta_('bookOrder:' + activeSeasonId_(), ids.join(','));
    bookMemoClear_();
    markDirtyAll_();
    return ids.join(',');
  }
  if (!regionById_(regionId)) throw new Error('Pick a region.');

  dbAddCols_('_regions', REGION_HEADERS);
  dbUpdate_('_regions', { regionId: regionId }, { bookOrder: ids.join(',') });
  bookMemoClear_();
  markDirtyRegions_([regionId]);
}
function bookIndex_() {
  if (!_bookIndex) {
    _bookIndex = {};
    allBooks_().forEach(function (b) { _bookIndex[b.id] = b; });
  }
  return _bookIndex;
}

/* Payment QR codes. Scope 'SEASON' means every region can show it; a regionId
   scopes it to that region alone. Images are stored as data URLs so there is no
   second place for files to live (and nothing to break when a link rots). */
function doQrSave(p) {
  var scope = String(p.scope || SEASON);
  var kept = objectsOf_('_qr')
    .filter(function (q) { return q && q.id && String(q.scope || '') !== scope; })
    .map(function (q) {
      return { id: String(q.id), scope: String(q.scope || ''), label: String(q.label || ''),
               caption: String(q.caption || ''), src: String(q.src || ''), sort: Number(q.sort) || 0 };
    });
  var mine = (p.rows || []).map(function (r, i) {
    return { id: String(r.id || ('Q' + Utilities.getUuid().slice(0, 7))),
             scope: scope, label: String(r.label || '').trim(),
             caption: String(r.caption || '').trim(), src: String(r.src || ''), sort: i };
  }).filter(function (r) { return r.label && r.src; });
  dbSave_('_qr', kept.concat(mine), ['id','scope','label','caption','src','sort']);
  markDirtyAll_();
}

/* Remove a title from the catalog.

   Only ever a custom or consignment title — the eight standard books stay. A
   title that has been sold is kept, because deleting it would orphan the sales
   that reference it; the honest fix there is to delete those sales first. */
/* Rename a title, or change which kind it is.

   Only ever a custom or consignment title — the standard eight keep their
   names. Sales reference a book by id, so a rename is safe: every past sale
   follows the new name automatically. */
function doRenameBook(p) {
  var id = String(p.bookId || '');
  var name = String(p.name || '').trim();
  if (!name) throw new Error('Give the title a name.');
  var bSet = { name: name };
  if (p.cat) bSet.cat = normCat_(p.cat);
  var found = dbUpdate_('_custombooks', { id: id }, bSet);
  if (!found) throw new Error('That is one of the standard titles and cannot be renamed.');
  bookMemoClear_();
  markDirtyRegions_(regionsTouchedByBook_(partnerOfBook_(id)));
}

function doDeleteBook(p) {
  var id = String(p.bookId || '');
  var custom = objectsOf_('_custombooks').filter(function (b) { return b && b.id; });
  if (!custom.some(function (b) { return String(b.id) === id; })) {
    throw new Error('That is one of the standard titles and cannot be removed.');
  }
  var sold = objectsOf_('_sales').filter(function (r) { return String(r.bookId) === id; }).length;
  if (sold) {
    throw new Error('This title has ' + sold + ' sale' + (sold === 1 ? '' : 's') +
      ' recorded against it. Delete those first if you really mean to remove it.');
  }
  /* Any stock it still shows is notional once the title is gone, so clear it.
     The map is keyed "location|bookId", so match on the book half rather than
     treating the keys as bare locations. */
  var map = loadInvMap_();
  var held = 0;
  Object.keys(map).forEach(function (key) {
    var bits = String(key).split('|');
    if (bits[bits.length - 1] !== id) return;
    held += Number(map[key]) || 0;
    map[key] = 0;
  });
  if (held) saveInvMap_(map);

  dbSave_('_custombooks', custom.filter(function (b) { return String(b.id) !== id; }));
  // Its prices go with it.
  dbSave_('_prices', objectsOf_('_prices').filter(function (r) { return String(r.bookId) !== id; })
      .map(function (r) {
        return { regionId: String(r.regionId), bookId: String(r.bookId),
                 cur: String(r.cur), price: Number(r.price) || 0 };
      }), ['regionId','bookId','cur','price']);
  // Only where the title actually was needs redrawing.
  markDirtyRegions_(regionsOrdered_().map(function (r) { return r.regionId; }));
  return { removedStock: held };
}

/* The three kinds a title can be. 'other' is for things that are neither a Big
   Book nor an Adventures — it was being silently turned into 'big', so choosing
   it appeared to do nothing. */
function normCat_(v) {
  v = String(v || '').toLowerCase();
  return (v === 'aotm' || v === 'other') ? v : 'big';
}

/* Which regions a title actually affects.

   A consignment title belongs to one group in one region, so only that region's
   spreadsheet needs redrawing. Flagging the whole tour meant adding one
   Macedonian pamphlet queued a rebuild of every regional file — and because
   Apps Script runs one script at a time, the next thing you did then waited
   behind all of it. That is what made saving feel slow when the work itself is
   milliseconds. */
function regionsTouchedByBook_(partnerId) {
  if (partnerId) {
    var pt = partnerById_(String(partnerId));
    if (pt && pt.regionId) return [String(pt.regionId)];
  }
  return regionsOrdered_().map(function (r) { return r.regionId; });
}

function doAddBook(p) {
  var name = String(p.name || '').trim();
  if (!name) throw new Error('Give the book a title.');
  var cat = normCat_(p.cat);
  var existing = allBooks_();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].name.toLowerCase() === name.toLowerCase())
      throw new Error('A book called "' + name + '" already exists.');
  }
  var id = 'bk_' + Utilities.getUuid().slice(0, 6);
  dbAddCols_('_custombooks', ['id','name','cat','createdAt','partnerId','sort']);
  var rowB = { id: id, name: name, cat: cat, createdAt: new Date(),
               partnerId: String(p.partnerId || ''), sort: '' };
  dbInsert_('_custombooks', rowB);
  bookMemoClear_();
  markDirtyRegions_(regionsTouchedByBook_(p.partnerId));
  return id;
}

function bookById_(id) { return bookIndex_()[id] || null; }
/* The tour's own catalog. A consignment title is left out of these, so it
   never appears in our stock tables or sales blocks — it has its own sheet.
   allBooks_() still carries everything, so lookups by id always resolve. */
function tourBooks_()  { return allBooks_().filter(function (b) { return !b.partnerId; }); }
function bigBooks_()   { return tourBooks_().filter(function (b) { return b.cat === 'big'; }); }
function bigBooksFor_(regionId) {
  return booksForRegion_(regionId).filter(function (b) { return !b.partnerId && b.cat === 'big'; });
}
function aotmBooks_()  { return tourBooks_().filter(function (b) { return b.cat === 'aotm'; }); }
/* The third kind. Without this, a pamphlet was reported as a Big Book on every
   spreadsheet. */
function otherBooks_() { return tourBooks_().filter(function (b) { return b.cat === 'other'; }); }
function catOf_(id)    { var b = bookById_(id); return b ? b.cat : 'big'; }

/* Returns the whole event, not just its name.

   This used to hand back only the id and name, so anything else on the row —
   which region it belongs to, whether it is closed, which payments it takes —
   was invisible to every caller that used it. */
function eventById_(id) {
  var e = objectsOf_('_events');
  for (var i = 0; i < e.length; i++) {
    if (String(e[i].eventId) !== String(id)) continue;
    var row = e[i];
    return { eventId: String(row.eventId), name: String(row.name),
             regionId: String(row.regionId || ''), closedAt: row.closedAt || '',
             payTypes: String(row.payTypes || '') };
  }
  return null;
}

function locLabel_(loc) {
  // Every kind of place gets a readable name — a warehouse, an event, a devotee
  // storing books, or a batch on the road — so messages and the spreadsheet
  // never fall back to an internal id.
  var regs = regionsOrdered_();
  for (var i = 0; i < regs.length; i++) {
    if (regs[i].whLoc === loc) return regs[i].name + ' (Warehouse)';
  }
  // A warehouse in another season (checked before the original id below, which
  // the first region still uses) is named with its season.
  var otherWh = allRegionsEverywhere_().filter(function (r) { return r.whLoc === String(loc); })[0];
  if (otherWh) return otherWh.name + ' (Warehouse, ' + otherWh.seasonName + ')';
  var ev = eventById_(loc);
  if (ev) return ev.name;
  var hs = objectsOf_('_holders');
  for (var j = 0; j < hs.length; j++) {
    if (String(hs[j].holderId) === String(loc)) return String(hs[j].name) + ' (storing books)';
  }
  if (String(loc) === 'BANK' || isRegionBank_(loc)) return bankLabel_(loc);
  var sp = shipmentById_(loc);
  if (sp) {
    var who = sp.mode === 'shipping'
      ? (sp.tracking ? 'courier ' + sp.tracking : 'courier')
      : (sp.carrier || 'a devotee');
    return 'In transit with ' + who +
      (sp.fromRegion === OUTSIDE_ORIGIN ? ' from ' + (sp.origin || 'outside the tour') : '');
  }
  /* A place in ANOTHER season — stock handed over from Europe Tour, say. The
     lookups above only know the current season, so these showed as raw ids
     like "wh_35217d". Named with their season so it is clear where they are. */
  var other = allRegionsEverywhere_().filter(function (r) { return r.whLoc === String(loc); })[0];
  if (other) return other.name + ' (Warehouse, ' + other.seasonName + ')';
  var evAll = objectsOf_('_events').filter(function (e) { return String(e.eventId) === String(loc); })[0];
  if (evAll) {
    var er = allRegionsEverywhere_().filter(function (r) { return r.regionId === String(evAll.regionId); })[0];
    return String(evAll.name) + (er ? ' (' + er.seasonName + ')' : '');
  }
  return loc;
}

function toUSD_(amt, cur) {
  amt = Number(amt) || 0;
  if (!amt) return 0;
  cur = String(cur || '').toUpperCase();
  if (cur === 'USD') return amt;
  var per = perUsd_(cur);
  return per > 0 ? amt / per : 0;
}

/* ---- Dollars from the truth ----

   Local amounts never change; only their dollar value can. In order of trust:
     1. dollars actually received, where entered on the sale (usdActual);
     2. the rates a closed REGION was frozen at, the day it closed;
     3. the rates a closed SEASON was frozen at (getRates_ already returns them);
     4. today's rates, as an estimate.
   Every dollar figure in the spreadsheets goes through the helpers below, so a
   closed region's totals stop moving and add up the same everywhere. */
var _locFxMemo = null;
/** The rates a closed region was frozen at, or null. */
function regionFrozenRates_(r) {
  if (!r || !r.closedAt || !r.frozenRates) return null;
  try { var fr = JSON.parse(r.frozenRates); return (fr && fr.RATES) ? fr.RATES : null; } catch (e) { return null; }
}
/** Location -> frozen rates, for every place in a closed region (any season). */
function locFxMap_() {
  if (_locFxMemo) return _locFxMemo;
  var byRegion = {}, out = {};
  objectsOf_('_regions').forEach(function (r) {
    var fx = regionFrozenRates_(r);
    if (!fx) return;
    byRegion[String(r.regionId)] = fx;
    if (r.whLoc) out[String(r.whLoc)] = fx;
  });
  if (Object.keys(byRegion).length) {
    objectsOf_('_events').forEach(function (e) { var fx = byRegion[String(e.regionId || '')]; if (fx) out[String(e.eventId)] = fx; });
    objectsOf_('_holders').forEach(function (h) { var fx = byRegion[String(h.regionId || '')]; if (fx) out[String(h.holderId)] = fx; });
  }
  _locFxMemo = out;
  return out;
}
function ratesForLoc_(loc) { return locFxMap_()[String(loc)] || null; }
/* Location -> a closed season's frozen rates, for every place in it. Inside a
   season getRates_ already returns them; this is for Earthly HQ, which counts
   every season at once. */
var _seasonFxMemo = null;
function seasonFxMap_() {
  if (_seasonFxMemo) return _seasonFxMemo;
  var bySeason = {}, byRegion = {}, out = {};
  if (dbHas_('_seasons')) objectsOf_('_seasons').forEach(function (x) {
    if (!x || !x.closedAt || !x.frozenRates) return;
    try { var fr = JSON.parse(x.frozenRates); if (fr && fr.RATES) bySeason[String(x.seasonId)] = fr.RATES; } catch (e) {}
  });
  if (Object.keys(bySeason).length) {
    objectsOf_('_regions').forEach(function (r) {
      var fx = bySeason[String(r.seasonId || '')];
      if (!fx) return;
      byRegion[String(r.regionId)] = fx;
      if (r.whLoc) out[String(r.whLoc)] = fx;
    });
    objectsOf_('_events').forEach(function (e) { var fx = byRegion[String(e.regionId || '')]; if (fx) out[String(e.eventId)] = fx; });
    objectsOf_('_holders').forEach(function (h) { var fx = byRegion[String(h.regionId || '')]; if (fx) out[String(h.holderId)] = fx; });
  }
  _seasonFxMemo = out;
  return out;
}
/** The frozen rates a place counts at: its closed region's, else its closed season's. */
function truthFxForLoc_(loc) { return ratesForLoc_(loc) || seasonFxMap_()[String(loc)] || null; }
/** Dollars at a place's own rates: a closed region's if it has them, else as usual. */
function toUsdAt_(amt, cur, loc) {
  amt = Number(amt) || 0;
  if (!amt) return 0;
  cur = String(cur || '').toUpperCase();
  if (cur === 'USD') return amt;
  var fx = truthFxForLoc_(loc);
  var per = fx ? Number(fx[cur]) : 0;
  return per > 0 ? amt / per : toUSD_(amt, cur);
}
function hasUsdActual_(s) {
  var v = s ? s.usdActual : '';
  return v !== '' && v !== null && v !== undefined && !isNaN(Number(v)) && Number(v) > 0;
}
/* How far the dollars received move this sale from its estimate: every leg is
   scaled by the same factor, so a breakdown still adds up to the whole. */
function saleFactor_(s) {
  if (!hasUsdActual_(s) || !received_(s)) return 1;
  var est = 0;
  eachLeg_(s, function (l) { if (l.type !== 'Gift') est += toUsdAt_(l.amt, l.cur, s.location); });
  return est > 0 ? Number(s.usdActual) / est : 1;
}
/** One payment leg of a sale, in dollars, from the truth. */
function legTruthUsd_(s, leg, factor) {
  return toUsdAt_(leg.amt, leg.cur, s.location) * (factor === undefined ? saleFactor_(s) : factor);
}
/** A cost, in dollars at its place's rates. */
function costUsd_(c) { return toUsdAt_(c.amt, c.cur, c.location); }

function eachLeg_(s, fn) {
  if (s.p1type) fn({ type: String(s.p1type), cur: String(s.p1cur), amt: Number(s.p1amt) || 0 });
  if (s.p2type) fn({ type: String(s.p2type), cur: String(s.p2cur), amt: Number(s.p2amt) || 0 });
  pmoreRead_(s.pmore).forEach(function (l) { if (l && l.type) fn({ type: String(l.type), cur: String(l.cur), amt: Number(l.amt) || 0 }); });
}
function legsUsd_(s) { var t = 0, f = saleFactor_(s); eachLeg_(s, function (l) { t += legTruthUsd_(s, l, f); }); return t; }

/* Three payment states, from two stored fields:
     pending = true          nothing received; the legs are what is owed
     dueamt  > 0             the legs ARE in hand, and this much is still owed
     neither                 settled
   Rows written before partial payments existed have an empty dueamt, so they
   read exactly as they always did. */
function pendingFlag_(s) {
  return (s.pending === true || s.pending === 'true' || s.pending === 'TRUE') &&
         !(s.paid === true || s.paid === 'true' || s.paid === 'TRUE');
}
function dueAmt_(s) { return Math.max(0, Number(s.dueamt) || 0); }
function dueCur_(s) { return String(s.duecur || 'USD'); }

/** Has the money in the legs actually been collected? */
function received_(s) { return !pendingFlag_(s); }

/* USD helpers used by the season rollup. Kept alongside received_/eachLeg_ so
   every sheet values money the same way. */
function legsUSD_(s) { return legsUsd_(s); }
function dueUSD_(s) { return dueUsd_(s); }

/** Everything still owed on this sale, in USD. */
function dueUsd_(s) {
  if (pendingFlag_(s)) {
    // Nothing paid yet: the whole ticket is outstanding, at the place's rates.
    var t = 0;
    eachLeg_(s, function (l) { t += toUsdAt_(l.amt, l.cur, s.location); });
    return t;
  }
  return toUsdAt_(dueAmt_(s), dueCur_(s), s.location);
}

/** What is still owed, as amounts in the currencies they are owed in. */
function outstanding_(s) {
  var out = [];
  if (pendingFlag_(s)) {
    eachLeg_(s, function (l) { if (l.amt > 0) out.push({ amt: l.amt, cur: l.cur }); });
  } else if (dueAmt_(s) > 0) {
    out.push({ amt: dueAmt_(s), cur: dueCur_(s) });
  }
  return out;
}

function isPaid_(s) { return !pendingFlag_(s) && dueAmt_(s) <= 0; }
function payLabel_(s) {
  var parts = [];
  eachLeg_(s, function (l) { parts.push(l.type + ' ' + l.amt + ' ' + l.cur); });
  return parts.join(' + ');
}
/* The logs keep these in separate columns so the sheet can be sorted and
   filtered by either one. A mixed payment joins both sides with " + ". */
function payTypes_(s) {
  var a = [];
  eachLeg_(s, function (l) { a.push(l.type); });
  return a.join(' + ');
}
function payAmounts_(s) {
  var a = [];
  eachLeg_(s, function (l) { a.push(l.amt + ' ' + l.cur); });
  return a.join(' + ');
}
function round2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/* Utilities.formatDate follows the script's locale, so on a Polish-configured
   account "Aug" came out as "sie". Build the stamp from an explicit English
   month list so the sheet reads the same wherever the tour is. */
var EN_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function stamp_(d) {
  d = d || new Date();
  var tz = Session.getScriptTimeZone();
  var day = Utilities.formatDate(d, tz, 'd');
  var mon = EN_MONTHS[Number(Utilities.formatDate(d, tz, 'M')) - 1] || '';
  var rest = Utilities.formatDate(d, tz, 'yyyy, HH:mm');
  return day + ' ' + mon + ' ' + rest;
}
// Leading apostrophe keeps Sheets from mangling a +48… number into a formula.
function phoneCell_(v) { v = String(v || ''); return v ? "'" + v : ''; }

/* Numbers stored before the column was forced to text come back without their
   leading "+". Nothing can recover it for certain, but a bare number long
   enough to carry a country code almost certainly had one. */
function phoneRead_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') {
    var d = String(Math.round(v));
    return d.length > 9 ? '+' + d : d;
  }
  return String(v).replace(/^'/, '');
}

/* ============================ READABLE TABS ============================ */

function renderAll() {
  markDirtyAll_();
  syncSheets();
}

function displayTabName_(name) {
  var clean = String(name).replace(/[\[\]\*\/\\\?:]/g, ' ').trim().slice(0, 90);
  return clean || 'Event';
}

function colLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - m) / 26); }
  return s;
}


/* One place that turns rows + styling hints into a finished tab, so the season
   file and every regional file look identical. */
function paintSheet_(sh, rows, band, head, tot, money, ints) {
  /* ---- Write values in one call ---- */
  var width = rows.reduce(function (m, x) { return Math.max(m, x.length); }, 1);
  var padded = rows.map(function (x) { while (x.length < width) x.push(''); return x; });

  // Make sure the sheet is big enough BEFORE clearing: a fresh spreadsheet has
  // 26 columns, and writing wider than that throws — which used to happen after
  // the clear, leaving an empty sheet behind.
  if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
  if (sh.getMaxRows() < padded.length) sh.insertRowsAfter(sh.getMaxRows(), padded.length - sh.getMaxRows());
  sh.clear();

  // sh.clear() leaves merged cells behind, and a merge left over the masthead
  // would make setValues fail on the next rebuild.
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  if (sh.getMaxRows() < padded.length) sh.insertRowsAfter(sh.getMaxRows(), padded.length - sh.getMaxRows() + 20);
  if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns() + 2);

  sh.getRange(1, 1, padded.length, width).setValues(padded);

  /* ---- Style ---- */
  var last = colLetter_(width);
  var all = sh.getRange(1, 1, padded.length, width);
  all.setFontFamily('Arial').setFontSize(10).setFontColor(TH.ink).setBackground(TH.paper)
     .setVerticalAlignment('middle');

  // Masthead
  sh.getRange('A1:' + last + '1').merge()
    .setBackground(TH.plum).setFontColor(TH.gold)
    .setFontFamily('Georgia').setFontSize(15).setFontWeight('bold')
    .setHorizontalAlignment('left').setVerticalAlignment('middle');
  sh.setRowHeight(1, 36);
  sh.getRange('A2:' + last + '2').merge()
    .setBackground(TH.cream).setFontColor(TH.goldD)
    .setFontFamily('Georgia').setFontStyle('italic').setFontSize(11);
  sh.getRange('A3:' + last + '3').setBackground(TH.cream).setFontColor(TH.muted).setFontSize(9);

  if (band.length) {
    sh.getRangeList(band.map(function (n) { return 'A' + n + ':' + last + n; }))
      .setBackground(TH.plum).setFontColor(TH.gold)
      .setFontFamily('Georgia').setFontSize(11).setFontWeight('bold');
  }
  if (head.length) {
    sh.getRangeList(head.map(function (n) { return 'A' + n + ':' + last + n; }))
      .setBackground(TH.paper2).setFontColor(TH.muted)
      .setFontSize(9).setFontWeight('bold')
      .setBorder(null, null, true, null, null, null, TH.line, SpreadsheetApp.BorderStyle.SOLID);
  }
  if (tot.length) {
    sh.getRangeList(tot.map(function (n) { return 'A' + n + ':' + last + n; }))
      .setBackground(TH.cream).setFontColor(TH.plum).setFontWeight('bold')
      .setBorder(true, null, null, null, null, null, TH.line, SpreadsheetApp.BorderStyle.SOLID);
  }
  if (money.length) sh.getRangeList(money).setNumberFormat('#,##0.00');
  // Book counts are things you can hold — never show them with decimals.
  if (ints && ints.length) sh.getRangeList(ints).setNumberFormat('#,##0');

  sh.setColumnWidth(1, 250);
  for (var c = 2; c <= width; c++) sh.setColumnWidth(c, 128);
  sh.setFrozenRows(3);
  if (sh.getMaxRows() > padded.length + 2) {
    sh.getRange(padded.length + 1, 1, sh.getMaxRows() - padded.length, sh.getMaxColumns())
      .setBackground(TH.paper);
  }
}

/* ---- BE1: the season spreadsheet ----
   Its own file, laid out like a regional Summary but rolled up across the whole
   tour, plus two sections that only make sense at this level: book sales by
   region and collections by region. Cash is shown per region, never per event. */
/* A partner's own file: their books, their money, nothing of ours. This is the
   thing they can be handed at the end of the event. */
function renderPartnerSheet_(partnerId) {
  var pt = partnerById_(partnerId);
  if (!pt) return;
  var ptRegion = regionById_(pt.regionId);
  var ptSid = ptRegion ? ptRegion.seasonId : activeSeasonId_();
  var ss = openOrCreateSheetFile_('partnerSheetId:' + partnerId,
    pt.name + ' — ' + seasonName_(ptSid) + ' — Consignment Sales',
    function () { return consignFolder_(ptSid); });
  var sh = ss.getSheetByName('Summary') || ss.insertSheet('Summary');

  var rows = [], band = [], head = [], tot = [], money = [], ints = [];
  function put(r) { rows.push(r); return rows.length; }
  function blank() { put(['']); }

  put([pt.name + ' — Book Sales']);
  put(['Sold alongside ' + getSeasonName_() + '. These are your books and your takings.']);
  put(['Last updated', stamp_()]);
  blank();

  var mine = objectsOf_('_sales').filter(function (r) {
    return partnerOfBook_(String(r.bookId)) === partnerId;
  });
  var books = allBooks_().filter(function (b) { return String(b.partnerId || '') === partnerId; });

  band.push(put(['BOOKS SOLD']));
  head.push(put(['Title', 'Sold', 'Pre-ordered', 'Total']));
  var iStart = rows.length + 1;
  var gs = 0, gp = 0;
  books.forEach(function (b) {
    var sold = mine.filter(function (r) { return String(r.bookId) === b.id && String(r.type) === 'SALE'; }).length;
    var pre  = mine.filter(function (r) { return String(r.bookId) === b.id && String(r.type) === 'PREORDER'; }).length;
    gs += sold; gp += pre;
    put([b.name, sold, pre, sold + pre]);
  });
  tot.push(put(['TOTAL', gs, gp, gs + gp]));
  ints.push('B' + iStart + ':D' + rows.length);
  blank();

  var t = partnerTally_(partnerId);
  var curs = allCurrencies_();
  band.push(put(['MONEY']));
  // Costs taken off before handing over (their share of card fees and the like).
  head.push(put(['Currency', 'Taken in', 'Costs', 'Handed over', 'Still to hand over']));
  var mStart = rows.length + 1;
  curs.forEach(function (c) {
    var cst = (t.costs || {})[c] || 0;
    if (!t.took[c] && !t.paid[c] && !cst) return;
    put([c, round2_(t.took[c] || 0), round2_(cst), round2_(t.paid[c] || 0), round2_(t.owed[c] || 0)]);
  });
  if (rows.length < mStart) put(['—', 0, 0, 0]);
  money.push('B' + mStart + ':E' + rows.length);
  blank();

  band.push(put(['EVERY SALE']));
  head.push(put(['Title', 'Type', 'Payment', 'Amount', 'Where', 'When', 'Recorded by']));
  mine.slice().sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); }).forEach(function (r) {
    put([(bookById_(String(r.bookId)) || {}).name || r.bookId,
         String(r.type) === 'PREORDER' ? 'Pre-order' : 'Sale',
         payTypes_(r), payAmounts_(r), locLabel_(String(r.location)), r.ts, String(r.soldBy || '')]);
  });
  if (!mine.length) put(['Nothing sold yet']);

  paintSheet_(sh, rows, band, head, tot, money, ints);
}

function renderSeasonSheet_() {
  var ss = seasonSpreadsheet_();
  var sh = ss.getSheetByName('Summary') || ss.insertSheet('Summary');
  // NB: the sheet is deliberately NOT cleared here. Everything is assembled
  // first and cleared only at the moment of writing, so a failure part-way
  // through can never leave the file blank.

  var regions = regionsOrdered_();
  /* Only this season's sales. This used to read every sale on record, so the
     Year-Round summary's headline totals and collections included all of
     Europe Tour's — only the per-region sections below were limited properly. */
  var seasonLocs = {};
  regions.forEach(function (r) { locsInRegion_(r.regionId).forEach(function (l) { seasonLocs[l] = 1; }); });
  var allSales = tourSales_().filter(function (s) { return seasonLocs[String(s.location)]; });
  var invMap = loadInvMap_();

  var rows = [], band = [], head = [], tot = [], money = [], ints = [];
  function put(row) { rows.push(row); return rows.length; }
  function blank() { put(['']); }

  put([getSeasonName_() + ' \u2014 Season Summary (all regions)']);
  put(['gop\u012b-bhartu\u1e25 pada-kamalayor d\u0101sa-d\u0101s\u0101nud\u0101sa\u1e25']);
  put(['Last updated', stamp_()]);
  var fx = getRates_();
  put([(fx.frozen ? 'Exchange rates \u2014 FROZEN when this season closed'
        : fx.live ? 'Exchange rates \u2014 LIVE' : 'Exchange rates \u2014 OFFLINE FALLBACK (live fetch failed)'),
       'USD is the common currency' + (fx.live && fx.asOf ? '  (as of ' + fx.asOf + ')' : '')
       + (regions.some(function (r) { return ratesForLoc_(r.whLoc); })
          ? ' \u2014 a closed region counts at the rates of the day it closed' : '')]);
  blank();

  /* ---- Headline totals ---- */
  function catCount(sales, cat, type) {
    return sales.filter(function (s) {
      return s.bookId && catOf_(String(s.bookId)) === cat && String(s.type) === type;
    }).length;
  }
  band.push(put(['SUMMARY']));
  head.push(put(['', 'Sold', 'Pre-ordered', 'Total']));
  var bs = catCount(allSales, 'big', 'SALE'), bp = catCount(allSales, 'big', 'PREORDER');
  var as = catCount(allSales, 'aotm', 'SALE'), ap = catCount(allSales, 'aotm', 'PREORDER');
  put(['Big Books', bs, bp, bs + bp]);
  put(['AoTM (Adventures)', as, ap, as + ap]);
  tot.push(put(['All titles', bs + as, bp + ap, bs + bp + as + ap]));
  blank();

  var totUsd = 0, pendUsd = 0, donUsd = 0;
  allSales.forEach(function (s) {
    if (received_(s)) {
      totUsd += legsUSD_(s);
      if (String(s.type) === 'DONATION') donUsd += legsUSD_(s);
    }
    pendUsd += dueUSD_(s);
  });
  head.push(put(['Total collections (USD)', 'Donations (USD)', 'Pending (USD)']));
  var mStart = rows.length + 1;
  put([round2_(totUsd), round2_(donUsd), round2_(pendUsd)]);
  money.push('A' + mStart + ':C' + mStart);
  blank();

  /* ---- Where the books are, region by region ---- */
  // Books down column A, regions across — same shape as STOCK BY REGION.
  function salesBlock(label, list) {
    band.push(put([label + ' \u2014 SALES BY REGION']));
    head.push(put(['Book'].concat(regions.map(function (r) { return r.name; })).concat(['Total'])));
    var blkStart = rows.length + 1;
    var regSales = regions.map(function (r) {
      var mine = {}; locsInRegion_(r.regionId).forEach(function (l) { mine[l] = 1; });
      return allSales.filter(function (s) { return mine[String(s.location)] && s.bookId; });
    });
    var colTot = regions.map(function () { return 0; }), grand = 0;
    list.forEach(function (b) {
      var per = regSales.map(function (rs, i) {
        var n = rs.filter(function (s) { return String(s.bookId) === b.id; }).length;
        colTot[i] += n; grand += n; return n;
      });
      put([b.name].concat(per).concat([per.reduce(function (t, n) { return t + n; }, 0)]));
    });
    tot.push(put(['TOTAL'].concat(colTot).concat([grand])));
    var blkEnd = rows.length;
    // Sold vs pre-ordered, same orientation.
    ['SALE', 'PREORDER'].forEach(function (ty) {
      var lbl = ty === 'SALE' ? 'of which sold' : 'of which pre-ordered';
      var per = regSales.map(function (rs) {
        return rs.filter(function (s) {
          return String(s.type) === ty && list.some(function (b) { return b.id === String(s.bookId); });
        }).length;
      });
      put([lbl].concat(per).concat([per.reduce(function (t, n) { return t + n; }, 0)]));
    });
    ints.push('B' + (blkStart) + ':' + colLetter_(regions.length + 2) + rows.length);
    blank();
  }
  salesBlock('BIG BOOKS', bigBooks_());
  salesBlock('AoTM', aotmBooks_());

  /* ---- BE1: collections by region, per currency + USD ---- */
  var curs = allCurrencies_();
  band.push(put(['COLLECTIONS BY REGION']));
  head.push(put(['Currency'].concat(regions.map(function (r) { return r.name; })).concat(['Total'])));
  var cStart = rows.length + 1;
  // region -> currency -> amount, plus each region's USD equivalent
  var byReg = regions.map(function (r) {
    var mine = {}; locsInRegion_(r.regionId).forEach(function (l) { mine[l] = 1; });
    var acc = { usd: 0, cur: {} };
    allSales.forEach(function (s) {
      if (!mine[String(s.location)] || !received_(s)) return;
      eachLeg_(s, function (leg) {
        acc.cur[leg.cur] = (acc.cur[leg.cur] || 0) + leg.amt;
        acc.usd += legTruthUsd_(s, leg);
      });
    });
    return acc;
  });
  curs.forEach(function (c) {
    var per = byReg.map(function (a) { return round2_(a.cur[c] || 0); });
    put([c].concat(per).concat([round2_(per.reduce(function (t, n) { return t + n; }, 0))]));
  });
  var usdRow = byReg.map(function (a) { return round2_(a.usd); });
  tot.push(put(['USD equivalent'].concat(usdRow)
    .concat([round2_(usdRow.reduce(function (t, n) { return t + n; }, 0))])));
  money.push('B' + cStart + ':' + colLetter_(regions.length + 2) + rows.length);
  blank();

  /* ---- Cash on hand: regions only, never per event ---- */
  band.push(put(['STOCK BY REGION']));
  head.push(put(['Book'].concat(regions.map(function (r) { return r.name; })).concat(['Total'])));
  var stockStart = rows.length + 1;
  allBooks_().forEach(function (b) {
    var per = regions.map(function (r) {
      return locsInRegion_(r.regionId).reduce(function (t, l) { return t + getQty_(invMap, l, b.id); }, 0);
    });
    var total = per.reduce(function (t, n) { return t + n; }, 0);
    put([b.name].concat(per).concat([total]));
  });
  ints.push('B' + stockStart + ':' + colLetter_(regions.length + 2) + rows.length);
  blank();

  /* ---- BE1: book sales by region, Big Books and Adventures separately ---- */
  band.push(put(['CASH ON HAND (BY REGION)']));
  head.push(put(['Currency'].concat(regions.map(function (r) { return r.name; })).concat(['Bank', 'Total'])));
  var kStart = rows.length + 1;
  curs.forEach(function (c) {
    var per = regions.map(function (r) {
      return round2_(locsInRegion_(r.regionId).reduce(function (t, l) { return t + cashBalance_(l, c); }, 0));
    });
    var bank = round2_(cashBalance_('BANK', c));
    put([c].concat(per).concat([bank,
      round2_(per.reduce(function (t, n) { return t + n; }, 0) + bank)]));
  });
  money.push('B' + kStart + ':' + colLetter_(regions.length + 3) + rows.length);

  paintSheet_(sh, rows, band, head, tot, money, ints);
}

/* ---- Earthly HQ: every season, added up ----

   The first tab of the Earthly HQ file, the spreadsheet twin of the app's
   Summaries Portal: Distribution by Title, Collections by Season, Sales by
   Season, Collections by Payment Type and the Seasonal Warehouse Overview,
   each with a column per season and one for HQ itself. Dollars follow the
   truth (see toUsdAt_): received, else a closed region's or season's frozen
   rates, else today's. The file's other tabs are HQ's own, as for a region. */
var HQ_ALL_TAB = 'All Seasons';
function renderHQSheet_() {
  var ss = regionSpreadsheet_(HQ_REGION);
  var sh = ss.getSheetByName(HQ_ALL_TAB) || ss.insertSheet(HQ_ALL_TAB);

  // One column per season, then Earthly HQ.
  var allRegions = objectsOf_('_regions').filter(function (r) { return r && r.regionId; });
  var units = seasonsAll_().map(function (x) { return { id: String(x.seasonId), name: String(x.name) }; })
    .concat([{ id: HQ_ID, name: 'Earthly HQ' }]);
  var unitOf = {};
  var regionUnit = {};
  allRegions.forEach(function (r) {
    var u = String(r.regionId) === HQ_REGION ? HQ_ID : String(r.seasonId || '');
    regionUnit[String(r.regionId)] = u;
    if (r.whLoc) unitOf[String(r.whLoc)] = u;
  });
  objectsOf_('_events').forEach(function (e) { var u = regionUnit[String(e.regionId || '')]; if (u) unitOf[String(e.eventId)] = u; });
  objectsOf_('_holders').forEach(function (h) {
    if (truthyCell_(h.archived)) return;
    var u = regionUnit[String(h.regionId || '')]; if (u) unitOf[String(h.holderId)] = u;
  });
  var col = {}; units.forEach(function (u, i) { col[u.id] = i; });
  var zeros = function () { return units.map(function () { return 0; }); };
  var sum = function (a) { return a.reduce(function (t, n) { return t + n; }, 0); };

  var sales = tourSales_().filter(function (x) { return col[unitOf[String(x.location)]] !== undefined; });
  var costs = objectsOf_('_costs').filter(function (c) {
    return c && c.id && !String(c.partnerId || '') && col[unitOf[String(c.location)]] !== undefined;
  });
  var invMap = loadInvMap_();

  var rows = [], band = [], head = [], tot = [], money = [], ints = [];
  function put(row) { rows.push(row); return rows.length; }
  function blank() { put(['']); }
  var W = units.length + 2;               // label, one per unit, Total
  var names = units.map(function (u) { return u.name; });

  put(['Transcendental Book Sales \u2014 Earthly HQ \u2014 All Seasons']);
  put(['gop\u012b-bhartu\u1e25 pada-kamalayor d\u0101sa-d\u0101s\u0101nud\u0101sa\u1e25']);
  put(['Last updated', stamp_()]);
  var fx = getRates_();
  put(['Dollars', 'as received where entered; a closed region or season at the rates of the day it closed; '
       + 'otherwise today\u2019s' + (fx.live ? (fx.asOf ? ' (as of ' + fx.asOf + ')' : '') : ' (OFFLINE FALLBACK \u2014 live fetch failed)')]);
  blank();

  /* ---- Headline ---- */
  var totUsd = 0, donUsd = 0, pendUsd = 0, costUsd = 0;
  sales.forEach(function (x) {
    if (received_(x)) { var u = legsUsd_(x); totUsd += u; if (String(x.type) === 'DONATION') donUsd += u; }
    pendUsd += dueUsd_(x);
  });
  costs.forEach(function (c) { costUsd += costUsd_(c); });
  band.push(put(['SUMMARY']));
  head.push(put(['Total collections (USD)', 'Donations (USD)', 'Pending (USD)', 'Costs (USD)', 'Net (USD)']));
  var r0 = put([round2_(totUsd), round2_(donUsd), round2_(pendUsd), round2_(costUsd), round2_(totUsd - costUsd)]);
  tot.push(r0);
  money.push('A' + r0 + ':E' + r0);
  blank();

  /* ---- 1. Distribution by Title ---- */
  band.push(put(['DISTRIBUTION BY TITLE']));
  head.push(put(['Book'].concat(names).concat(['Total'])));
  var tStart = rows.length + 1;
  var colTot = zeros();
  allBooks_().forEach(function (b) {
    var per = zeros();
    sales.forEach(function (x) {
      if (String(x.bookId) !== b.id || (x.type !== 'SALE' && x.type !== 'PREORDER')) return;
      per[col[unitOf[String(x.location)]]]++;
    });
    if (!sum(per)) return;
    per.forEach(function (n, i) { colTot[i] += n; });
    put([b.name].concat(per).concat([sum(per)]));
  });
  tot.push(put(['TOTAL'].concat(colTot).concat([sum(colTot)])));
  ints.push('B' + tStart + ':' + colLetter_(W) + rows.length);
  blank();

  /* ---- 2. Collections by Season ---- */
  var curSeen = {};
  sales.forEach(function (x) { if (received_(x)) eachLeg_(x, function (l) { if (l.amt) curSeen[l.cur] = 1; }); });
  costs.forEach(function (c) { curSeen[String(c.cur)] = 1; });
  var curs = Object.keys(curSeen).sort();
  band.push(put(['COLLECTIONS BY SEASON']));
  head.push(put(['Currency'].concat(names).concat(['Total'])));
  var cStart = rows.length + 1;
  var got = {}; curs.forEach(function (c) { got[c] = zeros(); });
  var usdIn = zeros(), usdCost = zeros();
  sales.forEach(function (x) {
    if (!received_(x)) return;
    var i = col[unitOf[String(x.location)]], f = saleFactor_(x);
    eachLeg_(x, function (l) {
      if (!l.amt || l.type === 'Gift') return;
      got[l.cur][i] += l.amt;
      usdIn[i] += legTruthUsd_(x, l, f);
    });
  });
  curs.forEach(function (c) {
    var per = got[c].map(round2_);
    put([c].concat(per).concat([round2_(sum(got[c]))]));
  });
  costs.forEach(function (c) { usdCost[col[unitOf[String(c.location)]]] += costUsd_(c); });
  tot.push(put(['Collected (USD)'].concat(usdIn.map(round2_)).concat([round2_(sum(usdIn))])));
  put(['Costs (USD)'].concat(usdCost.map(function (n) { return round2_(-n); })).concat([round2_(-sum(usdCost))]));
  var net = usdIn.map(function (n, i) { return n - usdCost[i]; });
  tot.push(put(['Net (USD)'].concat(net.map(round2_)).concat([round2_(sum(net))])));
  money.push('B' + cStart + ':' + colLetter_(W) + rows.length);
  blank();

  /* ---- 3. Sales by Season ---- */
  band.push(put(['SALES BY SEASON']));
  head.push(put([''].concat(names).concat(['Total'])));
  var sStart = rows.length + 1;
  [['SALE', 'Sold'], ['PREORDER', 'Pre-ordered'], ['DONATION', 'Donations']].forEach(function (pr) {
    var per = zeros();
    sales.forEach(function (x) { if (String(x.type) === pr[0]) per[col[unitOf[String(x.location)]]]++; });
    put([pr[1]].concat(per).concat([sum(per)]));
  });
  ints.push('B' + sStart + ':' + colLetter_(W) + rows.length);
  blank();

  /* ---- 4. Collections by Payment Type ---- */
  band.push(put(['COLLECTIONS BY PAYMENT TYPE (USD)']));
  head.push(put(['Type'].concat(names).concat(['Total'])));
  var pStart = rows.length + 1;
  var byType = {};
  sales.forEach(function (x) {
    if (!received_(x)) return;
    var i = col[unitOf[String(x.location)]], f = saleFactor_(x);
    eachLeg_(x, function (l) {
      if (!l.amt || l.type === 'Gift') return;
      (byType[l.type] = byType[l.type] || zeros())[i] += legTruthUsd_(x, l, f);
    });
  });
  var pTot = zeros();
  Object.keys(byType).sort().forEach(function (t) {
    byType[t].forEach(function (n, i) { pTot[i] += n; });
    put([t].concat(byType[t].map(round2_)).concat([round2_(sum(byType[t]))]));
  });
  tot.push(put(['TOTAL'].concat(pTot.map(round2_)).concat([round2_(sum(pTot))])));
  money.push('B' + pStart + ':' + colLetter_(W) + rows.length);
  blank();

  /* ---- 5. Seasonal Warehouse Overview ---- */
  band.push(put(['SEASONAL WAREHOUSE OVERVIEW (books on hand)']));
  head.push(put(['Book'].concat(names).concat(['Total'])));
  var wStart = rows.length + 1;
  var places = Object.keys(unitOf);
  var wTot = zeros();
  allBooks_().forEach(function (b) {
    var per = zeros();
    places.forEach(function (l) { per[col[unitOf[l]]] += getQty_(invMap, l, b.id); });
    if (!sum(per)) return;
    per.forEach(function (n, i) { wTot[i] += n; });
    put([b.name].concat(per).concat([sum(per)]));
  });
  tot.push(put(['TOTAL'].concat(wTot).concat([sum(wTot)])));
  ints.push('B' + wStart + ':' + colLetter_(W) + rows.length);

  paintSheet_(sh, rows, band, head, tot, money, ints);
  try { orderTabs_(HQ_REGION); } catch (e) { /* the tabs keep their order */ }
}

function renderView_(loc, regionId, ssOverride) {
  // Three kinds of tab now:
  //   Summary   — aggregates the REGION; stock + money only, no sales logs.
  //   Warehouse — an ordinary location tab for sales made directly at the
  //               region's warehouse, exactly like an event.
  //   Event     — one event.
  // Each region renders into its own spreadsheet, so a regional team only ever
  // sees their own file.
  var isSummary = (loc === SUMMARY);
  var region = regionId ? regionById_(regionId) : (regionsOrdered_()[0] || null);
  if (!region) return;
  var regionWh = region.whLoc;
  var isWarehouse = (loc === regionWh);
  var whName = region.name;
  var tabName = isSummary ? 'Summary'
              : isWarehouse ? (whName + ' — Warehouse Sales')
              : displayTabName_((eventById_(loc) || { name: loc }).name);

  var ss = ssOverride || regionSpreadsheet_(region.regionId);
  var sh = ss.getSheetByName(tabName) || ss.insertSheet(tabName);
  // Cleared inside paintSheet_, immediately before the write — see above.

  var regionLocs = locsInRegion_(region.regionId);
  var inRegion = {}; regionLocs.forEach(function (l) { inRegion[l] = 1; });
  // Only this region's records reach this file.
  var sales = tourSales_().filter(function (s) { return inRegion[String(s.location)]; });
  var scoped = isSummary ? sales : sales.filter(function (s) { return String(s.location) === loc; });
  var invMap = loadInvMap_();
  var rmap = reservedMap_(objectsOf_('_sales'));
  var stockLoc = isSummary ? regionWh : loc;

  // Built once. locLabel_ reads two sheets every time it is called, and the
  // master tab needs a label for every row in the log — that alone was enough
  // to push this render past its time budget and leave the tab unwritten.
  var evName = {};
  var evIds = [];
  objectsOf_('_events').forEach(function (e) {
    if (String(e.regionId || '') !== region.regionId) return;
    evName[String(e.eventId)] = String(e.name); evIds.push(String(e.eventId));
  });

  // Every physical copy still in the region for a title: the warehouse plus all
  // event tables. This is what "unsold in the region" counts.
  function regionStock_(bookId) {
    // Everywhere the region's books actually are: its warehouse, its events, and
    // whatever devotees are storing at home.
    var t = getQty_(invMap, regionWh, bookId);
    evIds.forEach(function (id) { t += getQty_(invMap, id, bookId); });
    holdersOfRegion_(region.regionId).forEach(function (h) {
      t += getQty_(invMap, h.holderId, bookId);
    });
    return t;
  }
  var whLabel = whName + ' (Warehouse)';
  var label_ = function (l) { return l === regionWh ? whLabel : (evName[l] || l); };

  var rows = [];
  var band = [];    // dark section headers
  var head = [];    // pale table headers
  var tot  = [];    // emphasised total lines
  var money = [];   // ranges to format as 2dp numbers

  function put(row) { rows.push(row); return rows.length; }
  function blank() { rows.push([]); }

  /* ---- Masthead ---- */
  var title = isSummary ? (whName + ' — Summary (all locations)')
            : isWarehouse ? (whName + ' — Warehouse Sales')
            : (eventById_(loc) || { name: loc }).name;
  put(['Transcendental Book Sales — ' + title]);
  put(['gopī-bhartuḥ pada-kamalayor dāsa-dāsānudāsaḥ']);
  put(['Last updated', stamp_()]);
  var fx = getRates_();
  // A closed region keeps the rates of the day it closed.
  var regFx = ratesForLoc_(region.whLoc);
  var perOf = function (c) { return regFx && Number(regFx[c]) > 0 ? Number(regFx[c]) : perUsd_(c); };
  // Show the rate for whatever currencies THIS region actually deals in.
  put([(regFx ? 'Exchange rates — FROZEN when this region closed'
        : fx.frozen ? 'Exchange rates — FROZEN when this season closed'
        : fx.live ? 'Exchange rates — LIVE' : 'Exchange rates — OFFLINE FALLBACK (live fetch failed)'),
       '$1 = ' + (region.currencies || []).filter(function (c) { return c !== 'USD'; })
         .map(function (c) { return round2_(perOf(c)) + ' ' + c; }).join(' / ')
       + (!regFx && fx.live && fx.asOf ? '  (as of ' + fx.asOf + ')' : '')]);
  blank();

  /* ---- Counts, split big books vs AoTM ---- */
  function count(type, cat) {
    return scoped.filter(function (s) {
      return s.type === type && s.bookId && catOf_(String(s.bookId)) === cat;
    }).length;
  }
  var bigSold = count('SALE', 'big'),  bigPre = count('PREORDER', 'big');
  var aotmSold = count('SALE', 'aotm'), aotmPre = count('PREORDER', 'aotm');

  var totalUsd = 0, pendingUsd = 0, donationUsd = 0;
  scoped.forEach(function (s) {
    // A partly paid sale contributes to both columns at once.
    if (received_(s)) {
      var usd = legsUsd_(s);
      totalUsd += usd;
      if (s.type === 'DONATION') donationUsd += usd;
    }
    pendingUsd += dueUsd_(s);
  });

  band.push(put(['SUMMARY']));
  head.push(put(['', 'Sold', 'Pre-ordered', 'Total']));
  put(['Big Books', bigSold, bigPre, bigSold + bigPre]);
  put(['AoTM (Adventures)', aotmSold, aotmPre, aotmSold + aotmPre]);
  tot.push(put(['All titles', bigSold + aotmSold, bigPre + aotmPre, bigSold + aotmSold + bigPre + aotmPre]));
  blank();

  head.push(put(['Total collections (USD)', 'Donations (USD)', 'Pending (USD)']));
  var r = put([round2_(totalUsd), round2_(donationUsd), round2_(pendingUsd)]);
  tot.push(r);
  money.push('A' + r + ':C' + r);
  blank();

  /* ---- Physical stock ----
     Summary: the region-wide picture you asked for, per title —
       In Warehouse · At Events · Total Unsold · Total Sold · Total
     Location tab: just what is on this table right now. */
  function invBlock(label, list, withTotal) {
    band.push(put([label]));
    if (isSummary) {
      // "In Transit" is what is still traveling here — expected, not yet stock.
      head.push(put(['Book', 'In Warehouse', 'At Events', 'With Devotees',
                     'Total Unsold', 'In Transit', 'Expected Total', 'Total Sold', 'Total']));
      var sWh = 0, sEv = 0, sHold = 0, sUnsold = 0, sTransit = 0, sSold = 0, sAll = 0;
      var inbound = shipmentsInbound_(region.regionId);
      var holderLocs = holdersOfRegion_(region.regionId).map(function (h) { return h.holderId; });
      list.forEach(function (b) {
        var wh = getQty_(invMap, regionWh, b.id);
        var inRegionTotal = regionStock_(b.id);
        var withHolders = holderLocs.reduce(function (t, l) { return t + getQty_(invMap, l, b.id); }, 0);
        var atEvents = inRegionTotal - wh - withHolders;
        var transit = inbound.reduce(function (t, x) { return t + getQty_(invMap, x.shipId, b.id); }, 0);
        // Every sale of this title...
        var sold = sales.filter(function (s) { return s.type === 'SALE' && s.bookId === b.id; }).length;
        // ...but a pre-order fulfilled from OUTSIDE the region was never part of
        // our stock, so it must not inflate the regional total.
        var soldFromRegion = sales.filter(function (s) {
          return s.type === 'SALE' && s.bookId === b.id && !fromOutside_(s);
        }).length;
        sWh += wh; sEv += atEvents; sHold += withHolders; sUnsold += inRegionTotal;
        sTransit += transit; sSold += sold; sAll += inRegionTotal + soldFromRegion;
        put([b.name, wh, atEvents, withHolders, inRegionTotal, transit,
             inRegionTotal + transit, sold, inRegionTotal + soldFromRegion]);
      });
      if (withTotal) tot.push(put(['TOTAL ' + label, sWh, sEv, sHold, sUnsold, sTransit,
                                   sUnsold + sTransit, sSold, sAll]));
    } else {
      head.push(put(['Book', 'In stock here', 'Pre-ordered', 'Available', 'Sold', 'Status']));
      var sumHand = 0, sumPre = 0, sumAvail = 0, sumSold = 0;
      list.forEach(function (b) {
        var onHand = getQty_(invMap, stockLoc, b.id);
        var held = getReserved_(rmap, stockLoc, b.id);
        var avail = Math.max(0, onHand - held);
        var sold = scoped.filter(function (s) { return s.type === 'SALE' && s.bookId === b.id; }).length;
        sumHand += onHand; sumPre += held; sumAvail += avail; sumSold += sold;
        var status = avail <= 0 ? (onHand > 0 ? 'ALL PRE-ORDERED' : 'SOLD OUT')
                                : (avail === 1 ? 'DISPLAY BOOK (last copy)' : '');
        put([b.name, onHand, held, avail, sold, status]);
      });
      if (withTotal) tot.push(put(['TOTAL ' + label, sumHand, sumPre, sumAvail, sumSold, '']));
    }
    blank();
  }
  invBlock('BIG BOOKS', bigBooks_(), true);
  invBlock('AoTM — ADVENTURES', aotmBooks_(), false);

  /* ---- Cash on hand (Summary only): where physical cash and bank money sits.
     One row per account, a column per currency, folded from the cash ledger. */
  if (isSummary) {
    var cashAccts = [{ id: regionWh, name: whName }];
    evIds.forEach(function (id) { cashAccts.push({ id: id, name: evName[id] }); });
    // Not the bank's balance — what this region has sent there.
    cashAccts.push({ id: regionBankId_(region.regionId), name: bankLabel_(regionBankId_(region.regionId)) });
    cashAccts.push({ id: 'BANK', name: 'Global bank', bankOf: region.regionId });
    // A column for every currency in the season — London's pounds were missing
    // when this was fixed at PLN/EUR/USD.
    var cashCurs = allCurrencies_();
    // Show the section if any cash has moved OR any cash was collected anywhere.
    var anyCash = objectsOf_('_cash').length > 0 || cashAccts.some(function (a) {
      return cashCurs.some(function (c) { return cashCollected_(a.id, c); });
    });
    if (anyCash) {
      band.push(put(['CASH ON HAND']));
      head.push(put(['Account'].concat(cashCurs)));
      var cashStart = rows.length + 1;
      function acctAmt(a, cur) {
        return a.bankOf ? bankFromRegion_(a.bankOf, cur) : cashBalance_(a.id, cur);
      }
      cashAccts.forEach(function (a) {
        put([a.name].concat(cashCurs.map(function (c) { return acctAmt(a, c); })));
      });
      // totals row
      tot.push(put(['TOTAL'].concat(cashCurs.map(function (c) {
        return round2_(cashAccts.reduce(function (t, a) { return t + acctAmt(a, c); }, 0));
      }))));
      money.push('B' + cashStart + ':' + colLetter_(cashCurs.length + 1) + (cashStart + cashAccts.length));
      blank();
    }
  }

  /* ---- Money by currency ---- */
  band.push(put(['COLLECTIONS BY CURRENCY']));
  head.push(put(['Currency', 'Books & pre-orders', 'Donations', 'Total collected', 'USD equivalent']));
  var curStart = rows.length + 1;
  allCurrencies_().forEach(function (cur) {
    var bookAmt = 0, donAmt = 0, usdAmt = 0;
    scoped.forEach(function (s) {
      if (!received_(s)) return;
      eachLeg_(s, function (leg) {
        if (leg.cur !== cur) return;
        if (s.type === 'DONATION') donAmt += leg.amt; else bookAmt += leg.amt;
        usdAmt += legTruthUsd_(s, leg);
      });
    });
    var total = bookAmt + donAmt;
    put([cur, round2_(bookAmt), round2_(donAmt), round2_(total), round2_(usdAmt)]);
  });
  money.push('B' + curStart + ':E' + (rows.length));
  blank();

  /* ---- Money by kind of book ----

     What each kind of title actually brought in, currency by currency. The
     section above answers "how much came in"; this one answers "from what".
     Donations belong to no title, so they get their own line rather than being
     folded into Big Books and quietly inflating it. */
  band.push(put(['COLLECTIONS BY BOOK TYPE']));
  var curList = allCurrencies_();
  head.push(put(['Type'].concat(curList).concat(['USD equivalent'])));
  var typeStart = rows.length + 1;

  var KINDS = [['big', 'Big Books'], ['aotm', 'Adventures'], ['other', 'Other']];
  var totalsByCur = {}, totalUsdEq = 0;
  curList.forEach(function (c) { totalsByCur[c] = 0; });

  KINDS.forEach(function (pair) {
    var kind = pair[0];
    var byCur = {}, usdEq = 0;
    curList.forEach(function (c) { byCur[c] = 0; });
    scoped.forEach(function (s) {
      if (!received_(s) || s.type === 'DONATION' || !s.bookId) return;
      var b = bookById_(s.bookId);
      if (!b || normCat_(b.cat) !== kind) return;
      eachLeg_(s, function (leg) {
        if (byCur[leg.cur] === undefined) return;
        byCur[leg.cur] += leg.amt; totalsByCur[leg.cur] += leg.amt;
        var u = legTruthUsd_(s, leg); usdEq += u; totalUsdEq += u;
      });
    });
    put([pair[1]].concat(curList.map(function (c) { return round2_(byCur[c]); }))
        .concat([round2_(usdEq)]));
  });

  // Donations, kept separate because they are not a book sale.
  var donByCur = {}, donUsdEq = 0;
  curList.forEach(function (c) { donByCur[c] = 0; });
  scoped.forEach(function (s) {
    if (!received_(s) || s.type !== 'DONATION') return;
    eachLeg_(s, function (leg) {
      if (donByCur[leg.cur] === undefined) return;
      donByCur[leg.cur] += leg.amt; totalsByCur[leg.cur] += leg.amt;
      var u = legTruthUsd_(s, leg); donUsdEq += u; totalUsdEq += u;
    });
  });
  put(['Donations'].concat(curList.map(function (c) { return round2_(donByCur[c]); }))
      .concat([round2_(donUsdEq)]));

  put(['Total'].concat(curList.map(function (c) { return round2_(totalsByCur[c]); }))
      .concat([round2_(totalUsdEq)]));

  money.push('B' + typeStart + ':' + colLetter_(curList.length + 2) + (typeStart + KINDS.length + 1));
  blank();

  /* ---- Money by payment type ---- */
  band.push(put(['COLLECTIONS BY PAYMENT TYPE']));
  // Every currency in the season, as in the tables above (not just PLN/EUR/USD).
  var payCurs = allCurrencies_();
  head.push(put(['Type'].concat(payCurs).concat(['USD equivalent'])));
  var payStart = rows.length + 1;
  PAY_TYPES.forEach(function (t) {
    var byCur = {}, usdEq = 0;
    payCurs.forEach(function (c) { byCur[c] = 0; });
    scoped.forEach(function (s) {
      if (!received_(s)) return;
      eachLeg_(s, function (leg) {
        if (leg.type === t && byCur[leg.cur] !== undefined) { byCur[leg.cur] += leg.amt; usdEq += legTruthUsd_(s, leg); }
      });
    });
    put([t].concat(payCurs.map(function (c) { return round2_(byCur[c]); })).concat([round2_(usdEq)]));
  });
  money.push('B' + payStart + ':' + colLetter_(payCurs.length + 2) + (payStart + PAY_TYPES.length - 1));
  blank();

  /* ---- Costs, and what was kept after them (Summary only) ----

     Card-machine fees and other costs of selling, recorded in the app against
     a place in this region. Listed one by one, totaled by currency, then set
     against what was collected to give the net. Consignment money is not ours,
     so — as in the collections above — it is not part of the net either. */
  if (isSummary) {
    var costCurs = allCurrencies_();
    var regionCosts = objectsOf_('_costs')
      // Our own costs only: a consignment group's costs come off what it is owed.
      .filter(function (c) { return c && c.id && inRegion[String(c.location)] && !String(c.partnerId || ''); })
      .sort(function (a, b) { return new Date(a.ts) - new Date(b.ts); });

    band.push(put(['COSTS']));
    if (!regionCosts.length) {
      put(['No costs recorded.']);
    } else {
      head.push(put(['When', 'What for', 'Payment type', 'Where', 'Note'].concat(costCurs).concat(['USD equivalent'])));
      var costStart = rows.length + 1;
      var costTotal = {}, costUsd = 0; costCurs.forEach(function (c) { costTotal[c] = 0; });
      regionCosts.forEach(function (c) {
        var cur = String(c.cur), amt = Number(c.amt) || 0;
        if (costTotal[cur] !== undefined) { costTotal[cur] += amt; costUsd += costUsd_(c); }
        put([c.ts, String(c.category || 'Other'), String(c.payType || ''), locLabel_(String(c.location)),
             String(c.note || '')]
          .concat(costCurs.map(function (k) { return k === cur ? round2_(amt) : 0; }))
          .concat([round2_(costUsd_(c))]));
      });
      put(['Total costs', '', '', '', ''].concat(costCurs.map(function (k) { return round2_(costTotal[k]); }))
        .concat([round2_(costUsd)]));
      money.push(colLetter_(6) + costStart + ':' + colLetter_(6 + costCurs.length) + (costStart + regionCosts.length));
      blank();

      // What was kept: collected (our own sales, received) less the costs.
      var got = {}, gotUsd = 0; costCurs.forEach(function (k) { got[k] = 0; });
      scoped.forEach(function (sl) {
        if (!received_(sl)) return;
        eachLeg_(sl, function (leg) { if (got[leg.cur] !== undefined) { got[leg.cur] += leg.amt; gotUsd += legTruthUsd_(sl, leg); } });
      });
      band.push(put(['NET AFTER COSTS']));
      head.push(put([''].concat(costCurs).concat(['USD equivalent'])));
      var netStart = rows.length + 1;
      put(['Collected'].concat(costCurs.map(function (k) { return round2_(got[k]); })).concat([round2_(gotUsd)]));
      put(['Costs'].concat(costCurs.map(function (k) { return round2_(-costTotal[k]); })).concat([round2_(-costUsd)]));
      put(['Net'].concat(costCurs.map(function (k) { return round2_(got[k] - costTotal[k]); }))
        .concat([round2_(gotUsd - costUsd)]));
      money.push('B' + netStart + ':' + colLetter_(2 + costCurs.length) + (netStart + 2));
    }
    blank();
  }

  /* ---- The Summary is a pure aggregator: stock and money only, no per-sale
     logs. Everything below belongs to a location tab. ---- */
  if (!isSummary) {

  /* ---- Pre-orders still to hand over ---- */
  var owed = scoped.filter(function (s) { return s.type === 'PREORDER' && !isDelivered_(s); });
  band.push(put(['PRE-ORDERS AWAITING DELIVERY']));
  head.push(put(['Book', 'Paid?', 'Payment type', 'Amount', 'Name', 'Phone', 'Ordered']));
  if (!owed.length) {
    put(['Nothing awaiting delivery.']);
  } else {
    owed.forEach(function (s) {
      var b = bookById_(s.bookId) || { name: s.bookId };
      var payState = isPaid_(s) ? 'PAID'
        : (pendingFlag_(s) ? 'AWAITING PAYMENT'
                           : 'PART PAID — ' + dueAmt_(s) + ' ' + dueCur_(s) + ' OWED');
      put([b.name, payState, payTypes_(s), payAmounts_(s), s.name, phoneCell_(s.phone), s.ts]);
    });
  }
  blank();

  /* ---- Pending ---- */
  var pendingRows = scoped.filter(function (s) { return !isPaid_(s); });
  band.push(put(['PENDING PAYMENTS']));
  head.push(put(['Item', 'What They Still Owe', 'Currency', 'Already paid', 'Name', 'Phone', 'When']));
  if (!pendingRows.length) {
    put(['Nothing outstanding.']);
  } else {
    pendingRows.forEach(function (s) {
      var label = s.type === 'DONATION'
        ? 'Donation'
        : ((bookById_(s.bookId) || { name: s.bookId }).name + (s.type === 'PREORDER' ? ' (pre-order)' : ''));
      var banked = received_(s) ? payAmounts_(s) : '';
      outstanding_(s).forEach(function (d) {
        put([label, d.amt, d.cur, banked, s.name, phoneCell_(s.phone), s.ts]);
      });
    });
  }
  blank();

  /* ---- Logs ---- */
  band.push(put(['SALES LOG — BOOKS']));
  head.push(put(['Book', 'Category', 'Payment type', 'Amount', 'USD equivalent', 'Pending?',
                 'Pre-order', 'Name', 'Phone', 'Comments', 'When', 'Recorded by']));
  logRows_(scoped, 'SALE').forEach(put);
  blank();

  band.push(put(['SALES LOG — PRE-ORDERS']));
  head.push(put(['Book', 'Category', 'Payment type', 'Amount', 'USD equivalent', 'Pending?',
                 'Name', 'Phone', 'When', 'Recorded by']));
  logRows_(scoped, 'PREORDER').forEach(put);
  blank();

  band.push(put(['SALES LOG — DONATIONS']));
  head.push(put(['Payment type', 'Amount', 'USD equivalent', 'Name', 'Phone', 'Comments', 'When', 'Recorded by']));
  scoped.filter(function (s) { return s.type === 'DONATION'; }).forEach(function (s) {
    put([payTypes_(s), payAmounts_(s), round2_(legsUsd_(s)), s.name, phoneCell_(s.phone),
         s.comments, s.ts, s.soldBy || '']);
  });

  } // end if (!isSummary)

  paintSheet_(sh, rows, band, head, tot, money);
}

/**
 * Puts the readable tabs in a predictable left-to-right order: warehouse first,
 * then events in the order they were created. New sheets otherwise land wherever
 * Google inserts them, which is usually beside whatever tab was active.
 *
 * Anything else in the Sheet — tabs you made by hand — is left alone and simply
 * ends up to the right of ours.
 */
function orderTabs_(regionId) {
  var reg = regionId ? regionById_(regionId) : regionsOrdered_()[0];
  if (!reg) return;
  var ss = regionSpreadsheet_(reg.regionId);
  var wanted = ['Summary', reg.name + ' — Warehouse Sales'];
  if (reg.regionId === HQ_REGION) wanted.unshift(HQ_ALL_TAB);
  eventsOrdered_().forEach(function (e) {
    if (String(e.regionId || '') !== reg.regionId) return;
    wanted.push(displayTabName_(String(e.name)));
  });

  var active = ss.getActiveSheet();
  var pos = 1;
  wanted.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh || sh.isSheetHidden()) return;
    if (sh.getIndex() !== pos) {
      ss.setActiveSheet(sh);
      ss.moveActiveSheet(pos);
    }
    pos++;
  });
  removeStaleRegionTabs_(ss, wanted);
  // Leave whoever was looking at the Sheet where they were.
  try { if (active && !active.isSheetHidden()) ss.setActiveSheet(active); } catch (e) { /* it was removed */ }
}

/* Remove tabs this app made that no longer belong in the file.

   Tabs are named after their region and events, so renaming a region (Poland to
   Warsaw, Macedonia to Skopje) or an event started a tab under the new name and
   left the old one behind, frozen at its last update. A tab is only removed if
   the app itself wrote it — its first cell reads "Transcendental Book Sales —" —
   so anything you added yourself is never touched. The blank "Sheet1" Google
   creates with a new file goes too, but only while it is empty. */
function removeStaleRegionTabs_(ss, wanted) {
  var keep = {}; wanted.forEach(function (n) { keep[n] = 1; });
  var DEFAULT_NAME = /^(Sheet|Blad|Tabelle|Hoja|Feuille|Foglio|Planilha|Arkusz|Лист)\s?\d+$/i;
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (keep[name]) return;
    if (ss.getSheets().length <= 1) return;          // a file must keep one tab
    var ours = false, empty = false;
    try {
      ours = /^Transcendental Book Sales — /.test(String(sh.getRange(1, 1).getValue()));
      empty = DEFAULT_NAME.test(name) && sh.getLastRow() === 0;
    } catch (e) { return; }
    if (ours || empty) {
      try { ss.deleteSheet(sh); } catch (e) { /* leave it rather than fail the sync */ }
    }
  });
}

function logRows_(scoped, type) {
  return scoped.filter(function (s) { return s.type === type; }).map(function (s) {
    var b = bookById_(s.bookId) || { name: s.bookId, cat: 'big' };
    var cat = b.cat === 'aotm' ? 'AoTM' : (b.cat === 'other' ? 'Other' : 'Big Book');
    var row = [b.name, cat, payTypes_(s), payAmounts_(s), round2_(legsUsd_(s)),
               isPaid_(s) ? '' : (pendingFlag_(s) ? 'PENDING'
                 : 'PART PAID — ' + dueAmt_(s) + ' ' + dueCur_(s) + ' owed')];
    // No more double-marking. The Pre-order column just says FULFILLED; the
    // source (which warehouse the copy came from) goes in the comments, in front
    // of anything the user typed. Display only — the stored comment is untouched,
    // since these tabs are rebuilt from the hidden data each sync.
    if (type === 'SALE') {
      var isFilled = isDelivery_(s);
      var source = !isFilled ? '' :
        (fromOutside_(s) ? 'Sourced from outside the region'
                         : (deliveredFrom_(s) ? locLabel_(deliveredFrom_(s)) : 'Own stock'));
      var shownComments = source
        ? (s.comments ? source + ' · ' + s.comments : source)
        : s.comments;
      row = row.concat([isFilled ? 'FULFILLED' : '', s.name, phoneCell_(s.phone), shownComments,
                        s.ts, s.soldBy || '']);
    } else {
      row = row.concat([s.name, phoneCell_(s.phone), s.ts, s.soldBy || '']);
    }
    return row;
  });
}

/* ============================ ACTIVITY LOG ============================
   One record of everything done in the app except sales (they keep their own
   log). Every write is described in plain words as it happens — by the server,
   so nothing can slip past because a screen forgot to log it — and, where it
   is safe, carries what is needed to undo it. "Delete" in the log means undo. */

var ACTIVITY_HEADERS = ['id','ts','season','who','action','text','locs','regions','moves','undo','undoneAt','undoneBy',
                        'parts','undoneParts'];
/* Sales have their own log; these are not repeated here. */
var ACTIVITY_SKIP = {
  sell:1, sellBundle:1, deleteBundle:1, markPaidBundle:1, markDeliveredBundle:1, editBundle:1,
  donate:1, editSale:1, deleteSale:1, markPaid:1, markDelivered:1, giveChange:1, setUsdActual:1,
  settle:1, deliver:1, undoActivity:1, undoActivityPart:1, saveCloseDraft:1
};
var _cashIds = [];            // cash rows written by the current request
var _activityBefore = null;   // what a change replaced, noted just before it runs

function activitySheet_() {
  return dbCreate_('_activity', ACTIVITY_HEADERS);
}

/* The region a place belongs to, in any season: warehouse, event, sub-warehouse. */
function regionOfAnyLoc_(loc) {
  loc = String(loc || '');
  if (!loc) return '';
  var r = allRegionsEverywhere_().filter(function (x) { return x.whLoc === loc; })[0];
  if (r) return r.regionId;
  var ev = objectsOf_('_events').filter(function (e) { return String(e.eventId) === loc; })[0];
  if (ev) return String(ev.regionId || '');
  var h = objectsOf_('_holders').filter(function (x) { return String(x.holderId) === loc; })[0];
  if (h) return String(h.regionId || '');
  return '';
}
function bookName_(id) { var b = bookById_(id); return b ? b.name : 'a title'; }
function plural_(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
function titlesText_(byBook) {
  return Object.keys(byBook).map(function (id) { return bookName_(id) + ' ×' + byBook[id]; }).join(', ');
}
/* Stock movements in words, as the log's headline: how many books, what
   happened, and where — "49 Books Transferred from Poland (Warehouse) to
   Summer Festival", "12 Books Added to Italy (Warehouse)", "3 Books Subtracted
   from …". Which titles they were is the entry's dropdown (partsJson_), so it
   is not repeated here. Transferred = the Transfer protocol; Added and
   Subtracted = Add Stock (and closing counts). */
function booksN_(n) { return n + ' Book' + (n === 1 ? '' : 's'); }
function namesList_(names) {
  if (names.length < 2) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}
function movesText_(moves) {
  var out = [];
  var byLoc = {}, locOrder = [];
  moves.filter(function (m) { return m.kind === 'ADJUST'; }).forEach(function (m) {
    if (!byLoc[m.to]) { byLoc[m.to] = { up: 0, down: 0 }; locOrder.push(m.to); }
    if (m.qty > 0) byLoc[m.to].up += m.qty; else byLoc[m.to].down -= m.qty;
  });
  locOrder.forEach(function (loc) {
    if (byLoc[loc].up) out.push(booksN_(byLoc[loc].up) + ' Added to ' + locLabel_(loc));
    if (byLoc[loc].down) out.push(booksN_(byLoc[loc].down) + ' Subtracted from ' + locLabel_(loc));
  });
  var xfers = moves.filter(function (m) { return m.kind === 'TRANSFER'; });
  if (xfers.length) {
    var total = 0, froms = [], tos = [];
    xfers.forEach(function (m) {
      total += m.qty;
      if (froms.indexOf(m.from) < 0) froms.push(m.from);
      if (tos.indexOf(m.to) < 0) tos.push(m.to);
    });
    out.push(booksN_(total) + ' Transferred from ' + namesList_(froms.map(locLabel_)) + ' to ' + namesList_(tos.map(locLabel_)));
  }
  return out.join('; ');
}

/* The entry's dropdown: one line per title — just the title and how many.
   Where they went is already the headline. */
function partsJson_(moves) {
  var by = {}, order = [];
  moves.forEach(function (m) {
    if (!by[m.bookId]) { by[m.bookId] = []; order.push(m.bookId); }
    by[m.bookId].push(m);
  });
  if (!order.length) return '';
  return JSON.stringify(order.map(function (b) {
    var ms = by[b], n = ms.reduce(function (t, m) { return t + Math.abs(m.qty); }, 0);
    return { id: 'b:' + b, ids: ms.map(function (m) { return m.id; }), text: bookName_(b) + ' ×' + n };
  }));
}
/* A line written before b197 ("Sri Radha ×6 transferred → Festival"), trimmed
   to the same title-and-count. */
function partText_(t) {
  var m = String(t || '').match(/^(.*? ×\d+)(?: (?:transferred|added|removed)\b[\s\S]*)?$/);
  return m ? m[1] : String(t || '');
}

/* One movement in words, for the lines inside a multi-line entry. */
function moveLine_(m) {
  if (m.kind === 'ADJUST') return (m.qty > 0 ? 'Added ' : 'Removed ') + Math.abs(m.qty) + ' × ' + bookName_(m.bookId) + ' at ' + locLabel_(m.to);
  return m.qty + ' × ' + bookName_(m.bookId) + ': ' + locLabel_(m.from) + ' → ' + locLabel_(m.to);
}

/* Noted just before a change runs, for the few things whose undo needs it. */
function activityBefore_(action, p) {
  _activityBefore = null;
  try {
    if (action === 'saveLabel') {
      var hit = objectsOf_('_labels').filter(function (r) { return String(r.key) === String(p.key); })[0];
      _activityBefore = { text: hit ? String(hit.text) : '' };
    }
    if (action === 'saveCost') {
      var cid = String(p.id || '');
      _activityBefore = { existed: !!cid && dbHas_('_costs') &&
        objectsOf_('_costs').some(function (c) { return String(c.id) === cid; }) };
    }
    if (action === 'regionAddBooks') {
      var r = regionById_(String(p.regionId || ''));
      _activityBefore = { books: r ? (r.books || []).slice() : [] };
    }
  } catch (e) { _activityBefore = null; }
}

/* What was done, in words; where; and how to undo it (null = not safely). */
function describe_(action, p, result, moves, who) {
  who = who || { role: 'admin' };
  var mv = movesText_(moves);
  var ids = moves.map(function (m) { return m.id; });
  var locs = {};
  moves.forEach(function (m) { if (m.from) locs[m.from] = 1; if (m.to) locs[m.to] = 1; });
  ['location', 'from', 'to', 'fromLoc', 'toLoc', 'eventId'].forEach(function (f) { if (p[f]) locs[String(p[f])] = 1; });
  var regions = {};
  ['regionId', 'fromRegion', 'toRegion'].forEach(function (f) {
    if (p[f] && p[f] !== OUTSIDE_ORIGIN) regions[String(p[f])] = 1; });
  var note = p.note ? ' — “' + String(p.note) + '”' : '';
  var movesUndo = ids.length ? { type: 'moves', ids: ids } : null;
  var reg = function (id) { var r = regionById_(String(id || '')); return r ? r.name : 'a region'; };
  var d = { text: '', undo: null };

  switch (action) {
    case 'adjustStockBulk': case 'setStockBulk': case 'transferBulk': case 'transferMulti':
    case 'transferExternal': case 'seasonTransfer':
      d = { text: (mv || 'Stock changed') + note, undo: movesUndo }; break;
    case 'undoStockMove':
      d = { text: 'Undid a stock movement from the old transfer record', undo: null }; break;
    case 'sendShipment':
      if (String(p.mode) === 'direct' || !result) { d = { text: (mv || 'Stock sent') + note, undo: movesUndo }; break; }
      var sent = {}; (p.items || []).forEach(function (it) { sent[it.bookId] = (sent[it.bookId] || 0) + (Number(it.qty) || 0); });
      var total = Object.keys(sent).reduce(function (t, k) { return t + sent[k]; }, 0);
      var how = String(p.mode) === 'shipping' ? ('by shipping company' + (p.tracking ? ' (tracking ' + p.tracking + ')' : ''))
                                               : ('with ' + (p.carrier || 'a devotee'));
      d = { text: 'Put ' + plural_(total, 'book') + ' in transit (' + titlesText_(sent) + ') from ' +
                  (String(p.fromRegion) === OUTSIDE_ORIGIN ? 'outside the tour' : reg(p.fromRegion)) + ' → ' +
                  (p.toLoc ? locLabel_(p.toLoc) : reg(p.toRegion)) + ', ' + how + note,
            undo: { type: 'ship', shipId: String(result) } };
      break;
    case 'receiveShipment':
      d = { text: 'Books arrived: ' + (mv || 'nothing') + note, undo: ids.length ? { type: 'receive', shipId: String(p.shipId), ids: ids } : null }; break;
    case 'adjustShipment': d = { text: 'Corrected what a shipment holds: ' + (mv || 'no change') + note }; break;
    case 'deleteShipment': d = { text: 'Deleted a shipment' + (mv ? ': ' + mv : '') }; break;
    case 'setFulfilBy': {
      var fs = saleRowById_(p.remoteSaleId), fo = fs ? fs.o : {};
      var what = bookName_(String(fo.bookId || '')) + (fo.name ? ' for ' + fo.name : '') + ', ordered at ' + placePath_(fo.location);
      d = { text: p.fulfilBy ? ('Asked ' + placePath_((regionById_(p.fulfilBy) || {}).whLoc) + ' to fulfill a pre-order: ' + what)
                             : ((p.declined || who.role !== 'admin' ? 'Declined' : 'Withdrew') + ' the request to fulfill a pre-order: ' + what) };
      if (fo.location) locs[String(fo.location)] = 1;
      if (p.fulfilBy) regions[String(p.fulfilBy)] = 1;
      break;
    }
    case 'fulfilRemote': {
      var fr = saleRowById_(p.remoteSaleId), fro = fr ? fr.o : {};
      d = { text: 'Fulfilled a pre-order for ' + placePath_(fro.location) + ': ' + bookName_(String(fro.bookId || '')) +
                  (fro.name ? ' for ' + fro.name : '') + ', from ' + locLabel_(p.fromLoc) +
                  ' (not counted in this region’s sales or cash)',
            undo: { type: 'fulfill', saleId: String(p.remoteSaleId), ids: ids } };
      if (fro.location) locs[String(fro.location)] = 1;
      break;
    }
    case 'editShipment':   d = { text: 'Changed a shipment’s details' }; break;
    case 'createEvent':
      d = { text: 'Created event “' + p.name + '” in ' + reg(p.regionId), undo: { type: 'event', eventId: String(result || p.eventId) } };
      locs[String(result || p.eventId)] = 1; break;
    case 'renameEvent':  d = { text: 'Renamed an event to “' + p.name + '”' }; break;
    case 'deleteEvent':  d = { text: 'Deleted an event' + (mv ? ': ' + mv : '') }; break;
    case 'setEventHidden': case 'setRegionHidden': d = { text: 'Changed what is shown for ' + (p.eventId ? locLabel_(p.eventId) : reg(p.regionId)) }; break;
    case 'createRegion': d = { text: 'Created region “' + p.name + '”' }; regions[String(result || p.regionId)] = 1; break;
    case 'editRegion':   d = { text: 'Changed the settings of ' + (p.name || reg(p.regionId)) + ' (name, currencies, titles or prices)' }; break;
    case 'deleteRegion': d = { text: 'Deleted a region' + (mv ? ': ' + mv : '') }; break;
    case 'regionAddBooks':
      var added = parseBookList_(p.bookIds).filter(function (id) {
        return _activityBefore && _activityBefore.books.length && _activityBefore.books.indexOf(id) < 0; });
      d = { text: 'Switched on ' + (added.length ? added.map(bookName_).join(', ') : 'titles') + ' for ' + reg(p.regionId),
            undo: added.length ? { type: 'regionBooks', regionId: String(p.regionId), ids: added } : null }; break;
    case 'saveSeason':   d = { text: p.seasonId ? 'Renamed a season to “' + p.name + '”' : 'Created season “' + p.name + '”' }; break;
    case 'closeSeason':  d = { text: 'Closed season ' + ((seasonById_(p.seasonId) || {}).name || '') + ' — its dollar figures are now fixed at that day’s exchange rates' }; break;
    case 'reopenSeason': d = { text: 'Reopened season ' + ((seasonById_(p.seasonId) || {}).name || '') }; break;
    case 'deleteSeason': d = { text: 'Deleted a season' }; break;
    case 'closeLocation':  d = { text: 'Closed ' + (p.kind === 'region' ? reg(p.id) : locLabel_(p.id)) + (mv ? ' — ' + mv : '') }; break;
    case 'reopenLocation': d = { text: 'Reopened ' + (p.kind === 'region' ? reg(p.id) : locLabel_(p.id)) }; break;
    case 'reorder':      d = { text: 'Changed the order of ' + (p.kind === 'event' ? 'events' : 'regions') }; break;
    case 'reorderBooks': d = { text: 'Changed the order of the titles' }; break;
    case 'setPrices':    d = { text: 'Changed prices' + (p.regionId ? ' in ' + reg(p.regionId) : '') }; break;
    case 'addBook':      d = { text: 'Added a new title: “' + p.name + '”' }; break;
    case 'renameBook':   d = { text: 'Renamed a title to “' + p.name + '”' }; break;
    case 'deleteBook':   d = { text: 'Deleted a title' }; break;
    case 'saveConsignBook': d = { text: 'Saved a consignment title' + (p.name ? ': “' + p.name + '”' : '') }; break;
    case 'savePartner':  d = { text: (p.partnerId ? 'Changed' : 'Added') + ' consignment group “' + (p.name || '') + '”' }; break;
    case 'partnerPayout': d = { text: 'Handed money to a consignment group' + note }; break;
    case 'deletePayout': d = { text: 'Removed a consignment hand-over' }; break;
    case 'saveHolder':
      if (p.archived) { d = { text: 'Removed sub-warehouse ' + (p.name || '') + ' from ' + reg(p.regionId) }; break; }
      d = { text: (p.holderId ? 'Changed sub-warehouse ' : 'Added sub-warehouse ') + (p.name || '') +
                  (p.phone ? ' (' + p.phone + ')' : '') + ' in ' + reg(p.regionId),
            undo: p.holderId ? null : { type: 'holder', holderId: String(result) } };
      locs[String(result || p.holderId)] = 1; break;
    case 'deleteHolder': d = { text: 'Deleted a sub-warehouse' + (mv ? ': ' + mv : '') }; break;
    case 'saveLabel':
      d = { text: 'Changed wording: “' + String(p.key || '').split(' › ').slice(1).join(' › ') + '” → “' + (p.text || '(original)') + '”',
            undo: _activityBefore ? { type: 'label', key: String(p.key), text: _activityBefore.text } : null }; break;
    case 'cashMove': case 'cashFloat': case 'cashAdjust': case 'cashSet': case 'cashMoveAll':
      d = { text: cashText_(action, p) + note, undo: _cashIds.length ? { type: 'cash', ids: _cashIds.slice() } : null };
      [p.from, p.to, p.acct, p.loc].forEach(function (l) { if (l) locs[String(l)] = 1; }); break;
    case 'cashDelete':   d = { text: 'Deleted a cash entry' }; break;
    case 'cashEdit':     d = { text: 'Changed a cash entry' }; break;
    case 'cashResetBank': case 'cashResetAcct': case 'cashResetAll': d = { text: 'Reset cash records' }; break;
    case 'changeWithdraw': d = { text: 'Took ' + p.amt + ' ' + p.cur + ' as change for ' + locLabel_(p.loc),
                                 undo: result ? { type: 'change', id: String(result) } : null }; locs[String(p.loc)] = 1; break;
    case 'changeReturn': d = { text: 'Returned change' }; break;
    case 'changeDelete': d = { text: 'Deleted a change entry' }; break;
    case 'changeMove':   d = { text: 'Moved change' }; break;
    case 'saveCost':
      d = { text: 'Recorded a cost: ' + p.amt + ' ' + p.cur + ' (' + (p.category || 'Other') + ') at ' + locLabel_(p.location) + note,
            undo: (!(_activityBefore && _activityBefore.existed) && (result || p.id)) ? { type: 'cost', id: String(result || p.id) } : null }; break;
    case 'deleteCost':   d = { text: 'Deleted a cost' }; break;
    case 'setPayTypes':  d = { text: 'Changed the payment types taken' + (p.location ? ' at ' + locLabel_(p.location) : '') }; break;
    case 'setPayTypeCurrency':
      d = { text: (p.cur && String(p.cur).toUpperCase() !== 'NONE')
        ? p.type + ' payments now arrive in ' + String(p.cur).toUpperCase()
        : p.type + ' is no longer a digital account' }; break;
    case 'setWarehouseName': d = { text: 'Renamed the warehouse to “' + p.name + '”' }; break;
    case 'orgSave':      d = { text: 'Changed the org chart' }; break;
    case 'qrSave':       d = { text: 'Changed a payment QR' }; break;
    case 'setKey': case 'sellerLink': d = { text: 'Changed a share link' }; break;
    case 'setDriveFolder': case 'setSeasonFolder': d = { text: 'Changed where the spreadsheets are filed' }; break;
    case 'descriptionsSheet': d = { text: 'Made the AI Descriptions spreadsheet' }; break;
    default: d = { text: (mv || ('Changed: ' + action)) + note, undo: movesUndo };
  }
  Object.keys(locs).forEach(function (l) { var r = regionOfAnyLoc_(l); if (r) regions[r] = 1; });
  d.locs = Object.keys(locs);
  d.regions = Object.keys(regions);
  return d;
}
function cashText_(action, p) {
  var amt = (p.amt !== undefined ? p.amt : '') + (p.cur ? ' ' + p.cur : '');
  if (action === 'cashMove') return 'Moved ' + amt + ' cash from ' + locLabel_(p.from) + ' → ' + locLabel_(p.to);
  if (action === 'cashMoveAll') return 'Moved all cash from ' + locLabel_(p.from) + ' → ' + locLabel_(p.to);
  if (action === 'cashFloat') return 'Gave change (float) to ' + locLabel_(p.loc || p.to);
  if (action === 'cashSet') return 'Set the cash at ' + locLabel_(p.acct) + ' to ' + amt;
  return (Number(p.amt) < 0 ? 'Removed ' : 'Added ') + String(amt).replace('-', '') + ' cash at ' + locLabel_(p.acct);
}

/* Called after every successful write. Never allowed to fail the write itself. */
function activityRecord_(action, p, result, who) {
  if (ACTIVITY_SKIP[action]) return;
  try {
    var moves = _moveBuffer.map(function (r) {
      return { id: String(r[0]), kind: String(r[2]), from: String(r[3] || ''), to: String(r[4] || ''),
               bookId: String(r[5]), qty: Number(r[6]) || 0 };
    });
    var d = describe_(action, p, result, moves, who);
    if (!d || !d.text) return;
    activitySheet_();
    dbAddCols_('_activity', ACTIVITY_HEADERS);
    var row = { id: 'A' + Utilities.getUuid().replace(/-/g, '').slice(0, 10), ts: new Date(),
      season: String(p.season || activeSeasonId_()), who: _cashBy || '', action: action,
      text: String(d.text).slice(0, 900), locs: d.locs.join(','), regions: d.regions.join(','),
      moves: moves.map(function (m) { return m.id; }).join(','),
      undo: d.undo ? JSON.stringify(d.undo) : '', undoneAt: '', undoneBy: '',
      // Several titles in one change: one line per title, so each can be undone on its own.
      parts: (d.undo && d.undo.type === 'moves') ? partsJson_(moves) : '',
      undoneParts: '' };
    dbInsert_('_activity', row);
  } catch (e) { /* the log must never cost anyone their change */ }
}

/* The log, for one season (and, on a regional link, one region). Newest first. */
function activityList_(who, seasonId) {
  if (!dbHas_('_activity')) return [];
  var seasonRegions = {};
  allRegionsEverywhere_().forEach(function (r) { if (r.seasonId === seasonId) seasonRegions[r.regionId] = 1; });
  var out = [];
  objectsOf_('_activity').forEach(function (r) {
    if (!r || !r.id) return;
    var regions = String(r.regions || '').split(',').filter(Boolean);
    var mine = String(r.season) === seasonId || regions.some(function (x) { return seasonRegions[x]; });
    if (!mine) return;
    if (who.role !== 'admin' && regions.indexOf(String(who.regionId)) < 0) return;
    out.push({ id: String(r.id), ts: r.ts, who: String(r.who || ''), action: String(r.action || ''),
      text: stockEntryText_(r), locs: String(r.locs || '').split(',').filter(Boolean), regions: regions,
      moves: String(r.moves || '').split(',').filter(Boolean),
      canUndo: !!String(r.undo || '') && !r.undoneAt, undoneAt: r.undoneAt || '', undoneBy: String(r.undoneBy || ''),
      parts: (function () {
        var gone = String(r.undoneParts || '').split(',').filter(Boolean);
        var list = []; try { list = JSON.parse(String(r.parts || '[]')) || []; } catch (e) { list = []; }
        /* Entries written before lines were grouped by title: rebuild them from
           the movements still on record, so every transfer gets its dropdown. */
        var ids = String(r.moves || '').split(',').filter(Boolean);
        var older = !list.length || list.some(function (x) { return !x.ids; });
        if (older && ids.length >= 1 && String(r.undo || '').indexOf('"moves"') >= 0) {
          var rec = movesById_();
          var ms = ids.map(function (i) { return rec[i]; }).filter(Boolean);
          var rebuilt = ms.length ? partsJson_(ms) : '';
          if (rebuilt) {
            list = JSON.parse(rebuilt);
            // A line counts as undone once every movement in it has been undone.
            list.forEach(function (x) { if (x.ids.every(function (i) { return gone.indexOf(i) >= 0 || !rec[i]; })) gone.push(x.id); });
          }
        }
        return list.map(function (x) { return { id: String(x.id), text: partText_(x.text), ids: (x.ids || []).map(String),
                                                undone: gone.indexOf(String(x.id)) >= 0 }; });
      })(),
      // What kind of undo it is, so the app can show a stock undo straight away.
      undoType: (function () { try { return (JSON.parse(String(r.undo || '')) || {}).type || ''; } catch (e) { return ''; } })() });
  });
  return out.reverse().slice(0, 1500);
}

/* A stock entry's headline in today's words, however long ago it was written:
   rebuilt from its movements while they are all still on record, keeping any
   note that was typed with it. Other entries read as they were written. */
var STOCK_ENTRY_ACTIONS_ = { adjustStockBulk: 1, setStockBulk: 1, transferBulk: 1, transferMulti: 1,
                             transferExternal: 1, seasonTransfer: 1, sendShipment: 1 };
function stockEntryText_(r) {
  var text = String(r.text || '');
  if (!STOCK_ENTRY_ACTIONS_[String(r.action)] || String(r.undo || '').indexOf('"moves"') < 0) return text;
  var ids = String(r.moves || '').split(',').filter(Boolean);
  if (!ids.length) return text;
  var rec = movesById_();
  var ms = ids.map(function (i) { return rec[i]; });
  if (ms.some(function (m) { return !m; })) return text;       // partly undone: as written
  var mv = movesText_(ms);
  if (!mv) return text;
  var note = text.match(/ — “[\s\S]*”$/);
  return mv + (note ? note[0] : '');
}

/* The movement record by id, in the shape the log uses — read once per request. */
var _movesById = null;
function movesById_() {
  if (_movesById) return _movesById;
  _movesById = {};
  objectsOf_('_stockmoves').forEach(function (m) {
    if (!m || !m.id) return;
    _movesById[String(m.id)] = { id: String(m.id), kind: String(m.kind), from: String(m.fromLoc || ''),
      to: String(m.toLoc || ''), bookId: String(m.bookId), qty: Number(m.qty) || 0 };
  });
  return _movesById;
}

/* Reverse a set of stock movements together: all checked first, then all done,
   so an undo never leaves half its books behind. */
function undoMoves_(ids) {
  var want = {}; ids.forEach(function (id) { want[String(id)] = 1; });
  var rows = objectsOf_('_stockmoves');
  var hit = rows.filter(function (m) { return want[String(m.id)]; });
  if (!hit.length) throw new Error('Those movements are no longer in the record — nothing to undo.');
  var map = loadInvMap_();
  var need = {};
  hit.forEach(function (m) {
    var q = Math.round(Number(m.qty) || 0), kind = String(m.kind);
    if (kind === 'TRANSFER') { var k = m.toLoc + '||' + m.bookId; need[k] = (need[k] || 0) + q; }
    else if (kind === 'ADJUST') { if (q > 0) { var k2 = m.toLoc + '||' + m.bookId; need[k2] = (need[k2] || 0) + q; } }
    else throw new Error('This movement cannot be undone here.');
  });
  Object.keys(need).forEach(function (k) {
    var bits = k.split('||'), have = getQty_(map, bits[0], bits[1]);
    if (have < need[k]) throw new Error('Only ' + have + ' × ' + bookName_(bits[1]) + ' left at ' + locLabel_(bits[0]) +
      ' — not enough to undo this. Nothing was changed.');
  });
  hit.forEach(function (m) {
    var q = Math.round(Number(m.qty) || 0), b = String(m.bookId);
    if (String(m.kind) === 'TRANSFER') { addQty_(map, String(m.toLoc), b, -q); addQty_(map, String(m.fromLoc), b, q); markDirty_(m.fromLoc); }
    else addQty_(map, String(m.toLoc), b, -q);
    markDirty_(m.toLoc);
  });
  saveInvMap_(map);
  dbDelete_('_stockmoves', function (m) { return !!want[String(m.id)]; });
  markDirtyAll_();
}

/* Undo one line of a multi-line entry. When the last line goes, the entry
   itself counts as undone. */
function doUndoActivityPart(p, who) {
  var id = String(p.id || ''), part = String(p.part || '');
  if (!dbHas_('_activity')) throw new Error('That entry is no longer in the log.');
  var e = null;
  objectsOf_('_activity').forEach(function (r) { if (String(r.id) === id) e = r; });
  if (!e) throw new Error('That entry is no longer in the log.');
  var mine = lastOnly_('_activity', { id: id });
  if (e.undoneAt) return 'already';
  var parts = []; try { parts = JSON.parse(String(e.parts || '[]')) || []; } catch (x) { parts = []; }
  // Older entries: their lines are rebuilt the same way the log shows them.
  if (!parts.length || parts.some(function (x) { return !x.ids; })) {
    var rec = movesById_();
    var ms = String(e.moves || '').split(',').filter(Boolean).map(function (i) { return rec[i]; }).filter(Boolean);
    var rb = ms.length ? partsJson_(ms) : '';
    if (rb) parts = JSON.parse(rb);
  }
  var line = parts.filter(function (x) { return String(x.id) === part; })[0];
  if (!line) throw new Error('That line is no longer in this entry.');
  /* Keep the lines as they are now. Undoing takes the movements off the record,
     so an older entry rebuilt from the record afterwards would lose (or, with
     one title left, fall back to its old list and show again) the line just
     undone. */
  dbAddCols_('_activity', ACTIVITY_HEADERS);
  if (parts.every(function (x) { return x.ids; })) dbUpdate_('_activity', mine, { parts: JSON.stringify(parts) });
  var gone = String(e.undoneParts || '').split(',').filter(Boolean);
  if (gone.indexOf(part) >= 0) return 'already';
  if (who.role !== 'admin') {
    var regs = String(e.regions || '').split(',').filter(Boolean);
    if (!regs.length || regs.some(function (r) { return r !== String(who.regionId); })) {
      throw new Error('This link can only undo stock changes in its own region.');
    }
  }
  var gonePrev = gone.slice();
  undoMoves_((line.ids || [part]).filter(function (i) { return gonePrev.indexOf(i) < 0; }));
  gone.push(part);
  (line.ids || []).forEach(function (i) { if (gone.indexOf(i) < 0) gone.push(i); });
  var set = { undoneParts: gone.join(',') };
  if (parts.every(function (x) { return gone.indexOf(String(x.id)) >= 0; })) {
    set.undoneAt = new Date();
    set.undoneBy = _cashBy || '';
  }
  dbUpdate_('_activity', mine, set);
  dbInsert_('_activity', { id: 'A' + Utilities.getUuid().replace(/-/g, '').slice(0, 10), ts: new Date(),
    season: String(e.season || ''), who: _cashBy || '', action: 'undoActivity',
    text: 'Undid one line: ' + String(line.text), locs: String(e.locs || ''), regions: String(e.regions || ''),
    moves: '', undo: '', undoneAt: '', undoneBy: '', parts: '', undoneParts: '' });
  return 'undone';
}

function doUndoActivity(p, who) {
  var id = String(p.id || '');
  if (!dbHas_('_activity')) throw new Error('That entry is no longer in the log.');
  var e = null;
  objectsOf_('_activity').forEach(function (r) { if (String(r.id) === id) e = r; });
  if (!e) throw new Error('That entry is no longer in the log.');
  if (e.undoneAt) return 'already';                          // a resend: done already
  var u = null; try { u = JSON.parse(String(e.undo || '')); } catch (x) { u = null; }
  if (!u) throw new Error('This one cannot be undone here.');
  if (who.role !== 'admin') {
    var regs = String(e.regions || '').split(',').filter(Boolean);
    if (!regs.length || regs.some(function (r) { return r !== String(who.regionId); }) ||
        ['moves', 'ship', 'receive', 'holder', 'event', 'regionBooks', 'fulfill'].indexOf(u.type) < 0) {
      throw new Error('This link can only undo stock changes in its own region.');
    }
  }

  var goneParts = String(e.undoneParts || '').split(',').filter(Boolean);
  if (u.type === 'moves') undoMoves_((u.ids || []).filter(function (x) { return goneParts.indexOf(String(x)) < 0; }));
  else if (u.type === 'ship') {
    var s = shipmentById_(u.shipId);
    if (!s) throw new Error('That shipment is already gone.');
    if (s.status !== 'IN_TRANSIT') throw new Error('Some of it has already arrived — undo those arrivals first.');
    doDeleteShipment({ shipId: u.shipId });
  }
  else if (u.type === 'receive') {
    undoMoves_(u.ids || []);
    // Back on the road: in transit again, or partly delivered if other copies had arrived.
    var sp = shipmentById_(u.shipId);
    if (sp) {
      var map = loadInvMap_(), left = 0, sentTotal = 0;
      allBooks_().forEach(function (b) { left += getQty_(map, sp.shipId, b.id); });
      Object.keys(sp.manifest || {}).forEach(function (k) { sentTotal += Number(sp.manifest[k]) || 0; });
      var status = (sentTotal && left < sentTotal) ? 'PARTIAL' : 'IN_TRANSIT';
      dbUpdate_('_shipments', { shipId: sp.shipId }, { status: status, arrivedAt: '' });
    }
  }
  else if (u.type === 'fulfill') {
    // The copy goes back on the fulfilling shelf; the pre-order is waiting again.
    var fh = saleRowById_(u.saleId);
    if (!fh) throw new Error('That pre-order is no longer in the log.');
    undoMoves_(u.ids || []);
    setSaleFields_(fh, { type: 'PREORDER', delivered: false, dsource: '', fulfilLoc: '', fulfilAt: '' });
    markDirty_(fh.o.location);
  }
  else if (u.type === 'cash') (u.ids || []).forEach(function (cid) { doCashDelete({ id: cid }); });
  else if (u.type === 'cost') doDeleteCost({ id: u.id });
  else if (u.type === 'change') doChangeDelete({ id: u.id });
  else if (u.type === 'label') doSaveLabel({ key: u.key, text: u.text || '' });
  else if (u.type === 'regionBooks') {
    dbUpdate_('_regions', { regionId: String(u.regionId) }, function (row) {
      var list = parseBookList_(row.books).filter(function (b) { return (u.ids || []).indexOf(b) < 0; });
      return list.length ? { books: list.join(',') } : {};
    });
    markDirtyRegions_([u.regionId]);
  }
  else if (u.type === 'holder' || u.type === 'event') {
    var loc = u.type === 'holder' ? u.holderId : u.eventId;
    var inv = loadInvMap_(), held = 0;
    allBooks_().forEach(function (b) { held += getQty_(inv, loc, b.id); });
    if (held) throw new Error(locLabel_(loc) + ' is holding ' + plural_(held, 'book') + ' — move them first.');
    if (u.type === 'event') {
      var sold = objectsOf_('_sales').some(function (x) { return String(x.location) === String(loc); });
      if (sold) throw new Error('There are sales at ' + locLabel_(loc) + ', so it cannot simply be removed.');
      doDeleteEvent({ eventId: loc });
    } else {
      var hh = objectsOf_('_holders').filter(function (x) { return String(x.holderId) === String(loc); })[0];
      if (hh) doSaveHolder({ holderId: loc, regionId: hh.regionId, name: hh.name, phone: hh.phone, note: hh.note, archived: true });
    }
  }
  else throw new Error('This one cannot be undone here.');

  // Kept in the log, marked undone — and the undo is itself recorded.
  dbUpdate_('_activity', lastOnly_('_activity', { id: id }), { undoneAt: new Date(), undoneBy: _cashBy || '' });
  dbInsert_('_activity', { id: 'A' + Utilities.getUuid().replace(/-/g, '').slice(0, 10), ts: new Date(),
    season: String(e.season || ''), who: _cashBy || '', action: 'undoActivity',
    text: 'Undid: ' + String(e.text || ''), locs: String(e.locs || ''), regions: String(e.regions || ''),
    moves: '', undo: '', undoneAt: '', undoneBy: '' });
  return 'undone';
}

/* ============================ PRE-ORDERS FULFILLED BY ANOTHER REGION ============================
   A pre-order taken in one region (say Europe Tour › Italy) can be delivered by
   another, in any season (Year-Round › Barcelona). The copy comes off the
   fulfilling region's stock — as if transferred out — and the pre-order is
   marked delivered where it was sold, where it still counts as that region's
   sale and money. The fulfilling region's sales log gets a note, never a sale. */

/* "Europe Tour › Italy › Mela — Day 2": where something is, in words, any season. */
function placePath_(loc) {
  loc = String(loc || '');
  var regs = allRegionsEverywhere_();
  var rid = regionOfAnyLoc_(loc);
  var r = regs.filter(function (x) { return x.regionId === rid; })[0];
  if (!r) return locLabel_(loc);
  var parts = [r.seasonName || '', r.name];
  if (loc !== r.whLoc) {
    var ev = objectsOf_('_events').filter(function (e) { return String(e.eventId) === loc; })[0];
    parts.push(ev ? String(ev.name) : locLabel_(loc));
  }
  return parts.filter(Boolean).join(' › ');
}

function saleRowById_(id) {
  var all = objectsOf_('_sales');
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].saleId) === String(id)) return { o: all[i] };
  }
  return null;
}
function setSaleFields_(hit, fields) {
  dbAddCols_('_sales', SALES_HEADERS);
  dbUpdate_('_sales', firstOnly_({ saleId: String(hit.o.saleId) }), fields);
}
function isOpenPreorder_(o) {
  return String(o.type) === 'PREORDER' && !(o.delivered === true || String(o.delivered).toUpperCase() === 'TRUE');
}

function openPreorders_() {
  return objectsOf_('_sales').filter(isOpenPreorder_).map(function (o) {
    return { saleId: String(o.saleId), ts: o.ts, location: String(o.location), bookId: String(o.bookId),
      bookName: bookName_(String(o.bookId)), name: String(o.name || ''), phone: phoneRead_(o.phone),
      comments: String(o.comments || ''), soldBy: String(o.soldBy || ''),
      fulfilBy: String(o.fulfilBy || ''), origin: placePath_(o.location),
      originRegion: regionOfAnyLoc_(o.location) };
  }).reverse();
}

/* Ask another region to deliver a pre-order — or, with no region, withdraw the
   request (the fulfilling region declining it, or the seller changing plans). */
function doSetFulfilBy(p, who) {
  var hit = saleRowById_(p.remoteSaleId);
  if (!hit) throw new Error('That pre-order is no longer in the log.');
  if (!isOpenPreorder_(hit.o)) throw new Error('That pre-order has already been delivered.');
  var to = String(p.fulfilBy || '');
  var home = regionOfAnyLoc_(hit.o.location);
  if (to) checkCanFulfill_(to, String(hit.o.bookId), hit.o.location);
  if (who.role !== 'admin') {
    var mine = String(who.regionId);
    var ok = (home === mine) || (!to && String(hit.o.fulfilBy) === mine);
    if (!ok) throw new Error('This link can only change its own region’s pre-orders.');
  }
  /* Declined by the region that was asked: remembered, so the region that took
     the pre-order sees it in red. A new request clears it. */
  var declined = (!to && String(hit.o.fulfilBy) && (who.role === 'admin' ? !!p.declined : String(hit.o.fulfilBy) === String(who.regionId)))
    ? String(hit.o.fulfilBy) : '';
  setSaleFields_(hit, { fulfilBy: to, fulfilDeclined: to ? '' : declined });
  markDirty_(hit.o.location);
  return to;
}

/* A request may only go to a region that exists, is not where it was ordered,
   and has at least one copy of the title on any of its shelves. */
function checkCanFulfill_(regionId, bookId, fromLoc) {
  var r = regionById_(regionId);
  if (!r) throw new Error('That region is no longer listed.');
  if (regionId === regionOfAnyLoc_(fromLoc)) throw new Error('That is the region it was ordered in.');
  var map = loadInvMap_(), have = 0;
  locsInRegion_(regionId).forEach(function (l) { have += getQty_(map, l, bookId); });
  if (have < 1) {
    throw new Error(r.name + ' has no copies of ' + bookName_(bookId) +
      ', so it cannot fulfill this pre-order. Choose a region that has it in stock.');
  }
  return regionId;
}

/* Deliver a pre-order from another region's shelf. */
function doFulfilRemote(p, who) {
  var hit = saleRowById_(p.remoteSaleId);
  if (!hit) throw new Error('That pre-order is no longer in the log.');
  if (!isOpenPreorder_(hit.o)) throw new Error('That pre-order has already been delivered.');
  var from = String(p.fromLoc || '');
  var region = regionOfAnyLoc_(from);
  if (!region) throw new Error('Choose where the copy comes from.');
  if (region === regionOfAnyLoc_(hit.o.location)) {
    throw new Error('That shelf is in the region it was ordered in — use Deliver there instead.');
  }
  if (who.role !== 'admin' && region !== String(who.regionId)) {
    throw new Error('This link can only fulfill from its own region.');
  }
  var bookId = String(hit.o.bookId);
  var map = loadInvMap_();
  var have = getQty_(map, from, bookId);
  if (have < 1) throw new Error('There are no copies of ' + bookName_(bookId) + ' at ' + locLabel_(from) + '.');
  addQty_(map, from, bookId, -1);
  saveInvMap_(map);
  stockMoveAppend_({ kind: 'ADJUST', toLoc: from, bookId: bookId, qty: -1,
    note: 'Fulfilled a pre-order for ' + placePath_(hit.o.location) + (hit.o.name ? ' (' + hit.o.name + ')' : ''),
    toBefore: have, toAfter: have - 1 });
  setSaleFields_(hit, { type: 'SALE', delivered: true, dsource: DSRC_REMOTE,
    fulfilBy: region, fulfilLoc: from, fulfilAt: new Date() });
  markDirty_(from); markDirty_(hit.o.location);
  markDirtyRegions_([region, regionOfAnyLoc_(hit.o.location)]);
  return String(hit.o.saleId);
}

/* ============================ CLOSING A SEASON ============================
   Only once every region in it is closed and every book has been moved
   somewhere else. From then on its dollar figures use the exchange rates of the
   day it closed (see getRates_), so the tour's result stops moving. */
function doCloseSeason(p) {
  var id = String(p.seasonId || '');
  var season = seasonById_(id);
  if (!season) throw new Error('That season is no longer listed.');
  if (season.closedAt) return 'already';
  var regs = allRegionsEverywhere_().filter(function (r) { return r.seasonId === id; });
  var open = regs.filter(function (r) { return !r.closedAt; });
  if (open.length) {
    throw new Error('Close every region first — still open: ' + open.map(function (r) { return r.name; }).join(', ') + '.');
  }
  var map = loadInvMap_(), left = 0;
  regs.forEach(function (r) {
    locsInRegion_(r.regionId).forEach(function (l) { allBooks_().forEach(function (b) { left += getQty_(map, l, b.id); }); });
  });
  shipmentsAll_().forEach(function (x) {
    if (x.status === 'ARRIVED') return;
    if (regs.some(function (r) { return r.regionId === x.toRegion || r.regionId === x.fromRegion; })) {
      allBooks_().forEach(function (b) { left += getQty_(map, x.shipId, b.id); });
    }
  });
  if (left) throw new Error(plural_(left, 'book') + ' still belong to this season. Move them to another season or region first.');
  // Rates as they are today, frozen with it.
  var ctx = _seasonOverride;
  setSeasonContext_('');
  var live = null;
  try { _fxMemo = null; live = getRates_(); } finally { setSeasonContext_(ctx); }
  dbAddCols_('_seasons', ['seasonId','name','sort','createdAt','closedAt','frozenRates']);
  dbUpdate_('_seasons', { seasonId: id }, { closedAt: new Date(), frozenRates: JSON.stringify(live || {}) });
  cacheClear_(); markDirtyAll_();
  return 'closed';
}
function doReopenSeason(p) {
  var id = String(p.seasonId || '');
  dbUpdate_('_seasons', { seasonId: id }, { closedAt: '', frozenRates: '' });
  cacheClear_(); markDirtyAll_();
}
