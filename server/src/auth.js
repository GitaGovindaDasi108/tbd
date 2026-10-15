/* Who may use the owner's app (Phase 2).

   On Google, the Apps Script address itself was the secret: anyone who sent a
   request without a link key was treated as the owner. A Cloudflare address is
   an ordinary web address, so the owner's app now signs in:

     - An admin signs in with Google once on a device. Google vouches for the
       email address (a signed "ID token"), the server checks it is on the
       admin list, and hands the device its own session, good for 90 days and
       renewed whenever it is used — so in practice a device stays signed in.
     - Regional coordinators and sellers keep their links. Nothing changes for
       them: a request carrying a link key goes straight through, and Code.gs
       decides what that link may do, as before (and refuses it once the
       region is closed).

   Sessions are kept in the database; signing out, or removing someone from
   the admin list, ends theirs at once.

   People and roles (b222, docs/PERMISSIONS.md): everyone signs in. A person
   holds any number of roles, each tied to a place — Seller at one event,
   Regional Lead for one region, Universal everywhere. An "admin" is now
   simply someone holding Universal; the old admin list was moved over. Who
   may give or remove which role, and where, is decided here (peopleRules). A
   role whose place has closed is kept but does nothing until it reopens.

   Who is an admin (b207):
     - the "owners", ADMIN_EMAILS in Cloudflare's settings: always admins,
       and not removable from the app, so nobody can ever be locked out;
     - anyone an admin adds in the app, by their Google address;
     - anyone who signs in, is not yet an admin, and is approved: their
       sign-in is kept as a request, shown to the admins to approve or
       decline. A declined request is not shown again (an admin can still
       add that address). */

const DAY = 24 * 3600 * 1000;
export const SESSION_DAYS = 90;
const GOOGLE_KEYS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

