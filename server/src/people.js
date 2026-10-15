/* People and roles: the rules (b222). See docs/PERMISSIONS.md.

   Pure functions over two things: the places (every season, region and event,
   and whether each is closed — from Code.gs's placesForAuth_) and the roles
   people hold. Nothing here reads or writes the database, so the rules can be
   read, and tested, on their own. */

/* The nine roles, highest first, with the kind of place each is tied to. */
export const ROLES = {
  U:  { name: 'Universal',          kind: 'all',    rank: 5 },
  F:  { name: 'Finance',            kind: 'all',    rank: 4 },
  FA: { name: 'Finance Assistant',  kind: 'all',    rank: 4 },
  SL: { name: 'Seasonal Lead',      kind: 'season', rank: 3 },
  SA: { name: 'Seasonal Assistant', kind: 'season', rank: 3 },
  RL: { name: 'Regional Lead',      kind: 'region', rank: 2 },
  RA: { name: 'Regional Assistant', kind: 'region', rank: 2 },
  EL: { name: 'Event Lead',         kind: 'event',  rank: 1 },
  S:  { name: 'Seller',             kind: 'event',  rank: 0 },
};
export const ROLE_ORDER = ['U', 'F', 'FA', 'SL', 'SA', 'RL', 'RA', 'EL', 'S'];

/* Which roles each role may give (section 3): any role below its own, and a
   lead its own level's assistant. Assistants and Finance give none. */
const GIVES = {
  U:  ROLE_ORDER.slice(),
  SL: ['SA', 'RL', 'RA', 'EL', 'S'],
  RL: ['RA', 'EL', 'S'],
  EL: ['S'],
};
/* Who may see the people with roles in their reach (assistants see, not change). */
const SEES_PEOPLE = { U: 1, SL: 1, SA: 1, RL: 1, RA: 1, EL: 1 };

/* Until Stage 2 enforces every rule, a role works through the nearest
   permission set the app already had — never a wider one (PERMISSIONS.md §6). */
const WORKS_AS = { U: 'admin', RL: 'coordinator', EL: 'seller', S: 'seller' };

export function indexPlaces(pl) {
  const seasons = {}, regions = {}, events = {};
  (pl.seasons || []).forEach(s => { seasons[s.id] = s; });
  (pl.regions || []).forEach(r => { regions[r.id] = r; });
  (pl.events || []).forEach(e => { events[e.id] = e; });
  return { seasons, regions, events, raw: pl };
}

/* The season, region and event a place sits in (whichever apply). */
function chain(P, kind, id) {
  if (kind === 'event') {
    const e = P.events[id]; if (!e) return null;
    const r = P.regions[e.regionId]; const s = r && P.seasons[r.seasonId];
    return { event: e, region: r || null, season: s || null };
  }
  if (kind === 'region') {
    const r = P.regions[id]; if (!r) return null;
    return { event: null, region: r, season: P.seasons[r.seasonId] || null };
  }
  if (kind === 'season') {
    const s = P.seasons[id]; return s ? { event: null, region: null, season: s } : null;
  }
  return { event: null, region: null, season: null };          // 'all'
}

/* Is this role in force? Not when its place (or anything above it) has closed,
   or has gone. Reopening brings it back. */
export function activeState(P, g) {
  const kind = (ROLES[g.role] || {}).kind;
  if (!kind) return { active: false, why: 'This role is not known.' };
  if (kind === 'all') return { active: true };
  const c = chain(P, kind, g.placeId);
  if (!c) return { active: false, why: 'Its place no longer exists.' };
  const shut = (c.event && c.event.closed && c.event) || (c.region && c.region.closed && c.region) || (c.season && c.season.closed && c.season);
  if (shut) return { active: false, why: shut.name + ' is closed.' };
  return { active: true };
}

