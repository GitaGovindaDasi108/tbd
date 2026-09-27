/* A brand-new spreadsheet starts empty (b197): the book catalogue and one
   season to put things in — no region, no "Poland", no contacts, no payment
   codes. Those used to be seeded from the app's Poland-only beginnings. */
const m = require(__dirname + '/mini.js');
m.initBare();
const st = m.call({ action: 'getState' }).state;
const t = [];
t.push(['no region', (st.regions || []).length === 0]);
t.push(['no contacts', (st.org || []).length === 0]);
t.push(['no payment codes', (st.qr || []).length === 0]);
t.push(['nothing called Poland anywhere', !/Poland/.test(JSON.stringify(st))]);
t.push(['one season, neutrally named', (st.seasons || []).length === 1 && st.seasonName === 'First Season']);
t.push(['the book catalogue is there', (st.books || []).length >= 9]);
const r = m.call({ action: 'createRegion', name: 'Kolkata', currencies: 'INR,USD' });
t.push(['the first region is made in the app', r.ok && m.call({ action: 'getState' }).state.regions.length === 1]);
t.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL'), n));
