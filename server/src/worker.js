/* Transcendental Book Sales on Cloudflare (Phase 2).

   Every request goes to ONE Durable Object, "main". It holds the records in
   its own SQLite database and answers requests one at a time, so two phones
   saving at once can never tread on each other — the job Google's script lock
   did, without the queue. The app talks to it exactly as it talked to Apps
   Script: a POST whose body is the request, a JSON reply. */
import { DurableObject } from 'cloudflare:workers';
import { makeServer } from './core.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const HOUR = 3600 * 1000;
// Open sockets allowed at once. The tour has a few dozen phones; this is only a
// ceiling against something opening thousands (the oldest are closed first).
const MAX_SOCKETS = 400;

export class TbsServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keep-alives answered by Cloudflare, without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.srv = makeServer({
      exec: (sql, ...params) => ctx.storage.sql.exec(sql, ...params).toArray(),
      timeZone: env.TIME_ZONE || 'UTC',
      fetchImpl: (url, init) => fetch(url, init),
      googleClientId: env.GOOGLE_CLIENT_ID || '',
      adminEmails: env.ADMIN_EMAILS || '',
      googleCertsUrl: env.GOOGLE_CERTS_URL || '',    // never set in production
      // Google's side, which still builds the spreadsheets (see core.js, the bridge).
      reportUrl: env.REPORT_URL || '',
      reportSecret: env.REPORT_SECRET || ''
    });
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') === 'websocket') return this.openLive();
    let e;
    if (request.method === 'POST') e = { postData: { contents: await request.text() } };
    else e = { parameter: Object.fromEntries(new URL(request.url).searchParams) };

    await this.srv.warm();                       // rates in hand before the rules ask
    const text = await this.srv.request(e);      // sign-in check, then the whole request
    // Anything the rules wanted from the web and did not have: fetched now, for next time.
    this.ctx.waitUntil(this.srv.fetchWanted());
    this.tellPhones();                            // a save: every open app hears at once
    // The hourly housekeeping, set going on the first request.
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + HOUR);
    return new Response(text, { headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
  }

  async alarm() {
    await this.srv.warm();
    this.srv.housekeeping();
    await this.srv.fetchWanted();                // e.g. historical rates for a closed region
    this.srv.housekeeping();                     // ...used straight away
    this.tellPhones();
    await this.ctx.storage.setAlarm(Date.now() + HOUR);
  }

  /* A phone opens its live line: it is told the revision straight away, so a
     phone that was asleep catches up the moment it wakes. */
  openLive() {
    const open = this.ctx.getWebSockets();
    for (let i = 0; i <= open.length - MAX_SOCKETS; i++) { try { open[i].close(1013, 'Too many'); } catch (e) {} }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    try { pair[1].send(JSON.stringify({ rev: this.srv.rev() })); } catch (e) {}
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  /* Send the revision to every open app, but only when it has changed. */
  tellPhones() {
    let rev;
    try { rev = this.srv.rev(); } catch (e) { return; }
    if (rev === this.lastTold) return;
    this.lastTold = rev;
    const msg = JSON.stringify({ rev });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch (e) {} }
  }
  // A phone asking outright (it does so when it wakes): the current number.
  webSocketMessage(ws, msg) {
    if (msg === 'rev') { try { ws.send(JSON.stringify({ rev: this.srv.rev() })); } catch (e) {} }
  }
  webSocketClose(ws) { try { ws.close(); } catch (e) {} }
  webSocketError() {}
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    return env.TBS.get(env.TBS.idFromName('main')).fetch(request);
  }
};
