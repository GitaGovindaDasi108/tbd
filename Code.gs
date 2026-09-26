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

var WAREHOUSE = 'WAREHOUSE';            // Poland's warehouse — kept as a literal so all
                                        // pre-season data (sales, stock, cash) stays valid.
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
  if (_fxMemo) return _fxMemo;
  var wanted = allCurrencies_();
  var key = 'fx_v4_' + wanted.join('-');
  try {
    var hit = CacheService.getScriptCache().get(key);
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
    try { CacheService.getScriptCache().put(key, JSON.stringify(live), 6 * 3600); } catch (e) {}
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
  'usdActual'];

// Sheet theme — mirrors the colours used in index.html.
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
  var v = PropertiesService.getScriptProperties().getProperty('rev');
  return v ? Number(v) : 0;
}
function bumpRev_() {
  var n = getRev_() + 1;
  PropertiesService.getScriptProperties().setProperty('rev', String(n));
  return n;
}

function doGet(e)  { return handle(e); }
/* Which build of this script is actually running.

   Pasting Code.gs is not enough: the web app keeps serving the last deployed
   version until you make a NEW VERSION. The app shows this next to its own
   build number, so a half-finished deployment is visible at a glance instead
   of looking like a bug. */
var SERVER_BUILD = 'b176';

function doPost(e) { return handle(e); }

/* Requests carry a one-off id so a repeat cannot be applied twice.

   Apps Script occasionally answers a perfectly good write with something the
   app cannot read — a redirect or an error page rather than JSON. The write has
   happened; the app just cannot tell. Pressing the button again then did the
   work a second time. Now the second attempt is recognised and given the
   original answer back, so a retry is always safe. */
function opSeen_(opId) {
  if (!opId) return null;
  try { return CacheService.getScriptCache().get('op_' + opId); }
  catch (e) { return null; }
}
function rememberOp_(opId, reply) {
  if (!opId) return;
  // Ten minutes is far longer than anyone keeps pressing a button.
  // Six hours — the most the cache allows — so a save re-sent long after a
  // closed page is still recognised rather than applied a second time.
  try { CacheService.getScriptCache().put('op_' + opId, reply, 21600); } catch (e) {}
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

    /* Already done? Hand back the same answer instead of repeating the work. */
    var prior = opSeen_(params.opId);
    if (prior) return raw(prior);
    sheetMemoClear_();                   // never serve rows read before this request
    _moveBuffer = [];                    // nothing carried over from a previous call
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

    // ---- Reads: no lock, cache-backed. ----
    if (action === 'getState') {
      return raw(consistentStateReply_(who));
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
      if (oid) { try { done = !!CacheService.getScriptCache().get('op_' + oid); } catch (e) {} }
      return raw('{"ok":true,"done":' + (done ? 'true' : 'false') + '}');
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
      switch (action) {
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
        case 'createEvent':      result = doCreateEvent(params);  break;
        case 'setEventHidden':   result = doSetEventHidden(params); break;
        case 'setRegionHidden':  result = doSetRegionHidden(params); break;
        case 'renameEvent':      doRenameEvent(params);      break;
        case 'deleteEvent':      doDeleteEvent(params);      break;
        case 'transferBulk':     doTransferBulk(params);     break;
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
        case 'sendShipment':     result = doSendShipment(params); break;
        case 'seasonTransfer':   result = doSeasonTransfer(params); break;
        case 'editShipment':     doEditShipment(params);          break;
        case 'deleteShipment':   result = doDeleteShipment(params); break;
        case 'deletePayout':     doDeletePayout(params);          break;
        case 'deleteHolder':     result = doDeleteHolder(params);  break;
        case 'adjustShipment':   result = doAdjustShipment(params); break;
        case 'receiveShipment':  result = doReceiveShipment(params); break;
        case 'reopenLocation':   doReopenLocation(params);   break;
        default: throw new Error('Unknown action: ' + action);
      }
      cacheClear_();                       // data changed; drop the stale copy
      // Deliberately NOT returning the state. The page already applied this
      // change locally the moment the button was pressed; rebuilding and
      // shipping the whole state here would only make the write slower.
      flushStockMoves_();          // one write for however many rows this action made
      // Tells the background render to hold off while a burst of work is going on.
      PropertiesService.getScriptProperties().setProperty('lastWriteAt', String(Date.now()));
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
    var c = CacheService.getScriptCache();
    var KEY = CACHE_KEY + '_r' + rev;
    var n = Math.ceil(str.length / CHUNK);
    if (n > MAX_CHUNKS) return;            // too big to cache; reads stay direct
    var payload = {};
    for (var i = 0; i < n; i++) payload[KEY + '_' + i] = str.substr(i * CHUNK, CHUNK);
    payload[KEY + '_n'] = String(n);
    c.putAll(payload, 3600);               // an hour is plenty; the key changes on every write
  } catch (err) { /* cache is an optimisation, never a requirement */ }
}

function cacheGet_(rev) {
  try {
    var c = CacheService.getScriptCache();
    var KEY = CACHE_KEY + '_r' + rev;
    var n = c.get(KEY + '_n');
    if (!n) return null;
    n = Number(n);
    var keys = [];
    for (var i = 0; i < n; i++) keys.push(KEY + '_' + i);
    var got = c.getAll(keys);
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
    var c = CacheService.getScriptCache();
    var rev = getRev_();
    var KEY = CACHE_KEY + '_r' + rev;
    var keys = [KEY + '_n'];
    for (var i = 0; i < MAX_CHUNKS; i++) keys.push(KEY + '_' + i);
    c.removeAll(keys);
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

  full.role = who.role;
  full.lockedRegion = regionId;
  // One event means the app can lock onto it; several means a chooser.
  full.lockedEvent = (isSeller && myEvents.length === 1) ? myEvents[0] : '';
  full.sellerEvents = myEvents;

  full.regions = (full.regions || []).filter(function (r) { return r.regionId === regionId; });
  full.events  = (full.events  || []).filter(function (e) {
    return isSeller ? myEvents.indexOf(e.eventId) >= 0 : String(e.regionId || '') === regionId;
  });
  full.inventory = (full.inventory || []).filter(function (i) { return mine[i.location]; });
  full.sales     = (full.sales     || []).filter(function (x) { return mine[x.location]; });
  full.costs     = isSeller ? [] : (full.costs || []).filter(function (c) { return mine[c.location]; });
  full.change    = isSeller ? [] : (full.change || []).filter(function (c) {
    // A link sees change at its own places or with its own coordinator.
    return mine[String(c.loc)] || String(c.loc) === 'BANK_' + regionId;
  });
  delete full.driveFolder;     // an owner's setting, not for link holders
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
    return '{"ok":true,"rev":' + rev + ',"state":' + body + '}';
  } finally {
    if (held) lock.releaseLock();
  }
}

/* Every message the app shows is in English.

   The app's own errors are written in English. But errors raised by Google's
   services — a lock that timed out, a spreadsheet that could not be reached —
   arrive in the language of the Google account, which is how a Dutch message
   turned up in an English app. Those are recognised and replaced with an
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
  var hit = cacheGet_(rev);
  if (hit) return hit;
  var str = JSON.stringify(scopeToSeason_(readState()));
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
    try { if (CacheService.getScriptCache().get('tbs_ready_v4')) return; } catch (err) {}
  }

  sheet_('_meta',      ['key','value']);
  sheet_('_books',     ['id','name','cat','usd','pln','eur','sort']);
  sheet_('_custombooks',['id','name','cat','createdAt','partnerId','sort']);
  sheet_('_partners',  ['partnerId','regionId','name','note','createdAt','archived']);
  sheet_('_payouts',   ['id','partnerId','ts','cur','amt','note','method']);
  sheet_('_costs',     ['id','ts','location','category','payType','cur','amt','note','partnerId']);
  sheet_('_change',    ['id','ts','amt','cur','source','sourceName','loc','returnedAt','by']);
  sheet_('_labels',    ['key','text']);
  sheet_('_qr',        ['id','scope','label','caption','src','sort']);
  sheet_('_holders',   ['holderId','regionId','name','phone','note','createdAt','archived']);
  sheet_('_shipments', ['shipId','fromRegion','toRegion','mode','carrier','phone',
                        'tracking','trackingUrl','eta','note','status','createdAt','arrivedAt',
                        'manifest','origin']);
  sheet_('_regions',   ['regionId','name','whLoc','sort','createdAt','currencies','books','key','closedAt','seasonId']);
  sheet_('_seasons',   ['seasonId','name','sort','createdAt','closedAt']);
  sheet_('_prices',    ['regionId','bookId','cur','price']);
  sheet_('_events',    ['eventId','name','createdAt','regionId','key','closedAt','sort','payTypes']);
  sheet_('_inventory', ['location','bookId','qty']);
  sheet_('_sales',     SALES_HEADERS);
  sheet_('_cash',      ['id','ts','kind','fromAcct','toAcct','cur','amt','note','purpose','by','changeAmt','changeIds','changeRef']);
  sheet_('_org',       ['id','scope','category','sort','name','phone']);
  sheet_('_stockmoves',['id','ts','kind','fromLoc','toLoc','bookId','qty','note','fromBefore','fromAfter','toBefore','toAfter']);

  // Force the phone column to plain text. Without this, Sheets treats a leading
  // "+" as the start of a formula and quietly eats it, so international numbers
  // came back as bare digits with the country code prefix gone.
  var salesSh = getSheet_('_sales');
  var phoneIdx = SALES_HEADERS.indexOf('phone') + 1;
  salesSh.getRange(2, phoneIdx, Math.max(salesSh.getMaxRows() - 1, 1), 1).setNumberFormat('@');

  /* Sheets treats a leading "+" as the start of a formula, which turned +48
     numbers into errors — and reading that error back is what wiped the number.
     Every sheet holding a phone gets its column forced to plain text, not just
     the sales one; the org chart was missed and that is where pasted numbers
     with a country code were being lost. */
  [['_sales', SALES_HEADERS.indexOf('phone') + 1],
   ['_org', 6],           // id, scope, category, sort, name, phone
   ['_holders', 4]        // holderId, regionId, name, phone
  ].forEach(function (pair) {
    var sh = getSheet_(pair[0]);
    if (!sh || pair[1] < 1) return;
    sh.getRange(2, pair[1], Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  });

  var meta = getSheet_('_meta');
  if (meta.getLastRow() < 2) meta.appendRow(['warehouseName', 'Poland']);

  var bs = getSheet_('_books');
  if (bs.getLastRow() < 2 || force) {
    bs.getRange(1, 1, 1, 6).setValues([['id','name','cat','usd','pln','eur']]).setFontWeight('bold');
    if (bs.getLastRow() > 1) bs.getRange(2, 1, bs.getLastRow() - 1, 6).clearContent();
    var rows = BOOKS.map(function (b) { return [b.id, b.name, b.cat, b.usd, b.pln, b.eur]; });
    bs.getRange(2, 1, rows.length, 6).setValues(rows);
  }

  // Seed the org chart once, with the initial contacts. Never overwrites edits.
  var orgSh = getSheet_('_org');
  if (orgSh.getLastRow() < 2) {
    var seed = [
      ['General — book distribution in Poland', 'Gita Govinda', '+16509225957'],
      ['Warehouse Books', 'Tulasi Sevani', '+48515967837'],
      ['Warehouse Books', 'Gita Govinda', '+16509225957'],
      ['Festival Books', 'Daivi Radhika', '+48726541539'],
      ['Warehouse Bank', 'Gita Govinda', ''],
      ['Universal Bank', 'Rasika', '']
    ];
    /* Written by column name. Laid out positionally, these five values landed in
       a six-column sheet, so every seeded contact was shifted one place — the
       category ended up under 'scope' and the phone under 'name'. */
    var orgHeadersNow = orgSh.getRange(1, 1, 1, Math.max(orgSh.getLastColumn(), 1))
      .getValues()[0].map(String);
    var orgRows = seed.map(function (r, i) {
      var row = { id: 'O' + Utilities.getUuid().slice(0, 7), scope: SEASON,
                  category: r[0], sort: i, name: r[1], phone: r[2] };
      return orgHeadersNow.map(function (h) { return row[h] === undefined ? '' : row[h]; });
    });
    orgSh.getRange(2, 1, orgRows.length, orgHeadersNow.length).setValues(orgRows);
    var iPhone = orgHeadersNow.indexOf('phone');
    if (iPhone >= 0) orgSh.getRange(2, iPhone + 1, orgRows.length, 1).setNumberFormat('@');
  }

  // Seed the tour-wide payment codes once, pointing at the files shipped with
  // the page. Editing or removing them later is never overwritten.
  var qrSh = getSheet_('_qr');
  if (qrSh && qrSh.getLastRow() < 2) {
    qrSh.getRange(2, 1, 3, 6).setValues([
      ['Qseed01', SEASON, 'Wise',   'Name: Renuka Radhakrishnan\nWiseTag: https://wise.com/pay/me/renukar73', 'qr-wise.jpeg', 0],
      ['Qseed02', SEASON, 'PayPal', 'rradhakrsna@gmail.com', 'qr-paypal.jpeg', 1],
      ['Qseed03', SEASON, 'Zelle',  'Name: Renuka RadhaKrishnan\nrradhakrsna@gmail.com', 'qr-zelle.jpeg', 2]
    ]);
  }

  migrateSeason_();
  ensureColumn_('_sales', 'soldBy');
  ensureColumn_('_sales', 'changeamt');
  ensureColumn_('_sales', 'changecur');
  migrateSales_();
  try { CacheService.getScriptCache().put('tbs_ready_v4', '1', 3600); } catch (err) {}
}

