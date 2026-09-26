# Hare Krishna Europe Tour — Book Sales Tracker

Handover notes. Current build: **b182**.

Live app: https://gitagovindadasi108.github.io/tbd/

---

## What it is

A multi-user book-distribution tracker for a travelling book-distribution tour.
Coordinators and sellers record sales, stock, cash and consignment across
several regions and events, in several currencies, over multiple seasons.

Two files, no build step:

| File | Role |
|---|---|
| `index.html` | The entire app — markup, CSS and JS in one file. Served from GitHub Pages. |
| `Code.gs` | Google Apps Script backend. Hidden sheets in a Google Spreadsheet are the database. |

There is no framework, no bundler, no npm install. Edit the two files directly.

### Deploying

1. Paste `Code.gs` into the Apps Script project.
2. **Deploy → Manage deployments → ✏️ → Version: New version → Deploy.**
   Pasting alone does nothing: the web app keeps serving the last deployed
   version. This has caused several phantom bug reports.
3. Push `index.html` to the repo; hard-refresh the page.
4. Run `initialize` in Apps Script after any change that adds a sheet or column.

`SERVER_BUILD` in `Code.gs` and the build tag in `index.html` should match. The
server reports its build in the state payload (not shown in the UI any more) —
useful when a bug refuses to go away.

---

## Architecture

### Client

- **Optimistic local writes.** `commit(payload, apply, okMsg, opts)` applies a
  change to local state immediately, renders, and sends in the background.
  `commitSync()` awaits the server — used only where the answer is needed.
- **`BASE` / `OPS` / `STATE`.** `BASE` is the last server state, `OPS` is the
  list of un-retired local changes, `STATE = derive()` is `BASE` with `OPS`
  applied. Renderers read `STATE` only.
- **Outbox.** Every save is written to `localStorage` before sending, sent one
  at a time in order (`sendInOrder`), and recovered on page open. A save that
  cannot be sent goes to `PENDING` and retries.
- **Polling.** `pull()` fetches state on a timer and after saves.

### Server

- Sheets prefixed `_` are the database (`_sales`, `_events`, `_regions`,
  `_cash`, `_change`, `_costs`, `_payouts`, `_labels`, `_meta`, …).
- Visible generated sheets are rebuilt by `syncSheets()`; a time trigger runs
  `syncEverySeason_()`.
- Writes take a script lock; reads do not.
- `rememberOp_(opId, reply)` caches replies for 6 hours so a re-sent save is
  recognised rather than applied twice.

---

## Conventions that matter

These were each learned from a real bug. Breaking them reintroduces it.

**The app names records; the server adopts the name.**
Sales, bundles, events, regions, cash movements, stock movements, payouts and
change entries are all named client-side and sent with the request. This is what
makes the UI instant and makes resends safe.

**Deleted things stay deleted.**
`tombstone_(id)` records deliberate deletions; `isDeleted_(id)` blocks
re-creation. Without it, a save re-sent after a delete resurrected the record.
The `_rebuilding` flag suppresses this during an edit, which deletes and rewrites
its own members under the same ids.

**Never assume a save failed.**
On a timeout or unreadable reply the app asks the server
(`action: 'opStatus'`, parameter `checkOp`) whether that save landed, before
reporting failure or queueing. The parameter is deliberately *not* `opId` —
using that name made the request look like a repeat of the save itself.

**Discard stale replies.**
`pull()` records the season it asked about and a `SEASON_EPOCH`; a reply that no
longer matches is dropped. Without this, a refresh in flight during a season
switch dragged the user back.

**Per-tab state.**
Position and season live in `sessionStorage` (per tab); `localStorage` holds only
a starting point for a new tab. The shared quick-cache (`cacheLoad`) is skipped
when it belongs to a different season than this tab's.

**Loading is not empty.**
A season opening as a shell has `loading: true`; position-recovery must not
conclude the user's region is gone.

**Validate before destroying.**
Bundle edits check stock *before* deleting the original, and `restoreSales_`
re-deducts stock when putting a failed edit back. The original bug invented
inventory on every failed attempt.

---

## Domain concepts worth knowing

**Seasons.** Everything is scoped to a season. Each request carries its own
`season` parameter; `setSeasonContext_()` applies it. Never rely on a stored
"current season" for a read.

**Levels.** `CUR_LEVEL` is `season` | `region` | `event`; `CUR_REGION` and
`CUR_LOC` locate the user. Most renderers behave differently at each level.

