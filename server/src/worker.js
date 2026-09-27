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

export class TbsServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.srv = makeServer({
      exec: (sql, ...params) => ctx.storage.sql.exec(sql, ...params).toArray(),
      timeZone: env.TIME_ZONE || 'UTC',
      fetchImpl: (url) => fetch(url)
    });
  }

  async fetch(request) {
    let e;
    if (request.method === 'POST') e = { postData: { contents: await request.text() } };
    else e = { parameter: Object.fromEntries(new URL(request.url).searchParams) };

    await this.srv.warm();                       // rates in hand before the rules ask
    const text = this.srv.answer(e);             // the whole request, start to finish
    // Anything the rules wanted from the web and did not have: fetched now, for next time.
    this.ctx.waitUntil(this.srv.fetchWanted());
    // The hourly housekeeping, set going on the first request.
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + HOUR);
    return new Response(text, { headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
  }

  async alarm() {
    await this.srv.warm();
    this.srv.housekeeping();
    await this.srv.fetchWanted();                // e.g. historical rates for a closed region
    this.srv.housekeeping();                     // ...used straight away
    await this.ctx.storage.setAlarm(Date.now() + HOUR);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    return env.TBS.get(env.TBS.idFromName('main')).fetch(request);
  }
};