/**
 * Keeps the _sales header row canonical.
 *
 * SALES_HEADERS has only ever grown by appending, so rewriting row 1 in full is
 * always correct and is safe to repeat.
 *
 * This replaces an earlier version that appended only the missing labels at
 * getLastColumn() + 1, which was subtly wrong: appendRow writes a value for
 * every column in SALES_HEADERS whether or not the header row knows about it,
 * so the data column count ran ahead of the label count and the new labels
 * landed one block too far right. Values then read back under an empty key and
 * vanished — a partial payment's balance silently became zero. Rewriting the
 * row puts the labels back over their own data and recovers those records.
 */
/* One-time upgrade to the season/region/event hierarchy.

   Deliberately non-destructive: Poland's warehouse keeps the literal location id
   'WAREHOUSE', so every existing sale, inventory row, cash entry and stock move
   still points at exactly the right place. We only add the region record around
   them, stamp existing events with it, and scope existing org rows to it.      */
function migrateSeason_() {
  ensureColumn_('_events', 'regionId');
  ensureColumn_('_org', 'scope');
  ensureColumn_('_regions', 'currencies');
  ensureColumn_('_regions', 'books');
  ensureColumn_('_regions', 'key');
  ensureColumn_('_events', 'key');
  ensureColumn_('_events', 'closedAt');
  ensureColumn_('_events', 'sort');
  ensureColumn_('_events', 'hidden');
  ensureColumn_('_shipments', 'manifest');
  ensureColumn_('_custombooks', 'partnerId');
  ensureColumn_('_payouts', 'method');
  ensureColumn_('_shipments', 'origin');
  ensureColumn_('_cash', 'purpose');
  ensureColumn_('_cash', 'by');
  ensureColumn_('_cash', 'changeAmt');
  ensureColumn_('_cash', 'changeIds');
  ensureColumn_('_cash', 'changeRef');
  ensureColumn_('_regions', 'seasonId');
  ensureColumn_('_events', 'payTypes');
  ensureColumn_('_custombooks', 'sort');
  ensureColumn_('_regions', 'bankName');
  ensureColumn_('_regions', 'bookOrder');
  if (getSheet_('_costs')) ensureColumn_('_costs', 'partnerId');
  ensureColumn_('_regions', 'sellerKey');
  ensureColumn_('_regions', 'sellerScope');
  ensureColumn_('_regions', 'payTypes');
  ensureColumn_('_regions', 'closedAt');

  var regionsSh = getSheet_('_regions');
  var firstRegionId = '';

  if (regionsSh.getLastRow() < 2) {
    // Name the first region after whatever the warehouse was already called.
    var whName = String(getWarehouseName_() || 'Poland').trim() || 'Poland';
    firstRegionId = 'rg_' + Utilities.getUuid().slice(0, 6);
    // Poland's original three currencies, in the order the app has always shown them.
    regionsSh.appendRow([firstRegionId, whName, WAREHOUSE, 0, new Date(), 'PLN,EUR,USD']);
  } else {
    var existing = regionsOrdered_();
    firstRegionId = existing.length ? existing[0].regionId : '';
  }

  // Stamp any event that predates regions onto the first region.
  var evRows = rowsOf_('_events');
  var evHeaders = evRows.headers.map(String);
  var regIdx = evHeaders.indexOf('regionId');
  if (regIdx >= 0 && firstRegionId) {
    evRows.data.forEach(function (row, i) {
      if (!String(row[regIdx] || '').trim()) {
        evRows.sheet.getRange(i + 2, regIdx + 1).setValue(firstRegionId);
      }
    });
  }

  // Seed that region's prices from the built-in figures, so nothing changes for
  // Poland while later regions get their own pricing.
  var pricesSh = getSheet_('_prices');
  if (pricesSh && pricesSh.getLastRow() < 2 && firstRegionId) {
    var rows = [];
    allBooks_().forEach(function (b) {
      rows.push([firstRegionId, b.id, 'PLN', Number(b.pln) || 0]);
      rows.push([firstRegionId, b.id, 'EUR', Number(b.eur) || 0]);
      rows.push([firstRegionId, b.id, 'USD', Number(b.usd) || 0]);
    });
    if (rows.length) pricesSh.getRange(2, 1, rows.length, 4).setValues(rows);
  }

  repairOrgColumns_();

  // Existing org entries belong to that first region (they were written when the
  // warehouse WAS the whole world).
  var orgRows = rowsOf_('_org');
  var orgHeaders = orgRows.headers.map(String);
  var scopeIdx = orgHeaders.indexOf('scope');
  if (scopeIdx >= 0 && firstRegionId) {
    orgRows.data.forEach(function (row, i) {
      if (!String(row[scopeIdx] || '').trim()) {
        orgRows.sheet.getRange(i + 2, scopeIdx + 1).setValue(firstRegionId);
      }
    });
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

  writeObjects_('_org', ['id','scope','category','sort','name','phone'], fixed);
  console.log('Repaired ' + shifted.length + ' org row(s) shifted by the scope-column change.');
}

function migrateSales_() {
  var sh = getSheet_('_sales');
  var width = Math.max(sh.getLastColumn(), SALES_HEADERS.length);
  var headers = sh.getRange(1, 1, 1, width).getValues()[0];

  var correct = true;
  for (var i = 0; i < SALES_HEADERS.length; i++) {
    if (String(headers[i] || '') !== SALES_HEADERS[i]) { correct = false; break; }
  }
  // Anything to the right of the canonical set is stale from the old bug.
  for (var j = SALES_HEADERS.length; j < width; j++) {
    if (String(headers[j] || '') !== '') { correct = false; break; }
  }
  if (correct) return;

  sh.getRange(1, 1, 1, SALES_HEADERS.length).setValues([SALES_HEADERS]).setFontWeight('bold');
  if (width > SALES_HEADERS.length) {
    sh.getRange(1, SALES_HEADERS.length + 1, 1, width - SALES_HEADERS.length).clearContent();
  }
}

function sheet_(name, headers) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.hideSheet();
  }
  return sh;
}

function getSheet_(name) { return SpreadsheetApp.getActive().getSheetByName(name); }

/* Add a column header to an existing sheet if it isn't there yet. Rows written
   before the column existed simply read back undefined, which callers default —
   so this upgrades a live sheet without rewriting a single row. */
/* Make sure a sheet has every column the code expects, adding any that are
   missing.

   Rows are appended by position, so a sheet that predates a new field silently
   drops it — the record saves, but the new value lands in an unnamed column and
   is gone on the next read. That is how "change owed" vanished from a sale that
   was otherwise intact. Self-healing here means a new field works the moment the
   code ships, whether or not initialize has been run. */
function ensureHeaders_(name, headers) {
  var sh = getSheet_(name);
  if (!sh) return;
  var width = Math.max(sh.getLastColumn(), 1);
  var live = sh.getRange(1, 1, 1, width).getValues()[0].map(String);
  var missing = headers.filter(function (h) { return live.indexOf(h) < 0; });
  if (!missing.length) return;
  if (sh.getMaxColumns() < live.length + missing.length) {
    sh.insertColumnsAfter(sh.getMaxColumns(), missing.length);
  }
  sh.getRange(1, live.length + 1, 1, missing.length).setValues([missing]);
  sheetMemoClear_();
}

function ensureColumn_(name, header) {
  var sh = getSheet_(name);
  if (!sh) return;
  var width = Math.max(sh.getLastColumn(), 1);
  var headers = sh.getRange(1, 1, 1, width).getValues()[0].map(String);
  if (headers.indexOf(header) >= 0) return;
  sh.getRange(1, width + 1).setValue(header);
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
  undoStockMove:1
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
  var rows = rowsOf_(sheetName);
  var hs = rows.headers.map(String);
  var iId = hs.indexOf(idCol), iC = hs.indexOf('closedAt');
  if (iC < 0) throw new Error('That sheet has not been upgraded — run initialize.');
  var found = false;
  rows.data.forEach(function (row, i) {
    if (String(row[iId]) !== String(id)) return;
    rows.sheet.getRange(i + 2, iC + 1).setValue(when);
    found = true;
  });
  if (!found) throw new Error('That no longer exists.');
  sheetMemoClear_();
}

/* Close an event or a region, reconciling the shelves on the way out.

   `counts` is what was physically there at the end. Anything that differs from
   what the system expected is recorded as an adjustment with a note, so the
   discrepancy is visible in the transfer log rather than silently absorbed. */
function doCloseLocation(p) {
  var kind = String(p.kind || 'event');
  var id = String(p.id || '');
  var locs = (kind === 'event') ? [id] : locsInRegion_(id);
  if (!locs.length) throw new Error('Nothing to close.');

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

function doReopenLocation(p) {
  var kind = String(p.kind || 'event'), id = String(p.id || '');
  setClosed_(kind, id, '');
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
  var rows = rowsOf_(sheetName);
  var hs = rows.headers.map(String);
  if (hs.indexOf('sort') < 0) throw new Error('That sheet has not been upgraded — run initialize.');
  var objs = rows.data.map(function (row) {
    var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; });
    var at = ids.indexOf(String(o[idCol]));
    if (at >= 0) o.sort = at;
    return o;
  });
  writeObjects_(sheetName, hs, objs);
  markDirtyAll_();
}