**Cash vs change.** Change (float) lent to a place is tracked in `_change`,
never counted in `cashBalance()`, and shown separately as
`Change: +10 € = 210 € Total`. Moving cash can carry change with it
(`changeAmt`, `changeIds` on the movement); deleting such a movement restores
the change record.

**Consignment.** Books with a `partnerId` belong to a group, not the tour. Their
money is held for the group: excluded from the tour's own totals, shown as its
own subtraction (`Gross → −Consignment → −Costs → Net`), and confined to the
region that took them on.

**Dollars received.** A sale may carry `usdActual` — what actually landed for a
digital payment. Local-currency totals never change; the USD column swaps that
sale's converted estimate for the real figure. See `usdEst` / `usdAct` in
`renderPayments` and `saleUsd()`. The adjustment must follow *whose book it is*
for consignment, not the place grouping.

**Editable wording.** Any label matching `EDIT_SEL` can be rewritten in-app and
is stored in `_labels`, keyed by `normLabelKey()` — location plus original
words, with the varying part of a heading stripped so "Edit region" and
"New region" share one entry. `**bold**` and newlines are supported. A label is
replaced *whole*; keying on a fragment showed both versions at once.

---

## Testing

There is no test framework. Everything lives in `test/` — plain Node, no
install. See `test/README.md`.

| Harness | What it is |
|---|---|
| `test/mini.js` | A fake Apps Script environment (SpreadsheetApp, DriveApp, CacheService…). `require` it, call `m.init()`, then `call({action: …})` against the real `Code.gs`. |
| `test/clientsim.js` | Loads the app's JS with a mock DOM. `T.setUp(state)`, `T.goTo(...)`, then call app functions and inspect `store['#id'].innerHTML`. |

`node test/run-all.js` checks both files parse and runs every regression
script (`simtest`, `bundle`, `chg2`, `verify`, `stale`, `createtest`,
`dutchtest`, `reptest`, `payusd`).

`node test/browser-buttons.js`, `browser-addstock.js`, `browser-transit.js`, `browser-transfer.js` and `browser-speed.js` are optional:
they drive the real app in Chromium (Playwright), with every Apps Script request
answered by `mini.js`. Screenshots land in the system temp folder.

Before publishing, always: run `test/run-all.js`, run `m.sync(true)` to confirm
sheets still render.

**Harness caveats that have wasted time:** mock elements persist between
dialogs (real browsers create new ones), `document.querySelectorAll` is stubbed
narrowly, and Node's `navigator` is read-only — override it with
`Object.defineProperty`. Several "bugs" have turned out to be the harness.

---

## Done in b177

- **Button wording is editable.** Plain-text buttons get a pencil in Edit
  wording mode. A capture-phase click listener answers the pencil before the
  button hears the click. Buttons with icon/badge elements, symbol-only
  buttons and anything inside `.no-edit` are skipped.
- **Dollars received in dropdowns.** The per-place, Donations and Consignment
  lines inside a payment type's dropdown now use `usdActual` too (`usdAdj` in
  `renderPayments`), so they add up to the row above. Covered by
  `test/payusd.js`.

## Done in b178 — Stock protocol, part 1: Add Stock

- **One "＋ Add Stock" button** on every page (admin, and regional links), in
  place of "Add / subtract stock" and "Books coming from outside the tour".
  Sales links do not get it.
- **Destination picker** (`stockPlaces`, `placePickerHTML`/`bindPlacePicker`):
  searchable, indented season › region › event; closed places left out; a
  regional link sees only its region. Reused for Transfer in part 2.
- **Another season** works: `stockCtxFor` fetches that season's state, writes
  carry `season`, and nothing is applied locally (its cache is dropped instead).
- **Already at the destination** = the old adjust-stock table, plus a warning
  (on screen and a confirm) whenever a count goes down.
- **Not there yet** = a batch in transit (`sendShipment` from `OUTSIDE`). The
  app now names the batch (`shipId`), and it records `toLoc`, so a batch can be
  aimed at an event; "Mark as arrived" defaults there. The `toLoc` column is
  added on first use — no need to re-run initialize.
- **Other Books** switches a title on for the region via the new
  `regionAddBooks` action (regional links allowed, own region only).
  **My Book Is Not Listed** (admin only) is the Edit-region add-a-title.
- **Add something new** (Season / Region / Event), reached from "Can't find
  your destination?". `regionModal(edit, after)` and `eventModal(edit, after)`
  take a callback so the user is brought back to Add Stock with it chosen.
