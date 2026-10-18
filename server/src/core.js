/* The server, without Cloudflare: Code.gs on a SQLite database.

   worker.js puts this inside a Durable Object; the tests run it on Node's own
   SQLite. Either way one request is answered completely before the next
   starts, which is what the script lock did on Google. */
import { makeApp, CODE_BUILD } from './app.gen.js';
import { makeSqlStore } from './sqlstore.js';
import { makeGoogle, makeWebCache } from './google.js';
import { makeAuth } from './auth.js';
import * as people from './people.js';
import { makeExpenses } from './expenses.js';

// Where the exchange rates come from (the first source Code.gs tries).
export const RATES_URL = 'https://open.er-api.com/v6/latest/USD';

// The app's requests about spreadsheets: Google does those (see the bridge below).
const SHEET_ACTIONS = /^(driveMap|syncSheets|setDriveFolder|setSeasonFolder|descriptionsSheet)$/;
const IN_FLIGHT_MS = 15 * 60 * 1000;          // a spreadsheet run that never reported back

export function makeServer({ exec, timeZone, fetchImpl, uuid, googleClientId, adminEmails, googleCertsUrl,
                             reportUrl, reportSecret, practice, liveUrl, liveSecret, practiceSecret }) {
  const { store, kv, forget, dump, exportAll, importAll } = makeSqlStore(exec);
  /* On the practice server the owners are the live server's (copied with the
     records), unless ADMIN_EMAILS is set on it as well. */
  const owners = practice ? () => adminEmails || kv.getProp('liveOwners') || '' : adminEmails;
  const auth = makeAuth({ exec, clientId: googleClientId, adminEmails: owners, fetchImpl, certsUrl: googleCertsUrl });
  const web = makeWebCache(kv, 6 * 3600 * 1000);
  const app = makeApp(Object.assign(makeGoogle({ store, kv, web, timeZone, uuid }), { reportsHere: false }));

  /* Expenses and their receipts (b238): kept and decided here, where the people are. */
  const expenses = makeExpenses({ exec, app, auth, people, places: () => places(), kv, practice: !!practice,
    // A cost kept for an expense is written by Code.gs's own saveCost/deleteCost, as the owner's app would.
    asOwner: (params, name) => {
      app.setTrustedWho_({ role: 'admin', name: name || 'Expenses', email: '', grant: 'U' });
      const r = JSON.parse(answer({ postData: { contents: JSON.stringify(Object.assign({ opId: 'xc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) }, params)) } }));
      if (!r.ok) throw new Error(r.error || 'The cost could not be kept.');
      return r;
    } });

  /* ---- View as (b238, the practice space only) ----
     Universal sees the app as someone else would: a person (with their own
     roles), or a role at a place nobody holds. The page sends "va"; for that
     one request the server answers as that person — or as a stand-in holding
     only that role — so what is shown and what is allowed are exactly theirs.
     Never on the live server. */
  const PREVIEW = 'preview@practice.invalid';
  let VIEW = null;
  const realAuth = { grantsOf: auth.grantsOf, isAdmin: auth.isAdmin, isOwner: auth.isOwner, nameOf: auth.nameOf, person: auth.person };
  auth.grantsOf = e => (VIEW && VIEW.grants && e === PREVIEW) ? VIEW.grants : realAuth.grantsOf(e);
  auth.isAdmin = e => (VIEW && e === PREVIEW) ? VIEW.role === 'U' : realAuth.isAdmin(e);
  auth.isOwner = e => (VIEW && e === PREVIEW) ? false : realAuth.isOwner(e);
  auth.nameOf = e => (VIEW && e === PREVIEW) ? VIEW.name : realAuth.nameOf(e);
  auth.person = e => (VIEW && e === PREVIEW) ? { email: PREVIEW, name: VIEW.name, googleName: '', owner: false } : realAuth.person(e);
  function viewAs(me, va) {
    if (!practice || !va || !realAuth.isAdmin(me)) return me;
    if (va.email) {
      const email = String(va.email).trim().toLowerCase();
      return realAuth.grantsOf(email).length || realAuth.isOwner(email) ? email : me;
    }
    const role = String(va.role || ''), kind = (people.ROLES[role] || {}).kind;
    if (!kind) return me;
    const placeId = kind === 'all' ? '' : String(va.placeId || '');
    VIEW = { role, name: 'Preview (' + people.ROLES[role].name + ')',
      grants: [{ id: 'gPREVIEW', email: PREVIEW, role, placeId, addedBy: '', addedAt: 0 }] };
    return PREVIEW;
  }

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
    VIEW = null;
    try { return await request1(e); } finally { VIEW = null; }
  }
  async function request1(e) {
    let p = {};
    try { p = e.postData ? JSON.parse(e.postData.contents || '{}') : (e.parameter || {}); }
    catch (err) { return reply({ ok: false, error: 'That request could not be read.' }); }
    const action = String(p.action || 'getState');
    // The live server, asked for a copy by the practice server (b231).
    if (action === 'practiceExport') return reply(practiceExport(p));
    // The practice server fills itself from live the first time it is used.
    if (practice && !kv.getProp('practiceSeeded') && liveUrl && liveSecret) {
      try { await practiceReset(); } catch (err) { console.log('practice copy: ' + err); }
    }
    if (action === 'practiceInfo') return reply({ ok: true, result: { practice: !!practice, copiedAt: Number(kv.getProp('practiceSeeded')) || 0 } });
    if (action === 'signIn') {
      if (!googleClientId) return reply({ ok: false, error: 'Sign-in is not set up on this server yet.' });
      try {
        const r = await auth.signIn(p.idToken);
        if (r.pending) return reply({ ok: false, pending: true, email: r.email, name: r.name || '',
          error: 'Your request has been sent to the admins. You can come in once one of them approves it.' });
        if (r.declined) return reply({ ok: false, declined: true, email: r.email,
          error: 'This account has not been approved for the app. Ask an admin to add it.' });
        return reply({ ok: true, result: r });
      } catch (err) { return reply({ ok: false, error: String(err && err.message || err) }); }
    }
    if (action === 'signOut') { auth.signOut(p.s); return reply({ ok: true }); }
    // Google's spreadsheet side, calling in with the shared secret.
    if (/^(reportExport|reportWriteBack|reportImport|reportState)$/.test(action)) return reply(bridge(p));
    // A phone still pointed at Google, passed on by Google (Phase 3): answered as it always was.
    if (action === 'relay') return relay(p);
    const linkKey = String(p.k || '').trim();
    let me = linkKey ? null : auth.check(p.s);
    // View as someone else (practice only, Universal only).
    if (me && p.va && typeof p.va === 'object') me = viewAs(me, p.va);
    // The people Universal may view the app as (practice only).
    if (action === 'viewAsList') {
      if (!practice || !me || !realAuth.isAdmin(me)) return reply({ ok: false, error: 'View as is for Universal, in the practice space.' });
      const P = places(), by = {};
      auth.allGrants().forEach(g => { (by[g.email] = by[g.email] || { email: g.email, name: g.name || g.googleName || g.email.split('@')[0], roles: [] })
        .roles.push(people.describe(P, g)); });
      return reply({ ok: true, result: { people: Object.values(by).sort((a, b) => a.name.localeCompare(b.name)),
        roles: people.ROLE_ORDER.map(r => ({ role: r, name: people.ROLES[r].name, kind: people.ROLES[r].kind })),
        places: { seasons: P.raw.seasons, regions: P.raw.regions, events: P.raw.events } } });
    }
    if (action === 'ping') {                                       // the revision number, nothing more
      const out = answer(e);
      // ...and, for someone who can give logins, how many sign-in requests are waiting.
      if (!me) return out;
      const o = JSON.parse(out);
      if (auth.isAdmin(me) || people.givesAny(places(), auth.grantsOf(me), false)) o.requests = auth.requestCount();
      return reply(o);
    }
    if (!linkKey && !me) {
      return reply({ ok: false, signIn: true, error: 'Please sign in with Google to use the app.' });
    }
    // Permissions (b234): Universal reads and changes the table.
    if (!linkKey && /^perm(Get|Set)$/.test(action)) {
      if (!auth.isAdmin(me)) return reply({ ok: false, error: 'Only Universal can change permissions.' });
      const parse = (k, d) => { try { return JSON.parse(kv.getProp(k) || '') || d; } catch (e) { return d; } };
      if (action === 'permSet') {
        kv.setProp('permTable', JSON.stringify(people.cleanPermTable(p.table)));
        kv.setProp('permPeople', JSON.stringify(people.cleanPermPeople(p.people)));
      }
      const persons = {};
      auth.allGrants().forEach(g => { const x = persons[g.email] || (persons[g.email] = { email: g.email, name: g.name || g.googleName || g.email, roles: [] });
        if (x.roles.indexOf(g.role) < 0) x.roles.push(g.role); });
      return reply({ ok: true, result: { caps: people.PERM_CAPS, roles: people.PERM_ROLES, names: Object.fromEntries(people.PERM_ROLES.map(r => [r, people.ROLES[r].name])),
        defaults: people.permDefaults(), table: parse('permTable', {}), people: parse('permPeople', {}), persons: Object.values(persons) } });
    }
    /* Expenses (b238): anyone signed in, in any role (even one the rest of the
       app cannot use yet), and any link. expenses.js decides who may do what. */
    if (expenses.isAction(action)) {
      try { return reply({ ok: true, result: expenses.handle(action, p, me, linkKey) }); }
      catch (err) { return reply({ ok: false, error: String(err && err.message || err) }); }
    }
    // Who I am, my roles, and the People panel (b222).
    if (!linkKey && /^(me|setMyName|people(List|Add|Remove|Decline)|emergencyLink)$/.test(action)) {
      try { return reply({ ok: true, result: peopleAction(me, action, p) }); }
      catch (err) { return reply({ ok: false, error: String(err && err.message || err) }); }
    }
    const universal = !linkKey && auth.isAdmin(me);
    /* Anyone else signed in acts in one of their roles: the one the page asks
       for (g), or their first usable one. Code.gs is told who that is directly
       (setTrustedWho_), so nothing in the request can claim more. */
    let acting = null;
    if (!linkKey && !universal) {
      acting = people.acting(places(), auth.grantsOf(me), String(p.g || ''));
      if (!acting.who) {
        return reply({ ok: false, noAccess: true, me: meInfo(me),
          error: 'You are signed in, but none of your roles can be used in the app yet. ' +
                 'Your access starts with the next update — or ask the person who added you.' });
      }
    }
    // A signed-in person's own name goes on what they record (sales, cash, the Activity Log).
    if (!linkKey) {
      p.by = auth.nameOf(me);
      delete p.k;
      e = e.postData ? { postData: { contents: JSON.stringify(p) } } : { parameter: p };
    }
    // The Admins panel: who may use the owner's app.
    if (!universal && /^admins(List|Add|Approve|Decline|Remove)$/.test(action)) {
      return reply({ ok: false, error: 'Only Universal can do that.' });
    }
    if (universal && /^admins(List|Add|Approve|Decline|Remove)$/.test(action)) {
      try {
        if (action === 'adminsAdd') auth.add(me, p.email);
        if (action === 'adminsApprove') auth.add(me, p.email);
        if (action === 'adminsDecline') auth.decline(p.email);
        if (action === 'adminsRemove') auth.remove(me, p.email);
        if (action !== 'adminsList') kv.setProp('shareDirty', '1');       // who may open the spreadsheets changed
        return reply({ ok: true, result: auth.list(me) });
      } catch (err) { return reply({ ok: false, error: String(err && err.message || err) }); }
    }
    // Practice: start over from a fresh copy of the live records (Universal).
    if (action === 'practiceReset') {
      if (!practice) return reply({ ok: false, error: 'This is the live app, not the practice space.' });
      if (!universal) return reply({ ok: false, error: 'Only Universal can start the practice space over.' });
      try { await practiceReset(); return reply({ ok: true, result: { copiedAt: Number(kv.getProp('practiceSeeded')) } }); }
      catch (err) { return reply({ ok: false, error: String(err && err.message || err) }); }
    }
    if (practice && SHEET_ACTIONS.test(action))
      return reply({ ok: false, error: 'The practice space does not build spreadsheets. Your real spreadsheets are untouched.' });
    // The owner's spreadsheet requests are passed to Google, which does them.
    if (universal && SHEET_ACTIONS.test(action)) return forwardToGoogle(p);
    /* Anyone else signed in sees only their own files, without the folders (b226). */
    if (!linkKey && !universal && action === 'driveMap') {
      const mine = auth.grantsOf(me);
      if (!people.seesSheets(mine)) return reply({ ok: false, error: 'There are no spreadsheets for your roles.' });
      const text = await forwardToGoogle(p);
      try {
        const o = JSON.parse(text);
        if (o && o.ok && o.result) o.result = people.sheetsMapFor(places(), mine, o.result);
        return reply(o);
      } catch (err) { return text; }
    }
    // Who is asking, told to Code.gs directly: the role acted in, their name, their address (b223).
    if (universal) app.setTrustedWho_({ role: 'admin', name: auth.nameOf(me), email: me, grant: 'U' });
    if (acting) {
      app.setTrustedWho_(Object.assign({ name: auth.nameOf(me), email: me, grant: acting.grant.role }, acting.who));
      const out = answer(e);
      // Which role this was answered in, so the page can show it.
      if (action === 'getState' || action === 'setSeason') {
        try { const o = JSON.parse(out); if (o && o.ok) { o.acting = acting.grant.id; return reply(o); } } catch (err) {}
      }
      return out;
    }
    return answer(e);
  }

  /* ---- People and roles (b222; the rules are in people.js) ---- */
  let placesMemo = null;
  function places() {
    const r = rev();
    if (placesMemo && placesMemo.rev === r) return placesMemo.P;
    app.sheetMemoClear_(); app.setSeasonContext_('');
    const P = people.indexPlaces(app.placesForAuth_());
    placesMemo = { rev: r, P };
    return P;
  }
  function meInfo(me) {
    const P = places(), mine = auth.grantsOf(me), owner = auth.isOwner(me);
    const all = auth.allGrants();
    const grants = mine.map(g => {
      const d = people.describe(P, g);
      // At an event: its Event Leads by name, so a Seller can "Hand your cash to Gita" (b223).
      if ((people.ROLES[g.role] || {}).kind === 'event') d.leads = all.filter(x => x.role === 'EL' && x.placeId === g.placeId && x.email !== me)
        .map(x => ({ email: x.email, name: x.name || x.googleName || x.email.split('@')[0] }));
      return d;
    });
    if (owner) grants.unshift({ id: '', role: 'U', roleName: 'Universal', placeId: '', place: 'Everywhere',
      active: true, why: '', usable: true, owner: true });
    return Object.assign(auth.person(me), {
      universal: auth.isAdmin(me), grants,
      seesPeople: people.seesPeople(mine, owner),
      givesLogins: people.givesAny(P, mine, owner),
      // Events they may hand an emergency link for.
      linkEvents: P.raw.events.filter(ev => mayLink(P, me, ev.id)).map(ev => ({ id: ev.id, label: people.placeLabel(P, 'S', ev.id) }))
    });
  }
  /* An emergency link (Seller permissions, one event): Event Leads and above. */
  function mayLink(P, me, eventId) {
    if (auth.isAdmin(me)) return !!P.events[eventId];
    if (!P.events[eventId] || people.activeState(P, { role: 'S', placeId: eventId }).active === false) return false;
    return auth.grantsOf(me).some(g => ['EL', 'RL', 'SL'].indexOf(g.role) >= 0 &&
      people.activeState(P, g).active && people.mayGive(P, [g], false, 'S', eventId));
  }
  function peopleAction(me, action, p) {
    const P = places(), mine = auth.grantsOf(me), owner = auth.isOwner(me) || mine.some(g => g.role === 'U');
    if (action === 'me') return meInfo(me);
    if (action === 'setMyName') { auth.setName(me, p.name); return meInfo(me); }
    if (action === 'emergencyLink') {
      const id = String(p.eventId || '');
      if (!mayLink(P, me, id)) throw new Error('You cannot make a link for that event.');
      let key = P.events[id].key;
      if (!key || p.regenerate) {
        // Made as the owner's app would (Code.gs's own setKey), for this one event only.
        const r = JSON.parse(answer({ postData: { contents: JSON.stringify({ action: 'setKey', kind: 'event', id, by: auth.nameOf(me) }) } }));
        if (!r.ok) throw new Error(r.error || 'The link could not be made.');
        key = r.result;
      }
      return { eventId: id, key, label: people.placeLabel(P, 'S', id) };
    }
    if (!people.seesPeople(mine, owner)) throw new Error('You cannot see who has access.');
    if (action === 'peopleAdd') {
      const role = String(p.role || ''), placeId = (people.ROLES[role] || {}).kind === 'all' ? '' : String(p.placeId || '');
      if (!people.mayGive(P, mine, owner, role, placeId)) throw new Error('You cannot give that role there.');
      if (people.ROLES[role].kind !== 'all' && !people.activeState(P, { role, placeId }).active)
        throw new Error('That place is closed, so a role there would do nothing.');
      auth.addGrant(me, p.email, p.name, role, placeId);
      kv.setProp('shareDirty', '1');           // the spreadsheets may have someone new to share with (b226)
    }
    if (action === 'peopleRemove') {
      const g = auth.grantById(p.id);
      if (!g) throw new Error('That role has already been removed.');
      if (!people.mayRemove(P, mine, owner, me, g)) throw new Error(g.email === me
        ? 'You cannot remove your own role. Ask someone above you.' : 'You cannot remove that role.');
      auth.removeGrant(g.id);
      kv.setProp('shareDirty', '1');
    }
    if (action === 'peopleDecline') {
      if (!people.givesAny(P, mine, owner)) throw new Error('You cannot answer sign-in requests.');
      auth.decline(p.email);
    }
    // The list: everyone with a role within my reach, and only those roles.
    const byEmail = {};
    auth.allGrants().forEach(g => {
      if (!people.maySee(P, mine, owner, g)) return;
      const d = people.describe(P, g);
      d.removable = people.mayRemove(P, mine, owner, me, g);
      (byEmail[g.email] = byEmail[g.email] || { email: g.email, name: g.name || g.googleName || g.email.split('@')[0], grants: [] }).grants.push(d);
    });
    const list = Object.values(byEmail).sort((a, b) => a.name.localeCompare(b.name));
    if (owner) auth.list(me).owners.forEach(o => {
      if (!byEmail[o]) list.unshift({ email: o, name: auth.nameOf(o), grants: [] });
      const row = list.find(x => x.email === o);
      row.owner = true;
    });
    return { me: meInfo(me), people: list,
      requests: people.givesAny(P, mine, owner) ? auth.requests() : [],
      choices: people.giveChoices(P, mine, owner) };
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
      if (flying.share) kv.setProp('shareDirty', '1');
      kv.delProp('cfInFlight');
    }
    const dirty = parse(kv.getProp('dirtyLocs'), {});
    const quiet = Date.now() - Number(kv.getProp('lastWriteAt') || 0) >= app.QUIET_MS;
    const reshare = !!kv.getProp('shareDirty');
    // tick: the minute check — only when something needs drawing (or sharing) and nobody is saving.
    if (mode === 'tick' && ((!Object.keys(dirty).length && !reshare) || !quiet || kv.getProp('cfInFlight'))) return { idle: true };
    let claim = '';
    const props = kv.allProps();
    if (mode === 'tick' || mode === 'sync') {
      claim = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      kv.setProp('cfInFlight', JSON.stringify({ id: claim, at: Date.now(), set: dirty, share: reshare }));
      kv.setProp('dirtyLocs', '{}');
      props.dirtyLocs = JSON.stringify(dirty);
    } else {
      props.dirtyLocs = '{}';          // (a forwarded request draws nothing by itself)
    }
    delete props.cfInFlight;
    delete props.shareDirty;
    if (mode !== 'forward') kv.delProp('shareDirty');
    return { claim, tables: exportAll(), props, share: sheetShare() };
  }
  /* Who should have each spreadsheet (b226): worked out here, where the roles
     are; Google only makes Drive match it (Code.gs shareSpreadsheets_). */
  function sheetShare() {
    try {
      return people.sheetsWanted(auth.allGrants(), auth.ownerList(), app.sheetFilesForAuth_());
    } catch (e) { return null; }
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
    // Sharing left half done, or a new spreadsheet made: share on the next minute (b226).
    if (back.shareAgain || Object.keys(back.meta || {}).some(k => /SheetId(:|$)/.test(k))) kv.setProp('shareDirty', '1');
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

  /* ---- The practice space (b231) ----
     A second server, the same code, with its own database. It fills itself
     with a copy of the live records and people, read from the live server
     with a phrase that allows reading a copy and nothing else (PRACTICE_SECRET
     on live, LIVE_SECRET on practice). Nothing is ever sent back, and the
     practice server never reaches the spreadsheets. */
  function practiceExport(p) {
    if (!practiceSecret || String(p.secret || '') !== practiceSecret) return { ok: false, error: 'Not allowed.' };
    app.sheetMemoClear_(); app.setSeasonContext_(''); app.flushStockMoves_();
    const props = kv.allProps();
    Object.keys(props).forEach(k => { if (/^(dirtyLocs|cfInFlight|shareDirty|CF_|lastRenderError)/.test(k)) delete props[k]; });
    return { ok: true, result: { tables: exportAll(), props, people: auth.peopleRows(), owners: auth.ownerList() } };
  }
  async function practiceReset() {
    if (!practice || !liveUrl || !liveSecret) throw new Error('The practice space is not connected to the live app yet (LIVE_URL and LIVE_SECRET).');
    let r;
    try {
      const res = await fetchImpl(liveUrl, { method: 'POST', body: JSON.stringify({ action: 'practiceExport', secret: liveSecret }) });
      r = JSON.parse(await res.text());
    } catch (err) { throw new Error('The live app could not be reached. Try again in a moment.'); }
    if (!r || !r.ok) throw new Error('The live app would not share a copy: ' + ((r && r.error) || 'no answer'));
    const rev = Number(kv.getProp('rev') || 0);
    importAll(r.result.tables || {}, r.result.props || {});
    auth.replacePeople(r.result.people || {});
    kv.setProp('liveOwners', (r.result.owners || []).join(','));
    kv.setProp('practiceSeeded', String(Date.now()));
    // On past both copies' revisions, so every phone in practice fetches afresh.
    kv.setProp('rev', String(Math.max(rev, Number((r.result.props || {}).rev || 0)) + 1));
    app.sheetMemoClear_(); app.setSeasonContext_(''); app.cacheClear_();
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
    try { expenses.sweep(); } catch (e) { console.log('expenses.sweep: ' + e); }
  }
  /* The revision number: it changes on every save (Phase 4 sends it to the
     phones the moment it does). */
  function rev() { return Number(app.getRev_()) || 0; }
  return { answer, request, bridge, relay, auth, warm, fetchWanted, housekeeping, rev, kv, store, forget, dump, build: CODE_BUILD, web, app };
}