function doSaveHolder(p) {
  var name = String(p.name || '').trim();
  if (!name) throw new Error('Give the devotee a name.');
  var regionId = String(p.regionId || '');
  if (!regionById_(regionId)) throw new Error('Pick a region.');
  var id = String(p.holderId || '');
  if (id) {
    var rows = rowsOf_('_holders');
    var hs = rows.headers.map(String);
    var iId = hs.indexOf('holderId');
    var objs = rows.data.map(function (row) {
      var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; });
      if (String(o.holderId) === id) {
        o.name = name; o.phone = String(p.phone || '').trim(); o.note = String(p.note || '').trim();
        if (p.archived !== undefined) o.archived = !!p.archived;
      }
      return o;
    });
    writeObjects_('_holders', hs, objs);
  } else {
    id = 'hd_' + Utilities.getUuid().slice(0, 6);
    getSheet_('_holders').appendRow([id, regionId, name, String(p.phone || '').trim(),
      String(p.note || '').trim(), new Date(), false]);
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
   over directly — no transit, because nothing is travelling; the books are
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
function allRegionsEverywhere_() {
  var seasons = {};
  seasonsAll_().forEach(function (x) { seasons[x.seasonId] = x.name; });
  return objectsOf_('_regions').filter(function (r) { return r && r.regionId; })
    .map(function (r) {
      return { regionId: String(r.regionId), name: String(r.name),
               whLoc: String(r.whLoc || ''), seasonId: String(r.seasonId || ''),
               seasonName: seasons[String(r.seasonId || '')] || '' };
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
    return { bookId: String(it.bookId), qty: Math.max(0, Math.round(Number(it.qty) || 0)) };
  }).filter(function (it) { return it.qty > 0 && bookById_(it.bookId); });
  if (!items.length) throw new Error('Enter a quantity for at least one title.');

  var srcLoc = fromOutside ? '' : String(p.fromLoc || from.whLoc);
  var map = loadInvMap_();
  if (!fromOutside) {
    items.forEach(function (it) {
      var have = getQty_(map, srcLoc, it.bookId);
      if (have < it.qty) {
        throw new Error('Only ' + have + ' × ' + bookById_(it.bookId).name + ' at ' +
          locLabel_(srcLoc) + ' — you asked to send ' + it.qty + '. Nothing was sent.');
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
      var fB = getQty_(map, srcLoc, it.bookId), tB = getQty_(map, to.whLoc, it.bookId);
      addQty_(map, srcLoc, it.bookId, -it.qty);
      addQty_(map, to.whLoc, it.bookId, it.qty);
      stockMoveAppend_({ kind: 'TRANSFER', fromLoc: srcLoc, toLoc: to.whLoc,
        bookId: it.bookId, qty: it.qty, note: p.note,
        fromBefore: fB, fromAfter: getQty_(map, srcLoc, it.bookId),
        toBefore: tB, toAfter: getQty_(map, to.whLoc, it.bookId) });
    });
    saveInvMap_(map);
    markDirty_(srcLoc); markDirty_(to.whLoc);
    return '';
  }

  // In transit: the books live in the shipment until it is received.
  var shipId = 'sh_' + Utilities.getUuid().slice(0, 6);
  var manifest = {};
  items.forEach(function (it) { manifest[it.bookId] = (manifest[it.bookId] || 0) + it.qty; });
  getSheet_('_shipments').appendRow([shipId, fromRegion, toRegion, mode,
    String(p.carrier || '').trim(), String(p.phone || '').trim(),
    String(p.tracking || '').trim(), String(p.trackingUrl || '').trim(),
    p.eta ? new Date(p.eta) : '', String(p.note || '').trim(),
    'IN_TRANSIT', new Date(), '', JSON.stringify(manifest),
    String(p.origin || '').trim()]);

  items.forEach(function (it) {
    addQty_(map, shipId, it.bookId, it.qty);
    if (fromOutside) {
      stockMoveAppend_({ kind: 'ADJUST', toLoc: shipId, bookId: it.bookId, qty: it.qty,
        note: 'On its way from ' + (p.origin || 'outside the tour'),
        toBefore: 0, toAfter: it.qty });
      return;
    }
    var fB = getQty_(map, srcLoc, it.bookId);
    addQty_(map, srcLoc, it.bookId, -it.qty);
    stockMoveAppend_({ kind: 'TRANSFER', fromLoc: srcLoc, toLoc: shipId,
      bookId: it.bookId, qty: it.qty,
      note: 'Sent in transit to ' + to.name + (p.carrier ? ' with ' + p.carrier : ''),
      fromBefore: fB, fromAfter: getQty_(map, srcLoc, it.bookId),
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
    // Copies that never travelled go back where they came from; extras that
    // turned up are taken from there, so the sending region stays truthful.
    if (backTo) {
      var bB = getQty_(map, backTo, bookId);
      addQty_(map, backTo, bookId, -delta);
      stockMoveAppend_({ kind: 'TRANSFER',
        fromLoc: delta > 0 ? backTo : id, toLoc: delta > 0 ? id : backTo,
        bookId: bookId, qty: Math.abs(delta),
        note: 'Shipment contents corrected' + (p.note ? ' — ' + p.note : ''),
        toBefore: delta > 0 ? have : bB, toAfter: delta > 0 ? want : bB + Math.abs(delta) });
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
    var rowsM = rowsOf_('_shipments');
    var hsM = rowsM.headers.map(String);
    var objsM = rowsM.data.map(function (row) {
      var o = {}; hsM.forEach(function (h, i) { o[h] = row[i]; });
      if (String(o.shipId) === id) {
        var man = parseManifest_(o.manifest);
        changes.forEach(function (c) {
          man[c.bookId] = Math.max(0, (Number(man[c.bookId]) || 0) + (c.now - c.was));
          if (!man[c.bookId]) delete man[c.bookId];
        });
        o.manifest = JSON.stringify(man);
      }
      return o;
    });
    writeObjects_('_shipments', hsM, objsM);
  }
  if (backTo) markDirty_(backTo);
  markDirtyRegions_([ship.fromRegion, ship.toRegion]);
  return { changes: changes };
}

/* Delete a shipment outright.

   A batch created by mistake had no way out — you could correct its contents but
   not remove it. Anything still travelling in it goes back where it came from,
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
      var tB = getQty_(map, backTo, b.id);
      addQty_(map, backTo, b.id, q);
      stockMoveAppend_({ kind: 'TRANSFER', fromLoc: id, toLoc: backTo, bookId: b.id, qty: q,
        note: 'Shipment deleted — books returned', fromBefore: q, fromAfter: 0,
        toBefore: tB, toAfter: tB + q });
    } else {
      stockMoveAppend_({ kind: 'ADJUST', toLoc: id, bookId: b.id, qty: -q,
        note: 'Shipment deleted', toBefore: q, toAfter: 0 });
    }
  });
  saveInvMap_(map);

  var rows = rowsOf_('_shipments');
  var hs = rows.headers.map(String);
  writeObjects_('_shipments', hs, rows.data.map(function (row) {
    var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  }).filter(function (o) { return String(o.shipId) !== id; }));
  if (backTo) markDirty_(backTo);
  markDirtyRegions_([ship.fromRegion, ship.toRegion]);
  return { returned: returned };
}

/* Remove a hand-over recorded against a partner — a mistyped amount, say. */
function doDeletePayout(p) {
  var id = String(p.id || '');
  var rows = rowsOf_('_payouts');
  var hs = rows.headers.map(String);
  writeObjects_('_payouts', hs, rows.data.map(function (row) {
    var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  }).filter(function (o) { return String(o.id) !== id; }));
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
  var r = rowsOf_('_holders');
  var hs = r.headers.map(String);
  writeObjects_('_holders', hs, r.data.map(function (row) {
    var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  }).filter(function (o) { return String(o.holderId) !== id; }));
  markDirtyRegions_([String(mine.regionId)]);
  return { returned: moved };
}

function doEditShipment(p) {
  var id = String(p.shipId || '');
  var oldTo = '';
  var rows = rowsOf_('_shipments');
  var hs = rows.headers.map(String);
  var found = false;
  var objs = rows.data.map(function (row) {
    var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; });
    if (String(o.shipId) === id) {
      found = true;
      ['carrier','phone','tracking','trackingUrl','note'].forEach(function (f) {
        if (p[f] !== undefined) o[f] = String(p[f]).trim();
      });
      if (p.eta !== undefined) o.eta = p.eta ? new Date(p.eta) : '';
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
        o.toRegion = String(p.toRegion);
      }
    }
    return o;
  });
  if (!found) throw new Error('That shipment is no longer listed.');
  writeObjects_('_shipments', hs, objs);
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
  var rows = rowsOf_('_shipments');
  var hs = rows.headers.map(String);
  var objs = rows.data.map(function (row) {
    var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; });
    if (String(o.shipId) === id) { o.status = status; if (status === 'ARRIVED') o.arrivedAt = new Date(); }
    return o;
  });
  writeObjects_('_shipments', hs, objs);
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
  transferBulk:1, createEvent:1, adjustStockBulk:1, setStockBulk:1, closeLocation:1
};

/* Who is holding this link, and what they can see.

   A seller link belongs to the REGION, not to one event. Which event it opens
   on is a setting the owner changes — so the same link follows a person from
   Monday's festival to Tuesday's, and can be widened to the whole region at
   reconciliation time without reissuing anything.

   Per-event keys are still honoured, so links already handed out keep working. */
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
  ensureHeaders_('_regions', REGION_HEADERS);
  var r = rowsOf_('_regions');
  var hs = r.headers.map(String);
  var made = '';
  writeObjects_('_regions', hs, r.data.map(function (row) {
    var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; });
    if (String(o.regionId) === regionId) {
      if (p.revoke) { o.sellerKey = ''; }
      else if (!String(o.sellerKey || '') || p.regenerate) {
        o.sellerKey = suppliedKey_(p.key, 's') || ('s' + Utilities.getUuid().replace(/-/g, '').slice(0, 14));
      }
      if (p.scope !== undefined) o.sellerScope = String(p.scope || '');
      made = String(o.sellerKey || '');
    }
    return o;
  }));
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
  if (action === 'createEvent' && who.role === 'coordinator') {
    params.regionId = who.regionId;          // never another region's
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
  sheet_('_costs', ['id','ts','location','category','payType','cur','amt','note','partnerId']);
  sheetMemoClear_();
  ensureHeaders_('_costs', ['id','ts','location','category','payType','cur','amt','note','partnerId']);
  var r = rowsOf_('_costs');
  var hs = r.headers.map(String);
  var rows = r.data.map(function (row) { var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; }); return o; });
  var at = id ? rows.findIndex(function (x) { return String(x.id) === id; }) : -1;
  if (at >= 0) {
    rows[at] = Object.assign(rows[at], obj);            // an edit
  } else {
    if (!obj.id) obj.id = 'C' + Utilities.getUuid().slice(0, 8);
    rows.push(obj);                                     // new (or a resend of a new one)
  }
  writeObjects_('_costs', hs, rows);
  markDirtyRegions_([regionOfLoc_(loc)]);
  return obj.id;
}
function doDeleteCost(p) {
  var id = String(p.id || '');
  if (!getSheet_('_costs')) return;                     // nothing recorded yet
  var r = rowsOf_('_costs');
  var hs = r.headers.map(String);
  var loc = '';
  var keep = r.data.map(function (row) { var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; }); return o; })
    .filter(function (x) { if (String(x.id) === id) { loc = String(x.location); return false; } return true; });
  writeObjects_('_costs', hs, keep);
  if (loc) markDirtyRegions_([regionOfLoc_(loc)]);
}

/* ---- Change: money borrowed to give to buyers ----

   It comes from somewhere — a coordinator, an event's takings, or a person who
   simply handed it over — and it goes back there. It travels with the cash it
   sits among, so it is tracked as its own thing: where it came from, where it
   is now, and whether it has gone home. */
function changeRows_() {
  sheet_('_change', ['id','ts','amt','cur','source','sourceName','loc','returnedAt','by']);
  sheetMemoClear_();
  var r = rowsOf_('_change');
  var hs = r.headers.map(String);
  return { hs: hs, rows: r.data.map(function (row) {
    var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; }); return o; }) };
}
function changeWrite_(hs, rows) { writeObjects_('_change', hs, rows); }

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
  for (var i = 0; i < c.rows.length; i++) if (String(c.rows[i].id) === id) return id;   // a resend
  c.rows.push({ id: id, ts: p.ts ? new Date(p.ts) : new Date(), amt: amt, cur: cur,
                source: source, sourceName: sourceName, loc: loc, returnedAt: '', by: _cashBy });
  changeWrite_(c.hs, c.rows);

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
  var c = changeRows_();
  var hit = null;
  c.rows.forEach(function (r) { if (String(r.id) === id) hit = r; });
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
  hit.returnedAt = new Date();
  changeWrite_(c.hs, c.rows);
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
  var c = changeRows_();
  var kept = c.rows.filter(function (r) { return String(r.id) !== id; });
  if (kept.length !== c.rows.length) changeWrite_(c.hs, kept);
  tombstone_(id);
  // Any movements that only existed to carry this change go with it.
  var cash = cashRows_();
  var keptCash = cash.rows.filter(function (r) { return String(r.changeRef || '') !== id; });
  if (keptCash.length !== cash.rows.length) cashWrite_(cash.headers, keptCash);
  markDirtyAll_();
  return id;
}

/** The change travelled with the money. If it reached its source, it is home. */
function doChangeMove(p) {
  var ids = p.ids || [];
  if (!ids.length) return '';
  var to = String(p.toLoc || '');
  var c = changeRows_();
  var touched = false;
  c.rows.forEach(function (r) {
    if (ids.indexOf(String(r.id)) < 0 || String(r.returnedAt || '')) return;
    r.loc = to;
    if (to && to === String(r.source)) r.returnedAt = new Date();   // back where it came from
    touched = true;
  });
  if (touched) changeWrite_(c.hs, c.rows);
  return '';
}

