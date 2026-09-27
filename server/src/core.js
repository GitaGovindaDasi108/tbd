/* The server, without Cloudflare: Code.gs on a SQLite database.

   worker.js puts this inside a Durable Object; the tests run it on Node's own
   SQLite. Either way one request is answered completely before the next
   starts, which is what the script lock did on Google. */
import { makeApp, CODE_BUILD } from './app.gen.js';
import { makeSqlStore } from './sqlstore.js';
import { makeGoogle, makeWebCache } from './google.js';

// Where the exchange rates come from (the first source Code.gs tries).
export const RATES_URL = 'https://open.er-api.com/v6/latest/USD';

export function makeServer({ exec, timeZone, fetchImpl, uuid }) {
  const { store, kv, forget, dump } = makeSqlStore(exec);
  const web = makeWebCache(kv, 6 * 3600 * 1000);
  const app = makeApp(Object.assign(makeGoogle({ store, kv, web, timeZone, uuid }), { reportsHere: false }));

  /* One request, as Apps Script hands it to doPost/doGet: a POST's body, or a
     GET's parameters. Returns the reply text. */
  function answer(e) { return app.handle(e).getContent(); }

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
  }
  return { answer, warm, fetchWanted, housekeeping, kv, store, forget, dump, build: CODE_BUILD, web, app };
}