/* "Yoga Studio · Italy · Europe Tour" — a place as people read it. */
export function placeLabel(P, role, placeId) {
  const kind = (ROLES[role] || {}).kind;
  if (kind === 'all') return 'Everywhere';
  const c = chain(P, kind, placeId);
  if (!c) return '(a place that no longer exists)';
  return [c.event, c.region, c.season].filter(Boolean).map(x => x.name).join(' · ');
}

/* Is place (kind, id) inside the reach of grant g? */
function within(P, g, kind, id) {
  const gk = (ROLES[g.role] || {}).kind;
  if (gk === 'all') return true;
  const c = chain(P, kind, id);
  if (!c) return false;
  if (gk === 'season') return !!c.season && c.season.id === g.placeId;
  if (gk === 'region') return !!c.region && c.region.id === g.placeId;
  if (gk === 'event') return !!c.event && c.event.id === g.placeId;
  return false;
}

/* May someone holding these grants give role `role` at `placeId`? */
export function mayGive(P, myGrants, owner, role, placeId) {
  if (!ROLES[role]) return false;
  const kind = ROLES[role].kind;
  if (owner) return kind === 'all' ? !placeId : !!chain(P, kind, placeId);
  return myGrants.some(g => activeState(P, g).active && (GIVES[g.role] || []).indexOf(role) >= 0 &&
    (kind === 'all' ? (g.role === 'U' && !placeId) : within(P, g, kind, placeId)));
}

/* May they take away grant `target`? The same people who could give it, and an
   Event Lead only the Sellers they added themselves. Nobody removes their own. */
export function mayRemove(P, myGrants, owner, me, target) {
  if (!target || target.email === me) return false;
  if (owner) return true;
  if (!mayGive(P, myGrants, false, target.role, target.placeId)) return false;
  const broader = myGrants.some(g => activeState(P, g).active && g.role !== 'EL' &&
    (GIVES[g.role] || []).indexOf(target.role) >= 0 &&
    (ROLES[target.role].kind === 'all' || within(P, g, ROLES[target.role].kind, target.placeId)));
  return broader || target.addedBy === me;
}

/* Is this grant visible to someone holding myGrants (People panel)? */
export function maySee(P, myGrants, owner, target) {
  if (owner) return true;
  return myGrants.some(g => {
    if (!SEES_PEOPLE[g.role] || !activeState(P, g).active) return false;
    if (g.role === 'U') return true;
    const kind = (ROLES[target.role] || {}).kind;
    if (!kind || kind === 'all') return false;
    return within(P, g, kind, target.placeId);
  });
}
export const seesPeople = (myGrants, owner) => owner || myGrants.some(g => SEES_PEOPLE[g.role]);
export const givesAny = (P, myGrants, owner) => owner || myGrants.some(g => GIVES[g.role] && activeState(P, g).active);

/* Every role and place this person may give, for the People panel's choices. */
export function giveChoices(P, myGrants, owner) {
  const out = [];
  ROLE_ORDER.forEach(role => {
    const kind = ROLES[role].kind;
    const places = kind === 'all' ? [{ id: '', label: 'Everywhere' }]
      : (kind === 'season' ? P.raw.seasons : kind === 'region' ? P.raw.regions : P.raw.events)
        .filter(x => activeState(P, { role, placeId: x.id }).active)
        .map(x => ({ id: x.id, label: placeLabel(P, role, x.id) }));
    const ok = places.filter(x => mayGive(P, myGrants, owner, role, x.id));
    if (ok.length) out.push({ role, name: ROLES[role].name, places: ok });
  });
  return out;
}

/* What this grant works as, in the rules Code.gs already enforces, until Stage 2. */
export function worksAs(P, g) {
  const as = WORKS_AS[g.role];
  if (!as) return null;
  if (as === 'admin') return { role: 'admin' };
  if (as === 'coordinator') return { role: 'coordinator', regionId: g.placeId };
  const e = P.events[g.placeId];
  if (!e) return null;
  return { role: 'seller', regionId: e.regionId, eventIds: [e.id], eventId: e.id };
}

/* Pick the role a request acts in: the one asked for (by id) if it is theirs
   and usable, else their first usable one. */
