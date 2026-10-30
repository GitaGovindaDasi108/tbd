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

   Tried in the practice space first, and on in the live app too since b274
   (Gita, 2026-10-21). */

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
  'catOther', 'contactPhone', 'contactEmail',
  // b259: paid back in another currency: the amount at the rate on the day of the purchase.
  'payAmt',
  // b260: the day it was actually paid back, as Finance gives it.
  'paidOn',
  // b265: the exact dollars, when given (they win over any rate), and the
  // dollars at the rate on the day of the expense, worked out by the server.
  'usdAmt', 'usdDay',
  // b320 (practice): the books this printing, shipping or postage cost is put on (Code.gs bookCostCalc_).
  'bookLink'];
const T = '_expenses';
const PART = 900 * 1024;                    // characters of base64 per stored part
const MAX_FILE = 8 * 1024 * 1024;           // bytes, after the phone has shrunk a photo
const MAX_FILES = 10;
const CUR = /^[A-Z]{3}$/;

export function makeExpenses({ exec, app, auth, people, places, kv, now, practice, asOwner, rateNow }) {
  rateNow = rateNow || (() => null);
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
  /* Earthly HQ (b265): where an expense starts for anyone who reaches every
     place (Gita, 2026-10-20). To the data it is a region of a season of its own. */
  const HQ = { id: 'rg_hq', kind: 'hq', seasonId: 'HQ', regionId: 'rg_hq', eventId: '' };
  /* Finance-only places (b279, Gita): somewhere money was spent that isn't a
     place in the app — never in sales, only in Finance's lists and searches.
     Kept in `finPlaces` as { fp_…: { id, name, parent } }, parent being '' (Earthly
     HQ), a season or a region, so it sits under it (sub-regions may sit beside). */
  const getFP = () => { const o = parse(kv.getProp('finPlaces'), {}); return o && typeof o === 'object' ? o : {}; };
  function placeOf(P, id) {
    if (id === HQ.id) return Object.assign({}, HQ);
    if (/^fp_/.test(String(id))) {
      const fp = getFP()[id]; if (!fp) return null;
      const up = (fp.parent && placeOf(P, fp.parent)) || Object.assign({}, HQ);
      return { id, kind: 'fin', name: fp.name, parent: up.id, seasonId: up.seasonId, regionId: up.regionId, eventId: '' };
    }
    if (P.events[id]) { const e = P.events[id], r = P.regions[e.regionId] || {}; return { id, kind: 'event', seasonId: r.seasonId || '', regionId: e.regionId, eventId: id }; }
    if (P.regions[id]) return { id, kind: 'region', seasonId: P.regions[id].seasonId, regionId: id, eventId: '' };
    if (P.seasons[id]) return { id, kind: 'season', seasonId: id, regionId: '', eventId: '' };
    return null;
  }
  function inReach(w, pl) {
    const r = w.reach;
    // A link's own place is always where its form records (b291: Earthly HQ, a Finance-only place or a closed one too).
    if (w.open && w.linkPlace && pl.id === w.linkPlace) return true;
    if (pl.kind === 'fin') return isFin(w);
    if (r.all) return true;
    if (pl.kind === 'hq') return false;
    if ((r.events || []).indexOf(pl.eventId) >= 0 && pl.eventId) return true;
    if (pl.regionId && (r.regions || []).indexOf(pl.regionId) >= 0) return true;
    if (pl.seasonId && (r.seasons || []).indexOf(pl.seasonId) >= 0) return true;
    return false;
  }
  function labelOf(P, pl) {
    if (pl.kind === 'hq') return 'Earthly HQ';
    if (pl.kind === 'fin') { const up = placeOf(P, pl.parent); return pl.name + ' · ' + (up ? labelOf(P, up) : 'Earthly HQ'); }
    const role = pl.kind === 'event' ? 'S' : pl.kind === 'region' ? 'RL' : 'SL';
    return people.placeLabel(P, role, pl.id);
  }
  function placeList(w) {
    const P = w.P, out = [];
    if (inReach(w, HQ)) out.push(Object.assign({}, HQ, { closed: false, label: labelOf(P, HQ) }));
    const open = pl => people.activeState(P, { role: pl.kind === 'event' ? 'S' : pl.kind === 'region' ? 'RL' : 'SL', placeId: pl.id }).active;
    P.raw.seasons.forEach(s => {
      [placeOf(P, s.id)].concat(P.raw.regions.filter(r => r.seasonId === s.id).flatMap(r =>
        [placeOf(P, r.id)].concat(P.raw.events.filter(e => e.regionId === r.id).map(e => placeOf(P, e.id)))))
        .forEach(pl => {
          if (!pl || !inReach(w, pl)) return;
          /* Only the person's permissions limit where (Gita, 2026-10-20): Finance and
             Universal reach every place, closed ones too (expenses come in after an
             event ends). A link stays with the places still running. */
          const shut = !open(pl);
          if (shut && w.open && pl.id !== w.linkPlace) return;
          const label = labelOf(P, pl);
          out.push(Object.assign(pl, { closed: shut, label: shut ? label.replace(/^(.*?)( · |$)/, '$1 (closed)$2') : label }));
        });
    });
    // Finance's own places, each just after the place it sits under.
    if (isFin(w)) Object.values(getFP()).sort((a, b) => String(a.name).localeCompare(String(b.name))).forEach(fp => {
      const pl = placeOf(P, fp.id); if (!pl) return;
      let at = out.findIndex(x => x.id === pl.parent);
      if (at < 0) at = out.length - 1;
      // Past whatever already sits under the parent (its events, earlier Finance places).
      while (at + 1 < out.length && (out[at + 1].kind === 'fin' && out[at + 1].parent === pl.parent || (pl.parent && out[at + 1].regionId === pl.parent && out[at + 1].kind === 'event'))) at++;
      out.splice(at + 1, 0, Object.assign(pl, { closed: false, label: labelOf(P, pl) }));
    });
    return out;
  }
  function finPlaceAdd(w, p) {
    if (!mayPay(w)) throw new Error('Only Finance can add a place.');
    const name = clip(p.name, 80).replace(/\s+/g, ' ').trim();
    if (!name) throw new Error('Type the name of the place.');
    const P = places(), parent = String(p.parent || '');
    const up = parent && parent !== HQ.id ? placeOf(P, parent) : null;
    if (parent && parent !== HQ.id && (!up || (up.kind !== 'season' && up.kind !== 'region'))) throw new Error('A new place goes under Earthly HQ, a season or a region.');
    const all = getFP(), pid = up ? up.id : '';
    const same = Object.values(all).find(x => x.parent === pid && String(x.name).toLowerCase() === name.toLowerCase());
    if (same) return { id: same.id };
    const id = 'fp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    all[id] = { id, name, parent: pid };
    kv.setProp('finPlaces', JSON.stringify(all));
    actLog(w, {}, 'finPlaceAdd', 'Added “' + name + '” as a Finance-only place', null);
    return { id };
  }

  /* Edit Finance-Only Locations (b287, Gita; live in b295): rename one, move it under another
     place, or remove it once no expense is recorded there. */
  function finPlaceEdit(w, p) {
    if (!mayPay(w)) throw new Error('Only Finance can change a place.');
    const all = getFP(), id = String(p.id || ''), fp = all[id];
    if (!fp) throw new Error('There is no Finance-only place like that.');
    const used = rows().filter(r => String(r.location || '') === id).length;
    if (p.remove) {
      if (used) throw new Error('“' + fp.name + '” has ' + used + ' expense' + (used === 1 ? '' : 's') + ' recorded there. Move ' + (used === 1 ? 'it' : 'them') + ' to another place first.');
      delete all[id];
      kv.setProp('finPlaces', JSON.stringify(all));
      actLog(w, {}, 'finPlaceEdit', 'Removed “' + fp.name + '” as a Finance-only place', null);
      return { id, removed: true };
    }
    const name = clip(p.name == null ? fp.name : p.name, 80).replace(/\s+/g, ' ').trim();
    if (!name) throw new Error('Type the name of the place.');
    let pid = fp.parent;
    if (p.parent != null) {
      const parent = String(p.parent || ''), P = places();
      const up = parent && parent !== HQ.id ? placeOf(P, parent) : null;
      if (parent && parent !== HQ.id && (!up || (up.kind !== 'season' && up.kind !== 'region'))) throw new Error('A place goes under Earthly HQ, a season or a region.');
      pid = up ? up.id : '';
    }
    if (Object.values(all).some(x => x.id !== id && x.parent === pid && String(x.name).toLowerCase() === name.toLowerCase()))
      throw new Error('There is already a Finance-only place called “' + name + '” there.');
    const was = fp.name;
    all[id] = { id, name, parent: pid };
    kv.setProp('finPlaces', JSON.stringify(all));
    actLog(w, {}, 'finPlaceEdit', was === name ? 'Moved the Finance-only place “' + name + '”' : 'Renamed the Finance-only place “' + was + '” to “' + name + '”', null);
    return { id, used };
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
  /* Ways of paying back Finance removed for good (Gita, 2026-10-20: "delete
     reimbursement types completely if they will never be used"). */
  /* Kinds of expense (b276+, Gita 2026-10-21): Finance's own list, starting with
     just "Card machine fee" and added to as they go. "Other" (with its own words)
     is always there last. Expenses keep the kind they were saved with. */
  const getCats = () => { const a = parse(kv.getProp('expCats'), null); return Array.isArray(a) ? a.map(x => String(x)).filter(Boolean) : ['Card machine fee']; };
  const catList = () => getCats().filter(c => c.toLowerCase() !== 'other').concat(['Other']);
  function catAdd(w, p) {
    if (!mayPay(w)) throw new Error('Only Finance can add kinds of expense.');
    const name = clip(p.name, 60).replace(/\s+/g, ' ').trim();
    if (!name) throw new Error('Type the new kind of expense.');
    const cur = getCats();
    if (name.toLowerCase() !== 'other' && !cur.some(c => c.toLowerCase() === name.toLowerCase())) {
      kv.setProp('expCats', JSON.stringify(cur.concat([name]).slice(0, 200)));
      actLog(w, {}, 'expCatAdd', 'Added “' + name + '” as a kind of expense', null);
    }
    return catList();
  }
  function catGone(w, p) {
    if (!mayPay(w)) throw new Error('Only Finance can remove kinds of expense.');
    const name = clip(p.name, 60), cur = getCats();
    if (!cur.some(c => c === name)) throw new Error('There is no kind of expense called that.');
    kv.setProp('expCats', JSON.stringify(cur.filter(c => c !== name)));
    actLog(w, {}, 'expCatGone', 'Removed “' + name + '” as a kind of expense (expenses already saved keep it)', null);
    return catList();
  }
  /* How an expense was paid (b278, Gita): Finance's own list too, starting as
     the payment types already used at the places, and added to as they go.
     Only Finance's expenses use it; the sales' payment types are untouched. */
  const getPays = F => { const a = parse(kv.getProp('expPays'), null);
    return Array.isArray(a) ? a.map(x => String(x)).filter(Boolean)
      : [...new Set((F || facts()).payTypes.map(t => String(t)))].filter(t => !/^(gift|other)$/i.test(t)); };
  const payList = F => getPays(F).filter(t => !/^(gift|other)$/i.test(t));
  function payAdd(w, p) {
    if (!mayPay(w)) throw new Error('Only Finance can add payment types.');
    const name = clip(p.name, 40).replace(/\s+/g, ' ').trim();
    if (!name) throw new Error('Type the new payment type.');
    const cur = getPays();
    if (!/^(gift|other)$/i.test(name) && !cur.some(c => c.toLowerCase() === name.toLowerCase())) {
      kv.setProp('expPays', JSON.stringify(cur.concat([name]).slice(0, 100)));
      actLog(w, {}, 'expPayAdd', 'Added “' + name + '” as a way an expense was paid', null);
    }
    return payList();
  }
  function payGone(w, p) {
    if (!mayPay(w)) throw new Error('Only Finance can remove payment types.');
    const name = clip(p.name, 40), cur = getPays();
    if (!cur.some(c => c === name)) throw new Error('There is no payment type called that.');
    kv.setProp('expPays', JSON.stringify(cur.filter(c => c !== name)));
    actLog(w, {}, 'expPayGone', 'Removed “' + name + '” as a way an expense was paid (expenses already saved keep it)', null);
    return payList();
  }
  const getGone = () => { const a = parse(kv.getProp('reimbGone'), []); return Array.isArray(a) ? a.map(x => String(x)) : []; };
  function allMethods(F, withGone) {
    const seen = {}, out = [];
    if (!withGone) getGone().forEach(g => { seen[g.toLowerCase()] = 1; });
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
    // Their WhatsApp number and email from their Profile (b304).
    Object.values(by).forEach(x => { const c = auth.contactOf(x.email); x.whatsapp = c.whatsapp; x.cemail = c.email; });
    return Object.values(by).sort((a, b) => a.name.localeCompare(b.name));
  }

  function options(w, p) {
    const F = facts(), rules = getRules();
    const list = placeList(w);
    if (w.open && w.linkPlace && !list.some(x => x.id === w.linkPlace)) {
      const lp = placeOf(w.P, w.linkPlace);
      if (lp) list.unshift(Object.assign(lp, { closed: false, label: labelOf(w.P, lp) }));
    }
    const want = String(p.location || '') || (w.open ? w.linkPlace || '' : '');
    /* A new expense starts where you are (b302, Gita: every searchable menu
       starts where you are); at Earthly HQ, or anywhere not in the list, it
       starts at Earthly HQ for whoever reaches it (2026-10-20). Anyone else
       starts at their only place. */
    const hq = p.start && list.find(x => x.kind === 'hq');
    const pl = list.find(x => x.id === want) || hq || (isFin(w) && list.length > 1 ? null : list[0]) || null;
    const forEmail = isFin(w) && p.forEmail ? String(p.forEmail).toLowerCase() : w.email;
    const eff = effective(F, rules, pl, forEmail);
    const spend = new Set(regionCurs(F, pl));
    Object.values(F.regions).forEach(r => r.currencies.forEach(c => spend.add(c)));
    ['USD', 'EUR', 'GBP', 'INR', 'PLN'].forEach(c => spend.add(c));
    return {
      places: list, location: pl ? pl.id : '', defaultCur: regionCurs(F, pl)[0] || 'USD',
      spendCurs: [...spend], methods: eff.methods.map(m => methodInfo(F, m)), curs: eff.curs,
      categories: catList(), payTypes: payList(F),
      // The consignment groups of the place's region (and only the place's own event's, for an event group).
      partners: pl && pl.regionId ? F.partners.filter(g => g.regionId === pl.regionId && (!g.eventId || g.eventId === pl.eventId))
        .map(g => ({ id: g.id, name: g.name })) : [],
      me: { name: w.name, email: w.email, link: !!w.link, contact: w.email && !w.link ? auth.contactOf(w.email) : null }, fin: w.fin, mayPay: mayPay(w),
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
    // A deleted expense the Activity Log can still bring back keeps its receipts for 30 days.
    if (app.dbHas_('_activity')) app.objectsOf_('_activity').forEach(a => {
      if (a.action !== 'expDelete' || a.undoneAt || now() - new Date(a.ts).getTime() > 30 * 86400000) return;
      const u = parse(a.undo, null); if (u && u.row) parse(u.row.receipts, []).forEach(x => used.add(x.id));
    });
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
  /* The sums behind Finance, worked out once per change (b284, Gita: "slow
     for finances to load"): every sale in every season is gone through, so the
     answer is kept until anything is saved (the revision moves) or five
     minutes pass (rates). Each request gets its own copy to dress. */
  let finMemo = null;
  function finSums() {
    const key = String(app.getRev_()) + '|' + Math.floor(Date.now() / 300000);
    if (!finMemo || finMemo.key !== key) finMemo = { key, json: JSON.stringify(app.financeData_()) };
    return JSON.parse(finMemo.json);
  }
  function finData(w) {
    if (!isFin(w)) throw new Error('The finance section is for Finance.');
    fresh();
    const D = finSums(), own = cleanSeries(parse(kv.getProp('finSeries'), {}));
    const dt = getDates();
    ['seasons', 'regions', 'events'].forEach(k => D[k].forEach(x => {
      x.series = own[k][x.id] || seriesOf(x.name);
      x.from = (dt[k][x.id] || {}).from || ''; x.to = (dt[k][x.id] || {}).to || '';
    }));
    D.mayEdit = mayPay(w);
    // Finance-only places (b279): their names, and their expenses tied to them.
    const P = places(), fps = Object.values(getFP()).map(fp => placeOf(P, fp.id)).filter(Boolean);
    D.finPlaces = fps.map(pl => ({ id: pl.id, name: pl.name, parent: pl.parent, seasonId: pl.seasonId, regionId: pl.regionId }));
    const fpOf = {}; fps.forEach(pl => { fpOf[pl.id] = pl; });
    const locOf = {}; rows().forEach(r => { if (fpOf[r.location]) locOf[r.id] = fpOf[r.location]; });
    D.expenses.forEach(x => { const pl = locOf[x.id]; if (pl) { x.f = pl.id; x.s = pl.seasonId; x.r = pl.regionId === HQ.regionId ? '' : pl.regionId; } });
    // An expense its place has no rate for still gets dollars (b269): the rate nearest its day, as an estimate.
    D.expenses.forEach(x => { if (!(x.usd > 0) && x.amt > 0 && String(x.cur).toUpperCase() !== 'USD') {
      const r = rateNow(String(x.cur).toUpperCase(), 'USD', x.d); if (r && r.rate > 0) { x.usd = Math.round(x.amt * r.rate * 100) / 100; x.usdExact = 0; } } });
    D.convs = convApply(D);
    return D;
  }

  /* ---- Dollars received (b267, Gita 2026-10-20) ----
     Finance writes down a real exchange: "took 3,000 zł from this event (or
     region, or season) and received $780". From then on that place's money in
     that currency counts at what it actually fetched, instead of the
     estimated rate. Several at one place add up; the nearest place wins (an
     event's over its region's over its season's). A sale whose dollars were
     entered by hand keeps them. Kept in the setting `finConv`. */
  const getConvs = () => { const a = parse(kv.getProp('finConv'), []); return Array.isArray(a) ? a : []; };
  /* Several currencies exchanged together for one dollar figure (b298, Gita:
     "85 euros + 6250 den + $5 = $253"). Each currency keeps its share of the
     dollars, split by what it was worth that day; dollars in the pile count as
     themselves. A row from before has just the one currency. */
  const convParts = c => Array.isArray(c.parts) ? c.parts : [{ cur: c.cur, amt: c.amt, usd: c.usd }];
  const convText = c => convParts(c).map(x => x.amt + ' ' + x.cur).join(' + ') + ' fetched $' + c.usd;
  function convApply(D) {
    const P = places(), list = getConvs().map(c => {
      const pl = placeOf(P, c.place);
      return Object.assign({}, c, { label: pl ? labelOf(P, pl) : '(a place since removed)', kind: pl ? pl.kind : '' });
    });
    const by = {};
    list.forEach(c => { if (!c.kind) return; convParts(c).forEach(x => { if (x.cur === 'USD') return;
      const k = c.place + '|' + x.cur; const o = by[k] || (by[k] = { amt: 0, usd: 0 }); o.amt += Number(x.amt) || 0; o.usd += Number(x.usd) || 0; }); });
    const keyFor = (x, cur) => { for (const id of [x.e, x.r, x.s]) { const o = id && by[id + '|' + cur]; if (o && o.amt > 0) return id + '|' + cur; } return null; };
    /* Each sale's share is rounded to the cent, so the cents left over go to
       the biggest one: the place's figure is then exactly what was written
       down (b299, Gita: $253 showed as $252.98). */
    const grp = {};
    D.sales.forEach(x => {
      if (x.con || x.ua || !x.cu) return;
      Object.keys(x.cur || {}).forEach(c => {
        const k = keyFor(x, c); if (k === null || !(c in x.cu)) return;
        const o = by[k], exact = x.cur[c] * o.usd / o.amt, cents = Math.round(exact * 100) / 100;
        x.gu = Math.round((x.gu - x.cu[c] + cents) * 100) / 100; x.cv = 1; (x.cvd = x.cvd || {})[c] = 1;
        const g = grp[k] || (grp[k] = { exact: 0, got: 0, big: null, bigV: -1 }); g.exact += exact; g.got += cents;
        if (cents > g.bigV) { g.big = x; g.bigV = cents; }
      });
      // Every other currency in it counted at a real exchange: its dollars are no longer an estimate.
      if (x.cv && !(x.pu > 0) && Object.keys(x.cur || {}).every(c => c === 'USD' || x.cvd[c])) x.ue = 0;
      delete x.cvd;
    });
    Object.keys(grp).forEach(k => { const g = grp[k], d = Math.round((Math.round(g.exact * 100) / 100 - g.got) * 100) / 100;
      if (d && g.big) g.big.gu = Math.round((g.big.gu + d) * 100) / 100; });
    return list;
  }
  function convSet(w, p) {
    if (!mayPay(w)) throw new Error('Only Finance can write down dollars received.');
    const pl = placeOf(w.P, clip(p.place, 60));
    if (!pl) throw new Error('Choose the event, region or season the money came from.');
    const got = {};
    (Array.isArray(p.parts) ? p.parts : [{ cur: p.cur, amt: p.amt }]).slice(0, 12).forEach(x => {
      const cur = String((x && x.cur) || '').toUpperCase(), amt = Math.round((Number(x && x.amt) || 0) * 100) / 100;
      if (!CUR.test(cur)) throw new Error('Choose the currency that was exchanged.');
      if (amt > 0) got[cur] = Math.round(((got[cur] || 0) + amt) * 100) / 100;
    });
    const usd = Math.round((Number(p.usd) || 0) * 100) / 100, cash = got.USD || 0;
    const curs = Object.keys(got).filter(c => c !== 'USD');
    if (!curs.length) throw new Error('How much of which currency was exchanged?');
    if (!(usd > 0)) throw new Error('How many dollars were received?');
    if (!(usd > cash)) throw new Error('The dollars received should be more than the $' + cash + ' that was already in dollars.');
    // Each currency's share of what the exchange fetched, by its worth that day (core looks the rates up); evenly with none.
    // Without a rate for every one of them, they share it evenly rather than one getting nothing.
    const rates = p.rates || {}, worth = curs.map(c => got[c] * (Number(rates[c]) > 0 ? Number(rates[c]) : 0));
    const all0 = worth.some(v => !(v > 0)), W = all0 ? curs.length : worth.reduce((a, b) => a + b, 0);
    let left = Math.round((usd - cash) * 100) / 100;
    const parts = curs.map((c, i) => {
      const share = i === curs.length - 1 ? left : Math.round((usd - cash) * (all0 ? 1 : worth[i]) / W * 100) / 100;
      left = Math.round((left - share) * 100) / 100;
      return { cur: c, amt: got[c], usd: share };
    });
    if (cash) parts.push({ cur: 'USD', amt: cash, usd: cash });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? String(p.date) : new Date(now()).toISOString().slice(0, 10);
    const all = getConvs(), id = clip(p.id, 40) || 'V' + Math.random().toString(36).slice(2, 10);
    const row = { id, place: pl.id, usd, date, note: clip(p.note, 200), by: w.name, at: new Date(now()).toISOString() };
    if (parts.length === 1) Object.assign(row, { cur: parts[0].cur, amt: parts[0].amt }); else row.parts = parts;
    const i = all.findIndex(c => c.id === id), was = i >= 0 ? all[i] : null;
    if (i >= 0) all[i] = row; else all.push(row);
    kv.setProp('finConv', JSON.stringify(all.slice(-2000)));
    // Delete in the Activity Log (b296, Gita): an added one goes, a changed one goes back to what it was.
    actLog(w, { seasonId: pl.seasonId, regionId: pl.regionId, location: pl.id }, 'finConv',
      'Dollars received: ' + convText(row).replace(' fetched', ' from ' + labelOf(w.P, pl) + ' fetched'), { type: 'exp', op: 'convSet', id, was });
    return finData(w);
  }
  function convDel(w, p) {
    if (!mayPay(w)) throw new Error('Only Finance can change dollars received.');
    const id = clip(p.id, 40), all = getConvs(), gone = all.find(c => c.id === id);
    kv.setProp('finConv', JSON.stringify(all.filter(c => c.id !== id)));
    if (gone) actLog(w, {}, 'finConv', 'Dollars received removed: ' + convText(gone), { type: 'exp', op: 'convDel', id, was: gone });
    return finData(w);
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
  /* "My expenses" (b278, Gita): only those that are yours by name. One entered
     as General, or for someone else, goes in the general pool (Finance's list),
     though whoever entered it may still change it. */
  function ownList(w, r) {
    if (!w.email) return mine(w, r);
    if (String(r.forEmail)) return String(r.forEmail) === w.email;
    return String(r.byEmail) === w.email && String(r.forName) !== 'General';
  }
  const shown = r => Object.assign({}, r, { amt: Number(r.amt) || 0, payTo: parse(r.payTo, {}), receipts: parse(r.receipts, []), payAmt: parse(r.payAmt, null) || payGuess(r),
    usdAmt: Number(r.usdAmt) > 0 ? Number(r.usdAmt) : null, usdDay: parse(r.usdDay, null), bookLink: parse(r.bookLink, null) });
  /* No rate came with it (b267): Finance still gets a figure and a total, at
     the latest rate the server has (marked as a fallback). */
  function payGuess(r) {
    const cur = String(r.cur || '').toUpperCase(), rc = String(r.reimbCur || '').toUpperCase();
    if (r.kind !== 'reimburse' || !rc || rc === cur) return null;
    const x = rateNow(cur, rc, String(r.date || ''));
    return x && x.rate > 0 ? { amt: Math.round((Number(r.amt) || 0) * x.rate * 100) / 100, cur: rc, rate: x.rate, on: x.on, fallback: true } : null;
  }
  /* The dollars at the rate on the day of the expense (b265): the rate comes
     from the server's own lookup (core.js puts it in p.usdDay), never the page. */
  function cleanUsdDay(x, amt) {
    if (!x || typeof x !== 'object' || !(Number(x.rate) > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(x.on || ''))) return '';
    return JSON.stringify({ usd: Math.round(amt * Number(x.rate) * 100) / 100, rate: Number(x.rate), on: String(x.on) });
  }
  /* What to pay back when it is in another currency than was spent (b259):
     worked out on the page from the rate on the day of the purchase, kept
     with the expense so Finance sees the same figure. */
  /* What to pay back (b267): exact numbers typed on the check page win
     ("I have the exact numbers for reimbursement"), then exact dollars when it
     is paid back in dollars, then the day's rate the server looked up (core.js
     puts it in p.payDay; a fallback rate says so). An exact amount keeps the
     day's figure beside it (est), so Finance sees when it is well above. */
  function payAmtFor(p, old, x) {
    if (!x.reimbCur || x.reimbCur === x.cur) return '';
    const day = p.payDay && Number(p.payDay.rate) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(p.payDay.on || '')) ? p.payDay : null;
    const est = day ? Math.round(x.amt * Number(day.rate) * 100) / 100 : null;
    const exact = Math.round((Number(p.payExact) || 0) * 100) / 100 || (x.reimbCur === 'USD' && x.usdAmt ? x.usdAmt : 0);
    if (exact > 0) return JSON.stringify({ amt: exact, cur: x.reimbCur, exact: true, est, rate: day ? Number(day.rate) : null, on: day ? day.on : x.date,
      fallback: day && day.fallback ? true : undefined });
    if (day) return JSON.stringify({ amt: est, cur: x.reimbCur, rate: Number(day.rate), on: String(day.on), fallback: day.fallback ? true : undefined });
    return '';
  }
  function cleanPayAmt(p, cur, reimbCur, amt) {
    const x = p && typeof p === 'object' ? p : null;
    if (!x || !reimbCur || reimbCur === cur) return '';
    const rate = Number(x.rate), on = String(x.on || '');
    if (!(rate > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(on)) return '';
    return JSON.stringify({ amt: Math.round(amt * rate * 100) / 100, cur: reimbCur, rate, on });
  }
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
    // Exact dollars (b265), optional: what actually came to, overriding any rate.
    const usdAmt = cur === 'USD' ? '' : (Math.round((Number(p.usdAmt) || 0) * 100) / 100 || '');
    if (usdAmt !== '' && !(usdAmt > 0)) throw new Error('The exact dollar amount should be more than 0.');
    const desc = clip(p.desc, 300);
    if (!desc) throw new Error('Say what the expense was for.');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? String(p.date) : new Date(now()).toISOString().slice(0, 10);
    // On someone's behalf (Finance): their name and address go on it, Finance's as who entered it.
    let forEmail = '', forName = '';
    if (p.forEmail === '*general' && isFin(w)) {
      // General (b276): the tour's own expense, nobody's, so nobody is paid back.
      forName = 'General';
      if (kind === 'reimburse') throw new Error('A General expense is not paid back to anyone. Untick reimbursement, or choose whose expense it is.');
    } else if (p.forEmail && isFin(w)) {
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
    // A kind since removed from the list stays on the expense that already had it.
    const category = catList().indexOf(String(p.category)) >= 0 || (old && String(old.category) === String(p.category) && p.category) ? String(p.category) : 'Other';
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
      catOther, contactPhone: contactPhone || (old ? String(old.contactPhone || '') : ''), contactEmail: contactEmail || (old ? String(old.contactEmail || '') : ''),
      // An edit that sends none keeps the rate it had, while the day and currencies are the same.
      usdAmt, usdDay: cur === 'USD' || usdAmt ? '' : cleanUsdDay(p.usdDay, amt) || (old && old.cur === cur && old.date === date ? (() => {
        const o = parse(old.usdDay, null); return o && o.rate > 0 ? JSON.stringify({ usd: Math.round(amt * o.rate * 100) / 100, rate: o.rate, on: o.on }) : ''; })() : ''),
      payAmt: kind === 'reimburse' ? payAmtFor(p, old, { cur, reimbCur, amt, date, usdAmt }) || cleanPayAmt(p.payAmt || (old && old.cur === cur && old.reimbCur === reimbCur && old.date === date ? parse(old.payAmt, null) : null), cur, reimbCur, amt) : ''
    };
    row.bookLink = bookLinkFor(w, p, old);
    if (!row.byName && !forName) throw new Error('Say who you are first.');
    app.dbCreate_(T, COLS); app.dbAddCols_(T, COLS);
    if (old) app.dbUpdate_(T, { id }, row); else app.dbInsert_(T, row);
    syncCost(row, F, w);
    if (old) actLog(w, row, 'expSave', 'Expense changed: ' + expWords(row), null);
    else actLog(w, row, 'expSave', 'Expense added: ' + expWords(row), { type: 'exp', op: 'add', id });
    // A link sent to one person is used up once their expenses are in (`more`: others follow in the same sending).
    if (w.open && !old && !p.more) {
      const L = getLinks();
      if (L[w.link] && L[w.link].once) { L[w.link].used = id; L[w.link].usedAt = new Date(now()).toISOString(); kv.setProp('reimbLinks', JSON.stringify(L)); }
    }
    return shown(row);
  }
  /* ---- Costs put on books (b320, practice first; Gita, 2026-10-29) ----
     A printing, a shipment or one sale's postage. Finance only. Weights in
     grams for a shipment's titles are kept with it (setting bookWeights). */
  function bookLinkFor(w, p, old) {
    if (p.bookLink === undefined) return old ? String(old.bookLink || '') : '';
    if (!practice || !isFin(w) || !p.bookLink) return '';
    const L = p.bookLink, k = String(L.k || '');
    let out = null;
    if (k === 'print' && /^(m|sh):[A-Za-z0-9_\-]{2,60}$/.test(String(L.src || ''))) {
      const shares = {};
      Object.keys(L.shares || {}).slice(0, 60).forEach(b => { const v = Math.round((Number(L.shares[b]) || 0) * 100) / 100; if (v > 0) shares[clip(b, 40)] = v; });
      out = { k, src: String(L.src), shares };
    } else if (k === 'ship' && /^sh_[A-Za-z0-9]{3,20}$/.test(String(L.sh || ''))) out = { k, sh: String(L.sh) };
    else if (k === 'post' && L.sale) out = { k, sale: clip(L.sale, 60) };
    if (!out) throw new Error('Choose which books this cost is for.');
    if (p.weights && typeof p.weights === 'object') {
      const W = parse(kv.getProp('bookWeights'), {}) || {};
      Object.keys(p.weights).slice(0, 200).forEach(b => { const g = Math.round(Number(p.weights[b]) || 0); if (g > 0 && g < 100000) W[clip(b, 40)] = g; });
      kv.setProp('bookWeights', JSON.stringify(W));
    }
    return JSON.stringify(out);
  }
  function bookCostOpts(w) {
    if (!practice || !isFin(w)) throw new Error('This is for Finance, in the practice space.');
    fresh();
    return app.bookCostOptions_();
  }
  function bookCostSales(w) {
    if (!practice || !isFin(w)) return { on: false, sales: {} };
    fresh();
    return app.bookCostSales_();
  }
  // Book weights in grams, all at once (Finance › Settings).
  function bookWeightsSet(w, p) {
    if (!practice || !mayPay(w)) throw new Error('Only Finance can change the book weights.');
    const W = {};
    Object.keys(p.weights || {}).slice(0, 500).forEach(b => { const g = Math.round(Number(p.weights[b]) || 0); if (g > 0 && g < 100000) W[clip(b, 40)] = g; });
    kv.setProp('bookWeights', JSON.stringify(W));
    actLog(w, {}, 'bookWeightsSet', 'Book weights changed (' + Object.keys(W).length + ' titles)', null);
    return { weights: W };
  }
  function remove(w, p) {
    fresh();
    const id = clip(p.id, 40), old = rows().find(r => String(r.id) === id);
    if (!old) return { id };
    if (!mayPay(w) && !mine(w, old)) throw new Error('That expense is not yours to delete.');
    if (old.status === 'paid' && !mayPay(w)) throw new Error('That expense has been paid back, so it cannot be deleted. Ask Finance.');
    app.dbDelete_(T, { id });
    dropCost(old, w);
    // Its receipts stay while the Activity Log can still bring it back (the sweep clears them after).
    actLog(w, old, 'expDelete', 'Expense deleted: ' + expWords(old), { type: 'exp', op: 'delete', id, row: old });
    return { id };
  }
  function mark(w, p) {
    if (!mayPay(w)) throw new Error('Only Finance can mark an expense as paid back.');
    fresh();
    const id = clip(p.id, 40), old = rows().find(r => String(r.id) === id);
    if (!old) throw new Error('That expense is no longer listed.');
    if (old.kind !== 'reimburse') throw new Error('That expense was recorded for the records, not to be paid back.');
    const status = ['paid', 'declined', 'pending'].indexOf(p.status) >= 0 ? p.status : 'paid';
    const today = new Date(now()).toISOString().slice(0, 10);
    const paidOn = String(p.paidOn || '');
    if (status === 'paid' && paidOn && (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || paidOn > today)) throw new Error('Give the date it was paid: today or before.');
    const set = status === 'pending' ? { status, doneAt: '', doneBy: '', doneNote: '', paidOn: '' }
      : { status, doneAt: new Date(now()).toISOString(), doneBy: w.name, doneNote: clip(p.note, 300), paidOn: status === 'paid' ? (paidOn || today) : '' };
    app.dbAddCols_(T, COLS);
    app.dbUpdate_(T, { id }, set);
    const now2 = Object.assign({}, old, set);
    syncCost(now2, facts(), w);
    const who = old.forName || old.byName || 'someone';
    if (status !== 'pending') actLog(w, now2, 'expMark', status === 'paid'
      ? 'Paid back ' + who + ' ' + payWords(now2) + ' for ' + old.desc + ' (paid ' + now2.paidOn + ')' + (set.doneNote ? ' — “' + set.doneNote + '”' : '')
      : 'Declined ' + who + '’s expense: ' + old.desc + ' ' + payWords(now2) + (set.doneNote ? ' — “' + set.doneNote + '”' : ''),
      { type: 'exp', op: 'mark', id, was: old.status || 'pending' });
    return shown(now2);
  }
  function list(w, p) {
    fresh();
    const all = p.scope === 'all' && isFin(w);
    return rows().filter(r => all || ownList(w, r)).map(shown).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  }
  /* Finance's To do: every payment still owed, and every expense still to be paid back, across the system. */
  function todo(w) {
    if (!isFin(w)) throw new Error('The Finance To do is for Finance.');
    const F = facts();
    return { pending: F.pending.sort((a, b) => String(b.ts).localeCompare(String(a.ts))),
      reimb: rows().filter(r => r.kind === 'reimburse' && r.status === 'pending').map(shown).sort((a, b) => String(b.ts).localeCompare(String(a.ts))),
      // Closed links someone has asked to have reactivated: a red dot on Links.
      asks: isFin(w) ? Object.values(getLinks()).filter(l => l.ask && (l.off || l.used)).length : 0 };
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
    return { rules: getRules(), methods: allMethods(F), gone: getGone(), cats: catList(), pays: payList(F), curs: [...curs], levels, people: peopleList(), mayEdit: mayPay(w),
      // What each level gives now, before any person's own setting.
      regionCurs: Object.fromEntries(levels.map(l => [l.id, regionCurs(F, placeOf(P, l.id))])) };
  }
  function rulesSet(w, p) {
    if (!mayPay(w)) throw new Error('Only Finance can change these settings.');
    kv.setProp('reimbRules', JSON.stringify(cleanRules(p.rules)));
    actLog(w, {}, 'expRulesSet', 'Changed the reimbursement settings', null);
    return rulesGet(w);
  }

  function methodGone(w, p) {
    if (!mayPay(w)) throw new Error('Only Finance can change these settings.');
    const name = clip(p.name, 60);
    if (!name || !allMethods(facts(), true).some(m => m.toLowerCase() === name.toLowerCase())) throw new Error('There is no way of paying back called that.');
    let gone = getGone().filter(g => g.toLowerCase() !== name.toLowerCase());
    if (p.gone) gone.push(name);
    kv.setProp('reimbGone', JSON.stringify(gone.slice(0, 100)));
    actLog(w, {}, 'expMethodGone', (p.gone ? 'Removed “' : 'Brought back “') + name + '” as a way of paying back', null);
    return rulesGet(w);
  }
  function linkList(w) {
    if (!isFin(w)) throw new Error('Reimbursement links are for Finance.');
    const P = w.P, L = getLinks();
    return Object.keys(L).map(k => Object.assign({ key: k }, L[k], {
      placeLabel: L[k].place && placeOf(P, L[k].place) ? labelOf(P, placeOf(P, L[k].place)) : 'General',
      sent: rows().filter(r => String(r.byLink) === k).length })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }
  function linkMake(w, p) {
    if (!isFin(w)) throw new Error('Reimbursement links are for Finance.');
    const place = clip(p.place, 60);
    if (place && !placeOf(w.P, place)) throw new Error('Choose a place from the list, or General.');
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
    const pl = place ? placeOf(w.P, place) : null;
    actLog(w, pl ? { seasonId: pl.seasonId, regionId: pl.regionId, location: pl.id } : {}, 'expLinkMake',
      'Made a reimbursement link' + (toName ? ' for ' + toName : '') + (pl ? ' (' + labelOf(w.P, pl).split(' · ')[0] + ')' : ''), null);
    return { key, list: linkList(w) };
  }
  function linkOff(w, p) {
    if (!isFin(w)) throw new Error('Reimbursement links are for Finance.');
    const L = getLinks(), k = clip(p.key, 60);
    if (L[k]) { L[k].off = p.on ? false : true; delete L[k].ask; if (p.on) { delete L[k].used; delete L[k].usedAt; } kv.setProp('reimbLinks', JSON.stringify(L)); }
    return linkList(w);
  }
  /* Deleting a link (b291, Gita): gone from the list for good; anything already
     sent in through it stays, as an expense. */
  function linkDel(w, p) {
    if (!isFin(w)) throw new Error('Reimbursement links are for Finance.');
    const L = getLinks(), k = clip(p.key, 60);
    if (L[k]) { delete L[k]; kv.setProp('reimbLinks', JSON.stringify(L)); }
    return linkList(w);
  }
  /* What the form needs to say at the top: which place, if one. */
  function linkInfo(w) {
    if (!w.open) throw new Error('This is for a reimbursement link.');
    const pl = w.linkPlace ? placeOf(w.P, w.linkPlace) : null;
    const L = getLinks()[w.link] || {};
    return { place: w.linkPlace, placeLabel: pl ? labelOf(w.P, pl) : '', to: L.to || null };
  }
  /* ---- The Activity Log (b260): Finance's changes, there to spot and undo mistakes ----
     Written into the app's own log (_activity), for the expense's season,
     region and place, so it shows where that place's other changes do. */
  const money = (a, c) => (Math.round((Number(a) || 0) * 100) / 100) + ' ' + String(c || '');
  const payWords = r => { const pa = parse(r.payAmt, null); return pa && pa.amt != null ? money(pa.amt, pa.cur) : money(r.amt, r.cur); };
  const expWords = r => String(r.desc || '') + ', ' + money(r.amt, r.cur) + (r.placeLabel ? ' at ' + String(r.placeLabel).split(' · ')[0] : '') +
    (r.kind === 'reimburse' ? ' (to pay back to ' + (r.forName || r.byName || 'them') + ')' : '');
  function actLog(w, r, action, text, undo) {
    try {
      app.activitySheet_(); app.dbAddCols_('_activity', ['parts', 'undoneParts']);
      app.dbInsert_('_activity', { id: 'A' + Math.random().toString(36).slice(2, 12), ts: new Date(now()),
        season: String(r.seasonId || app.activeSeasonId_()), who: w.name || (w.open ? 'reimbursement link' : ''), action,
        text: String(text).slice(0, 900), locs: String(r.location || ''), regions: String(r.regionId || ''), moves: '',
        undo: undo ? JSON.stringify(undo) : '', undoneAt: '', undoneBy: '', parts: '', undoneParts: '' });
    } catch (e) { /* the log must never cost anyone their change */ }
  }
  /* Delete in the Activity Log: an added expense goes, a deleted one comes
     back, a paid or declined one is waiting again. */
  function undo(w, p) {
    const id = clip(p.id, 40);
    const e = app.dbHas_('_activity') ? app.objectsOf_('_activity').find(r => String(r.id) === id) : null;
    if (!e) throw new Error('That entry is no longer in the log.');
    if (e.undoneAt) return { done: 'already' };
    const u = parse(e.undo, null);
    if (!u || u.type !== 'exp') throw new Error('This one cannot be undone here.');
    fresh();
    if (u.op === 'convSet' || u.op === 'convDel') {
      if (!mayPay(w)) throw new Error('Only Finance can change dollars received.');
      const all = getConvs().filter(c => c.id !== u.id);
      if (u.was && u.was.id) all.push(u.was);
      kv.setProp('finConv', JSON.stringify(all.slice(-2000)));
    } else if (u.op === 'add') remove(w, { id: u.id });
    else if (u.op === 'mark') mark(w, { id: u.id, status: 'pending' });
    else if (u.op === 'delete') {
      if (!mayPay(w) && !mine(w, u.row)) throw new Error('That expense is not yours to bring back.');
      if (rows().some(r => String(r.id) === String(u.id))) throw new Error('That expense is already back.');
      app.dbCreate_(T, COLS); app.dbAddCols_(T, COLS);
      const row = {}; COLS.forEach(k => { row[k] = u.row[k] === undefined ? '' : u.row[k]; });
      app.dbInsert_(T, row); syncCost(row, facts(), w);
    } else throw new Error('This one cannot be undone here.');
    app.dbUpdate_('_activity', { id }, { undoneAt: new Date(now()), undoneBy: w.name || '' });
    // The undo leaves a line of its own, as the rest of the log's do.
    app.dbInsert_('_activity', { id: 'A' + Math.random().toString(36).slice(2, 12), ts: new Date(now()), season: String(e.season || ''),
      who: w.name || '', action: 'undoActivity', text: 'Undid: ' + String(e.text || ''), locs: String(e.locs || ''), regions: String(e.regions || ''),
      moves: '', undo: '', undoneAt: '', undoneBy: '' });
    return { done: 'undone' };
  }

  /* ---- Finance's launch (b274, Gita): what was set up in practice, brought to live ----
     Asked for by Universal on the live app. The page reads it from the
     practice server with this device's practice sign-in (finCarryOut, there),
     then hands it to live (finCarryIn, here): the wording rewritten with the
     pencils, the reimbursement settings and ways of paying back, and the
     places' dates and recurring series. Practice's expenses, receipts and links
     are practice's own and stay there. */
  const CARRY_PROPS = ['reimbRules', 'reimbGone', 'placeDates', 'finSeries'];
  function carryOut(w) {
    if (!practice) throw new Error('This is read from the practice space.');
    if (!w.universal) throw new Error('Only Universal can bring settings to the live app.');
    const labels = app.dbHas_('_labels') ? app.objectsOf_('_labels').filter(r => r && String(r.key)).map(r => ({ key: String(r.key), text: String(r.text == null ? '' : r.text) })) : [];
    const props = {}; CARRY_PROPS.forEach(k => { const v = kv.getProp(k); if (v) props[k] = v; });
    // The wording as live had it when practice was last copied from it (b288); null before the first copy since.
    const base = parse(kv.getProp('labelsBase'), null);
    return { labels, props, base: base && typeof base === 'object' ? base : null };
  }
  /* Which practice wording goes to live (b288, Gita: "show me both and let me
     choose each time"). Against the wording as it was when practice was last
     copied from live: changed only in practice, it comes over; changed only in
     live, live keeps its own; changed in both, nothing is written until she
     picks. With no record of that copy, every difference is hers to pick. */
  function carryPlan(liveMap, prac, base) {
    const P = {}; prac.forEach(l => { if (l && l.key) P[String(l.key)] = String(l.text == null ? '' : l.text); });
    const keys = new Set(Object.keys(P).concat(Object.keys(liveMap), base ? Object.keys(base) : []));
    const take = [], both = []; let keep = 0;
    keys.forEach(k => {
      const pv = P[k] || '', lv = liveMap[k] || '';
      if (pv === lv) return;
      if (base) {
        const bv = base[k] || '';
        if (pv === bv) { keep++; return; }
        if (lv === bv) { take.push({ key: k, text: pv }); return; }
      }
      both.push({ key: k, practice: pv, live: lv });
    });
    return { take, both, keep };
  }
  function carryIn(w, p) {
    if (practice) throw new Error('Open the live app to bring practice settings into it.');
    if (!w.universal) throw new Error('Only Universal can bring settings to the live app.');
    const labels = Array.isArray(p.labels) ? p.labels.slice(0, 5000) : [];
    let words = 0;
    if (p.base !== undefined || p.plan) {
      // b288: only what changed on practice's side alone, plus the words she chose practice's version of.
      const liveMap = {};
      (app.dbHas_('_labels') ? app.objectsOf_('_labels') : []).forEach(x => { if (x && String(x.key)) liveMap[String(x.key)] = String(x.text == null ? '' : x.text); });
      const base = p.base && typeof p.base === 'object' ? p.base : null;
      const plan = carryPlan(liveMap, labels, base);
      if (p.plan) return { plan: true, take: plan.take.length, keep: plan.keep, both: plan.both };
      const pick = p.choices && typeof p.choices === 'object' ? p.choices : {};
      const open = plan.both.filter(x => pick[x.key] !== 'practice' && pick[x.key] !== 'live');
      if (open.length) throw new Error(open.length + ' wording' + (open.length === 1 ? ' was' : 's were') + ' changed in both places. Choose which to keep for each.');
      plan.take.concat(plan.both.filter(x => pick[x.key] === 'practice').map(x => ({ key: x.key, text: x.practice })))
        .forEach(l => { app.doSaveLabel({ key: l.key, text: l.text }); words++; });
    } else
    labels.forEach(l => { if (l && l.key && String(l.text || '')) { app.doSaveLabel({ key: String(l.key), text: String(l.text) }); words++; } });
    const props = p.props && typeof p.props === 'object' ? p.props : {}, set = [];
    CARRY_PROPS.forEach(k => {
      if (typeof props[k] !== 'string' || !props[k]) return;
      let v = parse(props[k], null);
      if (v === null || typeof v !== 'object') return;
      // Places' dates and series: practice's, over anything live already has for the same place.
      if (k === 'placeDates' || k === 'finSeries') { const cur = parse(kv.getProp(k), {}); v = Object.assign({}, cur && typeof cur === 'object' ? cur : {}, v); }
      kv.setProp(k, JSON.stringify(v)); set.push(k);
    });
    app.cacheClear_();
    actLog(w, {}, 'finCarryIn', 'Brought from practice: ' + words + ' rewritten wording' + (words === 1 ? '' : 's') +
      (set.length ? ', ' + set.map(k => ({ reimbRules: 'reimbursement settings', reimbGone: 'ways of paying back removed', placeDates: 'place dates', finSeries: 'recurring series' })[k]).join(', ') : ''), null);
    return { words, set };
  }

  const READS = { bookCostOpts: 1, bookCostSales: 1, expLinkList: 1, expLinkInfo: 1, expOptions: 1, expList: 1, expTodo: 1, receiptGet: 1, finData: 1, expRulesGet: 1, placeMetaGet: 1, finCarryOut: 1 };
  const OPEN_ACTIONS = { expOptions: 1, expSave: 1, receiptPut: 1, expLinkInfo: 1, expLinkAsk: 1 };

  const ACTIONS = { expLinkList: linkList, expLinkMake: linkMake, expLinkOff: linkOff, expLinkDel: linkDel, expLinkInfo: linkInfo, expLinkAsk: () => ({ asked: false }), expOptions: options, expSave: save, expDelete: remove, expMark: mark, expList: list, expTodo: todo,
    expRulesGet: rulesGet, expRulesSet: rulesSet, expMethodGone: methodGone, expCatAdd: catAdd, expCatGone: catGone, expPayAdd: payAdd, expPayGone: payGone, finPlaceAdd, finPlaceEdit, receiptPut, receiptGet, finData, finSeriesSet: seriesSet,
    placeMetaGet, placeMetaSet, expUndo: undo, finConvSet: convSet, finConvDel: convDel, finCarryOut: carryOut, finCarryIn: carryIn,
    bookCostOpts, bookCostSales, bookWeightsSet };
  /* One request: who is asking, then the action. */
  function handle(action, p, me, linkKey) {
    /* A closed link (b272, Gita): its page says so and offers "Request for
       this to be reactivated", which Finance sees as a red dot on Links. */
    if (isReimbKey(linkKey) && (action === 'expLinkInfo' || action === 'expLinkAsk')) {
      const L = getLinks(), l = L[linkKey];
      if (l && (l.off || l.used)) {
        if (action === 'expLinkInfo') return { closed: l.used && !l.off ? 'used' : 'off', asked: !!l.ask, to: l.to ? { name: l.to.name } : null };
        l.ask = { at: new Date(now()).toISOString(), name: clip(p.name, 60) || (l.to && l.to.name) || '', note: clip(p.note, 300) };
        kv.setProp('reimbLinks', JSON.stringify(L));
        actLog({ name: 'reimbursement link', open: true }, {}, 'expLinkAsk', 'Asked for a reimbursement link to be reactivated' + (l.ask.name ? ' (' + l.ask.name + ')' : ''), null);
        try { app.bumpRev_(); } catch (e) {}
        return { asked: true };
      }
      if (action === 'expLinkAsk') throw new Error('This link is working already. Open it again to send in an expense.');
    }
    const w = whoFor(p, me, linkKey);
    if (w.open && !OPEN_ACTIONS[action]) throw new Error('A reimbursement link can only send in an expense.');
    if (/^(expList|expTodo|finData)$/.test(action)) adopt();
    const out = ACTIONS[action](w, p);
    /* Anything written (a reimbursement sent in by link, one paid, a link
       closed) moves the revision on, so every open Finance page hears of it
       at once and fills it in without a refresh (Gita, 2026-10-21). */
    if (!READS[action]) { try { app.bumpRev_(); } catch (e) {} }
    return out;
  }
  return { handle, sweep, isAction: a => Object.prototype.hasOwnProperty.call(ACTIONS, a), effective, METHOD_FIELDS };
}