/* Rewrite a piece of the app's wording, or put it back.

   Keyed by the original words, so a label that is never rewritten costs
   nothing and the app falls back to what it always said. */
function doSaveLabel(p) {
  var key = String(p.key || '').slice(0, 300);
  if (!key) throw new Error('Nothing to rewrite.');
  var text = String(p.text == null ? '' : p.text).slice(0, 600);
  sheet_('_labels', ['key', 'text']);
  sheetMemoClear_();
  var r = rowsOf_('_labels');
  var hs = r.headers.map(String);
  var rows = r.data.map(function (row) { var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; }); return o; });
  var at = -1;
  rows.forEach(function (x, i) { if (String(x.key) === key) at = i; });
  if (!text) {                       // emptied: back to the original wording
    if (at >= 0) rows.splice(at, 1);
  } else if (at >= 0) {
    rows[at].text = text;
  } else {
    rows.push({ key: key, text: text });
  }
  writeObjects_('_labels', hs, rows);
  return text;
}

/* The dollars actually received for a sale paid digitally.

   The sale still counts in the currency it was made in — nothing about the
   local totals changes. Only the USD column uses this figure in place of a
   converted estimate, so the tour's dollar figure is what the bank shows. */
function doSetUsdActual(p) {
  var saleId = String(p.saleId || '');
  var rows = objectsOf_('_sales');
  var found = false;
  var v = (p.usd === '' || p.usd === null || p.usd === undefined) ? '' : (Number(p.usd) || 0);
  rows.forEach(function (r) {
    if (String(r.saleId) === saleId) { r.usdActual = v; found = true; }
  });
  if (!found) throw new Error('That sale is no longer in the log.');
  writeObjects_('_sales', SALES_HEADERS, rows);
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
  var rows = rowsOf_(sheetName);
  var hs = rows.headers.map(String);
  var iId = hs.indexOf(idCol), iKey = hs.indexOf('key');
  if (iKey < 0) throw new Error('This sheet has not been upgraded yet — run initialize.');
  var found = false;
  rows.data.forEach(function (row, i) {
    if (String(row[iId]) !== id) return;
    rows.sheet.getRange(i + 2, iKey + 1).setValue(key);
    found = true;
  });
  if (!found) throw new Error('That no longer exists.');
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
  ensureHeaders_('_regions', REGION_HEADERS);
  var sh = getSheet_('_regions');
  var live = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
  sh.appendRow(live.map(function (h) { return row[h] === undefined ? '' : row[h]; }));
  sheetMemoClear_();
}

function seasonsAll_() {
  /* Create the sheet if it isn't there. Without this, every request on a tour
     that hasn't been re-initialised failed at the first mention of a season —
     and a failure this early comes back as a page, not a message, which is why
     it read as "the server sent something unreadable". */
  if (!getSheet_('_seasons')) {
    sheet_('_seasons', ['seasonId','name','sort','createdAt','closedAt']);
    hideDataSheets_();
    sheetMemoClear_();
  }
  var rows = objectsOf_('_seasons').filter(function (x) { return x && x.seasonId; });
  if (!rows.length) {
    // First run, or an existing tour that predates seasons: adopt what is here.
    var id = 'sn_' + Utilities.getUuid().slice(0, 6);
    getSheet_('_seasons').appendRow([id, getSeasonName_(), 0, new Date(), '']);
    sheetMemoClear_();
    /* Adopt everything that existed before seasons did. Done once, here, so no
       row is left unattached — an unattached region would otherwise appear in
       every season at once. */
    var rr = rowsOf_('_regions');
    var hs = rr.headers.map(String);
    var iS = hs.indexOf('seasonId');
    if (iS >= 0) {
      /* Adopt anything not attached to a season that exists — both regions from
         before seasons were introduced, and any left dangling if this sheet was
         ever lost. An unattached region belongs to no season and would simply
         disappear from the app, so this is the safety net for that. */
      rr.data.forEach(function (row, n) {
        var cur = String(row[iS] || '');
        if (cur !== id) rr.sheet.getRange(n + 2, iS + 1).setValue(id);
      });
      sheetMemoClear_();
    }
    setMeta_('activeSeason', id);
    rows = objectsOf_('_seasons').filter(function (x) { return x && x.seasonId; });
  }
  return rows.map(function (x, i) {
    return { seasonId: String(x.seasonId), name: String(x.name || ''),
             sort: Number(x.sort) || 0, closedAt: x.closedAt || '', _i: i };
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
    var rows = rowsOf_('_seasons');
    var hs = rows.headers.map(String);
    writeObjects_('_seasons', hs, rows.data.map(function (row) {
      var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; });
      if (String(o.seasonId) === id) o.name = name;
      return o;
    }));
    cacheClear_(); markDirtyAll_();
    return id;
  }
  id = 'sn_' + Utilities.getUuid().slice(0, 6);
  getSheet_('_seasons').appendRow([id, name, seasonsAll_().length, new Date(), '']);
  sheetMemoClear_();

  /* A new season is a genuinely blank slate: no regions, no events, no stock,
     no money, no prices carried over. Only the book catalogue is shared, since
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
  regionsOrdered_(id).forEach(function (r) {
    doDeleteRegion({ regionId: r.regionId, confirmName: r.name, force: true });
  });
  var rows = rowsOf_('_seasons');
  var hs = rows.headers.map(String);
  writeObjects_('_seasons', hs, rows.data.map(function (row) {
    var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  }).filter(function (o) { return String(o.seasonId) !== id; }));
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
   region keeps its full catalogue without needing to be edited. */
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
  regionsOrdered_().forEach(function (r) {
    (r.currencies || []).forEach(function (c) { if (!seen[c]) { seen[c] = 1; out.push(c); } });
  });
  return out;
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
   totalled up, which is the point of holdersOfRegion_ / shipmentsInbound_.   */
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

function shipmentsAll_() {
  return objectsOf_('_shipments').filter(function (x) { return x && x.shipId; })
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

function hideDataSheets_() {
  ['_meta','_seasons','_books','_custombooks','_partners','_payouts','_costs','_change','_labels','_qr','_holders','_shipments','_regions','_prices','_events','_inventory','_sales','_cash','_org','_stockmoves'].forEach(function (n) {
    var sh = getSheet_(n);
    if (sh && !sh.isSheetHidden()) sh.hideSheet();
  });
}

/* ============================ DATA I/O ============================ */

/* Reading a sheet is the expensive part of every request, and building the
   app's state touches the same handful of sheets many times over. Hold each
   one for the life of the request; any write drops the lot. */
var _sheetMemo = {};
function sheetMemoClear_() { _sheetMemo = {}; bookMemoClear_(); }

function rowsOf_(name) {
  // Never read the movement log with entries still sitting in the buffer.
  if (name === '_stockmoves' && _moveBuffer.length) flushStockMoves_();
  if (_sheetMemo[name]) return _sheetMemo[name];
  var sh = getSheet_(name);
  var last = sh.getLastRow();
  var width = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, width).getValues()[0];
  var out = (last < 2)
    ? { sheet: sh, headers: headers, data: [] }
    : { sheet: sh, headers: headers, data: sh.getRange(2, 1, last - 1, width).getValues() };
  _sheetMemo[name] = out;
  return out;
}

function objectsOf_(name) {
  var r = rowsOf_(name);
  return r.data.map(function (row) {
    var o = {};
    r.headers.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  });
}

/* Rewrite a data sheet.

   The header row is rewritten too, and that matters: `ensureColumn_` appends a
   new column at the END, but these header lists put new fields where they read
   best (scope second, say). If we wrote values in list order while the sheet
   still carried the old order, every value would land one column off — which is
   exactly how a season org chart came back as scrambled Poland rows. Writing
   both together keeps the file and the code permanently in agreement. */
/* The canonical shape of each data sheet.

   Call sites used to pass their own header list, and any list that forgot a
   column silently erased it — that is how share links vanished on an update
   (deleting one event rewrote _events without 'key') and how the org chart got
   shifted. The sheet's own header row is now the authority, so a caller can
   never drop a column it happens not to care about. */
function headersFor_(name, fallback) {
  var sh = getSheet_(name);
  if (!sh) return fallback;
  var width = sh.getLastColumn();
  if (width < 1) return fallback;
  var live = sh.getRange(1, 1, 1, width).getValues()[0]
    .map(String).filter(function (h) { return h !== ''; });
  if (!live.length) return fallback;
  // Anything the caller knows about but the sheet lacks gets appended.
  fallback.forEach(function (h) { if (live.indexOf(h) < 0) live.push(h); });
  return live;
}

function writeObjects_(name, headers, objects) {
  var sh = getSheet_(name);
  if (!sh) return;
  headers = headersFor_(name, headers.slice());
  sheetMemoClear_();
  var wide = Math.max(sh.getLastColumn(), headers.length);
  if (sh.getMaxColumns() < headers.length) {
    sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  }
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, wide).clearContent();
  // Clear any stale trailing headers before laying down the current set.
  if (wide > headers.length) sh.getRange(1, headers.length + 1, 1, wide - headers.length).clearContent();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (!objects.length) return;
  var values = objects.map(function (o) {
    return headers.map(function (h) { return (o[h] === undefined || o[h] === null) ? '' : o[h]; });
  });
  sh.getRange(2, 1, values.length, headers.length).setValues(values);
}

/* ============================ STATE ============================ */

function getWarehouseName_() {
  var m = objectsOf_('_meta');
  for (var i = 0; i < m.length; i++) if (m[i].key === 'warehouseName') return m[i].value;
  return 'Poland';
}