export function acting(P, grants, wantedId) {
  const usable = grants.filter(g => activeState(P, g).active && worksAs(P, g));
  const g = usable.find(x => x.id === wantedId) || usable[0] || null;
  return g ? { grant: g, who: worksAs(P, g) } : { grant: null, who: null };
}

/* A grant as the app shows it. */
export function describe(P, g) {
  const st = activeState(P, g);
  return { id: g.id, role: g.role, roleName: (ROLES[g.role] || {}).name || g.role, placeId: g.placeId,
    place: placeLabel(P, g.role, g.placeId), active: st.active, why: st.why || '',
    usable: st.active && !!worksAs(P, g), addedBy: g.addedBy || '' };
}

/* ---- The spreadsheets (b226, PERMISSIONS.md "Spreadsheets") ----
   Universal edits every file. Finance and its assistant see every file but the
   wording one; a Seasonal Lead or Assistant sees their season's (its summary,
   its regions', its consignment groups'); a Regional Lead or Assistant sees
   their region's and its consignment groups'. Event Leads and Sellers see none.
   Seeing is "view only": they can open a file and make their own copy, not
   change the one the app keeps rebuilding.

   Files are { id, kind: 'hq'|'season'|'region'|'partner'|'desc', seasonId, regionId }.
   A role keeps its view after its place closes: the records stay worth reading. */
const SHEET_VIEW = { F: 'all', FA: 'all', SL: 'season', SA: 'season', RL: 'region', RA: 'region' };
function sheetInReach(g, f) {
  const k = SHEET_VIEW[g.role];
  if (!k || f.kind === 'desc') return false;
  if (k === 'all') return true;
  if (f.kind === 'hq') return false;
  if (k === 'season') return !!f.seasonId && f.seasonId === g.placeId;
  return (f.kind === 'region' || f.kind === 'partner') && !!f.regionId && f.regionId === g.placeId;
}
const lower = e => String(e || '').trim().toLowerCase();

/** Who should have each file, and how: { fileId: { e: [editors], v: [viewers] } }. */
export function sheetsWanted(grants, owners, files) {
  const editors = new Set((owners || []).map(lower).filter(Boolean));
  (grants || []).forEach(g => { if (g.role === 'U') editors.add(lower(g.email)); });
  const out = {};
  (files || []).forEach(f => {
    if (!f || !f.id) return;
    const e = [...editors];
    const v = new Set();
    (grants || []).forEach(g => { const m = lower(g.email); if (!editors.has(m) && sheetInReach(g, f)) v.add(m); });
    out[f.id] = { e: e.sort(), v: [...v].sort() };
  });
  return out;
}
/** Does anyone with these roles get any spreadsheet at all? */
export const seesSheets = grants => (grants || []).some(g => g.role === 'U' || SHEET_VIEW[g.role]);

/* The Spreadsheet Links map (Code.gs driveMap_) cut down to one person's own
   files, without folders (they are not shared, so their links would not open). */
export function sheetsMapFor(P, grants, map) {
  const regionSeason = id => ((P.regions[id] || {}).seasonId) || '';
  const sees = f => (grants || []).some(g => sheetInReach(g, f));
  const out = { root: null, driveOk: map.driveOk !== false, viewOnly: true, seasons: [] };
  if (map.hq && sees({ kind: 'hq' })) out.hq = map.hq;
  (map.seasons || []).forEach(se => {
    const asFile = (x, kind) => x.regionId
      ? { kind, regionId: x.regionId, seasonId: regionSeason(x.regionId) || se.seasonId }
      : { kind: 'season', seasonId: se.seasonId };
    const files = (se.files || []).filter(x => sees(asFile(x, 'region')));
    const consignFiles = (se.consignFiles || []).filter(x => sees(asFile(x, 'partner')));
    if (files.length || consignFiles.length)
      out.seasons.push({ seasonId: se.seasonId, name: se.name, folder: null, consign: null, files, consignFiles });
  });
  return out;
}
