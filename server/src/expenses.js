/* Expenses (b238): what people spent for the tour, kept for the records or
   to be paid back, with their receipts. See TRACKER.md "Done in b238".

   Everyone can record one: signed in in any role (Finance, Seasonal Lead and
   the assistants too, who cannot use the rest of the app until Stage 2), or on
   a sales or regional link. Finance (and Universal) see every expense, pay
   them back, record them on someone's behalf, and decide which ways of being
   paid back, and which currencies, are on offer — for the whole tour, a
   season, a region or an event, and for one person.

   The records sit in the app's own table `_expenses` (Code.gs's data store,
   so they travel with the rest: the practice copy, the spreadsheets later).
   Receipts are files, so they are kept apart, in their own database table
   `receipt`, which nothing copies: the state, the spreadsheet copies and the
   practice space never carry them. Each is split into parts well under the
   database's 2 MB limit for one value.

   Record Costs and Expenses are one (b238, the owner's wish): an expense has
   the cost's kind (card fee, travel...), the payment type it was paid with,
   and may belong to a consignment group. Every expense at a region or event
   is also kept as a cost in `_costs`, under the same id, through Code.gs's own
   saveCost — so every total that takes costs off (net sales, a group's money
   owed, the spreadsheets) takes expenses off, unchanged. A declined expense
   leaves the costs. Costs recorded before, with Record Costs, are taken into
   the expenses list as they are (adopt()).

   For now all of this is the practice space's only (the owner's wish: try it
   there first); the live server refuses it. */

/* Ways of being paid back, and what each needs from the person (the owner's
   list: cash, or any app the tour takes payments with). A payment type the
   tour has that is not named here asks for its account details as text. */
export const METHOD_FIELDS = {
  'Cash': [{ k: 'phone', label: 'Phone or WhatsApp number', ph: '+48 600 000 000', type: 'tel', req: true,
    hint: 'So Finance can arrange to hand you the cash.' }],
  'UPI': [{ k: 'upi', label: 'UPI ID', ph: 'name@bank', req: true },
    { k: 'name', label: 'Name on the account' }],
  'Zelle': [{ k: 'zelle', label: 'Email or US phone number registered with Zelle', req: true },
    { k: 'name', label: 'Name on the account', req: true }],
  'PayPal': [{ k: 'paypal', label: 'PayPal email or phone number', req: true }],
  'Wise': [{ k: 'wise', label: 'Email on your Wise account, or your Wisetag (@name)', req: true },
    { k: 'name', label: 'Full name on the account', req: true }],
  'Venmo': [{ k: 'venmo', label: 'Venmo username', ph: '@username', req: true },
    { k: 'last4', label: 'Last 4 digits of the phone number on the account', hint: 'Venmo sometimes asks for these.' }],
  'Cash App': [{ k: 'cashtag', label: '$Cashtag', ph: '$name', req: true }],
  'Revolut': [{ k: 'revolut', label: 'Revtag (@name) or the phone number on Revolut', req: true },
    { k: 'name', label: 'Name on the account' }],
  'Bank transfer': [{ k: 'holder', label: 'Account holder', req: true },
    { k: 'iban', label: 'IBAN or account number', req: true },
    { k: 'bic', label: 'SWIFT/BIC', hint: 'Or the IFSC in India, sort code in the UK, routing number in the US.' },
    { k: 'bank', label: 'Bank name' }]
};
// Not ways of paying anyone back.
const NOT_METHODS = { card: 1, gift: 1, other: 1 };
const fieldsFor = m => METHOD_FIELDS[m] || [{ k: 'details', label: 'Your ' + m + ' account details', req: true }];

const COLS = ['id', 'ts', 'seasonId', 'regionId', 'location', 'placeLabel', 'date', 'desc', 'cur', 'amt', 'kind',
  'category', 'payType', 'partnerId',
  'method', 'reimbCur', 'payTo', 'notes', 'receipts', 'byName', 'byEmail', 'byLink', 'forName', 'forEmail',
  'status', 'doneAt', 'doneBy', 'doneNote',
  // b254: what "Other" is, and how to reach someone who sent it in by a reimbursement link.
  'catOther', 'contactPhone', 'contactEmail'];
const T = '_expenses';
const PART = 900 * 1024;                    // characters of base64 per stored part
const MAX_FILE = 8 * 1024 * 1024;           // bytes, after the phone has shrunk a photo
const MAX_FILES = 10;
const CUR = /^[A-Z]{3}$/;

