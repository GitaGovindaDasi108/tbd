# Tests

No framework, no dependencies. Plain Node against the two source files.

```
node test/run-all.js
```

Checks that `index.html` and `Code.gs` parse, then runs every regression
script. Exits non-zero if anything fails, so it can gate a commit.

Run one on its own to read its output:

```
node test/simtest.js
```

## The two harnesses

**`mini.js`** — a stand-in for Apps Script: `SpreadsheetApp`, `DriveApp`,
`CacheService`, `PropertiesService`, `LockService`, `Utilities`. It loads the
real `Code.gs` and runs it.

```js
const m = require('./mini.js');
m.init();                                   // build the sheets
const st = m.call({ action: 'getState' }).state;
m.call({ action: 'sell', location: st.regions[0].whLoc, bookId: 'sr_en',
         legs: [{ type: 'Cash', cur: 'PLN', amt: 150 }], override: true });
m.sync(true);                               // rebuild the visible sheets
```

**`clientsim.js`** — loads the app's JavaScript out of `index.html` with a mock
DOM, and exposes its functions on `T`.

```js
const { T, store } = require('./clientsim.js');
T.setUp(stateObject);                       // pretend the server answered
T.goTo('region', 'it');
T.cashModal();
console.log(store['#modal'].innerHTML);     // what the user would see
```

Both find the source files at the repo root, or beside themselves. Override
with `TBS_APP=/path/to/index.html` and `TBS_CODE=/path/to/Code.gs`.

To drive the app against the real server logic in one process, point the app's
`fetch` at `mini.js` — see `verify.js` for the pattern.

## Traps

These have each cost a debugging session. A failing test here is as likely to
be the harness as the app.

- **Mock elements persist between dialogs.** A real browser builds new elements
  each time a dialog opens, so its listeners are fresh. Here they stack, and a
  button appears to fire several times. Clear `store['#id']._ev` between opens.
- **Don't clear `#modal`'s own listeners.** The app records what it has bound
  (`onModal`) and will not rebind, so the handler silently disappears.
- **`document.querySelectorAll` is stubbed narrowly.** It returns fixtures for a
  few selectors only. Extend it rather than assuming a query works.
- **`navigator` is read-only in Node.** `global.navigator = …` is ignored;
  use `Object.defineProperty(globalThis, 'navigator', { … })`.
- **Renderers write into `#modal .m-body`,** which is a different mock element
  from `#modal`. Read the one that was actually written to.

## Adding a test

Copy the shape of `bundle.js`: build a state, act, then print
`PASS`/`FAIL` lines. The runner counts `PASS`, `FAIL`, `: true` and `: false`,
so either style works. Add the filename to `SCRIPTS` in `run-all.js`.
