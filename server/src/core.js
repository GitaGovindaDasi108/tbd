/* The server, without Cloudflare: Code.gs on a SQLite database.

   worker.js puts this inside a Durable Object; the tests run it on Node's own
   SQLite. Either way one request is answered completely before the next
   starts, which is what the script lock did on Google. */
import { makeApp, CODE_BUILD } from './app.gen.js';
import { makeSqlStore } from './sqlstore.js';
import { makeGoogle, makeWebCache } from './google.js';
import { makeAuth } from './auth.js';

// Where the exchange rates come from (the first source Code.gs tries).
export const RATES_URL = 'https://open.er-api.com/v6/latest/USD';

// The app's requests about spreadsheets: Google does those (see the bridge below).
const SHEET_ACTIONS = /^(driveMap|syncSheets|setDriveFolder|setSeasonFolder|descriptionsSheet)$/;
const IN_FLIGHT_MS = 15 * 60 * 1000;          // a spreadsheet run that never reported back

export function makeServer({ exec, timeZone, fetchImpl, uuid, googleClientId, adminEmails, googleCertsUrl,
                             reportUrl, reportSecret }) {
  const { store, kv, forget, dump, exportAll, importAll } = makeSqlStore(exec);
  const auth = makeAuth({ exec, clientId: googleClientId, adminEmails, fetchImpl, certsUrl: googleCertsUrl });
  const web = makeWebCache(kv, 6 * 3600 * 1000);
  const app = makeApp(Object.assign(makeGoogle({ store, kv, web, timeZone, uuid }), { reportsHere: false }));

  /* One request, as Apps Script hands it to doPost/doGet: a POST's body, or a
     GET's parameters. Returns the reply text. */
  function answer(e) { return app.handle(e).getContent(); }

  /* A new database gets what initialize() gave a new spreadsheet — its tables
     and the book catalogue — before anything else is asked of it. */
  if (!store.has('_meta')) {
    app.sheetMemoClear_(); app.setSeasonContext_('');
    app.ensureReady(true); app.flushStockMoves_(); app.cacheClear_();
  }

  /* A request from the outside world: the sign-in gate, then the rules.
     Link holders go straight through (Code.gs decides what a link may do);
     the owner's app needs a signed-in admin's session. */
  const reply = o => JSON.stringify(o);
  async function request(e) {
    let p = {};
    try { p = e.postData ? JSON.parse(e.postData.contents || '{}') : (e.parameter || {}); }
    catch (err) { return reply({ ok: false, error: 'That request could not be read.' }); }
    const action = String(p.action || 'getState');
    if (action === 'signIn') {
      if (!googleClientId) return reply({ ok: false, error: 'Sign-in is not set up on this server yet.' });
      try { return reply({ ok: true, result: await auth.signIn(p.idToken) }); }
      catch (err) { return reply({ ok: false, error: String(err && err.message || err) }); }
    }
    if (action === 'signOut') { auth.signOut(p.s); return reply({ ok: true }); }
    // Google's spreadsheet side, calling in with the shared secret.
    if (/^(reportExport|reportWriteBack|reportImport|reportState)$/.test(action)) return reply(bridge(p));
    // A phone still pointed at Google, passed on by Google (Phase 3): answered as it always was.
    if (action === 'relay') return relay(p);
    if (action === 'ping') return answer(e);                        // the revision number, nothing more
    const linkKey = String(p.k || '').trim();
    if (!linkKey && !auth.check(p.s)) {
      return reply({ ok: false, signIn: true, error: 'Please sign in with Google to use the app.' });
    }
    // The owner's spreadsheet requests are passed to Google, which does them.
    if (!linkKey && SHEET_ACTIONS.test(action)) return forwardToGoogle(p);
    return answer(e);
  }

  /* ---- The spreadsheets, still made by Google ----

     Google's Apps Script keeps building the readable spreadsheets, exactly as
     before, from a copy of the records it asks for here ("reportExport"). It
     sends back only what it learned while doing it ("reportWriteBack"): the
     spreadsheet and folder ids it keeps in _meta, the Activity Log lines of the
     spreadsheet actions, the last error, and which places still need
     redrawing. Everything else in its copy is thrown away, so it can never
     overwrite a sale made in the meantime.

     Which places need redrawing is handed over, not copied: when Google takes
     them (a "claim") they are cleared here, and a run that never reports back
     is given back after 15 minutes. */
  function bridge(p) {
    if (!reportSecret || String(p.secret || '') !== reportSecret) return { ok: false, error: 'Not allowed.' };
    try {
      app.sheetMemoClear_(); app.setSeasonContext_('');
      app.flushStockMoves_();
      if (p.action === 'reportImport') return { ok: true, result: reportImport(p) };
      if (p.action === 'reportState') return { ok: true, result: reportState(p) };
      return { ok: true, result: p.action === 'reportExport' ? reportExport(String(p.mode || 'tick')) : reportWriteBack(p.back || {}) };
    } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  }
  const parse = (raw, dflt) => { try { return raw ? JSON.parse(raw) : dflt; } catch (e) { return dflt; } };
  function reportExport(mode) {
    // A run that never came back: its places need drawing still.
    const flying = parse(kv.getProp('cfInFlight'), null);
    if (flying && Date.now() - flying.at > IN_FLIGHT_MS) {
      const d = parse(kv.getProp('dirtyLocs'), {});
      Object.keys(flying.set || {}).forEach(k => { d[k] = 1; });
      kv.setProp('dirtyLocs', JSON.stringify(d));
      kv.delProp('cfInFlight');
    }
    const dirty = parse(kv.getProp('dirtyLocs'), {});
    const quiet = Date.now() - Number(kv.getProp('lastWriteAt') || 0) >= app.QUIET_MS;
    // tick: the minute check — only when something needs drawing and nobody is saving.
    if (mode === 'tick' && (!Object.keys(dirty).length || !quiet || kv.getProp('cfInFlight'))) return { idle: true };
    let claim = '';
    const props = kv.allProps();
    if (mode === 'tick' || mode === 'sync') {
      claim = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      kv.setProp('cfInFlight', JSON.stringify({ id: claim, at: Date.now(), set: dirty }));
      kv.setProp('dirtyLocs', '{}');
      props.dirtyLocs = JSON.stringify(dirty);
    } else {
      props.dirtyLocs = '{}';          // (a forwarded request draws nothing by itself)
    }
    delete props.cfInFlight;
    return { claim, tables: exportAll(), props };
  }
  /* Phase 3: the records copied across from Google, replacing what is here.
     The revision moves on past Google's, so every phone fetches afresh. */
  function reportImport(p) {
    const got = importAll(p.tables || {}, p.props || {});
    app.sheetMemoClear_(); app.setSeasonContext_('');
    kv.setProp('rev', String(Number((p.props || {}).rev || 0) + 1));
    app.cacheClear_();
    return got;
  }
  /* One season's state, as the owner's app would see it — to compare with Google's. */
  function reportState(p) {
    const r = JSON.parse(answer({ postData: { contents: JSON.stringify({ action: 'getState', season: String(p.season || '') }) } }));
    if (!r.ok) throw new Error(r.error || 'Could not read that season.');
    return r.state;
  }
  /* A request that reached Google from a phone not yet switched over. Google
     vouches for it with the shared secret, and it is answered exactly as the
     phone expects — so nothing is lost while phones catch up. */
  function relay(p) {
    if (!reportSecret || String(p.secret || '') !== reportSecret) return reply({ ok: false, error: 'Not allowed.' });
    return answer({ postData: { contents: JSON.stringify(p.params || {}) } });
  }
  function reportWriteBack(back) {
    Object.keys(back.meta || {}).forEach(k => {
      if (String(app.getMeta_(k, '')) !== String(back.meta[k])) app.setMeta_(k, back.meta[k]);
    });
    if ((back.activity || []).length) {
      app.activitySheet_();
      const have = new Set(app.objectsOf_('_activity').map(r => String(r.id)));
      back.activity.forEach(row => {
        if (row && row.id && !have.has(String(row.id))) {
          const o = {};
          Object.keys(row).forEach(k => { const v = row[k]; o[k] = (v && typeof v === 'object' && '$d' in v) ? new Date(v.$d) : v; });
          app.dbInsert_('_activity', o);
        }
      });
    }
    if (back.props && 'lastRenderError' in back.props) {
      if (back.props.lastRenderError) kv.setProp('lastRenderError', String(back.props.lastRenderError));
      else kv.delProp('lastRenderError');
    }
    // What Google could not finish: back on the list.
    const failed = back.failed || {};
    if (Object.keys(failed).length) {
      const d = parse(kv.getProp('dirtyLocs'), {});
      Object.keys(failed).forEach(k => { d[k] = 1; });
      kv.setProp('dirtyLocs', JSON.stringify(d));
    }
    const flying = parse(kv.getProp('cfInFlight'), null);
    if (flying && back.claim && flying.id === back.claim) kv.delProp('cfInFlight');
    app.cacheClear_(); app.bumpRev_();
    return { done: true };
  }
  /* The owner asked for something only Google can do (build every spreadsheet,
     change where they are filed...): Google does it with a fresh copy of the
     records, reports back through the bridge, and the app gets its answer. */
  async function forwardToGoogle(p) {
    if (!reportUrl || !reportSecret) return reply({ ok: false, error: 'The spreadsheets are not connected to this server yet.' });
    const params = Object.assign({}, p); delete params.s;
    let text;
    try {
      const r = await fetchImpl(reportUrl, { method: 'POST', body: JSON.stringify({ cfForward: true, secret: reportSecret, params }) });
      text = await r.text();
      JSON.parse(text);
    } catch (err) {
      return reply({ ok: false, error: 'Google could not be reached to do that. Try again in a moment.' });
    }
    // "Sync sheet" answers with the state, as it did on Google: this server's own, now.
    if (p.action === 'syncSheets') {
      const r = JSON.parse(text);
      if (!r.ok) return text;
      return answer({ postData: { contents: JSON.stringify({ action: 'getState', season: p.season }) } });
    }
    return text;
  }

  /* Fetch what the rules asked for and could not have (see google.js). */
  async function fetchWanted() {
    const urls = [...web.wanted];
    web.wanted.clear();
    for (const url of urls) {
      try {
        const r = await fetchImpl(url);
        web.put(url, r.status, await r.text());
      } catch (e) { /* unreachable: the rules carry on without it, as on Google */ }
    }
  }
  /* The rates, fetched ahead of the request that will want them. */
  async function warm() {
    if (!web.get(RATES_URL)) { web.wanted.add(RATES_URL); await fetchWanted(); }
  }
  /* The background jobs Google's minute trigger used to run that are about the
     records, not the spreadsheets: clearing leftovers of deleted seasons, and
     filling in the rates of regions closed before rates were kept. */
  function housekeeping() {
    app.sheetMemoClear_(); app.setSeasonContext_('');
    try { app.purgeOrphans_(); } catch (e) { console.log('purgeOrphans_: ' + e); }
    try { app.backfillRegionRates_(); } catch (e) { console.log('backfillRegionRates_: ' + e); }
    try { app.flushStockMoves_(); } catch (e) {}
    kv.sweepTemp();
    auth.sweep();
  }
  return { answer, request, bridge, relay, auth, warm, fetchWanted, housekeeping, kv, store, forget, dump, build: CODE_BUILD, web, app };
}