/* ---- Meta helpers ---- */
function getMeta_(key, dflt) {
  var m = objectsOf_('_meta');
  for (var i = 0; i < m.length; i++) if (String(m[i].key) === key) return m[i].value;
  return dflt === undefined ? '' : dflt;
}
function setMeta_(key, value) {
  var r = rowsOf_('_meta');
  var found = false;
  var objs = r.data.map(function (row) {
    if (String(row[0]) === key) { found = true; return { key: key, value: value }; }
    return { key: row[0], value: row[1] };
  });
  if (!found) objs.push({ key: key, value: value });
  writeObjects_('_meta', ['key','value'], objs);
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
  var cache = CacheService.getScriptCache();
  /* Keyed by the folder only, NOT by the data revision: folders change when you
     move them, not every time a book is sold. Keying it to the revision meant
     any save threw the map away, so it was rebuilt on almost every open. */
  var ck = 'drivemap_' + String(getMeta_('driveRootFolderId', '')) + '_' + String(getMeta_('driveMapStamp', '0'));
  try { var hit = cache.get(ck); if (hit) return JSON.parse(hit); } catch (e) {}

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

  var parts = getSheet_('_partners') ? objectsOf_('_partners') : [];
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
  try { cache.put(ck, JSON.stringify(out), 1800); } catch (e) {}   // half an hour
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
  try { CacheService.getScriptCache().remove('drivemap_' + f.getId() + '_' + getRev_()); } catch (e) {}
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
  return 'Europe Tour';
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
  var inv = objectsOf_('_inventory').map(function (r) {
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
      bundle: String(s.bundle || '')
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
    rates: (function () { var r = getRates_();
      var R = r.RATES || {};
      return { perUsd: R, plnPerUsd: R.PLN || RATE_PLN_PER_USD, eurPerUsd: R.EUR || RATE_EUR_PER_USD,
               live: !!r.live, asOf: r.asOf || '' }; })(),
    seasonName: (seasonById_(activeSeasonId_()) || {}).name || getSeasonName_(),
    seasons: seasonsAll_().map(function (x) {
      return { seasonId: x.seasonId, name: x.name, closedAt: x.closedAt };
    }),
    activeSeason: activeSeasonId_(),
    allRegions: allRegionsEverywhere_(),
    // Every season's events, only so that a place in another season can be named.
    allEvents: objectsOf_('_events').filter(function (e) { return e && e.eventId; })
      .map(function (e) { return { eventId: String(e.eventId), name: String(e.name), regionId: String(e.regionId || '') }; }),
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
    change: (getSheet_('_change') ? objectsOf_('_change') : []).filter(function (c) { return c && c.id; })
      .map(function (c) {
        return { id: String(c.id), ts: c.ts, amt: Number(c.amt) || 0, cur: String(c.cur || ''),
                 source: String(c.source || ''), sourceName: String(c.sourceName || ''),
                 loc: String(c.loc || ''), returnedAt: c.returnedAt ? String(c.returnedAt) : '',
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
      if (!getSheet_('_labels')) return out;
      objectsOf_('_labels').forEach(function (r) {
        if (r && String(r.key)) out[String(r.key)] = String(r.text == null ? '' : r.text);
      });
      return out;
    })(),
    driveFolder: String(getMeta_('driveRootFolderName', '') || ''),
    // Money spent to make sales — card-machine fees and the like.
    // Read only if the sheet exists: a new sheet must never stop the app loading
    // on a deployment where initialize has not been run yet.
    costs: (getSheet_('_costs') ? objectsOf_('_costs') : []).filter(function (x) { return x && x.id; })
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
  writeObjects_('_inventory', ['location','bookId','qty'], objs);
}

/* A pre-order that has not been handed over yet holds a copy back. On-hand
   always means "physically here"; available is what may still be sold to
   someone walking up to the table. */
function isDelivered_(s) { return s.delivered === true || s.delivered === 'true' || s.delivered === 'TRUE'; }

/* Where a delivered pre-order's copy came from. The wording changed once, so
   the older values are still recognised when reading. */
var DSRC_WAREHOUSE = 'Regional warehouse';
var DSRC_OUTSIDE   = 'Outside the region';
function fromOutside_(s) {
  var v = String(s.dsource || '');
  return v === DSRC_OUTSIDE || v === 'Other warehouse';
}
function isDelivery_(s) { return !!String(s.dsource || ''); }

/* Once delivered, a pre-order becomes an ordinary SALE row, so without a marker
   its history disappears. dsource is only ever set by a delivery, which makes it
   a reliable flag. */
function preorderNote_(s) {
  if (!isDelivery_(s)) return '';
  return 'Fulfilled pre-order — ' +
    (fromOutside_(s) ? 'sourced from outside the region'
                     : 'from the ' + getWarehouseName_() + ' warehouse');
}

/**
 * Every undelivered pre-order is a claim on the regional warehouse, wherever it
 * was taken. An event only takes pre-orders once it has sold out of that title,
 * so there is never event stock to hold back — the copy will come from the
 * warehouse or from outside the region entirely.
 */
function reservedMap_(sales) {
  var m = {};
  sales.forEach(function (s) {
    if (String(s.type) !== 'PREORDER' || isDelivered_(s) || !s.bookId) return;
    var k = invKey_(WAREHOUSE, String(s.bookId));
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
function shortfall_(rmap, bookId, after) {
  var held = getReserved_(rmap, WAREHOUSE, bookId);
  return Math.max(0, held - Math.max(0, after));
}
function breaksPreorders_(bookId, after, rmap) {
  var short = shortfall_(rmap, bookId, after);
  if (!short) return '';
  var b = bookById_(bookId) || { name: bookId };
  var held = getReserved_(rmap, WAREHOUSE, bookId);
  return short + ' of the ' + held + ' pre-order' + (held === 1 ? '' : 's') +
         ' for ' + b.name + ' could no longer be filled from ' + getWarehouseName_() + '.';
}

function getQty_(map, loc, book) { var v = map[invKey_(loc, book)]; return v === undefined ? 0 : v; }
function setQty_(map, loc, book, qty) { map[invKey_(loc, book)] = Math.max(0, Math.round(qty)); }
function addQty_(map, loc, book, delta) { setQty_(map, loc, book, getQty_(map, loc, book) + delta); }

/* ============================ DIRTY TRACKING ============================ */
/* Writes are fast because they only flag which readable tabs need rebuilding. */

function markDirty_(loc) {
  var p = PropertiesService.getScriptProperties();
  var set = {};
  try { set = JSON.parse(p.getProperty('dirtyLocs') || '{}'); } catch (err) { set = {}; }
  if (loc) set[String(loc)] = 1;
  set[WAREHOUSE] = 1;            // the master tab aggregates everything, always
  p.setProperty('dirtyLocs', JSON.stringify(set));
}

function markDirtyAll_() {
  var set = {};
  set[SUMMARY] = 1;
  regionsOrdered_().forEach(function (r) { if (r.whLoc) set[r.whLoc] = 1; });
  set[WAREHOUSE] = 1;
  objectsOf_('_events').forEach(function (e) { set[String(e.eventId)] = 1; });
  PropertiesService.getScriptProperties().setProperty('dirtyLocs', JSON.stringify(set));
}

/* Flag only the regions a change actually touched.

   markDirtyAll_ queues every tab in every regional file plus the season roll-up,
   and each of those files is a separate spreadsheet that has to be opened —
   seconds apiece. A shipment concerns two regions, so saying so keeps the
   background rebuild proportionate instead of redoing the whole tour. */
function markDirtyRegions_(regionIds) {
  var p = PropertiesService.getScriptProperties();
  var set = {};
  try { set = JSON.parse(p.getProperty('dirtyLocs') || '{}'); } catch (e) { set = {}; }
  // Deliberately NOT flagging SUMMARY: the sync reads that as "every region",
  // which would rebuild the whole tour. The season file is rewritten at the end
  // of every run anyway, so it stays current without asking.
  (regionIds || []).forEach(function (rid) {
    if (!rid) return;
    locsInRegion_(rid).forEach(function (l) { set[l] = 1; });
  });
  p.setProperty('dirtyLocs', JSON.stringify(set));
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
  var p = PropertiesService.getScriptProperties();
  var raw = p.getProperty('dirtyLocs');
  if (!raw || raw === '{}') return;
  var lastWrite = Number(p.getProperty('lastWriteAt') || 0);
  if (lastWrite && (Date.now() - lastWrite) < QUIET_MS) return;     // someone is working
  if (CacheService.getScriptCache().get('tbs_rendering')) return;   // already running
  var set = {};
  try { set = JSON.parse(raw); } catch (e) { return; }
  p.setProperty('dirtyLocs', '{}');          // anything written from here on re-flags

  var events = objectsOf_('_events');
  var groups = [];
  seasonsAll_().forEach(function (se) {
    setSeasonContext_(se.seasonId);
    var mine = {};
    regionsOrdered_().forEach(function (r) {
      if (r.whLoc) mine[r.whLoc] = 1;
      events.forEach(function (e) { if (String(e.regionId) === r.regionId) mine[String(e.eventId)] = 1; });
    });
    var group = {};
    Object.keys(set).forEach(function (k) { if (mine[k]) group[k] = 1; });
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
  if (!force && !_presetDirty) return syncEverySeason_();

  flushStockMoves_();                    // nothing left waiting before we render
  var p = PropertiesService.getScriptProperties();
  var dirtyRaw = _presetDirty ? JSON.stringify(_presetDirty) : p.getProperty('dirtyLocs');
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
    var lastWrite = Number(p.getProperty('lastWriteAt') || 0);
    if (lastWrite && (Date.now() - lastWrite) < QUIET_MS) return;
  }

  var cache = CacheService.getScriptCache();
  if (!force && !_presetDirty && cache.get('tbs_rendering')) return;   // a render is already in flight
  cache.put('tbs_rendering', '1', 300);

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
    if (!_presetDirty) p.setProperty('dirtyLocs', '{}');   // anything written from here on re-flags
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
          renderSeasonSheet_(); }
    catch (err) {
      lastErr = String(err && err.message ? err.message : err);
      console.error('renderSeasonSheet_ failed: ' + lastErr);
      try {
        var ss = seasonSpreadsheet_();
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

    if (lastErr) p.setProperty('lastRenderError', lastErr);
    else p.deleteProperty('lastRenderError');

    if (Object.keys(failed).length) {
      var still = {};
      try { still = JSON.parse(p.getProperty('dirtyLocs') || '{}'); } catch (e2) { still = {}; }
      Object.keys(failed).forEach(function (k) { still[k] = 1; });
      p.setProperty('dirtyLocs', JSON.stringify(still));
    }
  } finally {
    cache.remove('tbs_rendering');
  }
}

/* ============================ ACTION HANDLERS ============================ */

/* ============================ CASH LEDGER ============================
   A running record of physical cash and bank balances. Every entry is a signed
   movement, so balances are just the fold of all entries. Accounts are:
   'WAREHOUSE', 'BANK', or an event id. Currencies match the rest of the app.  */

var CASH_ACCTS = ['WAREHOUSE', 'BANK'];   // events are valid accounts too

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
  ensureHeaders_('_cash', CASH_HEADERS);
  var r = rowsOf_('_cash');
  var hs = r.headers.map(String);
  return { headers: hs, rows: r.data.map(function (row) {
    var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  }) };
}
function cashWrite_(headers, rows) { writeObjects_('_cash', headers, rows); }

/* 'by' records who made the entry. Without it, a movement nobody recognised
   could not be traced to a person or a link — which is exactly the position a
   transfer into a regional account left us in. */
var CASH_HEADERS = ['id','ts','kind','fromAcct','toAcct','cur','amt','note','purpose','by','changeAmt','changeIds','changeRef'];
var _cashBy = '';

/* What has been deliberately deleted, and must never come back.

   A save can arrive twice — a retry, or a page that closed before the reply and
   re-sent on opening. If it arrives AFTER the thing was deleted, the id is free
   again and the row would be written a second time: a deleted movement
   reappearing, and its money counted twice. These ids are remembered so a late
   arrival is recognised as something already dealt with. */
var TOMB_KEY = 'deletedIds';
function tombstones_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(TOMB_KEY) || '[]'); }
  catch (e) { return []; }
}
function tombstone_(id) {
  if (!id) return;
  var list = tombstones_();
  if (list.indexOf(String(id)) >= 0) return;
  list.push(String(id));
  if (list.length > 800) list = list.slice(list.length - 800);   // keep it small
  try { PropertiesService.getScriptProperties().setProperty(TOMB_KEY, JSON.stringify(list)); } catch (e) {}
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
  ensureHeaders_('_cash', CASH_HEADERS);
  /* The app may name the row itself. Without that, a movement made moments ago
     still carried a temporary name, so the first attempt to remove it was
     refused — "no longer in the ledger" — and only worked on a second try. */
  var wanted = String(o.id || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 40);
  if (wanted) {
    if (isDeleted_(wanted)) return wanted;          // deleted on purpose: never write it again
    var have = cashRows_().rows;
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
    changeIds: String(o.changeIds || ''),    // which change travelled with it
    changeRef: String(o.changeRef || ''),    // the change this row withdrew or returned
    purpose: String(o.purpose || '')
  };
  var sh = getSheet_('_cash');
  var live = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
  sh.appendRow(live.map(function (h) { return row[h] === undefined ? '' : row[h]; }));
  sheetMemoClear_();
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

  writeObjects_('_stockmoves',
    ['id','ts','kind','fromLoc','toLoc','bookId','qty','note','fromBefore','fromAfter','toBefore','toAfter'],
    rows.filter(function (m) { return String(m.id) !== id; }));
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

/** Write everything buffered so far. Safe to call at any time. */
function flushStockMoves_() {
  if (!_moveBuffer.length) return;
  var rows = _moveBuffer;
  _moveBuffer = [];                       // cleared first, so a failure can't double-write
  var sh = getSheet_('_stockmoves');
  if (!sh) return;
  var start = sh.getLastRow() + 1;
  var width = rows[0].length;
  if (sh.getMaxRows() < start + rows.length) {
    sh.insertRowsAfter(sh.getMaxRows(), rows.length + 10);
  }
  sh.getRange(start, 1, rows.length, width).setValues(rows);
  sheetMemoClear_();
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
    (getSheet_('_change') ? objectsOf_('_change') : []).forEach(function (r) {
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
  cashWrite_(cashRows_().headers, []);
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
  ensureHeaders_('_cash', CASH_HEADERS);
  var r = rowsOf_('_cash');
  var hs = r.headers.map(String);
  var found = false;
  var objs = r.data.map(function (row) {
    var o = {};
    hs.forEach(function (h, i) { o[h] = row[i]; });
    if (String(o.id) === id) {
      found = true;
      o.kind = kind;
      o.fromAcct = (kind === 'MOVE' ? String(p.fromAcct) : '');
      o.toAcct = String(p.toAcct);
      o.cur = cur;
      o.amt = amt;
      o.note = String(p.note || '');
      // purpose, and anything else on the row, is left exactly as it was.
    }
    return o;
  });
  if (!found) throw new Error('That entry is no longer in the ledger.');
  writeObjects_('_cash', hs, objs);
  var touched = [regionOfLoc_(String(p.toAcct))];
  if (p.fromAcct) touched.push(regionOfLoc_(String(p.fromAcct)));
  markDirtyRegions_(touched);
}

function doCashDelete(p) {
  var id = String(p.id);
  var c = cashRows_();
  var gone = null;
  var kept = c.rows.filter(function (o) {
    if (String(o.id) !== id) return true;
    gone = o; return false;
  });
  if (!gone) return;                       // already removed — a resend, not a failure
  cashWrite_(c.headers, kept);
  tombstone_(id);                          // and it must not come back on a resend

  /* Change is change wherever it goes, so removing a movement puts it back the
     way it was: a withdrawal undone removes the change entirely, a return
     undone makes it outstanding again, and a transfer undone brings the change
     back to where it started. */
  var ref = String(gone.changeRef || '');
  var ids = String(gone.changeIds || '').split(',').map(function (x) { return x.trim(); })
    .filter(function (x) { return x; });
  if (ref || ids.length) {
    var ch = changeRows_();
    var touched = false;
    ch.rows = ch.rows.filter(function (r) {
      if (ref && String(r.id) === ref && String(gone.purpose) === 'FLOAT') { touched = true; return false; }
      return true;
    });
    ch.rows.forEach(function (r) {
      if (ref && String(r.id) === ref && String(gone.purpose) === 'FLOAT_BACK') {
        r.returnedAt = ''; r.loc = String(gone.fromAcct || r.loc); touched = true;   // out again
      }
      if (ids.indexOf(String(r.id)) >= 0) {
        r.loc = String(gone.fromAcct || r.loc); r.returnedAt = ''; touched = true;   // back where it was
      }
    });
    if (touched) changeWrite_(ch.hs, ch.rows);
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
  var c = cashRows_();
  cashWrite_(c.headers, c.rows.filter(function (o) {
    return String(o.fromAcct) !== acct && String(o.toAcct) !== acct;
  }));
  markDirtyAll_();
}

function doCashResetBank(p) {
  var c = cashRows_();
  cashWrite_(c.headers, c.rows.filter(function (o) {
    return String(o.fromAcct) !== 'BANK' && String(o.toAcct) !== 'BANK';
  }));
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
  writeObjects_('_org', ['id','scope','category','sort','name','phone'], kept.concat(mine));
  markDirtyAll_();
}

/* ---- Regions ---- */
function doCreateRegion(p) {
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

  var rows = rowsOf_('_regions');
  var hs = rows.headers.map(String);
  var iId = hs.indexOf('regionId'), iName = hs.indexOf('name'), iCur = hs.indexOf('currencies');
  var iBooks = hs.indexOf('books');
  var bookIds = (p.books === undefined) ? null : parseBookList_(p.books);
  rows.data.forEach(function (row, i) {
    if (String(row[iId]) !== regionId) return;
    if (iName >= 0) rows.sheet.getRange(i + 2, iName + 1).setValue(name);
    if (iCur >= 0) rows.sheet.getRange(i + 2, iCur + 1).setValue(curs.join(','));
    if (iBooks >= 0 && bookIds) rows.sheet.getRange(i + 2, iBooks + 1).setValue(bookIds.join(','));
  });
  if (p.prices) savePrices_(regionId, p.prices);
  markDirtyAll_();
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
    allBooks_().forEach(function (b) {
      var total = 0;
      locs.forEach(function (l) {
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
  } else {
    locs.forEach(function (l) { allBooks_().forEach(function (b) { setQty_(map, l, b.id, 0); }); });
  }
  // The map is already authoritative — this region's locations were zeroed (or
  // emptied into the target) above. Drop its keys and write the map back.
  Object.keys(map).forEach(function (k) {
    if (isMine[k.split('||')[0]]) delete map[k];
  });
  saveInvMap_(map);

  // Sales, cash, stock moves, org rows, prices, events, and the region itself.
  writeObjects_('_sales', SALES_HEADERS,
    objectsOf_('_sales').filter(function (r) { return !isMine[String(r.location)]; }));

  var cashAll = cashRows_();
  cashWrite_(cashAll.headers, cashAll.rows.filter(function (c) {
    return !isMine[String(c.fromAcct)] && !isMine[String(c.toAcct)];
  }));

  writeObjects_('_stockmoves', ['id','ts','kind','fromLoc','toLoc','bookId','qty','note'],
    objectsOf_('_stockmoves').filter(function (m) {
      return !isMine[String(m.fromLoc)] && !isMine[String(m.toLoc)];
    }));

  var scopeGone = {}; scopeGone[regionId] = true;
  locs.forEach(function (l) { scopeGone[l] = true; });
  writeObjects_('_org', ['id','scope','category','sort','name','phone'],
    objectsOf_('_org').filter(function (r) { return !scopeGone[String(r.scope || '')]; }));

  writeObjects_('_prices', ['regionId','bookId','cur','price'],
    objectsOf_('_prices').filter(function (r) { return String(r.regionId) !== regionId; }));

  writeObjects_('_events', ['eventId','name','createdAt','regionId','key'],
    objectsOf_('_events').filter(function (e) { return String(e.regionId || '') !== regionId; }));

  writeObjects_('_regions', ['regionId','name','whLoc','sort','createdAt','currencies','books','key'],
    objectsOf_('_regions').filter(function (r) { return String(r.regionId) !== regionId; }));

  // Forget its spreadsheet so a region reusing the name gets a clean file.
  setMeta_('regionSheetId:' + regionId, '');
  _priceMemo = null;
  /* Only the season roll-up and wherever the stock went need rebuilding. Asking
     for the whole tour meant deleting one region rewrote every other region's
     file as well, which is what made it slow. */
  markDirtyRegions_(p.moveStockTo ? [String(p.moveStockTo)] : []);
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
  writeObjects_('_prices', ['regionId','bookId','cur','price'], rows);
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
  writeObjects_('_prices', ['regionId','bookId','cur','price'], kept.concat(mine));
  _priceMemo = null;
}

function doSetWarehouseName(p) {
  var name = String(p.name || '').trim();
  if (!name) throw new Error('Enter a warehouse name.');
  var r = rowsOf_('_meta');
  var found = false;
  for (var i = 0; i < r.data.length; i++) {
    if (r.data[i][0] === 'warehouseName') { r.data[i][1] = name; found = true; }
  }
  var objs = r.data.map(function (row) { return { key: row[0], value: row[1] }; });
  if (!found) objs.push({ key: 'warehouseName', value: name });
  writeObjects_('_meta', ['key','value'], objs);
  markDirtyAll_();
}

/** Absolute counts: "this location now holds exactly N of each." */
/* Shared advisory check for anything that reduces warehouse stock. */
function warnPreorders_(p, loc, items, afterFn, verbs) {
  if (p.override || loc !== WAREHOUSE) return;
  var rmap = reservedMap_(objectsOf_('_sales'));
  var warnings = [];
  (items || []).forEach(function (it) {
    if (!bookById_(String(it.bookId))) return;
    var why = breaksPreorders_(String(it.bookId), afterFn(it), rmap);
    if (why) warnings.push(why);
  });
  if (warnings.length) {
    var one = warnings.length === 1;
    throw new Error('There are currently pre-orders for ' + (one ? 'this book' : 'these books') +
      ' that you would no longer be able to fulfil if you ' + (one ? verbs[0] : verbs[1]) + '. ' +
      warnings.join(' '));
  }
}

function doSetStockBulk(p) {
  var loc = String(p.location || WAREHOUSE);
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
  var loc = String(p.location || WAREHOUSE);
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
  var loc = String(p.location || WAREHOUSE);
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
    if (!p.override && loc === WAREHOUSE && held > 0) {
      var why = breaksPreorders_(bookId, onHand - 1, rmap);
      if (why) {
        throw new Error('There are currently pre-orders for this book that you would no longer ' +
          'be able to fulfil if you sell it. ' + why);
      }
    }
    addQty_(map, loc, bookId, -1);
    saveInvMap_(map);
  }

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
    ts: p.ts
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
  var loc = String(p.location || WAREHOUSE);

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
    if (!p.override && loc === WAREHOUSE) {
      var why = breaksPreorders_(id, onHand - need[id], rmap);
      if (why) {
        throw new Error('There are currently pre-orders for these books that you would no ' +
          'longer be able to fulfil if you sell them. ' + why);
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
     before the screen caught up and the server no longer recognised it ("no
     longer in the log"), which is why the second attempt always worked. */
  var bundleId = String(p.keepBundleId || '') || ('B' + Utilities.getUuid().slice(0, 7));
  /* The app now names a new transaction itself, so that what it shows and what
     is stored carry the same id from the first moment. The one thing that must
     never happen is two sales sharing an id — that would fuse them — so a
     fresh sale naming an id already in use is given a new one instead. An edit
     has already removed its own rows, so it is never caught by this. */

  var n = items.length;
  var noteBase = n + ' book sale';   // one label for the whole transaction

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
      bundle: bundleId
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
    if (String(m.type) !== 'SALE' || !m.bookId || fromOutside_(m)) return;
    var back = isDelivery_(m) ? WAREHOUSE : String(m.location);
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
      throw new Error('One of those titles is no longer in the catalogue.');
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
  ensureHeaders_('_sales', SALES_HEADERS);
  var sh = getSheet_('_sales');
  var live = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
  rows.forEach(function (r) {
    sh.appendRow(live.map(function (h) { return r[h] === undefined ? '' : r[h]; }));
  });
  /* And take the copies back off the shelf.

     Deleting a sale puts its copy back; restoring the sale must take it off
     again, or a failed edit leaves a book on the shelf that was never there.
     That is how one Russian Adventures became two, and then four. */
  var map = loadInvMap_(), touched = false;
  rows.forEach(function (r) {
    if (String(r.type) !== 'SALE' || !r.bookId || fromOutside_(r)) return;
    var from = isDelivery_(r) ? WAREHOUSE : String(r.location);
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
  var loc = String(p.location || WAREHOUSE);
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
    pending: pending,
    paid: !pending && !(Number(o.dueamt) > 0),
    delivered: o.type === 'PREORDER' ? false : true,
    dsource: '',
    dueamt: pending ? 0 : Math.max(0, Number(o.dueamt) || 0),
    duecur: pending ? '' : String(o.duecur || ''),
    name: o.name || '', phone: o.phone || '', comments: o.comments || '',
    bundle: o.bundle || ''
  };
  /* Written by position, so the sheet must carry every column first. */
  ensureHeaders_('_sales', SALES_HEADERS);
  var sh = getSheet_('_sales');
  var live = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
  sh.appendRow(live.map(function (h) { return row[h] === undefined ? '' : row[h]; }));
  sheetMemoClear_();
  return row.saleId;
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
  return out.slice(0, 2);
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
  var r = rowsOf_(sheetName);
  var hs = r.headers.map(String);
  if (hs.indexOf('payTypes') < 0) {
    ensureHeaders_(sheetName, sheetName === '_events'
      ? ['eventId','name','createdAt','regionId','key','closedAt','sort','payTypes']
      : REGION_HEADERS);
    r = rowsOf_(sheetName); hs = r.headers.map(String);
  }
  var found = false;
  writeObjects_(sheetName, hs, r.data.map(function (row) {
    var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; });
    if (String(o[idField]) === id) { o.payTypes = value; found = true; }
    return o;
  }));
  if (!found) throw new Error('That place is no longer listed.');
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
  ensureHeaders_('_regions', REGION_HEADERS);
  var rows = objectsOf_('_regions');
  rows.forEach(function (r) { if (String(r.regionId) === regionId) r.hidden = ids.join(','); });
  writeObjects_('_regions', REGION_HEADERS, rows);
  markDirtyAll_();
  return ids.join(',');
}

function doSetEventHidden(p) {
  var id = String(p.eventId || '');
  var ev = eventById_(id);
  if (!ev) throw new Error('That event is no longer listed.');
  var ids = String(p.hidden || '').split(',').map(function (x) { return x.trim(); })
    .filter(function (x) { return x; });
  ensureColumn_('_events', 'hidden');
  var r = rowsOf_('_events');
  var hs = r.headers.map(String);
  var rows = r.data.map(function (row) { var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; }); return o; });
  rows.forEach(function (o) { if (String(o.eventId) === id) o.hidden = ids.join(','); });
  writeObjects_('_events', hs, rows);
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
  getSheet_('_events').appendRow([eventId, name, new Date(), regionId]);
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
  var objs = objectsOf_('_events').map(function (e) {
    if (String(e.eventId) === eventId) { oldName = String(e.name); e.name = name; }
    return e;
  });
  writeObjects_('_events', ['eventId','name','createdAt','regionId','key'], objs);
  var ss = SpreadsheetApp.getActive();
  var old = ss.getSheetByName(displayTabName_(oldName));
  if (old) ss.deleteSheet(old);
  markDirty_(eventId);
}

function doDeleteEvent(p) {
  var eventId = String(p.eventId);
  var ev = eventById_(eventId);
  if (!ev) throw new Error('Event not found.');

  // Books come home to THIS event's own regional warehouse — not Poland's.
  var homeWh = WAREHOUSE;
  var evRegion = String(ev.regionId || regionOfLoc_(eventId) || '');
  var evReg = evRegion ? regionById_(evRegion) : null;
  if (evReg && evReg.whLoc) homeWh = evReg.whLoc;

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
  var evObjs = objectsOf_('_events').filter(function (e) { return String(e.eventId) !== eventId; });
  writeObjects_('_events', ['eventId','name','createdAt','regionId','key'], evObjs);
  var keep = objectsOf_('_sales').filter(function (s) { return String(s.location) !== eventId; });
  writeObjects_('_sales', SALES_HEADERS, keep);

  // The tab lives in that region's own spreadsheet.
  try {
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
  if (!p.override && from === WAREHOUSE) {
    var rmap = reservedMap_(objectsOf_('_sales'));
    var warnings = [];
    moves.forEach(function (m) {
      var why = breaksPreorders_(m.id, getQty_(map, WAREHOUSE, m.id) - m.qty, rmap);
      if (why) warnings.push(why);
    });
    if (warnings.length) {
      var oneT = warnings.length === 1;
      throw new Error('There are currently pre-orders for ' + (oneT ? 'this book' : 'these books') +
        ' that you would no longer be able to fulfil if you ' +
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
   this is just a labelled entry/exit against our own stock. Only this
   warehouse's inventory changes; there is no bucket for the other warehouse
   to add to (or subtract from) yet. */
function doTransferExternal(p) {
  var dir = String(p.direction || 'out');
  // Sending to a region that IS in this season is a real two-sided move: books
  // leave here and arrive there. "Other" still just records the departure,
  // because there's nowhere in the system for them to land yet.
  var toRegionId = String(p.toRegionId || '');
  var target = toRegionId ? regionById_(toRegionId) : null;
  var here = regionById_(regionOfLoc_(String(p.fromLoc || WAREHOUSE))) ||
             regionsOrdered_()[0];
  var hereWh = here ? here.whLoc : WAREHOUSE;
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
  var all = objectsOf_('_sales');
  var target = null;
  var keep = all.filter(function (s) {
    if (String(s.saleId) === saleId) { target = s; return false; }
    return true;
  });
  // Already gone: the page's optimistic delete beat us here, or the write was
  // retried. Either way the end state is what the caller wanted, so succeed
  // quietly instead of throwing a scary error at them.
  if (!target) return;
  if (!_rebuilding) {                     // a late resend must not bring it back
    tombstone_(saleId);
    if (String(target.bundle || '')) tombstone_(String(target.bundle));
  }

  if (String(target.type) === 'SALE' && target.bookId) {
    // Put the copy back where it actually came from:
    //   • fulfilled from outside the region  → nothing to restore (never ours)
    //   • a delivered pre-order              → back on the warehouse shelf
    //   • an ordinary sale                   → back on its own location's table
    if (!fromOutside_(target)) {
      var map = loadInvMap_();
      var restoreLoc = isDelivery_(target) ? WAREHOUSE : String(target.location);
      addQty_(map, restoreLoc, String(target.bookId), 1);
      saveInvMap_(map);
      if (restoreLoc !== String(target.location)) markDirty_(restoreLoc);
    }
  }
  writeObjects_('_sales', SALES_HEADERS, keep);
  markDirty_(String(target.location));
}

function doEditSale(p) {
  var saleId = String(p.saleId);
  var r = rowsOf_('_sales');
  var idx = -1;
  for (var i = 0; i < r.data.length; i++) {
    if (String(r.data[i][0]) === saleId) { idx = i; break; }
  }
  if (idx < 0) throw new Error('That sale is no longer in the log.');

  var old = {};
  r.headers.forEach(function (h, i) { old[h] = r.data[idx][i]; });

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
    changecur: p.changecur !== undefined ? String(p.changecur) : String(old.changecur || '')
  };
  /* Written against the sheet's OWN column order, adding any it lacks. Writing
     by position here would scramble a sheet whose columns differ — the same
     fault that has cost us data before. */
  ensureHeaders_('_sales', SALES_HEADERS);
  var shS = getSheet_('_sales');
  var liveH = shS.getRange(1, 1, 1, Math.max(shS.getLastColumn(), 1)).getValues()[0].map(String);
  shS.getRange(idx + 2, 1, 1, liveH.length)
    .setValues([liveH.map(function (h) { return vals[h] === undefined ? '' : vals[h]; })]);
  sheetMemoClear_();

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
  var r = rowsOf_('_sales');
  for (var i = 0; i < r.data.length; i++) {
    if (String(r.data[i][0]) !== saleId) continue;
    var o = {};
    r.headers.forEach(function (h, j) { o[h] = r.data[i][j]; });
    if (String(o.type) !== 'PREORDER') throw new Error('That record is already a completed sale.');

    var loc = String(o.location), bookId = String(o.bookId);
    var book = bookById_(bookId) || { name: bookId };

    /* The copy comes off a shelf you choose — usually this region's warehouse,
       but the tour has many now, and a title may only be left in another one.
       Defaults to the home warehouse so older callers behave as before. */
    var src = String(p.fromLoc || '');
    if (fromStock) {
      if (!src) {
        var home = regionById_(regionOfLoc_(loc));
        src = home ? home.whLoc : WAREHOUSE;
      }
      var map = loadInvMap_();
      if (getQty_(map, src, bookId) <= 0) {
        throw new Error('There are no copies of ' + book.name + ' left at ' +
          locLabel_(src) + '. Choose somewhere else, or source it from outside.');
      }
      addQty_(map, src, bookId, -1);
      saveInvMap_(map);
    }

    var sh = getSheet_('_sales');
    sh.getRange(i + 2, SALES_HEADERS.indexOf('type') + 1).setValue('SALE');
    sh.getRange(i + 2, SALES_HEADERS.indexOf('delivered') + 1).setValue(true);
    sh.getRange(i + 2, SALES_HEADERS.indexOf('dsource') + 1)
      .setValue(fromStock ? DSRC_WAREHOUSE : DSRC_OUTSIDE);
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
  ensureHeaders_('_sales', SALES_HEADERS);
  var r = rowsOf_('_sales');
  var hs = r.headers.map(String);
  var iId = hs.indexOf('saleId'), iAmt = hs.indexOf('changeamt'), iCur = hs.indexOf('changecur');
  if (iAmt < 0) return;                     // nothing to clear
  var found = false;
  r.data.forEach(function (row, i) {
    if (String(row[iId]) !== saleId) return;
    r.sheet.getRange(i + 2, iAmt + 1).setValue(0);
    if (iCur >= 0) r.sheet.getRange(i + 2, iCur + 1).setValue('');
    found = true;
  });
  if (!found) return;                       // already cleared; nothing to do
  sheetMemoClear_();
  markDirtyRegions_([regionOfLoc_(String(p.location || ''))]);
}

function doMarkPaid(p) {
  var saleId = String(p.saleId);
  var r = rowsOf_('_sales');
  var sh = getSheet_('_sales');
  for (var i = 0; i < r.data.length; i++) {
    if (String(r.data[i][0]) !== saleId) continue;
    var o = {};
    r.headers.forEach(function (h, j) { o[h] = r.data[i][j]; });

    var due = dueAmt_(o), dueCur = dueCur_(o);
    if (!pendingFlag_(o) && due > 0) {
      if (String(o.p1cur) === dueCur) {
        sh.getRange(i + 2, SALES_HEADERS.indexOf('p1amt') + 1).setValue((Number(o.p1amt) || 0) + due);
      } else if (String(o.p2type) && String(o.p2cur) === dueCur) {
        sh.getRange(i + 2, SALES_HEADERS.indexOf('p2amt') + 1).setValue((Number(o.p2amt) || 0) + due);
      } else if (!String(o.p2type)) {
        sh.getRange(i + 2, SALES_HEADERS.indexOf('p2type') + 1).setValue(String(o.p1type) || 'Cash');
        sh.getRange(i + 2, SALES_HEADERS.indexOf('p2cur') + 1).setValue(dueCur);
        sh.getRange(i + 2, SALES_HEADERS.indexOf('p2amt') + 1).setValue(due);
      } else {
        // Both slots taken and neither is in the right currency. Convert into
        // the first leg's currency so the money is not simply lost.
        var conv = toUSD_(due, dueCur);
        var c1 = String(o.p1cur);
        var add = c1 === 'USD' ? conv : (c1 === 'PLN' ? conv * plnPerUsd_() : conv * eurPerUsd_());
        sh.getRange(i + 2, SALES_HEADERS.indexOf('p1amt') + 1).setValue(round2_((Number(o.p1amt) || 0) + add));
      }
    }

    sh.getRange(i + 2, SALES_HEADERS.indexOf('pending') + 1).setValue(false);
    sh.getRange(i + 2, SALES_HEADERS.indexOf('paid') + 1).setValue(true);
    sh.getRange(i + 2, SALES_HEADERS.indexOf('dueamt') + 1).setValue(0);
    sh.getRange(i + 2, SALES_HEADERS.indexOf('duecur') + 1).setValue('');
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

   Modelled as ownership on the title itself, so a seller taps the book exactly
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
    var rows = rowsOf_('_partners');
    var hs = rows.headers.map(String);
    writeObjects_('_partners', hs, rows.data.map(function (row) {
      var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; });
      if (String(o.partnerId) === id) {
        o.name = name; o.note = String(p.note || '').trim();
        if (p.archived !== undefined) o.archived = !!p.archived;
      }
      return o;
    }));
  } else {
    id = 'pt_' + Utilities.getUuid().slice(0, 6);
    getSheet_('_partners').appendRow([id, regionId, name, String(p.note || '').trim(), new Date(), false]);
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
     reply is recognised rather than paid a second time. */
  var payBase = String(p.payoutId || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 40);
  clean.forEach(function (it, i) {
    var rowId = payBase ? (payBase + '_' + i) : ('P' + Utilities.getUuid().slice(0, 7));
    if (payBase) {
      var seen = objectsOf_('_payouts').some(function (x) { return String(x.id) === rowId; });
      if (seen) return;                      // already recorded — a resend
    }
    getSheet_('_payouts').appendRow([rowId, partnerId,
      new Date(), it.cur, it.amt, String(p.note || '').trim(), String(p.method || 'Cash')]);
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
  if (getSheet_('_costs')) objectsOf_('_costs').forEach(function (c) {
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
/* The catalogue, built once per request and looked up by id.

   It used to be rebuilt on every single lookup, and every lookup then scanned
   it from the start. Consignment made that expensive: working out what a group
   is owed asks "whose book is this?" for every sale, so the whole catalogue was
   reassembled once per sale per group. An index turns that into one build and a
   direct lookup. */
var _bookMemo = null, _bookIndex = null;
function bookMemoClear_() { _bookMemo = null; _bookIndex = null; _tallyMemo = null; }

/* The catalogue in the order it should be shown.

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

/* The catalogue as a given region wants it shown.

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

  ensureHeaders_('_regions', REGION_HEADERS);
  var r = rowsOf_('_regions');
  var hs = r.headers.map(String);
  writeObjects_('_regions', hs, r.data.map(function (row) {
    var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; });
    if (String(o.regionId) === regionId) o.bookOrder = ids.join(',');
    return o;
  }));
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
  writeObjects_('_qr', ['id','scope','label','caption','src','sort'], kept.concat(mine));
  markDirtyAll_();
}

/* Remove a title from the catalogue.

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
  var r = rowsOf_('_custombooks');
  var hs = r.headers.map(String);
  var found = false;
  writeObjects_('_custombooks', hs, r.data.map(function (row) {
    var o = {}; hs.forEach(function (h, i) { o[h] = row[i]; });
    if (String(o.id) === id) {
      o.name = name;
      if (p.cat) o.cat = normCat_(p.cat);
      found = true;
    }
    return o;
  }));
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

  writeObjects_('_custombooks', rowsOf_('_custombooks').headers.map(String),
    custom.filter(function (b) { return String(b.id) !== id; }));
  // Its prices go with it.
  writeObjects_('_prices', ['regionId','bookId','cur','price'],
    objectsOf_('_prices').filter(function (r) { return String(r.bookId) !== id; })
      .map(function (r) {
        return { regionId: String(r.regionId), bookId: String(r.bookId),
                 cur: String(r.cur), price: Number(r.price) || 0 };
      }));
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
  ensureHeaders_('_custombooks', ['id','name','cat','createdAt','partnerId','sort']);
  var shB = getSheet_('_custombooks');
  var liveB = shB.getRange(1, 1, 1, Math.max(shB.getLastColumn(), 1)).getValues()[0].map(String);
  var rowB = { id: id, name: name, cat: cat, createdAt: new Date(),
               partnerId: String(p.partnerId || ''), sort: '' };
  shB.appendRow(liveB.map(function (h) { return rowB[h] === undefined ? '' : rowB[h]; }));
  sheetMemoClear_();
  bookMemoClear_();
  markDirtyRegions_(regionsTouchedByBook_(p.partnerId));
  return id;
}

function bookById_(id) { return bookIndex_()[id] || null; }
/* The tour's own catalogue. A consignment title is left out of these, so it
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
  if (loc === WAREHOUSE) return getWarehouseName_() + ' (Warehouse)';
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

function eachLeg_(s, fn) {
  if (s.p1type) fn({ type: String(s.p1type), cur: String(s.p1cur), amt: Number(s.p1amt) || 0 });
  if (s.p2type) fn({ type: String(s.p2type), cur: String(s.p2cur), amt: Number(s.p2amt) || 0 });
}
function legsUsd_(s) { var t = 0; eachLeg_(s, function (l) { t += toUSD_(l.amt, l.cur); }); return t; }

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
function legsUSD_(s) {
  var t = 0;
  eachLeg_(s, function (leg) { t += toUSD_(leg.amt, leg.cur); });
  return t;
}
function dueUSD_(s) {
  var amt = Number(s.dueamt) || 0;
  if (pendingFlag_(s)) {
    // Nothing paid yet: the whole ticket is outstanding.
    var t = 0;
    eachLeg_(s, function (leg) { t += toUSD_(leg.amt, leg.cur); });
    return t;
  }
  if (amt <= 0) return 0;
  return toUSD_(amt, String(s.duecur || 'USD'));
}

/** Everything still owed on this sale, in USD. */
function dueUsd_(s) {
  if (pendingFlag_(s)) return legsUsd_(s);
  return toUSD_(dueAmt_(s), dueCur_(s));
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
  put([(fx.live ? 'Exchange rates \u2014 LIVE' : 'Exchange rates \u2014 OFFLINE FALLBACK (live fetch failed)'),
       'USD is the common currency' + (fx.live && fx.asOf ? '  (as of ' + fx.asOf + ')' : '')]);
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
        acc.usd += toUSD_(leg.amt, leg.cur);
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
  // Show the rate for whatever currencies THIS region actually deals in.
  put([(fx.live ? 'Exchange rates — LIVE' : 'Exchange rates — OFFLINE FALLBACK (live fetch failed)'),
       '$1 = ' + (region.currencies || []).filter(function (c) { return c !== 'USD'; })
         .map(function (c) { return round2_(perUsd_(c)) + ' ' + c; }).join(' / ')
       + (fx.live && fx.asOf ? '  (as of ' + fx.asOf + ')' : '')]);
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
      // "In Transit" is what is still travelling here — expected, not yet stock.
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
    // Show the section if any cash has moved OR any cash was collected anywhere.
    var anyCash = objectsOf_('_cash').length > 0 || cashAccts.some(function (a) {
      return cashCollected_(a.id, 'PLN') || cashCollected_(a.id, 'EUR') || cashCollected_(a.id, 'USD');
    });
    if (anyCash) {
      band.push(put(['CASH ON HAND']));
      head.push(put(['Account', 'PLN', 'EUR', 'USD']));
      var cashStart = rows.length + 1;
      function acctAmt(a, cur) {
        return a.bankOf ? bankFromRegion_(a.bankOf, cur) : cashBalance_(a.id, cur);
      }
      cashAccts.forEach(function (a) {
        put([a.name, acctAmt(a, 'PLN'), acctAmt(a, 'EUR'), acctAmt(a, 'USD')]);
      });
      // totals row
      tot.push(put(['TOTAL',
        cashAccts.reduce(function (t, a) { return t + acctAmt(a, 'PLN'); }, 0),
        cashAccts.reduce(function (t, a) { return t + acctAmt(a, 'EUR'); }, 0),
        cashAccts.reduce(function (t, a) { return t + acctAmt(a, 'USD'); }, 0)]));
      money.push('B' + cashStart + ':D' + (cashStart + cashAccts.length));
      blank();
    }
  }

  /* ---- Money by currency ---- */
  band.push(put(['COLLECTIONS BY CURRENCY']));
  head.push(put(['Currency', 'Books & pre-orders', 'Donations', 'Total collected', 'USD equivalent']));
  var curStart = rows.length + 1;
  allCurrencies_().forEach(function (cur) {
    var bookAmt = 0, donAmt = 0;
    scoped.forEach(function (s) {
      if (!received_(s)) return;
      eachLeg_(s, function (leg) {
        if (leg.cur !== cur) return;
        if (s.type === 'DONATION') donAmt += leg.amt; else bookAmt += leg.amt;
      });
    });
    var total = bookAmt + donAmt;
    put([cur, round2_(bookAmt), round2_(donAmt), round2_(total), round2_(toUSD_(total, cur))]);
  });
  money.push('B' + curStart + ':E' + (curStart + 2));
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
  var totalsByCur = {};
  curList.forEach(function (c) { totalsByCur[c] = 0; });

  KINDS.forEach(function (pair) {
    var kind = pair[0];
    var byCur = {};
    curList.forEach(function (c) { byCur[c] = 0; });
    scoped.forEach(function (s) {
      if (!received_(s) || s.type === 'DONATION' || !s.bookId) return;
      var b = bookById_(s.bookId);
      if (!b || normCat_(b.cat) !== kind) return;
      eachLeg_(s, function (leg) {
        if (byCur[leg.cur] === undefined) return;
        byCur[leg.cur] += leg.amt; totalsByCur[leg.cur] += leg.amt;
      });
    });
    var usdEq = curList.reduce(function (t, c) { return t + toUSD_(byCur[c], c); }, 0);
    put([pair[1]].concat(curList.map(function (c) { return round2_(byCur[c]); }))
        .concat([round2_(usdEq)]));
  });

  // Donations, kept separate because they are not a book sale.
  var donByCur = {};
  curList.forEach(function (c) { donByCur[c] = 0; });
  scoped.forEach(function (s) {
    if (!received_(s) || s.type !== 'DONATION') return;
    eachLeg_(s, function (leg) {
      if (donByCur[leg.cur] === undefined) return;
      donByCur[leg.cur] += leg.amt; totalsByCur[leg.cur] += leg.amt;
    });
  });
  put(['Donations'].concat(curList.map(function (c) { return round2_(donByCur[c]); }))
      .concat([round2_(curList.reduce(function (t, c) { return t + toUSD_(donByCur[c], c); }, 0))]));

  put(['Total'].concat(curList.map(function (c) { return round2_(totalsByCur[c]); }))
      .concat([round2_(curList.reduce(function (t, c) { return t + toUSD_(totalsByCur[c], c); }, 0))]));

  money.push('B' + typeStart + ':' + colLetter_(curList.length + 2) + (typeStart + KINDS.length + 1));
  blank();

  /* ---- Money by payment type ---- */
  band.push(put(['COLLECTIONS BY PAYMENT TYPE']));
  head.push(put(['Type', 'PLN', 'EUR', 'USD', 'USD equivalent']));
  var payStart = rows.length + 1;
  PAY_TYPES.forEach(function (t) {
    var byCur = { PLN: 0, EUR: 0, USD: 0 };
    scoped.forEach(function (s) {
      if (!received_(s)) return;
      eachLeg_(s, function (leg) { if (leg.type === t && byCur[leg.cur] !== undefined) byCur[leg.cur] += leg.amt; });
    });
    var usdEq = toUSD_(byCur.PLN, 'PLN') + toUSD_(byCur.EUR, 'EUR') + toUSD_(byCur.USD, 'USD');
    put([t, round2_(byCur.PLN), round2_(byCur.EUR), round2_(byCur.USD), round2_(usdEq)]);
  });
  money.push('B' + payStart + ':E' + (payStart + PAY_TYPES.length - 1));
  blank();

  /* ---- Costs, and what was kept after them (Summary only) ----

     Card-machine fees and other costs of selling, recorded in the app against
     a place in this region. Listed one by one, totalled by currency, then set
     against what was collected to give the net. Consignment money is not ours,
     so — as in the collections above — it is not part of the net either. */
  if (isSummary) {
    var costCurs = allCurrencies_();
    var regionCosts = (getSheet_('_costs') ? objectsOf_('_costs') : [])
      // Our own costs only: a consignment group's costs come off what it is owed.
      .filter(function (c) { return c && c.id && inRegion[String(c.location)] && !String(c.partnerId || ''); })
      .sort(function (a, b) { return new Date(a.ts) - new Date(b.ts); });

    band.push(put(['COSTS']));
    if (!regionCosts.length) {
      put(['No costs recorded.']);
    } else {
      head.push(put(['When', 'What for', 'Payment type', 'Where', 'Note'].concat(costCurs).concat(['USD equivalent'])));
      var costStart = rows.length + 1;
      var costTotal = {}; costCurs.forEach(function (c) { costTotal[c] = 0; });
      regionCosts.forEach(function (c) {
        var cur = String(c.cur), amt = Number(c.amt) || 0;
        if (costTotal[cur] !== undefined) costTotal[cur] += amt;
        put([c.ts, String(c.category || 'Other'), String(c.payType || ''), locLabel_(String(c.location)),
             String(c.note || '')]
          .concat(costCurs.map(function (k) { return k === cur ? round2_(amt) : 0; }))
          .concat([round2_(toUSD_(amt, cur))]));
      });
      var costUsd = costCurs.reduce(function (t, k) { return t + toUSD_(costTotal[k], k); }, 0);
      put(['Total costs', '', '', '', ''].concat(costCurs.map(function (k) { return round2_(costTotal[k]); }))
        .concat([round2_(costUsd)]));
      money.push(colLetter_(6) + costStart + ':' + colLetter_(6 + costCurs.length) + (costStart + regionCosts.length));
      blank();

      // What was kept: collected (our own sales, received) less the costs.
      var got = {}; costCurs.forEach(function (k) { got[k] = 0; });
      scoped.forEach(function (sl) {
        if (!received_(sl)) return;
        eachLeg_(sl, function (leg) { if (got[leg.cur] !== undefined) got[leg.cur] += leg.amt; });
      });
      var gotUsd = costCurs.reduce(function (t, k) { return t + toUSD_(got[k], k); }, 0);
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
  head.push(put(['Item', 'Still owed', 'Currency', 'Already paid', 'Name', 'Phone', 'When']));
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
                         : getWarehouseName_() + ' Warehouse');
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
