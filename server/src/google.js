/* Stand-ins for the Google services Code.gs calls, on Cloudflare.

   Only what the app's rules need while answering a request:
     - Utilities: ids, and dates written out;
     - ContentService: how a reply is handed back;
     - LockService: one request at a time is already guaranteed — a Durable
       Object handles its requests one after another — so the lock is a no-op;
     - UrlFetchApp: exchange rates. Code.gs asks for them synchronously, which
       Cloudflare cannot do, so answers are served from what the server fetched
       earlier (see `web` below and worker.js), and anything not fetched yet is
       noted, fetched after the reply, and there for next time. Until then the
       rules treat the source as unreachable, exactly as they do when Google
       cannot reach it: the rates cached for six hours, or the built-in ones.
     - SpreadsheetApp, DriveApp, ScriptApp: spreadsheets are still made by
       Google, so nothing here builds one (REPORTS_HERE_ is false). Anything
       that reaches for them anyway fails loudly rather than quietly doing
       nothing. */

export function makeGoogle({ store, kv, web, timeZone, uuid }) {
  const notHere = what => () => { throw new Error(what + ' is not available on this server — the spreadsheets are made by Google.'); };
  const pad = (n, w) => String(n).padStart(w || 2, '0');

  /* Utilities.formatDate(date, timeZone, pattern) for the patterns Code.gs
     uses: yyyy MM M dd d HH mm ss, in the given time zone. */
  function formatDate(d, tz, fmt) {
    const parts = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
      .formatToParts(d).forEach(p => { parts[p.type] = p.value; });
    return String(fmt).replace(/yyyy|MM|M|dd|d|HH|mm|ss/g, t => ({
      yyyy: parts.year, MM: pad(parts.month), M: String(Number(parts.month)), dd: pad(parts.day),
      d: String(Number(parts.day)), HH: pad(parts.hour), mm: pad(parts.minute), ss: pad(parts.second) }[t]));
  }

  return {
    store, kv,
    Utilities: {
      getUuid: uuid || (() => crypto.randomUUID()),
      sleep: () => {},
      formatDate,
      formatString: f => f
    },
    ContentService: {
      MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
      createTextOutput: text => {
        const out = { setMimeType: () => out, getContent: () => String(text) };
        return out;
      }
    },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, tryLock: () => true, releaseLock: () => {}, hasLock: () => true })
    },
    Session: {
      getScriptTimeZone: () => timeZone || 'UTC',
      getActiveUser: () => ({ getEmail: () => '' })
    },
    UrlFetchApp: {
      fetch: url => {
        const hit = web.get(String(url));
        if (!hit) web.wanted.add(String(url));
        return { getResponseCode: () => (hit ? hit.code : 503), getContentText: () => (hit ? hit.text : '') };
      }
    },
    Logger: { log: (...a) => console.log(...a) },
    SpreadsheetApp: new Proxy({}, { get: (_, k) => (k === 'BorderStyle' ? {} : notHere('SpreadsheetApp.' + String(k))) }),
    DriveApp: new Proxy({}, { get: (_, k) => notHere('DriveApp.' + String(k)) }),
    ScriptApp: new Proxy({}, { get: (_, k) => notHere('ScriptApp.' + String(k)) }),
    PropertiesService: new Proxy({}, { get: (_, k) => notHere('PropertiesService.' + String(k)) }),
    CacheService: new Proxy({}, { get: (_, k) => notHere('CacheService.' + String(k)) })
  };
}

/* What the server has fetched from the web, for UrlFetchApp above: kept in
   memory and in the database, so it survives the server being restarted. */
export function makeWebCache(kv, maxAgeMs) {
  const mem = new Map();
  const wanted = new Set();
  return {
    wanted,
    get(url) {
      let hit = mem.get(url);
      if (!hit) {
        const raw = kv.getTemp('web:' + url);
        if (raw) { try { hit = JSON.parse(raw); mem.set(url, hit); } catch (e) {} }
      }
      if (hit && Date.now() - hit.at > maxAgeMs) return null;
      return hit || null;
    },
    put(url, code, text) {
      const hit = { code, text, at: Date.now() };
      mem.set(url, hit);
      kv.putTemp('web:' + url, JSON.stringify(hit), 21600);
    }
  };
}