export function makeAuth({ exec, clientId, adminEmails, fetchImpl, now, certsUrl }) {
  now = now || (() => Date.now());
  exec('CREATE TABLE IF NOT EXISTS session (token TEXT PRIMARY KEY, email TEXT NOT NULL, exp INTEGER NOT NULL, made INTEGER NOT NULL)');
  exec('CREATE TABLE IF NOT EXISTS admin (email TEXT PRIMARY KEY, name TEXT NOT NULL, addedBy TEXT NOT NULL, addedAt INTEGER NOT NULL)');
  exec('CREATE TABLE IF NOT EXISTS access_request (email TEXT PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL)');
  exec('CREATE TABLE IF NOT EXISTS person (email TEXT PRIMARY KEY, name TEXT NOT NULL, googleName TEXT NOT NULL, addedBy TEXT NOT NULL, addedAt INTEGER NOT NULL)');
  exec('CREATE TABLE IF NOT EXISTS grant_ (id TEXT PRIMARY KEY, email TEXT NOT NULL, role TEXT NOT NULL, placeId TEXT NOT NULL, addedBy TEXT NOT NULL, addedAt INTEGER NOT NULL)');
  // The admin list from before roles: each admin becomes Universal (once; the id makes it so).
  exec('SELECT email, name, addedBy, addedAt FROM admin').forEach(a => {
    if (!exec('SELECT email FROM person WHERE email = ?', a.email).length)
      exec('INSERT INTO person (email, name, googleName, addedBy, addedAt) VALUES (?, ?, ?, ?, ?)', a.email, a.name === a.email ? '' : a.name, '', a.addedBy, a.addedAt);
    if (!exec('SELECT id FROM grant_ WHERE id = ?', 'gU_' + a.email).length)
      exec('INSERT INTO grant_ (id, email, role, placeId, addedBy, addedAt) VALUES (?, ?, ?, ?, ?, ?)', 'gU_' + a.email, a.email, 'U', '', a.addedBy, a.addedAt);
  });
  exec('DELETE FROM admin');
  const owners = () => String(adminEmails || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const grantsOf = email => exec('SELECT id, email, role, placeId, addedBy, addedAt FROM grant_ WHERE email = ? ORDER BY addedAt', String(email || '').toLowerCase());
  const isOwner = email => owners().indexOf(String(email || '').toLowerCase()) >= 0;
  /* Universal: an owner, or holding the Universal role. (Never closes.) */
  const isAdmin = email => {
    email = String(email || '').toLowerCase();
    return !!email && (isOwner(email) || grantsOf(email).some(g => g.role === 'U'));
  };
  /* May sign in at all: Universal, or any role (even one whose place is closed:
     the app then says so, rather than asking them to sign in again). */
  const mayEnter = email => isAdmin(email) || grantsOf(email).length > 0;
  const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

  let keys = null, keysAt = 0;
  async function googleKeys() {
    if (keys && now() - keysAt < 6 * 3600 * 1000) return keys;
    // (certsUrl: only for testing the whole thing locally, with a stand-in Google.)
    const r = await fetchImpl(certsUrl || GOOGLE_KEYS);
    if (!r.ok) throw new Error('Could not reach Google to check the sign-in. Try again.');
    keys = (await r.json()).keys || [];
    keysAt = now();
    return keys;
  }

  const b64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  const json = s => JSON.parse(new TextDecoder().decode(b64(s)));

  /* A Google ID token, checked properly: Google's signature, meant for this
     app, not expired, and the email confirmed by Google. Returns the email. */
  async function verifyGoogle(idToken) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new Error('That sign-in was not valid. Try again.');
    const head = json(parts[0]), body = json(parts[1]);
    if (head.alg !== 'RS256') throw new Error('That sign-in was not valid. Try again.');
    const jwk = (await googleKeys()).find(k => k.kid === head.kid);
    if (!jwk) { keys = null; throw new Error('That sign-in could not be checked. Try again.'); }
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64(parts[2]),
      new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!ok) throw new Error('That sign-in was not valid. Try again.');
    if (GOOGLE_ISSUERS.indexOf(body.iss) < 0) throw new Error('That sign-in was not from Google.');
    if (!clientId || body.aud !== clientId) throw new Error('That sign-in was meant for a different app.');
    if (!(Number(body.exp) * 1000 > now())) throw new Error('That sign-in has expired. Try again.');
    if (!body.email || body.email_verified === false || body.email_verified === 'false') throw new Error('Google has not confirmed that email address.');
    return { email: String(body.email).toLowerCase(), name: String(body.name || '').slice(0, 80) };
  }

  function newToken() {
    const a = new Uint8Array(32); crypto.getRandomValues(a);
    return 'S' + Array.from(a, x => x.toString(16).padStart(2, '0')).join('');
  }

  return {
    /* { idToken } -> a session for an admin; for anyone else, a request
       for the admins to approve ({ pending: true }), or { declined: true }. */
    async signIn(idToken) {
      const who = await verifyGoogle(idToken), email = who.email;
      // Remember Google's name for them; it is their display name until they set one.
      if (who.name) {
        if (exec('SELECT email FROM person WHERE email = ?', email).length) exec('UPDATE person SET googleName = ? WHERE email = ?', who.name, email);
        else if (isOwner(email)) exec('INSERT INTO person (email, name, googleName, addedBy, addedAt) VALUES (?, ?, ?, ?, ?)', email, '', who.name, 'owner', now());
      }
      if (!mayEnter(email)) {
        const had = exec('SELECT status FROM access_request WHERE email = ?', email)[0];
        if (had && had.status === 'declined') return { declined: true, email };
        if (!had) exec('INSERT INTO access_request (email, name, at, status) VALUES (?, ?, ?, ?)', email, who.name || email, now(), 'pending');
        return { pending: true, email, name: who.name };
      }
      const token = newToken(), exp = now() + SESSION_DAYS * DAY;
      exec('INSERT INTO session (token, email, exp, made) VALUES (?, ?, ?, ?)', token, email, exp, now());
      return { session: token, email, expires: new Date(exp).toISOString() };
    },
    /* The admin a session belongs to, or null. Renewed while in use (at most once a day). */
    check(token) {
      if (!token) return null;
      const row = exec('SELECT email, exp FROM session WHERE token = ?', String(token))[0];
      if (!row || Number(row.exp) <= now()) return null;
      if (!mayEnter(String(row.email))) return null;                     // every role taken away
      if (Number(row.exp) - now() < (SESSION_DAYS - 1) * DAY) {
        exec('UPDATE session SET exp = ? WHERE token = ?', now() + SESSION_DAYS * DAY, String(token));
      }
      return String(row.email);
    },
    signOut(token) { exec('DELETE FROM session WHERE token = ?', String(token || '')); },

    /* ---- The Admins panel (for signed-in admins only; see core.js) ---- */
    list(me) {
      return {
        me,
        owners: owners(),
        admins: exec("SELECT g.email, g.addedBy, g.addedAt, p.name, p.googleName FROM grant_ g LEFT JOIN person p ON p.email = g.email WHERE g.role = 'U' ORDER BY g.addedAt").map(r => ({
          email: r.email, name: r.name || r.googleName || r.email, addedBy: r.addedBy, addedAt: new Date(Number(r.addedAt)).toISOString() })),
        requests: exec("SELECT email, name, at FROM access_request WHERE status = 'pending' ORDER BY at").map(r => ({
          email: r.email, name: r.name, at: new Date(Number(r.at)).toISOString() }))
      };
    },
    requestCount() { return Number((exec("SELECT COUNT(*) AS n FROM access_request WHERE status = 'pending'")[0] || {}).n || 0); },
    add(me, email, name) {
      email = String(email || '').trim().toLowerCase();
      if (!EMAIL.test(email)) throw new Error('Enter a full email address, like name@gmail.com.');
      if (isAdmin(email)) throw new Error(email + ' is already an admin.');
      const req = exec('SELECT name FROM access_request WHERE email = ?', email)[0];
      ensurePerson(email, String(name || (req && req.name) || ''), me);
      exec('INSERT INTO grant_ (id, email, role, placeId, addedBy, addedAt) VALUES (?, ?, ?, ?, ?, ?)', 'gU_' + email, email, 'U', '', me, now());
      exec('DELETE FROM access_request WHERE email = ?', email);
      return email;
    },
    decline(email) {
      email = String(email || '').trim().toLowerCase();
      exec("UPDATE access_request SET status = 'declined' WHERE email = ?", email);
      return email;
    },
    remove(me, email) {
      email = String(email || '').trim().toLowerCase();
      if (owners().indexOf(email) >= 0) throw new Error(email + ' is a permanent admin (set in Cloudflare), so cannot be removed here.');
      if (email === String(me || '').toLowerCase()) throw new Error('You cannot remove yourself. Ask another admin.');
      exec("DELETE FROM grant_ WHERE email = ? AND role = 'U'", email);
      if (!mayEnter(email)) exec('DELETE FROM session WHERE email = ?', email);   // signed out everywhere, at once
      return email;
    },
    sweep() { exec('DELETE FROM session WHERE exp <= ?', now()); },

    /* ---- People and roles (b222) ---- */
    isAdmin, isOwner, grantsOf,
    nameOf(email) {
      const p = exec('SELECT name, googleName FROM person WHERE email = ?', String(email || '').toLowerCase())[0];
      return (p && (p.name || p.googleName)) || String(email || '').split('@')[0];
    },
    person(email) {
      email = String(email || '').toLowerCase();
      const p = exec('SELECT name, googleName FROM person WHERE email = ?', email)[0] || { name: '', googleName: '' };
      return { email, name: p.name || p.googleName || email.split('@')[0], googleName: p.googleName, owner: isOwner(email) };
    },
    setName(email, name) {
      email = String(email || '').toLowerCase();
      name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!name) throw new Error('Type the name people know you by.');
      ensurePerson(email, '', 'self');
      exec('UPDATE person SET name = ? WHERE email = ?', name, email);
      return name;
    },
    /* Give a role. The rules (who may give what, where) are checked by the caller. */
    addGrant(me, email, name, role, placeId) {
      email = String(email || '').trim().toLowerCase();
      if (!EMAIL.test(email)) throw new Error('Enter a full email address, like name@gmail.com.');
      if (grantsOf(email).some(g => g.role === role && g.placeId === String(placeId || '')) || (role === 'U' && isOwner(email)))
        throw new Error('They already have that role there.');
      const req = exec('SELECT name FROM access_request WHERE email = ?', email)[0];
      ensurePerson(email, String(name || (req && req.name) || ''), me);
      const id = role === 'U' ? 'gU_' + email : newId();
      exec('INSERT INTO grant_ (id, email, role, placeId, addedBy, addedAt) VALUES (?, ?, ?, ?, ?, ?)', id, email, role, String(placeId || ''), me, now());
      exec('DELETE FROM access_request WHERE email = ?', email);
      return id;
    },
    grantById(id) { return exec('SELECT id, email, role, placeId, addedBy, addedAt FROM grant_ WHERE id = ?', String(id || ''))[0] || null; },
    removeGrant(id) {
      const g = exec('SELECT email FROM grant_ WHERE id = ?', String(id || ''))[0];
      exec('DELETE FROM grant_ WHERE id = ?', String(id || ''));
      if (g && !mayEnter(g.email)) exec('DELETE FROM session WHERE email = ?', g.email);   // nothing left: signed out at once
    },
    allGrants() {
      return exec('SELECT g.id, g.email, g.role, g.placeId, g.addedBy, g.addedAt, p.name, p.googleName FROM grant_ g LEFT JOIN person p ON p.email = g.email ORDER BY g.addedAt');
    },
    requests() {
      return exec("SELECT email, name, at FROM access_request WHERE status = 'pending' ORDER BY at").map(r => ({
        email: r.email, name: r.name, at: new Date(Number(r.at)).toISOString() }));
    }
  };
  function ensurePerson(email, name, by) {
    if (exec('SELECT email FROM person WHERE email = ?', email).length) {
      if (name) exec("UPDATE person SET name = ? WHERE email = ? AND name = ''", String(name).slice(0, 40), email);
      return;
    }
    exec('INSERT INTO person (email, name, googleName, addedBy, addedAt) VALUES (?, ?, ?, ?, ?)', email, String(name || '').slice(0, 40), '', by, now());
  }
  function newId() {
    const a = new Uint8Array(8); crypto.getRandomValues(a);
    return 'g' + Array.from(a, x => x.toString(16).padStart(2, '0')).join('');
  }
}