- Phone layout: the five-column stock table now fits a 390px screen.

## Done in b179 — Books in Transit on the main screen

- A **Books in Transit** section sits with Pending Payments / Pre-Orders
  (`transitHere`, `shipCardHTML`): every batch at the season, the region's
  incoming and outgoing batches, or the batches aimed at an event.
- **Full Delivery Arrived** (`shipArriveAll`) confirms, then receives
  everything to `shipLandsAt(x)` (its `toLoc`, else the warehouse).
  **Partial Delivery Arrived** is the old receive dialog, renamed.
- Regional links see their own region's batches (the server now filters
  `shipments` and includes the batches' inventory in a link's state) and may
  `receiveShipment` for their region only. Edit / Correct / Delete stay admin.

## Done in b180 — no waiting

- Picking a place in another season uses that season's copy saved on the
  device (`seasonCacheLoad`) and refreshes it behind the form
  (`refreshCounts` updates counts in place). Only "Already at the destination"
  Save waits for the fresh counts ("Checking counts…").
- "Add something new" no longer awaits `switchSeason`; the region/event dialog
  opens at once. Creating a season still waits for the server and says so.
- `prefetchSeasons` now waits until the season list has arrived; before, on a
  fresh device it found no seasons and fetched nothing.
- Place finder: a late close from an earlier blur no longer shuts the list
  when you tap straight back in.
- `test/browser-speed.js` checks each step with a 2-second server delay.

## Done in b181 — Stock protocol, part 2: Transfer Existing Stock

- One **⇄ Transfer Existing Stock** button (admin and regional links) replaces
  Transfer to event / Transfer in / Return to warehouse / Transfer to region /
  Hand stock to another season. `transferStockModal`, `transferKind`.
- Kinds: `event` (warehouse or event → event), `store` (event → its
  warehouse: one destination, or split between sub-warehouses, new ones
  created on the spot via `saveHolder` with an app-named `newHolderId`),
  `region` and `season` (arrive immediately, or travel as a shipment).
- **Sub-warehouses = devotee storage (`holders`)**, numbered SW1, SW2… in the
  region's own order (`swLabel`), each with a fixed tint (`SW_TINTS`). A
  warehouse whose books sit in sub-warehouses shows one Avail/Move pair per
  shelf. On a phone (≤560px) those tables become one card per title.
- Server: new `transferMulti` (many legs, all-or-nothing); `sendShipment`
  items may carry their own `fromLoc`; regional links may `transferMulti` and
  `saveHolder` within their region only.
- Warehouse cards count sub-warehouse stock in, with SW bubbles (tap = name
  and WhatsApp). Selling when the shelf itself has none asks which
  sub-warehouse (`sellFromWarehouse`) and records the sale there.
- Confirmations: "Transfer everything" alerts the count reminder; Transfer
  confirms the leaving message for the kind plus "Are you sure you have
  counted everything correctly?" in one pop-up.

Closed in b182: "Multiple Books" at a warehouse asks which sub-warehouse a
short title comes from (moves it to the shelf with `transferMulti`, then sells);
deleting or correcting a shipment returns copies to the shelves they left
(`shipReturnPlan_`, read from the movement record), the warehouse shelf only as
a fallback. Also: side-by-side boxes (`.row2`) no longer overflow a dialog.

## Still to do (agreed plan)

3. **One activity log** for everything. Decided: "Delete" on an entry undoes
   the action where that is safe; entries that cannot be undone have no Delete.

## Open items

1. **Scale.** Google Sheets is the ceiling: writes are serialised behind a
   script lock (~1–2 s each) and a read rebuilds state from ~25 sheet reads.
   Fine for a handful of concurrent users; it will not hold for a dozen sellers
   at once. The recommended move is Firestore — the entire UI and all the rules
   carry over; only the storage layer changes.

---

## Working style

- Diagnose before changing: reproduce the reported behaviour in a harness first.
  Several reports have been the harness, the deployment, or a fix of mine from
  two builds earlier.
- One build number per change set, bumped in both files.
- Say plainly what was *not* done. Half-finished work shipped as complete has
  cost more time than anything else here.
- Comments explain *why*, especially where a line exists to prevent a specific
  past bug.
- **The owner is not a coder.** Explain everything in plain language, say what
  they need to do (and what they don't), and define any technical word you
  can't avoid.
