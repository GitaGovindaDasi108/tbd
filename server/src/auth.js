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
  const owners = () => String(adminEmails || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const isAdmin = email => {
    email = String(email || '').toLowerCase();
    return !!email && (owners().indexOf(email) >= 0 || exec('SELECT email FROM admin WHERE email = ?', email).length > 0);
  };
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
      if (!isAdmin(email)) {
        const had = exec('SELECT status FROM access_request WHERE email = ?', email)[0];
        if (had && had.status === 'declined') return { declined: true, email };
        if (!had) exec('INSERT INTO access_request (email, name, at, status) VALUES (?, ?, ?, ?)', email, who.name || email, now(), 'pending');
        return { pending: true, email, name: who.name };
      }
      // A name to show in the Admins list, once known.
      if (who.name) exec('UPDATE admin SET name = ? WHERE email = ? AND name = email', who.name, email);
      const token = newToken(), exp = now() + SESSION_DAYS * DAY;
      exec('INSERT INTO session (token, email, exp, made) VALUES (?, ?, ?, ?)', token, email, exp, now());
      return { session: token, email, expires: new Date(exp).toISOString() };
    },
    /* The admin a session belongs to, or null. Renewed while in use (at most once a day). */
    check(token) {
      if (!token) return null;
      const row = exec('SELECT email, exp FROM session WHERE token = ?', String(token))[0];
      if (!row || Number(row.exp) <= now()) return null;
      if (!isAdmin(String(row.email))) return null;                       // taken off the list
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
        admins: exec('SELECT email, name, addedBy, addedAt FROM admin ORDER BY addedAt').map(r => ({
          email: r.email, name: r.name, addedBy: r.addedBy, addedAt: new Date(Number(r.addedAt)).toISOString() })),
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
      exec('INSERT INTO admin (email, name, addedBy, addedAt) VALUES (?, ?, ?, ?)',
           email, String(name || (req && req.name) || email).slice(0, 80), me, now());
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
      exec('DELETE FROM admin WHERE email = ?', email);
      exec('DELETE FROM session WHERE email = ?', email);          // signed out everywhere, at once
      return email;
    },
    sweep() { exec('DELETE FROM session WHERE exp <= ?', now()); }
  };
}