export function makeExpenses({ exec, app, auth, people, places, kv, now, practice, asOwner }) {
  now = now || (() => Date.now());
  exec('CREATE TABLE IF NOT EXISTS receipt (id TEXT NOT NULL, part INTEGER NOT NULL, parts INTEGER NOT NULL, name TEXT NOT NULL, ' +
       'mime TEXT NOT NULL, size INTEGER NOT NULL, owner TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (id, part))');

  const fresh = () => { app.sheetMemoClear_(); app.setSeasonContext_(''); };
  const rows = () => (app.dbHas_(T) ? app.objectsOf_(T) : []).filter(r => r && r.id);
  const parse = (raw, d) => { try { return raw ? JSON.parse(raw) : d; } catch (e) { return d; } };
  const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

  /* ---- Who is asking ----
     A signed-in person (their roles decide where they may record and whether
     they are Finance), or a link (its region or events, and the name the
     phone was given). Universal counts as Finance. */
  /* ---- Reimbursement links (b254) ----
     Finance sends one by WhatsApp or email to anyone, in the app or not, who
     spent money for the tour: it opens a form needing no sign-in, for one
     place or anywhere, and all it can do is send in an expense to be paid
     back (with its receipts). Kept in the setting `reimbLinks`. */
  const getLinks = () => { const o = parse(kv.getProp('reimbLinks'), {}); return o && typeof o === 'object' ? o : {}; };
  const isReimbKey = k => /^rb_[A-Za-z0-9]{8,40}$/.test(String(k || ''));
  function whoFor(p, me, linkKey) {
    const P = places();
    if (linkKey && isReimbKey(linkKey)) {
      const L = getLinks()[linkKey];
      if (L && L.used && !L.off) throw new Error('This link has already been used to send in an expense. If you have another one, ask Finance for a new link.');
      if (!L || L.off) throw new Error('This reimbursement link has been turned off. Ask Finance for a new one.');
      const pl = L.place ? placeOf(P, L.place) : null;
      if (L.place && !pl) throw new Error('This reimbursement link is for a place that is no longer listed. Ask Finance for a new one.');
      const reach = !pl ? { all: true } : pl.kind === 'event' ? { events: [pl.eventId] } : pl.kind === 'region' ? { regions: [pl.regionId] } : { seasons: [pl.seasonId] };
      return { P, link: linkKey, name: clip(p.by, 60), email: '', fin: '', universal: false, reach, open: true, linkPlace: L.place || '' };
    }
    if (linkKey) {
      const w = app.roleFor_(linkKey);
      if (!w || (w.role !== 'seller' && w.role !== 'coordinator')) throw new Error('That link is no longer valid. Ask for a new one.');
      const name = clip(p.by, 40);
      return { P, link: linkKey, name, email: '', fin: '', universal: false,
        reach: w.role === 'seller' ? { events: w.eventIds || [w.eventId] } : { regions: [w.regionId] } };
    }
    const grants = auth.grantsOf(me).filter(g => people.activeState(P, g).active);
    const universal = auth.isAdmin(me);
    const fin = universal ? 'U' : grants.some(g => g.role === 'F') ? 'F' : grants.some(g => g.role === 'FA') ? 'FA' : '';
    const reach = { all: !!fin || grants.some(g => g.role === 'U'), seasons: [], regions: [], events: [] };
    grants.forEach(g => {
      const kind = (people.ROLES[g.role] || {}).kind;
      if (kind === 'season') reach.seasons.push(g.placeId);
      if (kind === 'region') reach.regions.push(g.placeId);
      if (kind === 'event') reach.events.push(g.placeId);
    });
    if (!reach.all && !grants.length) throw new Error('You have no role in the app yet, so there is nowhere to record an expense.');
    return { P, link: '', name: auth.nameOf(me), email: me, fin, universal, reach };
  }
  const isFin = w => !!w.fin;                         // sees every expense, records for others
  const mayPay = w => w.fin === 'F' || w.fin === 'U'; // pays back, sets the rules (the assistant sees)

  /* ---- Places: every open season, region and event someone may record at ---- */
  function placeOf(P, id) {
    if (P.events[id]) { const e = P.events[id], r = P.regions[e.regionId] || {}; return { id, kind: 'event', seasonId: r.seasonId || '', regionId: e.regionId, eventId: id }; }
    if (P.regions[id]) return { id, kind: 'region', seasonId: P.regions[id].seasonId, regionId: id, eventId: '' };
    if (P.seasons[id]) return { id, kind: 'season', seasonId: id, regionId: '', eventId: '' };
    return null;
  }
  function inReach(w, pl) {
    const r = w.reach;
    if (r.all) return true;
    if ((r.events || []).indexOf(pl.eventId) >= 0 && pl.eventId) return true;
    if (pl.regionId && (r.regions || []).indexOf(pl.regionId) >= 0) return true;
    if (pl.seasonId && (r.seasons || []).indexOf(pl.seasonId) >= 0) return true;
    return false;
  }
  function labelOf(P, pl) {
    const role = pl.kind === 'event' ? 'S' : pl.kind === 'region' ? 'RL' : 'SL';
    return people.placeLabel(P, role, pl.id);
  }
  function placeList(w) {
    const P = w.P, out = [];
    const open = pl => people.activeState(P, { role: pl.kind === 'event' ? 'S' : pl.kind === 'region' ? 'RL' : 'SL', placeId: pl.id }).active;
    P.raw.seasons.forEach(s => {
      [placeOf(P, s.id)].concat(P.raw.regions.filter(r => r.seasonId === s.id).flatMap(r =>
        [placeOf(P, r.id)].concat(P.raw.events.filter(e => e.regionId === r.id).map(e => placeOf(P, e.id)))))
        .forEach(pl => { if (pl && open(pl) && inReach(w, pl)) out.push(Object.assign(pl, { label: labelOf(P, pl) })); });
    });
    return out;
  }

  /* ---- Rules: which ways of paying back, and which currencies (Finance) ----
     Kept as { levels: { '' (everywhere) | season | region | event id:
     { methods: { Wise: false, ... }, curs: ['EUR', ...] } }, people: { email:
     { methods, curs } } }. Each level, from everywhere down to the event,
     overrides the one above for what it sets; a person's own setting wins
     over every level. No currencies set anywhere: the region's own. */
  const getRules = () => cleanRules(parse(kv.getProp('reimbRules'), {}));
  function cleanRules(r) {
    const one = x => {
      const o = {};
      if (x && x.methods && typeof x.methods === 'object') {
        const m = {}; Object.keys(x.methods).slice(0, 60).forEach(k => { const n = clip(k, 40); if (n) m[n] = !!x.methods[k]; });
        if (Object.keys(m).length) o.methods = m;
      }
      if (x && Array.isArray(x.curs)) { const c = [...new Set(x.curs.map(v => String(v).toUpperCase()).filter(v => CUR.test(v)))]; if (c.length) o.curs = c; }
      return o;
    };
    const out = { levels: {}, people: {} };
    Object.keys((r && r.levels) || {}).slice(0, 2000).forEach(k => { const o = one(r.levels[k]); if (Object.keys(o).length) out.levels[clip(k, 60)] = o; });
    Object.keys((r && r.people) || {}).slice(0, 2000).forEach(k => {
      const m = String(k).trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+$/.test(m)) return;
      const o = one(r.people[k]); if (Object.keys(o).length) out.people[m] = o;
    });
    return out;
  }
  function facts() { fresh(); return app.financeFacts_(); }
  /* Every way of paying back the tour could offer: cash, every payment type it
     takes (but card and gift), and a bank transfer. */
  function allMethods(F) {
    const seen = {}, out = [];
    ['Cash'].concat(F.payTypes, ['Bank transfer']).forEach(t => {
      const k = String(t).toLowerCase();
      if (!t || NOT_METHODS[k] || seen[k]) return;
      seen[k] = 1; out.push(String(t));
    });
    return out;
  }
  const chainOf = pl => pl ? ['', pl.seasonId, pl.regionId, pl.eventId].filter((x, i) => i === 0 || x) : [''];
  function regionCurs(F, pl) {
    if (pl && pl.regionId && F.regions[pl.regionId]) return F.regions[pl.regionId].currencies.slice();
    const set = new Set();
    Object.values(F.regions).forEach(r => { if (!pl || !pl.seasonId || r.seasonId === pl.seasonId) r.currencies.forEach(c => set.add(c)); });
    return set.size ? [...set] : ['USD'];
  }
  function effective(F, rules, pl, email) {
    const on = {}; allMethods(F).forEach(m => { on[m] = true; });
    let curs = null;
    const apply = x => {
      if (!x) return;
      Object.keys(x.methods || {}).forEach(m => { if (m in on) on[m] = x.methods[m]; });
      if (x.curs) curs = x.curs.slice();
    };
    chainOf(pl).forEach(id => apply(rules.levels[id]));
    if (email) apply(rules.people[String(email).toLowerCase()]);
    return { methods: Object.keys(on).filter(m => on[m]), curs: curs || regionCurs(F, pl) };
  }
  function methodInfo(F, m) {
    const c = F.payTypeCur[m];
    const guess = { Zelle: 'USD', PayPal: 'USD', Venmo: 'USD', 'Cash App': 'USD', UPI: 'INR' }[m];
    return { name: m, fields: fieldsFor(m), cur: c && c !== 'none' ? c : (c === 'none' ? '' : (guess || '')) };
  }

  /* People Finance may record an expense for: everyone with a role, and the owners. */
  function peopleList() {
    const by = {};
    auth.ownerList().forEach(e => { by[e] = { email: e, name: auth.nameOf(e) }; });
    auth.allGrants().forEach(g => { if (!by[g.email]) by[g.email] = { email: g.email, name: g.name || g.googleName || g.email.split('@')[0] }; });
    return Object.values(by).sort((a, b) => a.name.localeCompare(b.name));
  }

  function options(w, p) {
    const F = facts(), rules = getRules();
    const list = placeList(w);
    const want = String(p.location || '');
    // Finance, standing nowhere in particular, chooses; anyone else starts where they are (or their only place).
    const pl = list.find(x => x.id === want) || (isFin(w) && list.length > 1 ? null : list[0]) || null;
    const forEmail = isFin(w) && p.forEmail ? String(p.forEmail).toLowerCase() : w.email;
    const eff = effective(F, rules, pl, forEmail);
    const spend = new Set(regionCurs(F, pl));
    Object.values(F.regions).forEach(r => r.currencies.forEach(c => spend.add(c)));
    ['USD', 'EUR', 'GBP', 'INR', 'PLN'].forEach(c => spend.add(c));
    return {
      places: list, location: pl ? pl.id : '', defaultCur: regionCurs(F, pl)[0] || 'USD',
      spendCurs: [...spend], methods: eff.methods.map(m => methodInfo(F, m)), curs: eff.curs,
      categories: F.categories, payTypes: F.payTypes.filter(t => String(t).toLowerCase() !== 'gift'),
      // The consignment groups of the place's region (and only the place's own event's, for an event group).
      partners: pl && pl.regionId ? F.partners.filter(g => g.regionId === pl.regionId && (!g.eventId || g.eventId === pl.eventId))
        .map(g => ({ id: g.id, name: g.name })) : [],
      me: { name: w.name, email: w.email, link: !!w.link }, fin: w.fin, mayPay: mayPay(w),
      people: isFin(w) ? peopleList() : []
    };
  }

  /* ---- Receipts ---- */
  const ownerTag = w => w.email ? 'e:' + w.email : 'k:' + w.link;
  function receiptPut(w, p) {
    const id = clip(p.id, 40), mime = clip(p.mime, 80).toLowerCase(), name = clip(p.name, 120) || 'receipt';
    if (!/^R[0-9a-z]{6,39}$/.test(id)) throw new Error('That receipt could not be named.');
    if (!/^image\/[a-z0-9.+-]+$/.test(mime) && mime !== 'application/pdf') throw new Error('Receipts can be photos or PDFs.');
    const data = String(p.data || '').replace(/^data:[^,]*,/, '');
    if (!/^[A-Za-z0-9+/]+=*$/.test(data)) throw new Error('That file could not be read.');
    const size = Math.floor(data.length * 3 / 4);
    if (size > MAX_FILE) throw new Error('That file is too big (over 8 MB).');
    const had = exec('SELECT owner FROM receipt WHERE id = ? AND part = 0', id)[0];
    if (had) { if (had.owner !== ownerTag(w)) throw new Error('That receipt could not be named.'); return { id, name, mime, size }; }
    const parts = Math.max(1, Math.ceil(data.length / PART));
    for (let i = 0; i < parts; i++) exec('INSERT INTO receipt (id, part, parts, name, mime, size, owner, at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, i, parts, name, mime, size, ownerTag(w), now(), data.slice(i * PART, (i + 1) * PART));
    return { id, name, mime, size };
  }
  function receiptGet(w, p) {
    const id = clip(p.id, 40);
    const head = exec('SELECT name, mime, size, owner, parts FROM receipt WHERE id = ? AND part = 0', id)[0];
    if (!head) throw new Error('That receipt is no longer kept.');
    const exp = rows().find(r => parse(r.receipts, []).some(x => x.id === id));
    const ok = isFin(w) || head.owner === ownerTag(w) || (exp && mine(w, exp));
    if (!ok) throw new Error('That receipt is not yours to open.');
    const data = exec('SELECT data FROM receipt WHERE id = ? ORDER BY part', id).map(r => r.data).join('');
    return { id, name: head.name, mime: head.mime, size: head.size, data };
  }
  /* Receipts uploaded for an expense that was never saved, after a day. */
  function sweep() {
    const used = new Set();
    rows().forEach(r => parse(r.receipts, []).forEach(x => used.add(x.id)));
    exec('SELECT DISTINCT id FROM receipt WHERE at < ?', now() - 24 * 3600 * 1000).forEach(r => {
      if (!used.has(r.id)) exec('DELETE FROM receipt WHERE id = ?', r.id);
    });
  }

  /* ---- One with Record Costs ---- */
  // The shelf a cost is kept against: an event, or its region's warehouse. A season-wide expense has none.
  function costLoc(F, r) {
    if (F.events[r.location]) return r.location;
    if (F.regions[r.location]) return F.regions[r.location].whLoc;
    return '';
  }
  const costIds = () => new Set(app.dbHas_('_costs') ? app.objectsOf_('_costs').map(c => String(c.id)) : []);
  function syncCost(r, F, w) {
    const loc = costLoc(F, r);
    if (!loc || r.status === 'declined') return dropCost(r, w);
    asOwner({ action: 'saveCost', id: r.id, ts: r.ts, location: loc, category: r.category || 'Other', payType: r.payType || '',
      cur: r.cur, amt: Number(r.amt), note: String(r.desc || '').slice(0, 200), partnerId: r.partnerId || '', season: r.seasonId }, w.name);
  }
  function dropCost(r, w) {
    if (costIds().has(String(r.id))) asOwner({ action: 'deleteCost', id: r.id, season: r.seasonId }, w.name);
  }
  /* Costs recorded with Record Costs before the two were one: each becomes an
     expense for the records, under its own id, so there is one list. */
  function adopt() {
    if (!app.dbHas_('_costs')) return;
    fresh();
    const have = new Set(rows().map(r => String(r.id)));
    const F = app.financeFacts_(), byWh = {};
    Object.values(F.regions).forEach(r => { if (r.whLoc) byWh[r.whLoc] = r.id; });
    const P = places(), add = [];
    app.objectsOf_('_costs').forEach(c => {
      if (!c || !c.id || have.has(String(c.id))) return;
      const loc = String(c.location || ''), pl = placeOf(P, F.events[loc] ? loc : (byWh[loc] || ''));
      if (!pl) return;                                  // a place since deleted
      const ts = c.ts instanceof Date ? c.ts.toISOString() : String(c.ts || new Date(now()).toISOString());
      add.push({ id: String(c.id), ts, seasonId: pl.seasonId, regionId: pl.regionId, location: pl.id, placeLabel: labelOf(P, pl),
        date: ts.slice(0, 10), desc: String(c.note || '') || String(c.category || 'Cost'), cur: String(c.cur || ''), amt: Number(c.amt) || 0,
        kind: 'record', category: String(c.category || 'Other'), payType: String(c.payType || ''), partnerId: String(c.partnerId || ''),
        method: '', reimbCur: '', payTo: '{}', notes: '', receipts: '[]', byName: 'Record Costs', byEmail: '', byLink: '',
        forName: '', forEmail: '', status: 'recorded', doneAt: '', doneBy: '', doneNote: '' });
    });
    if (!add.length) return;
    app.dbCreate_(T, COLS); app.dbAddCols_(T, COLS);
    app.dbInsert_(T, add);
  }

  /* ---- The finance section (b238): every sale and expense, as rows ----
     A season, region or event that repeats (Kartika every year, the Polish
     tour, the Chowpatty program) is one "series": its name without the year,
     unless Finance has named it otherwise (finSeries). */
  const seriesOf = name => String(name || '').replace(/\b(19|20)\d{2}\b/g, '').replace(/[\s\-–—,·:()]+$/g, '')
    .replace(/^[\s\-–—,·:()]+/g, '').replace(/\s{2,}/g, ' ').trim() || String(name || '');
  function finData(w) {
    if (!isFin(w)) throw new Error('The finance section is for Finance.');
    fresh();
    const D = app.financeData_(), own = cleanSeries(parse(kv.getProp('finSeries'), {}));
    const dt = getDates();
    ['seasons', 'regions', 'events'].forEach(k => D[k].forEach(x => {
      x.series = own[k][x.id] || seriesOf(x.name);
      x.from = (dt[k][x.id] || {}).from || ''; x.to = (dt[k][x.id] || {}).to || '';
    }));
    D.mayEdit = mayPay(w);
    return D;
  }
  function cleanSeries(o) {
    const out = { seasons: {}, regions: {}, events: {} };
    Object.keys(out).forEach(k => Object.keys((o && o[k]) || {}).slice(0, 5000).forEach(id => {
      const v = clip(o[k][id], 80); if (v) out[k][clip(id, 60)] = v;
    }));
    return out;
  }
  function seriesSet(w, p) {
    if (!mayPay(w)) throw new Error('Only Finance can change how seasons, regions and events are grouped.');
    const cur = cleanSeries(parse(kv.getProp('finSeries'), {}));
    const k = ['seasons', 'regions', 'events'].indexOf(p.kind) >= 0 ? p.kind : '';
    if (!k) throw new Error('Seasons, regions or events?');
    const id = clip(p.id, 60), v = clip(p.series, 80);
    if (v) cur[k][id] = v; else delete cur[k][id];
    kv.setProp('finSeries', JSON.stringify(cur));
    return finData(w);
  }

  /* ---- Dates and repeats (b255) ----
     When each season, region and event actually runs ({ from, to }, days),
     kept in the setting `placeDates`; and which series it belongs to, kept
     with Finance's own grouping (finSeries). Anyone signed in who looks after
     the place may set them: they are asked when they make it. */
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const KINDS = ['seasons', 'regions', 'events'];
  function cleanDates(o) {
    const out = { seasons: {}, regions: {}, events: {} };
    KINDS.forEach(k => Object.keys((o && o[k]) || {}).slice(0, 5000).forEach(id => {
      const x = o[k][id] || {}, v = {};
      if (DAY.test(String(x.from || ''))) v.from = String(x.from);
      if (DAY.test(String(x.to || ''))) v.to = String(x.to);
      if (v.from || v.to) out[k][clip(id, 60)] = v;
    }));
    return out;
  }
  const getDates = () => cleanDates(parse(kv.getProp('placeDates'), {}));
  // Every season, region and event, with its series and dates, for the forms and Finance's Dates page.
  function placeMetaGet(w) {
    if (w.link) throw new Error('Sign in to see this.');
    const P = w.P, own = cleanSeries(parse(kv.getProp('finSeries'), {})), dt = getDates();
    const one = (k, x, extra) => Object.assign({ id: x.id, name: x.name, closed: !!x.closed,
      series: own[k][x.id] || seriesOf(x.name), seriesOwn: own[k][x.id] || '',
      from: (dt[k][x.id] || {}).from || '', to: (dt[k][x.id] || {}).to || '' }, extra);
    fresh();
    // In the app's own order (regionsOrdered_ / eventsOrdered_), as everywhere else.
    const rank = {};
    try {
      P.raw.seasons.forEach(s => app.regionsOrdered_(s.id).forEach((r, i) => { if (r && r.regionId) rank[String(r.regionId)] = i; }));
      app.eventsOrdered_().forEach((e, i) => { if (e && e.eventId) rank[String(e.eventId)] = i; });
    } catch (e) { /* the order is a nicety */ }
    const byRank = list => list.slice().sort((a, b) => (rank[a.id] ?? 1e9) - (rank[b.id] ?? 1e9));
    const sName = id => (P.raw.seasons.find(s => s.id === id) || {}).name || '';
    const rOf = id => P.raw.regions.find(r => r.id === id) || {};
    return {
      seasons: P.raw.seasons.map(s => one('seasons', s, {})),
      regions: byRank(P.raw.regions).map(r => one('regions', r, { seasonId: r.seasonId, seasonName: sName(r.seasonId) })),
      events: byRank(P.raw.events).map(e => one('events', e, { regionId: e.regionId, regionName: rOf(e.regionId).name || '',
        seasonId: rOf(e.regionId).seasonId || '', seasonName: sName(rOf(e.regionId).seasonId) })),
      mayEdit: true
    };
  }
  function placeMetaSet(w, p) {
    if (w.link) throw new Error('Sign in to change this.');
    const k = KINDS.indexOf(p.kind) >= 0 ? p.kind : '';
    if (!k) throw new Error('Seasons, regions or events?');
    const id = clip(p.id, 60), pl = placeOf(w.P, id);
    if (!pl || pl.kind + 's' !== k) throw new Error('That ' + k.slice(0, -1) + ' is no longer listed.');
    if (!mayPay(w) && !inReach(w, pl)) throw new Error('Only someone who looks after it can change this.');
    if (p.from !== undefined || p.to !== undefined) {
      const d = getDates(), cur = d[k][id] || {};
      const from = p.from !== undefined ? String(p.from || '') : (cur.from || ''), to = p.to !== undefined ? String(p.to || '') : (cur.to || '');
      if ((from && !DAY.test(from)) || (to && !DAY.test(to))) throw new Error('Those dates could not be read.');
      if (from && to && to < from) throw new Error('The end date is before the start date.');
      if (from || to) d[k][id] = Object.assign({}, from ? { from } : {}, to ? { to } : {}); else delete d[k][id];
      kv.setProp('placeDates', JSON.stringify(d));
    }
    if (p.series !== undefined) {
      const cur = cleanSeries(parse(kv.getProp('finSeries'), {})), v = clip(p.series, 80);
      if (v) cur[k][id] = v; else delete cur[k][id];
      kv.setProp('finSeries', JSON.stringify(cur));
    }
    return placeMetaGet(w);
  }

  /* ---- The expenses ---- */
  function mine(w, r) {
    if (w.email) return String(r.byEmail) === w.email || String(r.forEmail) === w.email;
    return String(r.byLink) === w.link && (!w.name || String(r.forName || r.byName) === w.name);
  }
  const shown = r => Object.assign({}, r, { amt: Number(r.amt) || 0, payTo: parse(r.payTo, {}), receipts: parse(r.receipts, []) });
  function save(w, p) {
    fresh();
    const F = app.financeFacts_(), rules = getRules();
    const id = clip(p.id, 40);
    if (!/^[XC][0-9A-Za-z_-]{3,39}$/.test(id)) throw new Error('That expense could not be named.');
    const old = rows().find(r => String(r.id) === id);
    if (old && w.open) throw new Error('That expense has already been sent in.');
    if (old && !(isFin(w) && mayPay(w)) && !mine(w, old)) throw new Error('That expense is not yours to change.');
    if (old && old.status === 'paid' && !mayPay(w)) throw new Error('That expense has been paid back, so it cannot be changed. Ask Finance.');
    const pl = placeOf(w.P, clip(p.location, 60));
    if (!pl || !inReach(w, pl)) throw new Error('Choose where the expense belongs.');
    const kind = p.kind === 'reimburse' || w.open ? 'reimburse' : 'record';
    if (w.open && !w.name) throw new Error('Please give your name.');
    const contactPhone = clip(p.contactPhone, 40), contactEmail = clip(p.contactEmail, 120).toLowerCase();
    if (contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) throw new Error('That email address does not look right.');
    if (w.open && !contactPhone && !contactEmail) throw new Error('Give a phone (WhatsApp) number or an email, so Finance can reach you.');
    const amt = Math.round((Number(p.amt) || 0) * 100) / 100;
    if (!(amt > 0)) throw new Error('Give the expense an amount.');
    const cur = String(p.cur || '').toUpperCase();
    if (!CUR.test(cur)) throw new Error('Choose the currency it was spent in.');
    const desc = clip(p.desc, 300);
    if (!desc) throw new Error('Say what the expense was for.');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? String(p.date) : new Date(now()).toISOString().slice(0, 10);
    // On someone's behalf (Finance): their name and address go on it, Finance's as who entered it.
    let forEmail = '', forName = '';
    if (p.forEmail && isFin(w)) {
      forEmail = String(p.forEmail).trim().toLowerCase();
      const person = peopleList().find(x => x.email === forEmail);
      if (!person) throw new Error('Choose who the expense is for from the list.');
      forName = person.name;
    } else if (old) { forEmail = String(old.forEmail || ''); forName = String(old.forName || ''); }
    const whom = forEmail || (old ? String(old.byEmail || '') : w.email);
    let method = '', reimbCur = '', payTo = {};
    if (kind === 'reimburse') {
      const eff = effective(F, rules, pl, whom);
      method = clip(p.method, 40);
      if (eff.methods.indexOf(method) < 0) throw new Error(method ? method + ' is not offered for paying back here. Choose another way.' : 'Choose how you would like to be paid back.');
      reimbCur = String(p.reimbCur || '').toUpperCase();
      if (eff.curs.indexOf(reimbCur) < 0) throw new Error('Choose a currency to be paid back in: ' + eff.curs.join(', ') + '.');
      const given = (p.payTo && typeof p.payTo === 'object') ? p.payTo : {};
      fieldsFor(method).forEach(f => {
        const v = clip(given[f.k], 200);
        if (f.req && !v) throw new Error(f.label + ' is needed for ' + method + '.');
        if (v) payTo[f.k] = v;
      });
    }
    const receipts = (Array.isArray(p.receipts) ? p.receipts : []).slice(0, MAX_FILES).map(x => clip(x && x.id || x, 40)).filter(Boolean).map(rid => {
      const h = exec('SELECT name, mime, size, owner FROM receipt WHERE id = ? AND part = 0', rid)[0];
      const kept = old && parse(old.receipts, []).find(x => x.id === rid);
      if (!h || (!kept && h.owner !== ownerTag(w))) throw new Error('A receipt did not finish sending. Add it again.');
      return { id: rid, name: h.name, mime: h.mime, size: h.size };
    });
    const category = F.categories.indexOf(String(p.category)) >= 0 ? String(p.category) : 'Other';
    const catOther = category === 'Other' ? clip(p.catOther, 60) : '';
    const payType = clip(p.payType, 40);
    const partnerId = clip(p.partnerId, 40);
    if (partnerId && !F.partners.some(g => g.id === partnerId && g.regionId === pl.regionId)) throw new Error('That consignment group is not in this region.');
    const row = {
      id, ts: old ? old.ts : new Date(now()).toISOString(), seasonId: pl.seasonId, regionId: pl.regionId, location: pl.id,
      placeLabel: labelOf(w.P, pl), date, desc, cur, amt, kind, category, payType, partnerId, method, reimbCur, payTo: JSON.stringify(payTo),
      notes: clip(p.notes, 1000), receipts: JSON.stringify(receipts),
      byName: old ? old.byName : w.name, byEmail: old ? old.byEmail : w.email, byLink: old ? old.byLink : w.link,
      forName, forEmail,
      status: kind === 'record' ? 'recorded' : (old && old.kind === 'reimburse' && old.status !== 'recorded' ? old.status : 'pending'),
      doneAt: old && kind === 'reimburse' ? (old.doneAt || '') : '', doneBy: old && kind === 'reimburse' ? (old.doneBy || '') : '',
      doneNote: old && kind === 'reimburse' ? (old.doneNote || '') : '',
      catOther, contactPhone: contactPhone || (old ? String(old.contactPhone || '') : ''), contactEmail: contactEmail || (old ? String(old.contactEmail || '') : '')
    };
    if (!row.byName && !forName) throw new Error('Say who you are first.');
    app.dbCreate_(T, COLS); app.dbAddCols_(T, COLS);
    if (old) app.dbUpdate_(T, { id }, row); else app.dbInsert_(T, row);
    syncCost(row, F, w);
    // A link sent to one person is used up once their expense is in.
    if (w.open && !old) {
      const L = getLinks();
      if (L[w.link] && L[w.link].once) { L[w.link].used = id; L[w.link].usedAt = new Date(now()).toISOString(); kv.setProp('reimbLinks', JSON.stringify(L)); }
    }
    return shown(row);
  }
  function remove(w, p) {
    fresh();
    const id = clip(p.id, 40), old = rows().find(r => String(r.id) === id);
    if (!old) return { id };
    if (!mayPay(w) && !mine(w, old)) throw new Error('That expense is not yours to delete.');
    if (old.status === 'paid' && !mayPay(w)) throw new Error('That expense has been paid back, so it cannot be deleted. Ask Finance.');
    app.dbDelete_(T, { id });
    dropCost(old, w);
    parse(old.receipts, []).forEach(x => exec('DELETE FROM receipt WHERE id = ?', x.id));
    return { id };
  }
  function mark(w, p) {
    if (!mayPay(w)) throw new Error('Only Finance can mark an expense as paid back.');
    fresh();
    const id = clip(p.id, 40), old = rows().find(r => String(r.id) === id);
    if (!old) throw new Error('That expense is no longer listed.');
    if (old.kind !== 'reimburse') throw new Error('That expense was recorded for the records, not to be paid back.');
    const status = ['paid', 'declined', 'pending'].indexOf(p.status) >= 0 ? p.status : 'paid';
    const set = status === 'pending' ? { status, doneAt: '', doneBy: '', doneNote: '' }
      : { status, doneAt: new Date(now()).toISOString(), doneBy: w.name, doneNote: clip(p.note, 300) };
    app.dbUpdate_(T, { id }, set);
    const now2 = Object.assign({}, old, set);
    syncCost(now2, facts(), w);
    return shown(now2);
  }
  function list(w, p) {
    fresh();
    const all = p.scope === 'all' && isFin(w);
    return rows().filter(r => all || mine(w, r)).map(shown).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  }
  /* Finance's To do: every payment still owed, and every expense still to be paid back, across the system. */
  function todo(w) {
    if (!isFin(w)) throw new Error('The Finance To do is for Finance.');
    const F = facts();
    return { pending: F.pending.sort((a, b) => String(b.ts).localeCompare(String(a.ts))),
      reimb: rows().filter(r => r.kind === 'reimburse' && r.status === 'pending').map(shown).sort((a, b) => String(b.ts).localeCompare(String(a.ts))) };
  }
  function rulesGet(w) {
    if (!isFin(w)) throw new Error('Only Finance can see these settings.');
    const F = facts();
    const P = w.P, levels = [{ id: '', kind: 'all', label: 'Everywhere' }];
    P.raw.seasons.forEach(s => {
      levels.push({ id: s.id, kind: 'season', label: s.name, closed: s.closed });
      P.raw.regions.filter(r => r.seasonId === s.id).forEach(r => {
        levels.push({ id: r.id, kind: 'region', label: r.name + ' · ' + s.name, closed: r.closed });
        P.raw.events.filter(e => e.regionId === r.id).forEach(e => levels.push({ id: e.id, kind: 'event', label: e.name + ' · ' + r.name, closed: e.closed }));
      });
    });
    const curs = new Set(); Object.values(F.regions).forEach(r => r.currencies.forEach(c => curs.add(c)));
    ['USD', 'EUR', 'GBP', 'INR', 'PLN'].forEach(c => curs.add(c));
    // Each level's own chain, everywhere first, so the page can show what it inherits.
    levels.forEach(l => { l.chain = l.id ? chainOf(placeOf(P, l.id)) : ['']; });
    return { rules: getRules(), methods: allMethods(F), curs: [...curs], levels, people: peopleList(), mayEdit: mayPay(w),
      // What each level gives now, before any person's own setting.
      regionCurs: Object.fromEntries(levels.map(l => [l.id, regionCurs(F, placeOf(P, l.id))])) };
  }
  function rulesSet(w, p) {
    if (!mayPay(w)) throw new Error('Only Finance can change these settings.');
    kv.setProp('reimbRules', JSON.stringify(cleanRules(p.rules)));
    return rulesGet(w);
  }

  function linkList(w) {
    if (!isFin(w)) throw new Error('Reimbursement links are for Finance.');
    const P = w.P, L = getLinks();
    return Object.keys(L).map(k => Object.assign({ key: k }, L[k], {
      placeLabel: L[k].place && placeOf(P, L[k].place) ? labelOf(P, placeOf(P, L[k].place)) : 'Anywhere',
      sent: rows().filter(r => String(r.byLink) === k).length })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }
  function linkMake(w, p) {
    if (!isFin(w)) throw new Error('Reimbursement links are for Finance.');
    const place = clip(p.place, 60);
    if (place && !placeOf(w.P, place)) throw new Error('Choose a place from the list, or Anywhere.');
    const L = getLinks();
    if (Object.keys(L).length >= 500) throw new Error('There are too many reimbursement links. Turn some off first.');
    let key = '';
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    while (!key || L[key]) { key = 'rb_'; for (let i = 0; i < 16; i++) key += abc[Math.floor(Math.random() * abc.length)]; }
    /* Sent to one person (b255): their name and how to reach them, and it
       works once, turning itself off when they have sent their expense in. */
    const toName = clip(p.toName, 60), toEmail = clip(p.toEmail, 120).toLowerCase(), toPhone = clip(p.toPhone, 40);
    if (toEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail)) throw new Error('That email address does not look right.');
    if (toPhone && String(toPhone).replace(/\D/g, '').length < 7) throw new Error('That phone number looks too short. Include the country code.');
    if ((toEmail || toPhone) && !toName) throw new Error('Give the name of the person it is for.');
    const to = toName ? { name: toName, email: toEmail, phone: toPhone } : null;
    L[key] = Object.assign({ place, label: clip(p.label, 80) || toName, by: w.name, at: new Date(now()).toISOString(), off: false },
      to ? { to, once: true } : {});
    kv.setProp('reimbLinks', JSON.stringify(L));
    return { key, list: linkList(w) };
  }
  function linkOff(w, p) {
    if (!isFin(w)) throw new Error('Reimbursement links are for Finance.');
    const L = getLinks(), k = clip(p.key, 60);
    if (L[k]) { L[k].off = p.on ? false : true; if (p.on) { delete L[k].used; delete L[k].usedAt; } kv.setProp('reimbLinks', JSON.stringify(L)); }
    return linkList(w);
  }
  /* What the form needs to say at the top: which place, if one. */
  function linkInfo(w) {
    if (!w.open) throw new Error('This is for a reimbursement link.');
    const pl = w.linkPlace ? placeOf(w.P, w.linkPlace) : null;
    const L = getLinks()[w.link] || {};
    return { place: w.linkPlace, placeLabel: pl ? labelOf(w.P, pl) : '', to: L.to || null };
  }
  const OPEN_ACTIONS = { expOptions: 1, expSave: 1, receiptPut: 1, expLinkInfo: 1 };

  const ACTIONS = { expLinkList: linkList, expLinkMake: linkMake, expLinkOff: linkOff, expLinkInfo: linkInfo, expOptions: options, expSave: save, expDelete: remove, expMark: mark, expList: list, expTodo: todo,
    expRulesGet: rulesGet, expRulesSet: rulesSet, receiptPut, receiptGet, finData, finSeriesSet: seriesSet,
    placeMetaGet, placeMetaSet };
  /* One request: who is asking, then the action. */
  function handle(action, p, me, linkKey) {
    if (!practice) throw new Error('Expenses are being tried in the practice space first. Open the practice space to use them.');
    const w = whoFor(p, me, linkKey);
    if (w.open && !OPEN_ACTIONS[action]) throw new Error('A reimbursement link can only send in an expense.');
    if (/^(expList|expTodo|finData)$/.test(action)) adopt();
    return ACTIONS[action](w, p);
  }
  return { handle, sweep, isAction: a => Object.prototype.hasOwnProperty.call(ACTIONS, a), effective, METHOD_FIELDS };
}
