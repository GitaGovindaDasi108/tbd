/* Wording saved with the pencil is built into the app (b201). The saved copies
   of exactly that wording are retired on the first save after deploying, so
   the code is the reference; anything reworded since is kept. */
const m = require(__dirname + '/mini.js');
m.init();
const t = [];
const st = m.call({ action: 'getState' }).state, SA = st.activeSeason, W = st.regions[0].whLoc, B = st.books[0].id;
// As they were saved on the live app (written straight in, as an older build left them).
const tb = () => m.sheet('_labels');
m.run("dbCreate_('_labels', ['key','text'])");
tb().grid.push(['Panel: Active Sales Log › Active Sales Log', 'Sales Log']);          // built in
tb().grid.push(['Dialog › Whole region', 'Region Link']);                              // built in
tb().grid.push(['Dialog › Sellers', 'Seller Link (changed since)']);                   // reworded after
tb().grid.push(['Panel: App Admin › Something new', 'My own words']);                  // not ours
m.clear();
t.push(['(four saved rewordings)', Object.keys(m.call({ action: 'getState' }).state.labels).length === 4]);
m.call({ action: 'setStockBulk', season: SA, location: W, items: [{ bookId: B, qty: 3 }], override: true });
const left = m.call({ action: 'getState' }).state.labels;
t.push(['wording now in the app is no longer stored', !('Panel: Active Sales Log › Active Sales Log' in left) && !('Dialog › Whole region' in left)]);
t.push(['wording changed since, or never built in, is kept', left['Dialog › Sellers'] === 'Seller Link (changed since)' && left['Panel: App Admin › Something new'] === 'My own words']);
m.call({ action: 'setStockBulk', season: SA, location: W, items: [{ bookId: B, qty: 4 }], override: true });
t.push(['done once', Object.keys(m.call({ action: 'getState' }).state.labels).length === 2]);
t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
