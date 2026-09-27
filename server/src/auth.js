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
   the admin list, ends theirs at once. */

const DAY = 24 * 3600 * 1000;
export const SESSION_DAYS = 90;
const GOOGLE_KEYS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

export function makeAuth({ exec, clientId, adminEmails, fetchImpl, now, certsUrl }) {
  now = now || (() => Date.now());
  exec('CREATE TABLE IF NOT EXISTS session (token TEXT PRIMARY KEY, email TEXT NOT NULL, exp INTEGER NOT NULL, made INTEGER NOT NULL)');
  const admins = () => String(adminEmails || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

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
    return String(body.email).toLowerCase();
  }

  function newToken() {
    const a = new Uint8Array(32); crypto.getRandomValues(a);
    return 'S' + Array.from(a, x => x.toString(16).padStart(2, '0')).join('');
  }

  return {
    /* { idToken } -> a session for an admin. */
    async signIn(idToken) {
      const email = await verifyGoogle(idToken);
      if (admins().indexOf(email) < 0) throw new Error(email + ' is not on the list of admins for this app.');
      const token = newToken(), exp = now() + SESSION_DAYS * DAY;
      exec('INSERT INTO session (token, email, exp, made) VALUES (?, ?, ?, ?)', token, email, exp, now());
      return { session: token, email, expires: new Date(exp).toISOString() };
    },
    /* The admin a session belongs to, or null. Renewed while in use (at most once a day). */
    check(token) {
      if (!token) return null;
      const row = exec('SELECT email, exp FROM session WHERE token = ?', String(token))[0];
      if (!row || Number(row.exp) <= now()) return null;
      if (admins().indexOf(String(row.email)) < 0) return null;            // taken off the list
      if (Number(row.exp) - now() < (SESSION_DAYS - 1) * DAY) {
        exec('UPDATE session SET exp = ? WHERE token = ?', now() + SESSION_DAYS * DAY, String(token));
      }
      return String(row.email);
    },
    signOut(token) { exec('DELETE FROM session WHERE token = ?', String(token || '')); },
    sweep() { exec('DELETE FROM session WHERE exp <= ?', now()); }
  };
}
