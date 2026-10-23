# Hare Krishna Europe Tour — Book Sales Tracker

Tracker: what was built, build by build, and how it works (was HANDOVER.md). Current build: **b300**.

Live app: https://gitagovindadasi108.github.io/tbd/

---

## What it is

A multi-user book-distribution tracker for a traveling book-distribution tour.
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

Since b237 the page and the server have their own build numbers. Bump
`SERVER_BUILD` in `Code.gs` only when Code.gs or server/ changes (a merge that
changes them deploys the server by itself, `.github/workflows/deploy-server.yml`).
Bump `NEEDS_SERVER` in `index.html` only when the page starts relying on new
server code. The server reports its build in the state payload (not shown in the UI any more) —
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
- **Every read and write of those records goes through the data store**
  (section `DATA STORE` in `Code.gs`, since b192). The rest of the file sees
  rows as plain objects:

  | Call | Does |
  |---|---|
  | `objectsOf_(t)` | every row of table `t`, in stored order (`[]` if it doesn't exist yet) |
  | `dbInsert_(t, rows)` | append one row or several, by column name |
  | `dbUpdate_(t, match, set)` | change fields on the matching rows only |
  | `dbDelete_(t, match)` | remove the matching rows only |
  | `dbSave_(t, rows, cols)` | make the table hold exactly these rows (writes only what differs) |
  | `dbCreate_` / `dbAddCols_` / `dbHas_` / `dbCols_` | tables and columns |
  | `propGet_` / `propSet_` / `propDel_` / `propAll_` | lasting settings (revision, redraw queue, deleted ids, close drafts) |
  | `tempGet_` / `tempPut_` / `tempDel_` | short-lived memory (saves already done, state snapshot, FX) |

  `match` is `{ column: value }` or a function. `firstOnly_` / `lastOnly_`
  keep the old behaviour where code changed only one of several rows sharing
  an id. Underneath, two small objects, `STORE_` (tables) and `KV_`
  (properties and cache), are the **only** code that knows about Google
  Sheets. Moving the data to a database means writing another `STORE_` and
  `KV_`; `test/memstore.js` is a working example that keeps everything in
  memory. `test/seam.js` fails if anything else starts touching the sheets,
  properties or cache directly.
- Visible generated sheets (the reports) are rebuilt by `syncSheets()`; a
  time trigger runs `syncEverySeason_()`. They read their data through the
  store too, and are the one other place that uses Sheets and Drive.
- Writes take a script lock; reads do not.
- `rememberOp_(opId, reply)` caches replies for 6 hours so a re-sent save is
  recognized rather than applied twice.

---

## Conventions that matter

These were each learned from a real bug. Breaking them reintroduces it.

**The app names records; the server adopts the name.**
Sales, bundles, events, regions, cash movements, stock movements, payouts and
change entries are all named client-side and sent with the request. This is what
makes the UI instant and makes resends safe.

**There is no default warehouse.**
Every region has its own warehouse and none is "the" warehouse. The first
region's warehouse still has the id `WAREHOUSE` (so its old data stays valid),
but nothing may treat that id as a default: pre-orders are held against their
own region's warehouse (`reservedMap_`, `reservedQty`), a place is never
filled in when a request leaves it out (`placeOf_`), and names come from the
region, never from the old `warehouseName` setting. A new device starts at the
season, not in a region. Learned from "Copies would have to come from outside
Poland" on another region's pre-order (b194).

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
`dutchtest`, `reptest`, `payusd`, `seam`), then replays every recorded
session with the records in sheets and in memory and requires identical
results.

**Golden replay** (`test/golden.js`, since b192). `test/corpus/` holds real
request sessions recorded from the tests (`TBS_RECORD=file` in `mini.js`).
`node test/golden.js` replays each one against git `HEAD` and the working
copy, with the same clock, and compares every reply and every data sheet
after every request, then the readable spreadsheets. It prints the first
difference. Use it for any change that should not change behaviour —
especially anything touching storage. `--base=<rev>` compares against another
revision; `--store=memory` runs the working copy with its records in memory.
`test/corpus-extra.js` produced `extra.jsonl`, which drives the save actions
the browser tests never reach; re-record it (and the others) when an action
deliberately changes.

`node test/browser-buttons.js`, `browser-fold.js`, `browser-hq.js`, `browser-addstock.js`, `browser-transit.js`, `browser-transfer.js`, `browser-activity.js`, `browser-round2.js`, `browser-speed.js`, `browser-search.js`, `browser-preunlisted.js`, `browser-bookorder.js` and `browser-lang.js` are optional:
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

## Done in b183 — Stock protocol, part 3: one Activity Log

- **Recorded by the server**, not the screens: after every successful write,
  `activityRecord_` appends a row to the hidden `_activity` sheet (created on
  first use — no initialize needed): time, season, who (`_cashBy`: the link
  user's name, or "main app"), action, plain-English text (`describe_`,
  `movesText_`), places and regions touched, the stock-move ids it made, and an
  undo recipe. It is wrapped so logging can never fail the change itself.
- **Sales are left out** (`ACTIVITY_SKIP`) — they keep their own log.
- **Read on demand**: action `activity` (no lock), newest first, scoped to the
  season (and to its region for a regional link). The app shows the copy last
  saved on the device at once, then refreshes (`activityModal`). Stock moves
  not tied to any entry (made before b183) are listed too, each undoable.
- **Delete = undo** (`doUndoActivity`): stock moves (all together,
  all-or-nothing, `undoMoves_`), a shipment still fully in transit, an arrival
  (back into transit), cash entries, a new cost, change taken, a wording change,
  titles switched on, a new event or sub-warehouse while still empty. The entry
  stays, crossed out ("Undone by …"), and the undo is itself logged. Regional
  links may undo stock changes in their own region only.
- `transferMulti` now refuses any place that does not exist (found while
  testing: books could be sent to an unknown name and vanish).
- "📦 Transfer record" button replaced by "🗒 Activity Log" (the old
  `transfersModal` is still in the code, unused).

## Done in b184

- **Version warning** (`checkServerBuild`): if the Apps Script reports a
  different `serverBuild` from the page's build tag, a red banner tells the
  owner to deploy a new version. (An undeployed Code.gs caused "Unknown action:
  transferMulti" after b183.)
- Transfer: the count reminder only on "Transfer everything"; "Transfer" asks
  "Are you 108% sure you’ve counted everything correctly?".
- Place lists put the current season first, and the current region first in it.
- Activity log: entries with several stock lines keep them (`parts`); a
  dropdown lists them, each with its own Delete (`undoActivityPart`); "Delete
  all" undoes whatever is left.
- "# Arrived" heading on Partial Delivery; region prices with more than three
  currencies label every box (`rp-cell`); spacing in Add something new; a new
  region or event opens straight away; the wording pencil returns to the
  dialog it was tapped in (`LABEL_BACK`).
- **Pre-orders fulfilled by another region** (any season): `fulfilBy`,
  `fulfilLoc`, `fulfilAt` on sales; `setFulfilBy`, `fulfilRemote`,
  `openPreorders`; state carries `remote` (requests for this season's
  regions). The copy comes off the fulfilling shelf (ADJUST move), the sale is
  delivered where it was sold (`dsource` 'Another region'), and the fulfilling
  region's log shows a note, never a sale. Undo from the activity log.
- **List view** toggle in the top bar (`setViewMode`, `body.list-view`),
  remembered per device.

## Done in b185

- The version warning gave a false alarm right after a successful deploy: the
  server's cached state (kept up to an hour, keyed by data revision) still
  carried the old `serverBuild`. Now the cache key includes `SERVER_BUILD`,
  every state reply carries `"build"` stamped at reply time, and the app only
  trusts the build from a live reply (`LIVE_BUILD`), never the device's copy.

## Done in b186

- **Admin panel** regrouped into four columns: Admin (Activity Log, App and
  Sales Support, Spreadsheet Links, Edit Wording, Share Links), Money (Cash
  Tracker, Record Costs, Edit Payment Types), Books (Add New Stock, Transfer
  Existing Stock, Consignment Books, Edit Book Display), Location (Change
  Event Order and Change Regional Order everywhere, plus the
  Rename/Close/Delete buttons for the current level). Removed: Books in
  transit, Devotee storage, Fulfill for another region (now a "＋ Fulfill
  another" button in that panel's header).
- **Edit Book Display** (`bookDisplayModal`) merges Change book order and
  Titles offered here: tick to show, drag to reorder.
- **Close / Reopen Season** (`closeSeason`, `reopenSeason`): a checklist (all
  regions closed? no books left?). On close the season's exchange rates are
  frozen (`frozenRates`), so its USD figures stop moving, on screen and in
  its sheets (`getRates_` returns the snapshot, with `frozen: true`).
- **Activity log per title**: a multi-title transfer is one entry ("15 books
  transferred") with a dropdown of one line per title, each with its own
  Delete (`undoActivityPart` undoes that line's move ids).
- **Quantities are typed only**: arrow keys and the mouse wheel no longer
  change number fields; spinners are hidden.
- **Sub-warehouses** get their own colors and a "Stored At:" title on the
  warehouse cards; Sell asks "Selling from where?" (Warehouse, SW1, SW2…)
  whenever a sub-warehouse holds the title.
- **Remote pre-orders**: the badge reads "Being Fulfilled By: …"; a region
  with no copies refuses the request up front (`checkCanFulfill_`); a declined
  request shows a red "Pre-order fulfillment declined" on the pre-order
  (`fulfilDeclined` column).
- **Consignment titles** show only in the region their group belongs to
  (`bookBelongsIn`); `allPartnerIds` stops other seasons calling them orphans.
- American spelling throughout (fulfill, color…).

## Done in b187

- **Instant**: Reopen event/region (`commit`, clears `closedAt`), and Delete
  in the activity log. Delete marks the entry/line undone in the dialog,
  reverses the stock moves on screen (`undoMovesLocal`), checks first that the
  books are still there (`undoMovesFit`), and restores the entry if the
  server refuses (`commit` now takes `opts.onFail`). The log's entries carry
  `undoType` and per-line `ids` for this.
- **Deleted line came back** on entries written before b186: undoing a line
  removes its moves, and the rebuild-from-moves then lost it (or, with one
  title left, fell back to the stale stored list). `doUndoActivityPart` now
  stores the full line list first.
- **Mixed payments** (`mixedPayHTML` / `bindMixedPay`, shared by sale,
  multi-book and donation): any number of payments; the last one not typed
  fills with what is left, in the first payment's currency, converted with
  today's rates and marked as an estimate. Third and later payments are stored
  as JSON in the new `pmore` sales column; `eachLeg_`/`legs()` include them.
- **Editing a sale no longer wipes** columns the edit does not send
  (`usdActual`, `bundle`, `fulfil*`): `doEditSale` falls back to the old value.
- **Stock refused before saving**: a sale with no copies says so when the
  dialog opens (Save off, "Pre-order it instead"); moving a sale checks the new
  place; Multiple Books stops the Buy + at what is there, with a warning.
- **Multiple Books: "Selling from"** (Warehouse, SW1…) up front; replaces the
  after-Save sub-warehouse question.
- **Add Stock: "Coming From"** (free text) before the destination; it leads
  the note ("From the printer — …") and is the shipment `origin` in transit.
  "Can’t find your destination? Click here to add it."
- **Transfer: "Return all to warehouse"** fills From (the event), To (its
  warehouse), One Destination, and every count.
- **Wording**: each numbered instruction (`.how-to li`) is one label (was two
  halves); the edit box opens with the current words (`labelAsTyped`); a
  rewording applies wherever the same words appear (`byWords` in
  `applyLabels`), and restoring the original clears the other copies.

## Done in b188

- **Pencils everywhere.** `applyLabels` now takes every piece of text on
  screen (`lblTargets`: the `EDIT_SEL` list plus a text-node walk; bold inside
  a sentence belongs to the sentence), including dialog headings (`#modal > h3`
  was never matched before). A `MutationObserver` re-applies wording and
  pencils to anything drawn later. With pencils off, elements whose words have
  no saved wording are skipped, so long logs stay quick.
- **Numbers**: a label is keyed with each number as `#` ("# still coming");
  your wording's #s are filled with the numbers of the moment (`lblFill`).
  The editor explains the #.
- **Working parts survive a rewording**: only bold/line breaks count as part
  of the words (`lblIsFormatting`). Anything else inside (a spinner, a button,
  a link) is kept; only the text nodes change (`lblPut`), and are put back
  exactly (`lblRestore`, originals in `LBL_ORIG`). When the app itself changes
  a label's text, the label is re-keyed (`data-shown`).
- **Activity log**: a delete made while the log was still loading came back
  when the older copy arrived. Deletes are held in `ACT_PENDING` and laid over
  every fetched copy until the server's own copy shows them; the log refetches
  once the delete lands (`commit` now takes `opts.onDone`).
- **Errors in dialogs** scroll into view and flash (`#modalErr` watcher).
- **Shipment details**: "Coming From" (the `origin` of outside books) is
  editable; `doEditShipment` accepts `origin`.
- Admin: Share Links above Spreadsheet Links.

## Done in b189

- **Default sale vs Specialized Sales.** Single and multi-book sale dialogs
  show only Payment type, Currency and Amount received; everything else
  (payment status, name/phone, change owed, comments, date, where it was sold,
  who delivers a pre-order) sits in a closed `<details id="specBox">`
  "Specialized Sales". It opens by itself for a pre-order, when editing a sale
  that already uses any of it, and in Multiple Books as soon as a pre-order
  count is set (a name is then required).
- **Dollars actually received** is entered from the **sales log, after the
  sale** — not in the sale dialogs (the owner's decision). A "$ Received"
  button sits on every digital (non-cash, non-gift), non-pending row, single
  and multi-book; the drawer keeps its "Dollars received" line too. For a
  multi-book transaction it is one figure, shared out over the books by their
  estimated dollars (`splitUsdActual` / `splitUsdActual_`), and the row shows
  the total.
- Edits keep it: `doEditSale` falls back to the stored value, and
  `doEditBundle` carries the old total over and shares it out again over the
  new rows (it used to be lost, as the rows are rewritten).
- **Owner's standing rule:** whatever is added to single sales is added to
  multi-book transactions too, unless they say otherwise.

## Done in b190

- "$ Received" (dollars actually received) extends to **donations**: the
  button shows on digital donations in the log as on sales. Totals already
  applied the figure to donations (the `don` adjustment); editing a donation
  keeps it (`doEditSale` fallback).

## Done in b191

- **Totals honor dollars received**: the Total Collections tile uses
  `saleUsd` (entered figure, else estimate). Collections by Region and the
  report's Total add `usdActualAdj(list)`.
- **SOLD OUT / ALL PRE-ORDERED** badge sits on its own line above the title
  (was absolutely positioned over it).
- **Sell** buttons use `--green`, like Deliver.
- **Closing checklist: Save progress** (`saveCloseDraft`): ticks, changed
  counts and note, stored in script properties `cldraft:<kind>:<id>`, sent in
  state as `closeDrafts` (scoped to a regional link's own places), restored
  when the dialog opens, cleared by `doCloseLocation`. Regional links may
  save/close only their own region's places.
- **Edits keep everything**: Specialized Sales is always open on an edit, and
  `setSel` / `curOptions(sel)` add a stored payment type or currency that the
  place does not list, instead of silently showing (and saving) the first.
- **Speciality Reports** (App Admin): the WhatsApp report over chosen regions
  or events added together (`buildReport(part, {locs, groups, title})`), with
  the same section choices, a "BY PLACE" money breakdown, remembered per
  device (`tbs_spec_report`).
- **Auto-hide at events**: a title never brought to an event (no stock, no
  sale, no movement or shipment in) is off its shelf (`autoHiddenHere`); still
  pre-orderable via "Pre-order another title". Edit Book Display marks it "no
  copies here yet"; ticking it stores `+id` in the event's hidden list to show
  it anyway. `shelfBooks` = `baseShelfBooks` minus hidden.

## Done in b192 — Moving off Google Sheets, phase 1: the data store

No change anyone can see; the groundwork for leaving Google Sheets.

- **One storage layer.** Every read and write of the records now goes through
  the data store (see Architecture › Server). Before, the rules and the sheet
  calls were mixed together in about 200 places.
- **Changes touch only what changed.** Many saves used to rewrite a whole
  sheet to change one field. With 2,000 sales recorded, "dollars received"
  rewrote 62,093 cells and now writes 1; deleting a sale rewrote 62,068 and
  now removes one row; deleting a cash entry went from 3,641 cells to 14. A
  full rewrite still happens where the rows are reordered, or more than 25
  go at once.
- **Proven identical.** 653 recorded requests (14 sessions) give identical
  replies, identical data after every request and identical readable
  spreadsheets, before and after — and again with the records held in memory
  instead of sheets. All 291 browser checks and every regression script pass
  unchanged.
- Deploy as usual (new version of Code.gs, push index.html). No initialize
  needed; nothing in the data changes.

## Done in b193

- **No stray PLN.** Sale, multi-book, donation and cash dialogs asked for
  PLN as their starting currency (a leftover from the Poland-only days).
  Since b191 a currency asked for is added when the place lacks it, so PLN
  appeared, already chosen, in regions that never listed it. New entries now
  start on `defaultCur()`: PLN where the place takes it, else its first
  currency. Editing an old sale still shows its own stored currency.
  Covered by `test/curtest.js`.

## Done in b194 — no default warehouse

The first region's warehouse (Poland) was still treated as "the" warehouse
in about 30 places. Fixed on both the server and the page:

- **Pre-orders** hold copies at their own region's warehouse. Every open
  pre-order in every region and season was held against Poland's shelf,
  so Poland could be refused stock for another region's pre-order while that
  region's own shelf held nothing back. The pre-order details say "Copies in
  <its region> — Warehouse"; warnings name the warehouse being drawn down.
- **Deleting a delivered pre-order** puts the copy back on the shelf it came
  off. Deliveries now record that shelf (`dfrom`, a new `_sales` column,
  added on first use); older ones go back to their own region's warehouse.
  Before, the copy always went to Poland's warehouse. The page applies the
  same rule when it shows the change instantly (`restoreLocOf`).
- **No place is filled in by default:** a sale, donation or stock change that
  names no place is refused. Deleting an event needs its region's warehouse.
- **Every save queued a rebuild of Poland's report file**; no longer.
- Reports name the shelf a pre-order was filled from, not the old
  `warehouseName` setting.
- A new device (nothing remembered) opens at the season, not the first
  region; a region that has gone also falls back to the season.
- Covered by `test/nodefault.js` (every check fails on b193).
- `golden.js --ignore-col=name` leaves a deliberately new column out of the
  comparison. Against b193 the only other differences are the two intended
  ones (Italy's report now shows its pre-order held; a filled pre-order's
  report note names the real shelf).

Not changed: a brand-new, empty spreadsheet still seeds a first region named
after the `warehouseName` setting ("Poland") with PLN prices and the original
contacts. That only runs once, on a new spreadsheet.

## Done in b195 — folding panels; the season's order

- **Every panel folds from its heading** (tap the heading; the ▾ turns to ▸),
  at every level. Each device remembers its own choices, per level
  (`tbs_fold` in localStorage, keys like `season:payments`); everything
  starts open. Buttons, fields and wording pencils inside a heading keep
  working and do not fold it. The arrow is drawn by CSS, not written into the
  heading, so rewritten wording still matches. Panels carry `data-fold`;
  `applyFolds()` runs at the end of `renderAll`.
- **The season's order:** Total Sales by Title, Collections by Region, Sales
  by Region, Total Collections by Payment, then the Warehouse Overview.
- With the shelf folded, the sales log beside it drops out of its borrowed
  height (`.cols.inv-folded`), so it stays usable.
- `test/browser-fold.js` covers it.

## Done in b196 — Earthly HQ

The level above the seasons: Earthly HQ › Season › Region › Event.

- **What it is, in the data:** a region record (`rg_hq`, warehouse `wh_hq`,
  "Earthly HQ") whose `seasonId` is `HQ` — a "season" of its own, so it is
  never counted inside any tour. It is made the first time anyone opens HQ
  (`ensureHQ_`, under the lock), with currencies INR and USD and no prices yet.
  It cannot be closed or deleted, has no events, and no region can be made
  there.
- **Getting there:** 🌍 Earthly HQ starts the breadcrumb on every page. At HQ
  the season picker reads "Choose a season…"; a season's name anywhere in
  the summaries opens it. The server accepts `season: 'HQ'` (admin only) and
  `setSeason` to HQ never becomes the stored default.
- **Sales Portal** (folds): HQ's own region view — "Earthly HQ Warehouse" for
  its shelf, its sales log, pending payments and pre-orders, sales by title,
  totals by payment type. It sells, takes stock ("From the printer") and
  sends books to any season (Transfer / Books in Transit) exactly like a
  region. HQ heads the Add Stock / Transfer place list. "Edit Earthly HQ"
  sets its currencies, prices and titles; share links work as for a region.
- **Summaries Portal** (folds): Total Sales by Title, Collections by Season,
  Sales by Season, Total Collections by Payment (tap a type for the seasonal
  split), Seasonal Warehouse Overview. The tiles at the top of the page add
  up everything too. HQ appears as its own row beside the seasons.
- **How the summaries are drawn:** the season-level panels, handed a state
  in which each "region" is a whole season (`rollupState`, `withRollup`;
  `UNIT` supplies "season" and where a tap goes). The server sends every
  season's records as `state.everywhere`, only to an admin at HQ; links never
  get it. Existing seasons' replies are unchanged (golden replay identical).
- **Closed seasons** keep their frozen rates at HQ: each of their sales
  carries the dollar figure those rates give, through the same correction
  used for dollars actually received (`test/hqfrozen.js`).
- Folding is remembered separately at HQ (`hq:…` keys).
- Also fixed: a region's (or season's) name in a Collections table, and in
  the Cash Tracker, did nothing when tapped — the click handler ignored every
  link. Links that carry an app action are now handled.
- Tests: `test/hq.js` (server), `test/hqfrozen.js`, `test/browser-hq.js`.

Not done yet:
- No readable Google spreadsheet for HQ; HQ's own sales appear in no season
  file. The WhatsApp 📋 buttons are not on the Summaries Portal yet.
- In the summaries, a closed season's *costs* convert at today's rates (its
  sales use the frozen ones).
- HQ's Totals by Payment Type still says "tap a type to see it event by
  event", though HQ has no events.

## Done in b197

- **Activity log, cleaned up.** A stock entry's headline is now just the
  count, what happened and where: "49 Books Transferred from Poland
  (Warehouse) to Summer Festival" (the Transfer protocol), "12 Books Added
  to …" or "3 Books Subtracted from …" (Add Stock, and closing counts).
  Every such entry has a dropdown ("▸ 3 titles") holding only the
  breakdown, "Sri Radha (English) ×6" — no places, which are in the
  headline. Older entries are reworded the same way when the log is read,
  while their movements are all still on record (`stockEntryText_`,
  `partText_`). Per-line Delete appears only when there is more than one
  title.
- **A new spreadsheet starts empty** (book catalogue and one season,
  "First Season"). It used to create a region named "Poland" with Polish
  prices, the original contact list and three personal payment codes. A
  first region is still made to adopt data from before regions existed,
  if there is any. The tests' sample tour ("Europe Tour" › "Poland",
  warehouse `WAREHOUSE`) now lives in `test/mini.js` (`sampleTour`);
  `test/fresh.js` checks a bare start. The corpora were re-recorded.
- **WhatsApp 📋 on the Summaries Portal**, per section, reporting over
  every season ("— BY SEASON (after costs) —").
- (Removed in b203.) **📋 Copy Saved Wording** (admin, once anything has been rewritten): the
  rewritten wording as text, to be built into the app so your words become
  its own and the stored copies are cleared. (The running app cannot
  rewrite its own files; the owner allowed reading the wording from the
  live app, but this environment's network blocks script.google.com.)

## Done in b198 — dollars from the truth

Local amounts never change; only their dollar value can. Every dollar figure
— tiles, Collections by Region, Collections by Payment, the WhatsApp report,
the Summaries Portal at HQ, and the spreadsheets — now counts, in order:

1. **dollars actually received**, where entered on the sale (`usdActual`);
2. **a closed region's rates**, frozen the day it closed;
3. **a closed season's rates** (as before: `getRates_` returns them);
4. **today's rates**, an estimate.

Costs follow 2–4 by their place. Details:
- `doCloseLocation` (kind region) stores `frozenRates` on the region row
  (`freezeRegionRates_`: only the currencies the region used, and only if
  every one has a rate — never frozen offline). Reopening clears it.
- Regions closed before b198 are filled in by the background sync
  (`backfillRegionRates_`, at most hourly, five at a time): the ECB rate of
  the closing day from Frankfurter's history; a currency the ECB does not
  publish (e.g. MKD) takes the rate of the day it is filled in.
- Server: `ratesForLoc_`, `toUsdAt_`, `saleFactor_`, `legTruthUsd_`,
  `costUsd_`. `legsUsd_`/`dueUsd_` go through them, and each per-currency or
  per-payment-type dollar column adds up leg by leg. The spreadsheets had
  never honoured dollars received; now they do (golden differs there, and
  only there — checked by switching `saleFactor_` off). A closed region's
  sheet says "Exchange rates — FROZEN when this region closed"; a closed
  season's no longer says "OFFLINE FALLBACK".
- App: `state.regions[].rates` (closed regions only) and
  `everywhere.regions[].rates`. `toUSDAt`, `ratesAt`, `hasTruth`, `saleEst`,
  `costTruthAdj`; `saleUsd`, `usdActualAdj` and the payments factor use them.
  At HQ, `rollupState` gives `locFx` (place → region-frozen, else
  season-frozen rates) in place of the old per-sale `usdActual` injection,
  so costs are right there too. The "received" badges still mean only
  dollars actually entered (`hasUsdActual`).
- Tests: `truthusd.js` (server: freeze, reopen, backfill, spreadsheets),
  `truthclient.js` (app and HQ). `mini.js` gains `run(src)`.

## Done in b199 — the Earthly HQ spreadsheet

- **One file, "0 — Earthly HQ — Book Sales"**, at the top of the Drive
  folder (not in a season's), made once HQ has been opened in the app
  (`regionSpreadsheet_(HQ_REGION)`, meta key `regionSheetId:rg_hq`).
- **First tab, "All Seasons"** (`renderHQSheet_`) — the Summaries Portal as
  a sheet, a column per season plus Earthly HQ and a Total: a headline
  (collected, donations, pending, costs, net), Total Sales by Title,
  Collections by Season (currencies, then collected / costs / net in
  dollars), Sales by Season, Collections by Payment Type (dollars) and the
  Seasonal Warehouse Overview. Dollars follow the truth (b198); for sales in
  a closed season `toUsdAt_` now falls back to that season's frozen rates
  (`seasonFxMap_`, `truthFxForLoc_`), which is what lets HQ count every
  season at once.
- **Then HQ's own tabs**, exactly as for a region: Summary and
  "Earthly HQ — Warehouse Sales".
- **Kept current by the usual sync.** In the background HQ is one more
  group after the seasons, redrawn whenever anything was redrawn; a manual
  Sync sheet in a season refreshes it too; Sync sheet at HQ builds it.
- Listed under "Earthly HQ" in the Spreadsheet folders map.
- Test: `hqsheet.js`.

## Done in b200 — deleting a season, all of it, at once

- **What was wrong.** `doDeleteSeason` deleted its regions one at a time
  through `doDeleteRegion`, which removed rows one by one (a slow Sheets call
  each) and never touched shipments, devotees' shelves, costs, change or
  consignment groups. So a deleted test season's books in transit kept
  showing at Earthly HQ, and deleting took minutes.
- **`purgeRegions_(ids)`** removes regions and everything of theirs in one
  pass per table: warehouse, events, devotees and their stock; shipments to
  or from them (and the books in them); sales, cash, costs, change, stock
  movements, contacts, prices, consignment groups and payouts; their
  spreadsheet ids and closing drafts. Used by deleting a season and a region.
  Deleting a region with "move stock to" also moves books still in transit.
- **Leftovers from before:** `shipmentsAll_` hides shipments to or from a
  region that no longer exists (`OUTSIDE` is not a region), and the
  background sync sweeps them away hourly (`purgeOrphans_`).
- **Row deletion is batched:** neighbouring rows go in one `deleteRows`;
  more than `DB_RUNS_` (8) separate stretches rewrites the table instead.
- **In the app** the name is checked on the device, and the season vanishes
  at once — season list, HQ summaries, books in transit — saved like a sale
  (`deleteSeasonNow`, `dropSeason`; `commit` gains `anySeason`).
- Tests: `seasondel.js`, `seasondelclient.js`. Golden differs only where
  deleting a region now also deletes its shipments (extra.jsonl).

## Done in b201 — the saved wording is now the app's own

- The 104 pencil rewordings saved on the live app (read, not changed, on
  27 Sep 2026) are written into `index.html` itself, so the code is the
  reference. Where two saved versions disagreed, the one saved last wins;
  saved wording for text the app no longer shows (older dialogs) was
  dropped. Notable: the titles panel is now "Distribution by Title" at
  every level (the HQ spreadsheet's section too), "Active Sales Log" is
  "Sales Log", "still coming" reads "in transit", and the hidden items
  (the shipment-details lines, "Moving it also moves the copy…", the
  Activity Log's "Checking for the latest…") are gone from the code.
- Backend: the spreadsheets' "Still owed" column is "What They Still Owe";
  the HQ sheet's section is "DISTRIBUTION BY TITLE". Book titles are not
  touched (the owner changes those elsewhere).
- The saved copies are retired on the first save after deploying
  (`retireBuiltInLabels_`, list in `BUILT_IN_LABELS_`): only rows still
  exactly as built in, so wording saved since is kept. Test:
  `labelsbuiltin.js`.

## Done in b202 — books left on deleted shipments

- The live data still held 19 books (12 + 7) on two shipments of the test
  season deleted before b200: the shipment rows were gone, but their stock
  rows (location `sh_…`) were not, and Earthly HQ counted them in transit.
- `strayShipLocs_()`: an `sh_…` place with no live shipment. Its stock is
  never sent to the app (`readState`), and `purgeOrphans_` erases it — now
  on the first save of each hour as well as in the background sync.
- Test: added to `seasondel.js`.

## Done in b204 — Moving off Google Sheets, phase 2: the server on Cloudflare

Nothing switches yet; the app still talks to Google. See `server/README.md`
(owner's set-up steps included).

- **`server/`** runs Code.gs unchanged on Cloudflare. `build.cjs` wraps it as
  a module (Cloudflare forbids building code from text); `src/google.js`
  stands in for Utilities/ContentService/LockService/UrlFetchApp (rates are
  fetched ahead and served from memory; anything missing is fetched after
  the reply); `src/sqlstore.js` is `STORE_`/`KV_` on the Durable Object's
  synchronous SQLite (rows as JSON, dates as `{"$d":…}`, held in memory as
  the only writer). One Durable Object, `main`, answers every request in
  turn — the script lock's job. A new database is set up on first start.
  Hourly alarm: leftovers sweep, closed-region rates, expired sessions.
- **Code.gs**: `REPORTS_HERE_` (false on Cloudflare) keeps spreadsheet work
  off the server; the Sheets-only repairs skip themselves off Sheets
  (`STORE_.isSheets`); spreadsheet actions are refused there if they ever
  arrive unforwarded.
- **Sign-in** (`src/auth.js`): the owner's app signs in with Google (ID
  token checked: signature, audience, expiry, confirmed email,
  `ADMIN_EMAILS`) and gets a 90-day session renewed while used. Links are
  untouched. The page shows the sign-in screen only when config.js has
  `GOOGLE_CLIENT_ID`; saves made while signed out are kept and resent.
- **Spreadsheets stay with Google** through a bridge (core.js
  `bridge`/`forwardToGoogle`; Code.gs `withMirror_`, `cfTick_`,
  `cfForwarded_`): Apps Script asks for a copy of the records, draws from it
  in memory with the same code, and writes back only what it learned
  (`_meta` changes, spreadsheet actions' Activity lines, `lastRenderError`,
  places it could not finish). Places to redraw are claimed, and given back
  after 15 minutes if a run never reports. "Sync sheet", "Spreadsheet
  folders" and friends are forwarded by the server to Apps Script.
- **Deploy**: `.github/workflows/deploy-server.yml` checks and deploys on
  merge once `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` are set.
- **Tests**: `workergolden.js` (every session through the whole server vs
  Google: identical), golden `--store=sqlite` with `TBS_SQL_COLD=1`,
  `auth.js`, `bridge.js`, `browser-cloudflare.js` (real page, Cloudflare's
  runtime via `wrangler dev`). The test stand-ins for Google's cache now
  expire things as Apps Script does; `m.clear()` also moves the revision on.

## Done in b205 — Phase 3 tools: copy, compare, switch, and back

Run from the Apps Script editor; see server/README.md › Phase 3.
- `copyToCloudflare()` — every hidden table (by `TABLE_KEYS_`) and setting
  (not `CF_*`) sent to the server (`reportImport`, which replaces its
  tables and settings, keeps sign-ins, and moves `rev` past Google's), then
  `compareWithCloudflare()`: each season's state (and Earthly HQ's) here vs
  the server's (`reportState`), all but `serverTime` and `rates`, with a
  line per season of sales and money per currency. Refused once switched.
- `switchToCloudflare()` — under the script lock: `CF_LIVE=yes`, a last
  copy, the comparison; any difference unsets `CF_LIVE` and switches
  nothing. Once live, every app request reaching Google is relayed
  (`cfRelay_` → the server's `relay`, secret-checked; waits for the lock so
  none lands mid-copy), and the minute trigger draws from the server
  (`cfTick_`, now gated on `CF_LIVE`, not just `CF_URL`).
- `copyBackFromCloudflare()` — the way back: the server's tables rewritten
  into the sheets, its settings copied, `CF_LIVE` removed.
- Test: `cutover.js` (a whole recorded session plus a second season and HQ:
  rehearse, a tampered copy that switches nothing, the switch, a phone
  relayed and its resend recognised, copy back). Test harness: Apps
  Script's `getProperties` stand-in now returns a copy, and `Logger` exists.

## Done in b206 — dates written the same on Google and Cloudflare

The owner's first rehearsal (copyToCloudflare) found every season different
at `allRegions[0].closedAt`: the records matched, but `String(date)` writes a
date in the server's own time zone — the script's on Google, UTC on
Cloudflare. `dateText_()` writes such dates as ISO text everywhere (region,
season and event closings, change returned). The app only checks whether
they are set. `workergolden.js` now runs Google in Europe/Warsaw and
Cloudflare in UTC, so anything of this kind shows up; and
`compareWithCloudflare` shows up to three differences per season, with both
values.

## Where things live now (since the Phase 3 switch, September 2026)

- **The records**: the Cloudflare server, https://tbs-server.gitagovinda.workers.dev/
  (one SQLite Durable Object). `config.js` points the app at it; the owner
  signs in with Google, links do not.
- **The spreadsheets**: still built by the Apps Script project, from a copy
  of the server's records (Script properties `CF_URL`, `CF_SECRET`,
  `CF_LIVE=yes`). Its minute trigger must stay installed. Keep deploying
  Code.gs there as before: it is also the spreadsheet builder, and phones
  on an old page reaching it are relayed to the server.
- **Deploying the server**: automatic on merge (GitHub Action), for any
  change to `server/` or `Code.gs`.
- **The old hidden sheets** in the Google spreadsheet are no longer written
  to. They are the state at the switch; `copyBackFromCloudflare` rewrites
  them from the server if ever going back (revert config.js first).
- Settings: Cloudflare Worker variables `GOOGLE_CLIENT_ID`, `ADMIN_EMAILS`,
  `REPORT_URL`, secret `REPORT_SECRET` (= Apps Script's `CF_SECRET`).
  `ADMIN_EMAILS` are the permanent admins; everyone else is managed in the
  app's 🔑 Admins panel (b207).

## Done in b207 — admins added in the app: by email, or on request

- **Request and approve**: someone signs in with Google and is not an admin
  yet → no session; their request is kept (`access_request`, with the name
  Google gives) and they are told kindly it has gone to the admins. The
  admin panel's **🔑 Admins** button shows "N waiting" (the server adds
  `requests` to a signed-in admin's `ping`). Approve makes them an admin;
  Decline hides the request and they are told "not approved" if they try
  again (an admin can still add them).
- **Add by email** in the same panel: they can sign in at once.
- **Remove**: signs them out everywhere at once. Nobody can remove
  themself, and the `ADMIN_EMAILS` owners are permanent and shown, not
  removable — nobody can be locked out.
- Server: `auth.js` tables `admin` and `access_request`; core.js actions
  `adminsList/Add/Approve/Decline/Remove` (signed-in admins only, never
  links).
- Google's side: the sign-in app must be **published** (Google Auth
  Platform › Audience › Publish app), or Google blocks anyone not on its
  test-user list before they reach us.
- Tests: `auth.js` (37 checks), `browser-cloudflare.js` (a second person
  asks, the owner approves in the panel, they get in; add by email). The
  other browser tests now serve `test/config.test.js`, since the real
  config.js points at the live server.

## Done in b208 — books in transit shown only where they are headed

The owner's rule: a batch shows at the region, event or season it is going
to, never at the region it left. `transitHere()` (the main-screen panel) and
`shipmentsModal()` (no more "Sent from" list): at the season, only batches
going into its own regions; at a region or Earthly HQ, those coming to it;
at an event, those aimed at it. The data is unchanged — the sending region
still has the batch in its records and stock history, and a regional link
still receives it — it is simply not shown there. Test: `transitwhere.js`.

## Done in b209 — Speciality Reports: the choices fold away

The places and sections now sit in one foldable "Choices" bar
(`#spChoices`) whose summary says what is chosen ("Regions: Poland + Italy ·
4 of 5 sections"). "Done — show the report" folds it; it opens folded when
places were chosen before, and open the first time. Folded, the report box
fills the window (`#modal.sp-folded .rep-box`). Test: `browser-round7.js`,
desktop and phone width.

## Done in b255 — Finance round three: dates, repeats, one Expenses page (practice)

- **Dates on every place.** New/edit season, region and event forms ask "Dates
  the … runs (from – to)" (`placeMetaHTML` / `placeMetaBind` / `placeMetaSave`
  in index.html). Kept on the server in the setting `placeDates` (expenses.js
  `placeMetaGet` / `placeMetaSet`), and returned with `finData` (`from`, `to`).
- **Repeats are spotted.** While the name is typed, a name matching an earlier
  one without its year ("Zagreb 2027" ↔ "Zagreb") asks "Is this part of the
  recurring Zagreb?"; if not, dates within two weeks of another year's ask "Is
  this a recurring event?" with each candidate (Gita's idea). The answer is
  saved as the place's series in `finSeries`, so Compare and Reports use it.
  "No" with the same name files it under "Name · parent".
- **Dates & Repeats** (App Development › 📅, Universal, temporary): every
  season, region and event in the app's order with its dates and "Recurring
  as", saved as typed; "Only those without dates" (`datesModal`).
- **Expenses & Reimbursements are one page.** Tabs: Expenses, Pending
  Reimbursements, Paid back and declined, Reimbursement Links, Settings.
  `#finance/reimb` and `#finance/settings` still land there.
- **Send Reimbursements Link** is a name, an email or WhatsApp number, and Send:
  the link is made for the place being looked at and WhatsApp or email opens
  with the message written. A link sent to one person knows their name and
  number, and turns itself off once they've sent their expense in (`once`,
  `used` in `reimbLinks`). Group links ("A link anyone can use") stay as before.
- **Several expenses in one form.** "＋ Add another expense" keeps the one typed
  (with its receipts) in an "Added so far" list (Edit / 🗑) and starts the next,
  keeping where, whose, currency, date and how to be paid back. With more than
  one, Save becomes "Review all N expenses": a list with the total to check,
  then they save one after another (`expAddAnother`, `expReview`, `expPost`).
  On a one-time link, all but the last go with `more`, so the link closes
  only after the last.
- Practice only, like the rest of Finance. Tests: `browser-finance.js` (70).
- Proposal for Reports as a pick-your-own-data builder:
  /mnt/project-files/proposals/finance-reports-builder.md (not built).

## Done in b254 — Finance, first round of Gita's improvements (practice)

- **Regions and events in the app's order** on every Finance list and dropdown:
  Code.gs `financeData_` now walks `regionsOrdered_` / `eventsOrdered_` (sort,
  then as created, closed last A to Z).
- **Overview shows seven figures only** (`finOverviewFigs`, used by tiles, the
  table and WhatsApp alike): Big Books Sold, Adventures Sold (money in hand,
  with "27 Sold + 3 Gifts = 30 Distributed" beneath; Other titles count as Big
  Books), Donations, Pending Payments, Gross (formerly Collections; becomes
  **Expected Gross** with **Current Collected** beneath while anything is
  owed), Expenses, Net (margin beneath). Consignment money is the groups', so
  it is left out of these (still in Reports). `financeData_` sends `g` (a gift)
  so gifts are no longer counted as sold. Reports' figure names follow.
- **Place search** (`finSearchHTML`, `finBindSearch`): the app's drop-down
  search, every season › region › event, first on the dates line.
- **WhatsApp reports**: 📋 beside Overview, the By Region/Event/Season table,
  Reports, Compare and To do (`finrep`, `finReportText`); the top 📋 Report in
  Finance reports the section being looked at, with headings.
- **Pencils**: the Finance page was marked no-edit; now every word on it can be
  rewritten (place names apart), Edit Wording is on Finance's bar for
  Universal, and a passing message (toast) stays up and takes a pencil while
  wording is being edited.
- Wording: To do tabs read Pending Reimbursements / Pending Payments; the
  section is "To do" on the Finance page.
- **Edit Wording in place** (practice only, app-wide): tap any words (a
  button's by its pencil) and a box opens over them; Enter keeps, Esc leaves,
  🙈 hides (`labelInline`, `labelSave`). Live keeps the old window.
- **Expenses section** (`finExpensesRender`): totals bar — Total Expenses, or
  Expected Total Expenses with Current Expenses beneath while reimbursements
  are owed — and Reimbursements Due; every expense with Edit/Delete, sorted by
  date, name, amount or type, round buttons to filter by type, search, dates.
- **Reimbursements section** (`finReimbRender`): the same bar; Pending, Paid
  back and declined, Reimbursement Links, and ⚙️ Reimbursement Settings (moved
  off the section bar; `#finance/settings` still lands there; Where and Person
  are searchable drop-downs).
- **Send Reimbursements Link** (server: `expLinkMake/List/Off/Info`, setting
  `reimbLinks`; client `finLinksRender`, `reimbPublicStart`): a link
  `?practice&reimb=rb_…`, anywhere or for one place, sent by WhatsApp or email;
  it opens only the expense form (name, WhatsApp/phone or email, receipts), no
  sign-in, and ends on "received and will be processed at the earliest
  convenience". In Pending, Finance gets one-tap WhatsApp/email messages
  (received, or paid back). Fully automatic messages would need an email
  service or WhatsApp Business: not built.
- **Add Expense**: Where, Kind and Paid with are searchable drop-downs
  (`comboHTML`/`comboBind`); Other asks what it is (`catOther`, a paid-with
  Other keeps its words as the payment type).
- **Visualize** (`finVisualRender`): expenses by type as a pie or bars, with a
  table of amounts and shares; fixed palette, past 7 types folded into
  "Everything else".
- New `_expenses` columns: `catOther`, `contactPhone`, `contactEmail`.
- Tests: `test/browser-finance.js` (45), `browser-expenses.js` updated (66).

## Done in b253 — a read-only key for Claude to read the live records

- **Server:** a new request, `readOnly`, answered only with the right `READ_KEY` (a Cloudflare secret on tbs-server, 24+ characters). `what: "state"` gives a season as Universal sees it; `what: "export"` gives every table, the settings and the people with their roles (no sign-ins, no receipts). Nothing else is answered with it, so it cannot save, change or delete. The key may also come as `Authorization: Bearer`. `readOnly` in server/src/core.js, `withKey` in worker.js.
- **For Claude sessions:** `server/read-live.sh` reads it with `TBS_READ_KEY` from the cloud environment. Setup and removal: server/README.md, "The read-only key".
- **Tests:** test/readkey.js (10 checks), also run before every server deploy.

## Done in b252 — Hide here at every level, the season's page included

- **Season page:** while arranging (⇅), Universal gets "Hide here" on Distribution by Title and the Warehouse Overview. A hidden title leaves both panels; stock entry, reports and totals still count it, and regions and events keep their own lists. Stored per season on the server (`setSeasonHidden`, meta `hidden:<season>`, sent as `seasonHidden`). b251's "open a region or an event" note is gone.
- **Every book panel:** "Hide here" now shows on each book panel while arranging, not only the Inventory shelf. At Earthly HQ the Warehouse Overview follows HQ's hidden list too.
- **Hidden here:** works the same at every level; at the season "Hide all out of stock books" means none left anywhere on the tour or on the road. One `saveHiddenHere` in index.html now stores the list for wherever you are.
- **Server:** Code.gs changed (SERVER_BUILD b252); Cloudflare redeploys itself on merge.
- **Tests:** browser-arrange.js adds hiding and showing on the season page (54 checks).

## Done in b251 — Hide here at Earthly HQ; the season says where hiding is

- **Earthly HQ:** "Hide here" and "Hidden here" now work on HQ's shelf while arranging (it is region `rg_hq`, so setRegionHidden already worked). `canHideHere` no longer leaves HQ out. Gita looked for Hide here and didn't find it.
- **Season page:** it has no shelf of its own to hide from, so while arranging there Universal sees "To hide a title, open a region or an event and press ⇅ there." in the note at the foot.
- **Tests:** browser-arrange.js adds a region's warehouse, the season note, and hide/show at Earthly HQ (49 checks).

## Done in b250 — Arrange comes to the live app

- Everything built for arranging in practice is now in the live app too: the ⇅ on every book panel, dropping one book on another to swap them (the donation card included), each person's own order kept with their login (separate for phones and computers), and, for Universal, "Hide here" / "Hidden here" while arranging.
- Edit Book Display is gone from the live menu as well. The shared order can no longer be changed from the menu; a title added by mistake is removed from the Activity log (b248).
- The practice-only gates came out of `canHideHere`, `MY_ORDER.get`, the menu and `arrangeUI` in index.html. The server needed no change (setMyPref was never practice-only).
- Tests: browser-arrange.js now checks the live app has the ⇅, Sita's own order, swapping, no Edit Book Display, and Hide here (43 checks).

## Done in b249 — the donation card swaps too; headings read from the left

- **Donation card (practice):** it has a Drag bar in ⇅ Arrange and swaps like a title. Its place is kept in the person's own order as `__donation` (DONATION_ID); without one it stays last. It has no "Hide here". `renderInventory` and `saveShelfOrder` in index.html.
- **Headings:** every section title now starts right after its fold arrow (▾); the heading's buttons keep to the right. `justify-content:space-between` had put each title somewhere different, depending on what else its heading held.
- **Tests:** browser-arrange.js adds the donation swap (40 checks).

## Done in b248 — swap to arrange; undo a new title from the Activity log; no Edit Book Display (practice)

- **Arrange swaps (practice):** dropping a book on another swaps the two; nothing else moves while dragging (the book it will swap with is outlined). Before, the rest shuffled along like a phone's home screen. `makeShelfSortable` in index.html.
- **Undo a new title:** "Added a new title" in the Activity log now has Delete, which takes the title out of the catalogue (deleteBook: refused with sales, clears its stock). Older entries, written without an undo, find the title by name (`addedBookId_` in Code.gs). Choosing a title that already exists (Add Stock's orExisting) is no longer logged as "added".
- **Edit Book Display (practice):** gone from the menu. While arranging, Universal gets "Hide here" on each title of a region's or an event's shelf, and "Hidden here (n)" in the note at the foot, which lists hidden titles with Show plus "Hide all out of stock books". Live keeps Edit Book Display (with its 🗑) until Arrange is promoted. The shared order can no longer be changed in practice; personal orders (⇅) are unchanged.
- **Server:** Code.gs changed (SERVER_BUILD b248); Cloudflare redeploys itself on merge.
- **Tests:** browser-arrange.js updated for swapping, plus hide/show and the menu (37 checks). browser-newtitle.js adds the Activity log undo, old entries, and orExisting not logged (22 checks).

## Done in b247 — new titles wait for Save; a mistaken title can be deleted

- **Bug:** in Add Stock, "＋ A new book…" or "＋ A new language…" added the title to the catalogue the moment its button was pressed, so a slip ("Sri Radha Hindi") was in the system even if the stock was never saved.
- **Now:** the title waits on its line, marked "new title, added when you save". Save adds the titles its lines use (addBook with orExisting, so a title that already exists is reused, never doubled), then saves the stock with the real ids. Taking the line off or closing the dialog adds nothing. With no connection, Save says the title could not be added, saves nothing, and keeps the lines to try again.
- **Delete:** Edit Book Display shows 🗑 on titles added in the app (ids `bk_…`, Universal only; the standard titles are built in). It uses the existing deleteBook action: refused while any sale is recorded against the title, and any stock entered for it is taken off.
- **Test:** test/browser-newtitle.js (14 checks; 6 fail on b246). test/browser-stalelang.js updated: the b245 case now checks the stock lands on the existing title at Save.

## Done in b246 — Earthly HQ refreshes again (signed in)

- **Bug (Gita):** at Earthly HQ, "Checking for changes…" ran for 90 seconds
  and more without finishing, and the screen kept an old copy (which is also
  why a newly added language was missing).
- **Cause:** `post()` added the device's season to a request only when there
  was no sign-in (an `else if` after the session branch). Signed in on the
  Cloudflare server, the server answered with its stored season. Seasons are
  stored when chosen, so they looked fine; Earthly HQ is never stored, so every
  HQ refresh came back for another season and `pull` discarded it as stale.
- **Fix (page only):** the season goes with every request except a share
  link's and `setSeason`. No server change.
- Test: `browser-cloudflare.js` (+2, real Cloudflare runtime, signed in: HQ
  reaches "Up to date" after a refresh; fails on b245). Needs
  `npm install` in server/ to run.

## Done in b245 — a new language is chosen even when the screen is behind

- **Bug (Gita):** Hindi was not offered for Govardhana; adding it said "Could
  not open Govardhana (Hindi) — refresh the page…", and refreshing did not
  help. "Checking for changes…" also stayed up for a long time.
- **Cause:** the title had been added on the server, but this screen's copy of
  the catalogue was behind because its refresh had not landed. b240's add
  relied on that refresh (or on the new id, which an "already exists" refusal
  did not give).
- **Fix:** `addBook` takes `orExisting:true` and then answers with the existing
  title's id instead of refusing (Code.gs, `SERVER_BUILD` b245; an older server
  still works the old way). Add Stock puts that id on the line at once and
  refreshes behind it. The page's full refresh (`pull`) now has a 40 s limit,
  so a request that never answers no longer leaves "Checking for changes…"
  up for good; the regular check asks again.
- Test: `browser-stalelang.js` (+4: refresh stuck, Govardhana (Hindi) added
  elsewhere; fails on b243).
- Open question: why the refresh was slow on Gita's device (asked her).

## Done in b244 — arranging: a small ⇅ on every panel of book cards; phone and computer orders (practice)

- **Asked (Gita):** the Arrange button showed on the HQ shelf but not at other
  levels; make it a small icon like the list/cards and report buttons; and
  keep a different order on a phone than on a computer, since they lay the
  books out differently.
- **Icon:** `arrangeUI()` (run after every redraw, like `sectionViews`) puts a
  small ⇅ (`.view-tg.arr-tg`) beside ☰ on every panel holding book cards: the
  shelf (`#invGrid`) and every `.stat-grid[data-books]` (Distribution by Title
  and the Warehouse Overview, at the season, region, event and HQ). The season
  page has no shelf, which is where it was missing. The old heading button and
  inline bar are gone; while arranging, a note sits at the foot of the screen
  (`#arrDock`, clear of the phone menu button) with Use the shared order and
  Done. Drag bars are added to the cards by `arrangeUI`, not the renderers.
- **Phone or computer:** `isPhoneView()` (max-width 640px). `MY_ORDER` keeps
  `bookOrderPhone` / `tbs_my_order_phone` on a phone and `bookOrder` /
  `tbs_my_order` on a computer; a phone starts from the shared order. Server
  `PREF_KEYS` gains `bookOrderPhone` (Cloudflare redeploys itself).
- `renderAll` waits while a card is held (`dragging()`).
- Tests: `browser-arrange.js` (30 checks), `people.js` (+1).

## Done in b243 — ↕ Arrange on the shelf; each person's own book order (practice)

- **Asked (Gita):** rearrange the book squares on the shelf itself with a
  button right there, not in a pop-up; and let every person keep the books in
  their own order. Chosen: kept with their login, so it follows them to any
  device; the shared order (Edit Book Display) stays the default.
- **Shelf (`index.html`, practice only):** `↕ Arrange` on the Inventory
  heading. While arranging, a bar explains it, each card's Sell/Pre-order
  buttons give way to a "⠿ Drag" bar (a finger drags by it, so the rest of the
  shelf still scrolls; a mouse can grab the card anywhere), nothing on a card
  can be pressed, the lifted card follows the pointer over a dashed gap, and
  the page scrolls near the screen's top and bottom. `makeShelfSortable`;
  `renderInventory` waits while a card is held (`SHELF_DRAG`).
- **The order:** `MY_ORDER` (practice only) sits on top of the shared order in
  `inRegionOrder` (`inMyOrder`, `byRank`). Saved when a card is dropped
  (`saveShelfOrder`): this shelf's titles take the places they held among the
  whole catalogue, so other shelves keep their order. Kept in `localStorage`
  at once and, signed in, with the login. "Use the shared order" forgets it.
  Edit Book Display always shows and saves the shared order (`sharedOrder`).
- **Server (`server/src`, Cloudflare only):** table `pref (email, key, value)`;
  `setMyPref` (only `bookOrder` so far; `null` deletes) and `me` returns
  `prefs`. A link (no login) keeps the order on the device only. Code.gs is
  unchanged, so no `SERVER_BUILD` bump; Cloudflare redeploys itself on merge.
- Tests: `browser-arrange.js` (23 checks: mouse, finger, other device, other
  people, Edit Book Display, live has no Arrange), `people.js` (+6).

## Done in b242 — nothing entered without a signal is ever lost

- **Bug (Gita):** stock entered while the internet was out (unknown to her)
  was gone after refreshing, and never came back once the internet returned.
- **Causes:** (1) a change waiting for a signal was kept on the device, but
  how it changed the screen lived only in memory, so a refresh hid it;
  (2) `flushPending` threw a waiting change away after 8 failed tries (and an
  unreadable reply, e.g. Wi-Fi with no internet behind it, after 4) with
  "please redo it"; (3) a refusal, including a busy server, deleted the change;
  (4) with no internet the page itself would not open at all.
- **Fix (page only):** each change's effect on the screen is recorded as data
  (`stateFx`/`applyFx`, `tbs_fx`: rows added/changed/removed per table, stock
  as +/- counts) and redrawn on opening (`fxRestore`) until its save lands.
  Held changes (`rev:-1`) survive a pull until `retireOp`. No-signal and
  unreadable replies are retried for ever; a poll that reaches the server
  also sends the queue (Wi-Fi without internet never fires "online"). A busy
  server keeps the change queued (`isBusy`). A real refusal goes to
  `tbs_notsaved`, shown by the corner notice ("1 change not saved — tap to
  see") with Try again / Remove; only a person removes it. The corner notice
  (`#pendBadge`) is back, for held changes only. `sw.js`: the page, config
  and pictures are kept on the device (network first, 6 s then the kept copy),
  so the app opens with no internet; server requests are never touched.
- Test: `browser-offline.js` (served from localhost so the service worker runs).

## Done in b241 — drag to reorder works, by mouse and by finger

- **Bug (Gita):** in Edit Book Display, dragging a title left several blank
  spots, dragging to/from the bottom of the list did not work, and on a phone
  it did not work at all.
- **Causes:** `makeSortable` was bound again on every redraw of the list (after
  each arrow press or drag), so the next drag ran two or three times over,
  each adding a gap; the lifted row also stayed in the flow, leaving a blank
  where it had been next to the gap; nothing scrolled while dragging, so a
  long list could not be crossed; and `.ro-row{touch-action:none}` meant a
  finger on a row could not even scroll the list, while the handle was a
  15px target.
- **Fix (page only, `index.html`):** `makeSortable` binds once per list (the
  latest `onDrop` is kept on the container); the lifted row floats
  (absolute) over one dashed gap; the list (or page) scrolls when the row is
  held near its top or bottom edge; a finger drags by a 40px handle and can
  swipe rows to scroll; a mouse can grab the row anywhere except its buttons
  and tickboxes. Applies to Edit Book Display and Change Region/Event Order.
  No server change.
- Test: `browser-drag.js` (fails on b240, 23 checks pass on b241).

## Done in b240 — a new language shows up in another season's Add Stock

- **Bug (Gita):** added Sri Radha (Hindi) from Add Stock, could not stock it,
  and then Hindi was missing from the language list while "＋ A new language…"
  said it was already in the catalogue. No way on.
- **Cause:** stocking a place in a season other than the one on screen draws
  the lists from that season's own copy of the state (kept on the device, or
  fetched before the title was added), but the "already in the catalogue"
  check reads the screen's catalogue. The catalogue is the whole tour's, so
  the two disagreed. A refresh of that season landing just after the add also
  swapped the new title out from under its line, which is why it could not be
  stocked the first time.
- **Fix (page only, `index.html`):** `makeStockCtx` gets a `books` getter: the
  season's copy, with the screen's catalogue filling any gaps (and giving the
  newest names). `stockBooks`, `otherBooks`, `stockTitles` and the lines use
  it. Typing a title or language that already exists now simply chooses it on
  that line; a server "already exists" reply does the same; and if the
  refresh after adding is held back by a save in flight, the id in the reply
  is used. No server change, so no redeploy.
- Test: `browser-stalelang.js` (fails on b239, passes on b240).

## Done in b239 — Finance is a place of its own; View as loads (practice)

- **Finance is somewhere you go, not a window** (Gita: "its own app within the
  larger app"). `#finPage` in `<main>`; `body.fin-mode` hides the rest of the
  page and gives Finance its own colour (blue masthead and wash). Its address
  is `#finance/<section>/<place>` (`finGo`, `finParseHash`, `popstate`), so
  Back, Refresh and a bookmark all land in the right place; `goTo` anywhere
  else leaves it.
- **Sections**: Overview, Reports, Compare, To do, Reimbursement Settings
  (`FIN_SECS`), plus Add an expense and ← Back to the app. The To do and the
  settings draw into the page (`finHost`, `finRoot`) instead of a window.
- **Walking down**: the bar at the top is the same season › region › event
  path as the rest of the app, as dropdowns, and every name in the Overview
  table opens that place. Overview shows one level down (seasons › regions ›
  events › titles); Reports and the To do count only that place
  (`finScopeF`, `finScopedTodo`; Code.gs `financeFacts_` now gives each
  pending payment its `eventId`); Compare starts at the same kind of place and
  its group; Settings starts at that place.
- **Finance people** (who still get "Not quite yet" elsewhere) land on the
  Finance page; the red "sign in" status is hidden there.
- **View as loaded nothing**: the tab kept Universal's season, the server
  answered with the viewed person's, and `pull` threw every answer away as out
  of date. Viewing now keeps its own place (`posKey` + `_va`, cleared each time
  View as starts). Test: `browser-expenses.js` reproduces it (fails without the
  fix) with Universal looking at another season.
- Tests: `browser-expenses.js` (66), `browser-sellers.js` updated for the b238
  menu (View as in App Development; Record Costs is Expenses in practice).

## Done in b238 — Expenses and the Finance section, in the practice space first

"Cradle to grave" cost tracking, all of it (spreadsheets apart), **only in the
practice space** for now: the live server refuses every expense and finance
action ("being tried in the practice space first", `handle` in expenses.js)
and the live page shows none of it (`PRACTICE` gates the buttons). Going live
is removing that gate once Gita is happy.

- **Record Costs and Expenses are one form** (practice). Record Costs, its
  ✏️ and the consignment group's cost button all open Expenses, which gains
  Record Costs' *Kind of expense* (`COST_CATEGORIES`, now also Travel, Food,
  Printing and shipping, Venue, Supplies), *Paid with* (the place's payment
  types) and *Whose cost* (ours or a consignment group's). An expense at an
  event or a region (not a season-wide one, not a declined one) is mirrored
  into `_costs` (`syncCost`, through the owner's `saveCost`), so every net
  total, the consignment balances and the reports take it off exactly as a
  cost; declining or deleting it removes the cost. Costs recorded before are
  taken in as expenses, "recorded by Record Costs" (`adopt`).
- **📈 Finance section** (menu › Finance, Finance / Finance Assistant /
  Universal; `financeModal`; data from Code.gs `financeData_` via `finData`,
  all in dollars at each place's rates): *Overview* — tiles (books sold, gross
  sales, collections, donations, pending payments, consignment, expenses, net,
  margin, pending reimbursements) and the same at every level, season ›
  region › event, with season/region/event and date filters. *Reports* — rows
  by up to three of season, region, event (or their series), month, week, day,
  title, language, kind of book, seller, payment type, sale/pre-order/donation,
  ours or a group, kind of expense, person, expense status; any figures; the
  same filters and a search; sort by any column; ⬇ CSV; kept on the device
  (`tbs_finrep`). *Compare* — seasons, regions or events that repeat (matched
  by name without the year, regroupable by Finance; setting `finSeries`) side
  by side with ▲▼ change, all together and the average. Net = collections −
  consignment − expenses; margin = net ÷ (collections − consignment); book
  printing costs are not in the app.
- **👁 View as** (App Development, practice, Universal only): a person from a
  searchable list, or any role at any place. The server answers as them for
  this tab only (`viewAs` in core.js; `va` on every request, `VIEW_AS` in
  sessionStorage); a bar across the top says who, with Someone else and Stop
  viewing.

- **🧾 Expenses** (menu › Money, for everyone: Universal, every signed-in role,
  regional and sales links; `expensesModal`). Choose *For record-keeping* or
  *For reimbursement*; date (today), what for, amount and currency (the
  region's own to start), receipts, notes, where (the place you are on, or a
  choice of the places your roles reach). The name is logged automatically
  (the display name; on a link, the name the phone was given).
- **Receipts**: 📷 Take a photo (the phone's camera), 📎 Add photos or PDFs
  (several), drag and drop, or paste a screenshot. Each is sent the moment it
  is added; photos are shrunk on the phone first (long side 1800px, JPEG);
  up to 8 MB a file, 10 per expense. Opened in a viewer with ⬇ Download.
  **Kept on the Cloudflare server, in a table of their own (`receipt`, in
  expenses.js), split into parts under the database's 2 MB limit.** Nothing
  copies them: not the state, not the spreadsheet copies, not the practice
  space. Receipts of an expense never saved are cleared after a day (the
  hourly housekeeping).
- **For reimbursement** adds *Pay me back by* and *Pay me back in*, then what
  that way needs (`METHOD_FIELDS`, expenses.js): Cash → phone/WhatsApp; UPI →
  UPI ID (+ name); Zelle → email or US phone + name; PayPal → email or phone;
  Wise → email or Wisetag + name; Venmo → @username (+ last 4 digits); Cash
  App → $Cashtag; Revolut → Revtag or phone (+ name); Bank transfer → holder,
  IBAN/account, SWIFT/BIC (IFSC, sort code, routing), bank. Any other payment
  type the tour has asks for its account details as text. The ways offered are
  Cash, every payment type the tour takes anywhere (not Card, Gift or Other)
  and Bank transfer. The currency to be paid in starts at the way's own
  (UPI → INR, from Edit Payment Types). The details are remembered on the
  device for next time (`tbs_payto`).
- **Your expenses** under the form: status (Recorded / Waiting to be paid back
  / Paid back / Declined), Edit and Delete until paid back.
- **💼 Finance To do** (Finance, Finance Assistant, Universal;
  `financeTodoModal`): *Reimbursements pending* (with how to pay each person,
  totals by currency, ✓ Mark paid back with an optional reference, Decline
  with a reason, Back to waiting), *Payments pending* across every season
  (Code.gs `financeFacts_`: name, phone, book, what is owed, place, sold by),
  and *Every expense*; one search box for all three.
- **On someone's behalf** (Finance and Universal): "Whose expense?" is a
  searchable list of everyone with a role; their name goes on it, Finance's
  as who entered it, and it shows in their own list.
- **⚙️ Reimbursement Settings** (Finance and Universal change; the Finance
  Assistant sees): *By place* — everywhere, each season, region and event:
  each way On, Off or "As above", and the currencies "As above" or only
  chosen ones. *By person* — a person's own setting wins over every place.
  No currencies set anywhere: the region's own. Kept in the setting
  `reimbRules`. The server refuses a way or currency that is not offered.
- **Finance, Seasonal Leads and assistants**, who still see "Not quite yet"
  until Stage 2, now get Expenses (and Finance its To do and settings) on that
  page; its windows open above it (`body.has-na`).
- **Server**: `server/src/expenses.js` (core.js routes `exp*` and `receipt*`
  actions there before the role check). Records in the app table
  `_expenses` (Code.gs's store, so they travel with the practice copy and
  the spreadsheet bridge; in `TABLE_KEYS_`). Code.gs is unchanged except
  `financeFacts_()` (read-only) and the build number.
- **Not done yet**: not live (practice only); not in the spreadsheets or the
  Activity Log; no emailing of receipts into the app; the Permissions window
  has no rows for expenses; no printing cost per title, so margins are after
  expenses only.
- Tests: `test/expenses.js` (71 checks, in run-all), `test/browser-expenses.js`
  (55: the Seller's form, UPI ID, the receipt, Finance's page, To do, receipt
  viewer, paying back, on behalf, settings, phone width, the merged form and
  its cost, Finance overview/reports/CSV/compare, View as and stopping it).

## Done in b237 — no false "update the Google code" warning

- The warning compared the page's build with the server's and fired on any
  difference. After b236 merged, a browser still showing the b235 page saw a
  b236 server and was told to redeploy Apps Script, which was wrong twice over:
  the server is on Cloudflare and deploys itself, and the fix was a refresh.
- Now (`checkServerBuild`, `NEEDS_SERVER`, `buildNo`): the server older than
  the page needs gives "the server is still on bX; this page needs bY",
  usually a moment's wait after a merge, else look at the Actions tab. The
  server newer than the page gives "A newer version of the app is out" with a
  Refresh button. Any other difference says nothing.
- Page-only builds no longer bump `SERVER_BUILD` (this one does not), so no
  server deploy runs for them.
- Test: `browser-round2.js` (older server, newer server, a page ahead of a
  server that is new enough).

## Done in b236 — menu sections start folded; no counts on Costs and Consignment; To do scrolls; panels pack and end level

- **Menu sections start folded** (`SN.opened`): the menu itself already
  started closed (b235), but every section in it was open, which read as the
  menu starting open. Now each section starts folded on every page load, and
  opening one lasts until the page is left. Nothing about the menu is kept on
  the device any more (`tbs_sidenav` is cleared).
- **No count on Record Costs or Consignment Books**, in the menu and the
  classic panel.
- **To do scrolls on a computer.** Since b235 several kinds show one under
  another; each list had no height of its own to scroll in, so the panel cut
  them off at its foot. They now sit in one scrolling area (`.todo-scroll`).
- **Distribution by Title has the card/list switch** on the season and
  Earthly HQ pages too (`#seasonTitlePanel`, `#hqTitlePanel`; `sectionViews`
  also knows a panel by its fold name when it has no id).
- **Panels side by side, the owner's two rules, in order** (`foldRows`):
  1. two shorter panels that fit one above the other beside a taller one
     stand there together (the next two beside a tall one, or this one and the
     next beside a tall one after them; "fit" allows `FLOW_FIT` = 40px over);
  2. otherwise they pair as before, and the shorter one stretches so
     neighbouring columns end level. A panel with a height limit (To do and
     its neighbours) is let out to the foot of its row.
  How: `.flow` is now a grid of 40 narrow columns (a pair 20 + 20, the shelf
  and sales log 23 + 17, as before); `foldRows` measures each open panel at
  half width (`.f-measure`), then gives each its row and columns, and re-runs
  when the window is resized. Phones: one column, as before.
- Tests: `browser-fold.js` (two short panels stacked beside a tall one; every
  column ends level, season and region), `browser-sellers.js` (sections start
  folded, also after a reload; no counts; To do scrolls to its last item; the
  season's Distribution by Title switch).

## Done in b235 — the left-hand menu goes live; To do filters and its own report; HANDOVER.md is now TRACKER.md

- **The menu is live for everyone** (`SIDE_NAV = !CONFIG.CLASSIC_ADMIN`). The
  old four-column App Admin panel only comes back with `CLASSIC_ADMIN: true`
  in the config, which the older browser tests use because they drive it;
  `browser-sellers.js` covers the menu (its live pages open without it).
- **Look, the owner's notes**: section headings not bold; the sub-items
  indented under their heading (a thin line down the left) and dark grey
  (#4A4A4A), so they read as a sub-menu.
- **Always starts closed**, on phones and computers: "Keep the menu open"
  lasts until the page is left (it is no longer remembered); which sections
  are folded still is.
- **To do: filters, not sorting.** Each kind (Pending Payments, Pre-Orders,
  Change We Owe, Counts to Look Into) is an on/off filter with its colour and
  count, all on to begin with (kept on the device, `tbs_todo`). What is shown
  is listed kind by kind under small headings, newest first. The sort buttons
  are gone.
- **To Do report** (📋 on the panel, `todoReport`): kind by kind, in the
  panel's order, with a tick for each kind (pending payments, pre-orders as
  counts and/or who is waiting, change we owe, counts to look into); ticked to
  begin with is what the panel shows, then whatever was ticked last time. The
  report window is now shared (`reportDialog`) by the full report and this one.
- **HANDOVER.md → TRACKER.md**, at the owner's request.
- Tests: `browser-sellers.js` (the live menu, its look, starting closed, the
  To do filters and report), `config.test.js` / `browser-cloudflare.js`
  (`CLASSIC_ADMIN`).

## Done in b234 — the left-hand menu, round two (practice); Permissions; build number for Universal only

- **The menu (practice only, `SIDE_NAV`)**, reworked to the owner's notes:
  the page's own cream (`--cream`), one accent, no rainbow. Like Cloudflare's:
  a 56px column of section icons that opens out to 268px while the pointer is
  over it (a first tap on a touch screen), icons and words together; each
  section a dropdown (folded state remembered, `tbs_sidenav`); "Keep the menu
  open" pins it beside the page. Phones: the round ☰ (`#snFab`, outside the
  menu so it stays on screen) slides it in.
- **Sections, in order** (`SN_SECTIONS`, names in `SN_ITEMS`): Books ·
  Money · <Season/Region/Event/Earthly HQ> Admin (the place's actions) ·
  Advanced (Spreadsheets, Specialty Reports, Sales Links, App Access — was
  People) · App Development (Edit Wording, Practice, Permissions) · Settings
  (Profile: the 👤 You window, titled Profile) · Support (was App and Sales
  Support) · Sign Out at the foot. Each row is the panel's own button
  (`snRow`, its attributes kept), so it does exactly what the button does.
- **Activity Log** moves to the top bar in the new layout (`snTopActivity`).
- **Card or list, per section** in the new layout (`sectionViews`, `VIEWS`,
  `tbs_views`): a ☰/▦ switch on each panel heading that has cards; the
  top-bar button is hidden there. The list-view CSS now keys on `.list-view`
  on any ancestor, so it works for the body (live) and for one panel.
- **🔐 Permissions** (Universal; in the menu, App Development): the table of
  PERMISSIONS.md §4 (`PERM_CAPS`, 40 rows × 9 roles, in people.js) to change
  **by level** (a role) or **by person** (an override that wins over their
  roles). Server actions `permGet` / `permSet` (core.js, Universal only),
  kept in `permTable` / `permPeople` (cleaned: only known rows, roles,
  values). Saved now; **not yet enforced** — the app follows it once Stage 2
  is built, as the window says.
- **Build number and status light** (live too): Universal only
  (`body.is-u`); others see the status only when something is wrong
  (`.status.warn`, set by `setStatus('bad')`).
- Tests: `browser-sellers.js` (the menu: colour, order, hover, fold, pin,
  Track Cash, Profile, Permissions saved by level and by person, refused for a
  Seller; the view switch; the phone ☰; build number hidden for a Seller).

## Done in b233 — a left-hand menu for the admin buttons (mock-up, practice space only)

- **Only in the practice space** (`SIDE_NAV = PRACTICE`), for the owner to try
  before deciding. The live app keeps App Admin as it is.
- The App Admin buttons are now built as families (`drawAdmin(fams)`: admin,
  money, books, location; `ADMIN_FAMS` names, icons and colours) and drawn
  either as the old four-column panel or, in practice, as a menu
  (`renderSideNav`). Same buttons, same actions.
- **Wide screens (900px and up)**: a narrow dark strip down the left (☰ and
  one icon per family); a tap opens the menu at that family. 📌 keeps it open
  beside the page (the page moves over); otherwise choosing an action, ✕, or
  tapping outside folds it away. The place you are looking at comes first, with
  its own actions (Edit/Close/Delete…), headed by its name. Each family folds
  (remembered, `tbs_sidenav`, with the pin).
- **Phones**: no strip; a round ☰ at the bottom left slides the menu in.
- Tests: `browser-sellers.js` (in practice: strip, menu, an action from it,
  pin; on a phone: the ☰ and no sideways scroll; the live app unchanged).

## Done in b232 — one To do panel; the local price on the shelf; phones lose heading notes

- **To do** (`#todoPanel`, `renderTodo`): Pending Payments, Pre-Orders
  (awaiting delivery), Change We Owe and Counts to Look Into are one panel, a
  tab each with a red count, each kind in its own colour (tab and the left
  edge of its items: red, blue, gold, purple). Empty tabs are left out. Sort
  like the sales log: Date / Name (Title for counts) / Amount (Books for
  pre-orders, Difference for counts), tap again to reverse. The tab and sort
  are kept on the device (`tbs_todo`). The 📋 report buttons of the chosen tab
  sit on the heading. The old ids (`#pendingPanel`, `#prePanel`,
  `#changePanel`, `#countPanel` and their lists) are the tabs' panes now.
  Books in Transit and Pre-Orders to Fulfill for Other Regions stay as they
  were.
- **Shelf cards show the local price only** (the region's first currency); the
  sell window lists every currency's ("Price: 35 € · $40").
- **Phones**: the small grey notes beside panel headings are hidden, except
  Sales by Seller's instruction (`.hint.keep`).
- The owner kept, on purpose: Totals by Payment Type as it is, the shelf
  cards' "Stored At / At events / Total / In transit" lines, the header, and
  the sales log as long as the panel beside it.
- Tests: `browser-sellers.js` (tabs, counts, colours, panes, sort, the prices).

## Done in b231 — the practice space

- **A second server, tbs-practice** (`[env.practice]` in wrangler.toml, deployed
  by the same workflow, `wrangler deploy --env practice`): the same code, its
  own Durable Object, so its own database. `PRACTICE=1` there.
- **Its copy**: on its first request (and on **Start over**, action
  `practiceReset`, Universal only) it asks the live server for
  `practiceExport` with `LIVE_SECRET`; live answers only to its own
  `PRACTICE_SECRET` (read-only: tables, settings without the spreadsheet
  bookkeeping, people and roles, the owner list). `importAll` replaces the
  records; `auth.replacePeople` the people and roles (its own sign-ins stay).
  The owners come across as `liveOwners` (auth's `adminEmails` can now be a
  function). The revision moves past both, so every phone refetches.
- **Never the spreadsheets**: no `REPORT_URL`/`REPORT_SECRET` on practice
  (forced empty in worker.js), and its sheet actions answer "The practice space
  does not build spreadsheets".
- **The page**: `?practice` in the address points it at the practice server
  (`practiceUrl`: the live address with tbs-practice for tbs-server, or
  `CONFIG.PRACTICE_URL`) and prefixes every localStorage/sessionStorage key
  with `practice:` (Storage.prototype), so the saved state, the unsent saves
  and the sign-in never mix with live. A striped banner (`practiceBanner`, with
  when it was copied, from `practiceInfo`), **Start over from the live app**
  (Universal), **Leave practice**; the tab title starts "🧪 Practice". App
  Admin has **🧪 Practice Space** (opens it in a new tab) / **Leave Practice
  Space**.
- **Owner's setup, once**: `PRACTICE_SECRET` on tbs-server and `LIVE_SECRET`
  on tbs-practice, the same phrase (server/README.md, "The practice space").
- Tests: `test/practice.js` (15, in run-all: the copy, the people, nothing
  reaches live, no spreadsheets, start over, the phrase), `browser-sellers.js`
  (the page in practice: banner, the practice server, storage apart).

## Done in b230 — Sales by Seller in half a screen; more dropdowns; out-of-stock in one tap

- **Sales by Seller** is a half-width panel now (no `data-full`), one line per
  seller: **Big Books** sold (pre-orders included), **Adventures** sold, and
  everything **collected** (every payment type, digital included). The arrow
  (`sbtoggle`, `SB_OPEN`, kept open across redraws) opens their cash:
  **Received** (cash taken), **Pending submission** (still with them),
  **Submitted** (handed to the lead, waiting or confirmed, plus what Track Cash
  shows was moved on — "forced via an admin"). Same split as b229
  (`cashPeopleAt`). No totals, as asked. Heading note: "To manage seller cash,
  click dropdown arrow."
- **Handover requests** are answered inside the seller's dropdown (Received /
  Not received); the separate "Cash Handed Over" panel is no longer shown
  (`renderHandovers` hides it). A **red badge** with the number waiting sits on
  the seller's line.
- **Distribution by Title**: the per-place bubbles sit behind "▸ At N places",
  as in the Warehouse Overview (`chipsToggleHTML`, shared; keys `wo:` / `dt:`).
- **Edit Book Display**: "Hide all out of stock books (N)" at the top (no
  copies on this shelf); once they are all hidden it reads "Show all out of
  stock books (N)". Applied with Save, like the ticks.
- Tests: `browser-sellers.js` (the lines, the badge, the dropdown, answering
  there), `browser-lang.js` (Distribution dropdown, out-of-stock button).

## Done in b229 — Sales by Seller in step with Track Cash

- **The owner's rule:** if Track Cash shows a place's money has gone on (say,
  all of it is with the Global Coordinator), nobody at that place can still be
  holding it. Before, Sales by Seller only knew about seller → Event Lead
  handovers, so a seller kept "still holding" cash that Track Cash showed long
  gone.
- **One split, used everywhere** (`cashPeopleAt(loc)`): per place and
  currency, what has left the place in Track Cash (`cashCollected −
  cashBalance`) comes first out of what Event Leads confirmed receiving, then
  out of handovers still waiting, then out of what sellers still hold, in
  proportion to what each holds. What is left with each seller, plus the
  Event Lead's, is what Track Cash shows still at the place. Money moved INTO
  a place belongs to the place, not to a seller ("Brought here from other
  places in Track Cash").
- **Sales by Seller** now has a **Moved on** column and a footer: what is with
  the Event Lead(s), and "Still at <place> in Track Cash", which is Track Cash's
  own figure, so the panel visibly adds up to it.
- **A Seller's "My cash"** uses the same split, so their tile and the
  handover button agree with Track Cash.
- **Track Cash** shows under each place who holds its cash ("held by Tulasi
  35 € · Event Lead 70 €"), from the same split.
- Client only; the build number moves in Code.gs too, so the two match.
- Test: `browser-sellers.js` (moving €50, then the rest, to the Global
  Coordinator; Tulasi's own tile; Track Cash's "held by").

## Done in b228 — closed places sorted A to Z; in transit at Earthly HQ; the toggle hides

- **Closed events and regions drop below the open ones, in A-to-Z order**
  (`closedLast_` in Code.gs, applied in `eventsOrdered_` and
  `regionsOrdered_`, so the app's lists and the spreadsheet tabs agree). The
  open ones keep their chosen order; reopening puts a place back where it was.
  The app shows a close at once (`closedLast` in the optimistic close).
  Golden: the one difference is browser-round4's closed Festival now listed
  after Yoga Studio.
- **In transit at Earthly HQ**: the HQ overview adds up every season, but the
  list it opened was drawn from HQ's own batches only, so it was empty. It is
  now drawn the way the overview is (`withRollup`), read-only there (the
  arrival and edit buttons belong to the batch's own season). Each batch, at
  HQ and in a season, has **Go to <place> ›**, which opens where it is heading,
  switching season if needed (`goToShipHTML`, action `gotoship`, via
  `gsGoPlace`).
- **The region toggle really hides the bubbles now**: `.wo-chips` set
  `display:flex`, which beat the `hidden` attribute, so b227's toggle changed
  its arrow but the bubbles stayed. `.wo-chips[hidden]{display:none}`. (b227's
  test looked at the attribute, not at what showed; the tests now measure.)
- Tests: `test/closedorder.js` (in run-all), `browser-hq.js` (HQ in-transit
  list, Go to Barcelona, the toggle hides and shows).

## Done in b227 — coloured Sell buttons; Add Stock by title, then language; Warehouse Overview

- **Sell buttons in the language's colour**: a shelf card's Sell button takes
  its language's colour (`--lc`, the same as its label and stripe): English
  blue, Russian red… A title with no language keeps Deliver's green. CSS only
  (`.book.has-lang .sell-btn`). Selling stays one tap per title-and-language.
- **Add Stock: a title, then its language.** The table of every title is now
  lines: choose the title (each once, grouped Big Books / Adventures / Other /
  Consignment: what the place carries first, then the rest of the catalogue),
  then its language; the number boxes appear for that line, and a fresh empty
  line opens below (`lines`, `linesHTML`, `stockTitles`, `stockTitleKey`: the
  name before the brackets, plus the consignment group). A language already on
  another line is greyed out. A title the region does not offer yet is marked
  "new here" and switched on for it when saved (replaces "Other Books").
  **＋ A new book…** (title, language, kind) and **＋ A new language…**
  (adds "Title (Language)" with the title's kind) are in the lists themselves
  for Universal (replaces "My Book Is Not Listed"); either is added to the
  catalogue at once and chosen on that line. New titles have no price until one
  is set in Edit Region. On a phone the two lists take the full width with the
  numbers beneath.
- **Warehouse Overview**: "+N in transit" opens a list of every batch carrying
  that title: how many, from where to where, with the batch's card
  (`transitOfBookModal`). The per-region chips sit behind "▸ In N regions"
  (`wotoggle`), closed by default and kept open across redraws (`WO_OPEN`).
- Tests: `browser-addstock.js` (rewritten for the lines, plus a new language
  and a new book), `browser-lang.js` (Sell colours, the toggle, the transit
  list), `browser-round3/4/7.js` and `browser-speed.js` adjusted.

## Done in b226 — Stage 4: the spreadsheets

- **The note** (the owner's words, `SHEET_NOTE_`) is the first line of every
  tab the app draws: `paintSheet_` puts it on row 1 and moves everything else
  down one (band/head/total rows and the money/integer ranges are shifted for
  it; four frozen rows now). The AI Descriptions file is for writing in, so it
  has none. Golden: `node test/golden.js --strip-note` shows each tab is
  otherwise unchanged.
- **Sharing, per person.** The server works out who should have each file
  (`people.js` `sheetsWanted`: Universal and ADMIN_EMAILS edit; F/FA view all
  but the wording file; SL/SA their season's; RL/RA their region's and its
  consignment groups'; EL/S none) from `sheetFilesForAuth_()` (Code.gs: every
  file made, from `_meta`, with its season and region). It goes to Google with
  every `reportExport` as `share`; Google's `shareSpreadsheets_` (run in
  `withMirror_`) makes Drive match: removals first, then additions; never the
  script's own account. It records whom it added (`_meta` `sheetShare:<fileId>`),
  so only those are ever removed — people shared by hand stay — and the whole
  wish (`sheetShareSig`), so an unchanged wish costs no Drive call. Errors (an
  address that is not a Google account) are kept in `sheetShareError`, not
  retried every minute. More than 2 minutes of Drive calls: the rest next run
  (`shareAgain`).
- **When it runs:** the minute tick is no longer idle when `shareDirty` is set:
  on adding or removing a role (People, and the old admins actions), after a
  run that made a new file (a `*SheetId` key written back), or after one that
  ran out of time. A run that never reports back gives it back too.
- **Spreadsheet Links** (was "Spreadsheet folders"): Universal sees it as
  before, plus **⇪ Rebuild spreadsheets now** (the top bar's Sync sheet button
  is gone). Anyone else signed in (a Regional Lead today; the button is in the
  coordinator panel when signed in) gets `driveMap` cut to their own files,
  with no folders (`people.sheetsMapFor`, in core.js), and a "make a copy"
  hint. The cached map on the phone is kept per person.
- Wording that said "Sync sheet" now says "Rebuild spreadsheets now".
- Tests: `test/sharing.js` (19, in run-all), `test/bridge.js` (a new file is
  shared on the next minute), `test/seam.js` (`shareSpreadsheets_` may use
  Drive), `test/browser-sellers.js` (Spreadsheet Links for the owner and a
  Regional Lead).
- **For the owner to do after merging:** nothing new in Google's settings: the
  Drive permission is the one used to file the spreadsheets. Paste the new
  Code.gs as usual. People with roles are given their files within a minute or
  two; Google may send them its usual "shared with you" email.

## Done in b225 — Stage 3, part 3: an event's own prices; consignment for one event

- **Event Prices** (💲 button in Books, at an event; admin and Regional
  Lead): an event can ask its own price for a title, per currency. Only what is
  typed there is the event's; a blank box shows the region's price in grey and
  uses it, so later changes to the region's prices still reach every title the
  event has not set. Stored in `_prices` with the event's id in the `regionId`
  column (`doSetEventPrices`, action `setEventPrices`, COORD_EXTRA, checked to
  the coordinator's region; a blank removes the row). Sent as `eventPrices`
  (only what is set, only once any is). App: `priceIn` = `eventPriceIn` at an
  event, else `regionPriceIn`. A bundle at the event is split by the event's
  prices (`priceAtLoc_`). Deleting an event (or its season) takes its prices.
- **Consignment groups can belong to one event**: `_partners.eventId`
  (column added the first time a group is tied to an event). "Their titles are
  offered at": every event in the region, or only at one. Such a group's
  titles are on that event's shelf only (`partnersHere`), unless copies are on
  another event's table (stock is a fact). The region lists every group, with
  "Only at …". Deleting the event returns its groups to the whole region.
- Not yet: an Event Lead setting their event's prices (they work through a
  sales link until Stage 2; the table gives them "own").
- Tests: `test/eventprice.js` (17, in run-all), `test/browser-sellers.js`.
  Golden identical.

## Done in b224 — Stage 3, part 2: a count that does not match is flagged, not written over

- **Closing an event or region** with counts that differ from the records no
  longer rewrites the stock. Each differing title goes into `_mismatches`
  (expected, counted, note, who counted) as **open**, and the place shows it
  as outstanding (`outstanding.counts`), like unpaid sales.
- **Counts to Look Into** panel (bottom row; not for Sellers): what was
  expected, what was counted, by whom. The next person up answers (an event's:
  its Regional Lead; a region's: Universal until the Seasonal Lead exists in
  Stage 2) with a reason, required: **Accept the count** applies the
  difference (counted − expected) to today's stock, logged as an ADJUST stock
  move "Closing count accepted — reason"; **Settled** leaves the stock (the
  error was found, e.g. a sale recorded on paper). Server: `doMismatchAnswer`
  (action `mismatchAnswer`, COORD_EXTRA). Everyone else sees "with …".
- `_handovers` (b223) and `_mismatches` are now in `TABLE_KEYS_`, so they
  are copied by copyToCloudflare / cutover.
- Tests: `test/countflag.js` (13, in run-all), `test/browser-sellers.js`
  (the panel, a reason required, accepting). Golden: one difference, the
  `closeLocation` in extra.jsonl now leaves an open count instead of
  adjusting stock.

## Done in b223 — Stage 3, part 1: who sold it, My sales, cash handover, Sales by Seller

- **Sales remember who made them**: new `_sales` column `soldById` (the
  signed-in person's address; empty on a link). Code.gs takes it only from the
  server (`_meEmail`, from `setTrustedWho_`, which core.js now calls for
  Universal too, with `email`, `name` and `grant` — the role acted in). Edits
  keep the original seller (`doEditSale`, and `doEditBundle` via `_keepSeller`).
  The state sends `soldById` only on sales that have one.
- **A Seller** (role S, or any sales link) sees **My sales** (their own books,
  `isMine`: by sign-in, else by the name on the link) and **My cash** (cash
  they took, less what they handed over) instead of the event's tiles
  (`sellerTilesHTML`).
- **Cash handover** (`_handovers`, actions `handoverCash` / `handoverAnswer`):
  "Hand your cash to Gita" — the Event Leads of the event come from the server
  (`me.grants[].leads`). It waits until the person it was handed to (or, when
  none was named, an Event Lead there; or Universal) taps Received or Not
  received; never the seller themself. Allowed after the event closes, like
  settling. Not in the Activity Log (a record of its own, like sales).
- **Cash Handed Over** panel (bottom row) for leads, and **Sales by Seller**
  (region and event pages, not for Sellers): books sold, pre-orders, cash
  collected, handed to lead, still with them; per event at a region.
- Test: `test/browser-sellers.js` — a new, faster harness: the real page
  talking to `server/src/core.js` in-process, with a stand-in Google sign-in.
- Golden: identical apart from the new column (`--ignore-col=soldById`).

## Done in b222 — Stage 0 and 1 of logins: people, roles, sign-in for everyone

**The rules live in `docs/PERMISSIONS.md`** (Stage 0): the nine roles, who may
give which, the full permission table the owner decided, the new features that
come with it, and the stages. Read it before touching anything about access.

Stage 1, built here:
- **Everyone signs in with Google.** A person holds any number of roles, each
  tied to a place (Seller at an event, Regional Lead for a region, Universal
  everywhere…). Server: `server/src/auth.js` tables `person` (display name,
  Google name) and `grant_` (email, role, place). The old `admin` list is moved
  to Universal roles on first start and emptied. `ADMIN_EMAILS` owners are
  always Universal.
- **The rules are in `server/src/people.js`**, pure functions over the places
  (Code.gs `placesForAuth_`: every season, region and event, and whether
  closed): who may give which role where (`mayGive`: below your own, within your
  reach; an Event Lead only Sellers; only Universal gives Finance roles), who
  may remove (`mayRemove`: the same, an Event Lead only Sellers they added,
  never your own role), who sees whom (`maySee`), whether a role is in force
  (`activeState`: not while its place or anything above it is closed — reopening
  brings it back).
- **Until Stage 2**, a role works through the nearest permission set Code.gs
  already enforces, never a wider one (`worksAs`): Universal = the full app,
  Regional Lead = the regional link for its region, Event Lead and Seller =
  a sales link for their event. Assistants, Seasonal Lead and Finance roles can
  be given but show "Not quite yet" until Stage 2.
- **Who is asking is told to Code.gs directly**: core.js calls
  `app.setTrustedWho_(who)` just before handing over the request, and `handle()`
  uses it up at once. Nothing in a request can claim it, and it never outlives
  its request. On Google nobody sets it.
- **Names on everything**: for any signed-in request core.js puts the person's
  display name in `by`, so sales (`soldBy`), cash and the Activity Log carry it,
  whatever the page sent.
- **Several roles**: the page sends the chosen one as `g` (`ACTING`, chosen in
  "You", the 👤 button). The server uses it if it is theirs and usable, else
  their first usable one, and says which in `acting`.
- **App**: 👥 People (replaces 🔑 Admins) — people and roles within your reach,
  sign-in requests (answered by giving a role), add someone / another role
  (only the roles and places you may give), remove (✕), emergency sales links
  for your events (Event Lead and above; an event key, works as a sales link,
  stops at the event's close). 👤 You — display name, which role to work in,
  sign out. "Not quite yet" — signed in, nothing usable, each role and why.
- Server actions (core.js, not Code.gs): `me`, `setMyName`, `peopleList`,
  `peopleAdd`, `peopleRemove`, `peopleDecline`, `emergencyLink`. The old
  `admins*` actions still work for Universal people (old pages).
- Regional and sales links are untouched and keep working.
- Tests: `test/people.js` (47 checks, in run-all), `test/browser-cloudflare.js`
  (now 33: the People panel, a Regional Lead signing in, choosing a role,
  "Not quite yet"). That test needs `npm ci` in `server/` first.

Not done (later stages, see PERMISSIONS.md §6): every rule of the table
enforced (Stage 2), My sales / cash handover / sales by seller / count
mismatches / event prices and consignment (Stage 3), spreadsheets (Stage 4).

## Done in b221 — each language has its colour

- A title names its language in brackets at the end, "Sri Radha (Russian)".
  The app reads that word (`bookLang`) and shows the title as "Sri Radha"
  with a small coloured label "Russian" (`bookTitleHTML`), and a 4px stripe
  of the same colour down the left of its card (`langCard`, class
  `has-lang`, colour in `--lc`). Same language, same colour: every Russian
  book reads as one family.
- Colours (`langColor`) are handed out in the order languages first appear
  in the catalogue (`STATE.books`), so a new language takes the next colour
  and none of the others move. Eight soft hues (`LANG_HUES`); a ninth
  language takes the first again, deeper (0.78× per round), so no two match.
  Nothing to set up: add "Sri Radha (Hindi)" and Hindi has a colour.
- Where: shelf cards (label and stripe), Distribution by Title and Warehouse
  Overview cards (label and stripe), the mini cards in dropdowns, the sales
  log, Multiple Books, the stock and transfer tables, Edit Book Display and
  the pre-order list (label). Sentences and messages still use the full name.
- A title with no language in brackets has no label and no stripe. Book names
  are unchanged, so reports and spreadsheets still read "Sri Radha (English)".
- Test: `test/browser-lang.js`.

## Done in b220 — ⌂ marks Seasonal HQ as home

- The region picker's first choice reads "⌂ Seasonal HQ", marking it as the
  season's home page. ⌂ is the old home button's symbol; 🏠 is already the
  Warehouse's, at the head of the place picker. `test/browser-search.js`
  checks the wording.

## Done in b219 — Earthly HQ's book order shows everywhere

- **Reported:** saving the book order at Earthly HQ (Edit Book Display) said
  "saved" but the order did not show. It was saved (on the HQ region, as
  for any region) and HQ's own shelf and Distribution by Title followed it;
  the Summaries Portal did not, even after a reload. The summaries are drawn
  as a "season" with no region chosen (`rollupState`), which reads the
  season's order, and HQ's was never handed to it. Now `rollupState` passes
  HQ's order as `seasonBookOrder`.
- **Found with it:** `renderWarehouseOverview` listed the catalogue's order
  whatever had been set, at the season as well as at HQ. It now uses
  `inRegionOrder` (the season's order; HQ's in the summaries).
- Test: `test/browser-bookorder.js` (its HQ and overview checks fail on b218).
- **Not changed, found while checking:** the spreadsheets list titles in the
  catalogue's order everywhere. `booksForRegion_` / `bigBooksFor_` would
  order them but are not called, and `booksForRegion_` reads `reg.bookOrder`,
  which `regionById_` does not return.

## Done in b218 — pre-order any title in the catalogue

- **"+ Pre-Orders (Unlisted Titles)"** now offers every title in the
  catalogue that is not on the shelf where you are, in two groups: "Hidden
  here" (carried by the region, hidden at this spot, as before) and "Not
  carried in this region yet" (the rest of the catalogue). Another group's
  consignment titles are left out: not ours to promise. The button shows
  whenever either group has something (`unlistedTitles()`).
- **Pre-ordering a title the region does not carry switches it on for the
  region** (server `offerTitleInRegion_`, inside `doSell`, so a sales link can
  do it too), just as pre-ordering a hidden title puts it back on the shelf.
  It then shows on the shelf (0 in stock), in Distribution by Title and on
  the region's spreadsheet. The app shows it at once: `regionBooks` counts a
  title pre-ordered in the region as carried (`preorderedIn`, worked out
  once per state).
- The region may have no price for such a title: the amount is typed in.
- Test: `test/browser-preunlisted.js` (admin and sales link).
- Found while testing, not changed: with 1,500 open pre-orders at one event a
  full redraw takes about 1.6 s, the same before b218.

## Done in b217 — panels flow two by two

- The owner's follow-up to b216: when a panel folds, the open panels after it
  pair up afresh, two by two, instead of its neighbour taking the whole width.
  Region page, Warehouse folded: its bar, then Sales Log · Distribution by
  Title (or Pending Payments, whichever comes next), and so on.
- How: each group of rows sits in a `.flow` (a wrapping flexbox:
  `#seasonFlow`, `#salesFlow`, `#summaryFlow`), and the old row wrappers
  (`.cols`, `.cols-2`) are `display: contents` inside it, so a panel can pair
  with one from the next row. Their ids and show/hide are unchanged.
  `foldRows()` gives each panel its width: a pair (`f-half` / `f-half2`, the
  second grows into what is left so rounding never wraps it), the shelf
  beside the sales log (`f-inv` / `f-log`, the old 1.15 : 0.85), or the whole
  line (`f-full`: folded, left without a partner, or `data-full` — the two
  warehouse overviews). A flow with nothing showing is hidden (`.empty`).
- Beside anything but the shelf, the sales log has no height to borrow: it
  takes its own, up to 85% of the screen, and scrolls inside.
- Earthly HQ: panels flow within each portal, never from one into the other.
- Phones: one panel per line, as before.
- Test: `test/browser-fold.js` (its b216 width checks measured against a row
  wrapper that no longer has a size; they now measure the flow).

## Done in b216 — a folded panel gives up its space

- Side by side, a row is as tall as its tallest panel. Folding the
  Warehouse Inventory left its heading over a tall empty box as high as the
  sales log beside it; folding any panel in the two-column rows left an empty
  half-row.
- Now a folded panel stands on a line of its own, the width of the page, and
  whatever stood beside it moves up underneath and takes the whole width
  (`foldRows()`, run by `applyFolds()`; class `span-all`). Open panels still
  pair up in their order; one left without a partner spans the row. Opening
  the panel again puts them back side by side. Phones already show one column,
  so nothing changes there.
- Test: `test/browser-fold.js` (the new checks fail on b215).

## Done in b215 — Seasonal HQ; search anything

- **Seasonal HQ** is the first choice in the region picker and opens the
  season's overview, the way 🏠 Warehouse heads the place picker. It replaces
  the ⌂ button, so going up is the same move as going sideways
  (`SEASONAL_HQ`). "Choose a region…" is gone: at the overview the picker
  reads Seasonal HQ.
- **🔍 Search** in the toolbar (tap it, or press `/`): places and actions as
  you type, like finding a file in Google Drive. "Yoga studio in Italy" opens
  that event; "transfer stock" opens Transfer Existing Stock.
  - **Places**: Earthly HQ, every season (as its Seasonal HQ), and every region
    and event in every season, open or closed, from records the page already
    holds (`allRegions`/`allEvents`); nothing is fetched to search. Another
    season opens first, then the place (`gsGoPlace`).
  - **Actions**: read off the buttons actually in the admin panel and top bar
    at that moment (`gsItems`), and chosen by clicking that very button. So
    rewritten wording is what matches, and a regional link finds only what it
    was given: its own region's places, Activity Log, Add/Transfer Stock,
    Support. Sales links get no search. `GS_ALSO` adds other words per action
    ("expenses" → Record Costs). Actions tied to a place act where you are.
  - Matching: every word typed must start a word of the name or of where it
    sits; little words ("in", "at", "the") are ignored; name matches rank
    above region/season ones, this season above others, open above closed.
  - Not searched yet: books, buyers, sales.
- Test: `test/browser-search.js` (desktop and 390px phone, admin, regional
  and sales links).

## Done in b214 — pounds (and every currency) on a region's spreadsheet

- A region's Summary tab had "Cash on hand" and "Collections by payment type"
  fixed at PLN / EUR / USD columns. London (GBP) showed nothing in either,
  and "Cash on hand" was left out entirely when a region had only pounds.
  Both now have a column per season currency (`allCurrencies_()`), like
  "Collections by book type". "Collections by currency" is now money-formatted
  on every row. (First found and fixed in the London reconciliation session,
  PR #28, as "b213". Re-applied here as b214, because b213 was already Phase 4.)
- `doMarkPaid`: a balance added onto a first payment in another currency was
  converted at the euro rate for anything that wasn't USD or PLN (pounds
  included). It now uses that currency's own rate.
- Test: `test/gbpsheet.js`.

## Done in b213 — Phase 4: live updates

- `server/src/worker.js`: the Durable Object accepts WebSockets at `/live`
  (hibernation API; `ping`→`pong` auto-response). After every request and the
  hourly alarm, `tellPhones()` sends `{rev}` to every socket when the revision
  changed. On connect, and when asked `rev`, it sends the current one. At most
  400 sockets (the oldest are closed first). `core.js` gains `rev()`.
- `index.html`: `LIVE` / `liveConnect()` / `liveRev()`. The URL is derived from
  `APPS_SCRIPT_URL` (off for script.google.com; `CONFIG.LIVE_URL` overrides it,
  and `''` turns it off). A message with a new rev fetches at once, unless a
  form is open (then `LIVE.due`, fetched by `closeModal()`). While live, the
  regular poll runs once a minute. Reconnects with backoff, and on
  visibility/online.
- `test/browser-cloudflare.js`: live checks (both configs poll hourly).

## Done in b212 — sales-log filters stay on their page, and fit a short window

- The Books / Status / Payment filters are cleared (and their menus shut)
  whenever you go to another place or season: `clearLogFilters()`, called from
  `goTo()` and `switchSeason()`. Coming back starts unfiltered.
- A filter menu fits the window: `fitLogFilter()` sizes it to the room below
  the button (or opens it upward when there is more room above), Clear/Done
  are pinned at its foot, and the section holding it gets `.lf-open`, which
  lifts it above its neighbours and stops it clipping the menu. That clipping
  (the section's `overflow:hidden`) is what hid Clear in a half-screen window.
- Test: `test/browser-filters.js` (720×520 window).

## Done in b211 — pre-orders: the count and the details, both

- The pre-order report is two reports again. **📋 Count** (`preorders`) is the
  simple count from before b210: one line per title, then the total.
  **📋 Details** (`prepeople`) is the b210 list: name, phone, books, comments.
- Both buttons sit on the "Pre-Orders Awaiting Delivery" heading, and the full
  report and Speciality Reports offer both ("Pre-orders pending" and
  "Pre-orders — who is waiting").
- Tests: `test/paycur.js` checks both; `browser-round7.js` now counts 6 sections.

## Done in b210 — payment types have a currency; the pre-order report lists people

- **Each payment type's currency, tour-wide** (Edit Payment Types: a picker
  beside each type; saved at once; `setPayTypeCurrency`, stored in `_meta`
  `payTypeCur` as { type: 'USD' | … | 'none' }, sent in the state only once
  set). Starting guesses until set: Zelle, PayPal, Wise, Venmo, Cash App →
  USD; UPI → INR (`PAY_CUR_DEFAULTS`). A type with a currency is a digital
  account; cash and card have none.
- **"$ Received"** (`digitalSale`) now only for payments into a DOLLAR
  account — not card or cash (the owner's rule), and not an account in
  another currency (UPI's rupees stay rupees). Amounts already entered on
  card sales still count; only the button is gone.
- **Pre-order WhatsApp report**: each person, numbered — name, 📞 phone,
  📖 the book(s) (ordered together = one entry; "×2" for a repeat), 💬 any
  comment — then "Total - N books for M people".
- Tests: `paycur.js`; `browser-round6.js` now uses Zelle for "$ Received"
  and checks a card sale has none.

## Open items

1. **Scale — moving off Google Sheets.** Google Sheets is the ceiling: writes
   are serialised behind a script lock (~1–2 s each) and a read rebuilds
   state from ~25 sheet reads. Fine for a handful of concurrent users, not
   for 10–15 sellers at once. The owner's decisions (September 2026):
   - **Database: Cloudflare Workers + D1**, on the free plan. Always free, no
     credit card, never sleeps; a hard daily cap instead of a bill (5 M rows
     read, 100 k written, 5 GB). Upgrading, if ever needed, is the $5/month
     Workers Paid plan: a setting, no code or data change. Firebase (no
     server functions on its free plan) and Supabase (pauses after a week
     unused) were ruled out.
   - **Sign-in:** admins sign in with Google, once per device, remembered
     (~90 days). Regional coordinators and sellers keep links, no accounts.
     Seller links stay valid until their region closes (closing already
     blocks new business at a place; see `assertNotClosed_`).
   - **Reports:** the readable spreadsheets stay. A slimmed Apps Script keeps
     building them, reading from the new server every few minutes.

   Plan: **phase 1** (b192, done) — the data store. **Phase 2** (b204, done,
   see below) — the server on Cloudflare. **Phase 3** (b205–b206, done: the
   owner switched on 27 September 2026) — see "Where things live now"
   below.
   (Changed from the September plan: a SQLite-backed Durable Object instead
   of D1 — same free plan, but synchronous and one-request-at-a-time, so
   Code.gs runs unchanged and needs no lock.)

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

## Done in b256 — Reports builder: pick your own data (practice)

Gita's ask: "a data-choosing rubric … combining different data of their
choosing", with typed questions that pick the choices. Proposal:
/mnt/project-files/proposals/finance-reports-builder.md. Practice only.

- **One line of choices** on Finance › Reports (the `qb*` block in index.html,
  before "Reports: any rows, any figures, any filter"): Show (tick several),
  At (places, or a whole series such as every Kartika; `qbAtItems`), During,
  Split by, Only, Compared with, As (Numbers, Table, Bars, Pie, Line over time,
  List of payments). State is `QB.st`, kept per browser in localStorage
  `tbs_qb`. Answers come from `qbAnswer` → `qbMeasure`; Books always show Big
  Books and Adventures apart in the app's Sold + Gifts = Distributed form; money
  shows dollars with the actual currencies beneath ("37 € + $55").
- **Compare is folded into Reports**: Compared with = same time last year, the
  period before, the previous one in its series (from b255's repeats), or
  another place. `finGo('compare')` lands on Reports; the old Compare tab is gone.
- **Time measures**: "Days it ran" and "Last event to region end" use b255's
  place dates (first/last sale stand in until dates are filled in).
- **Ready-made questions** (`QB_READY`, 16) and **⭐ saved questions** kept with
  the login (`ME.prefs.finSaved`; `finSaved` added to auth.js `PREF_KEYS`).
- **Ask a question** (`qbParse`, no AI): recognises measures, time words,
  splits, every season/region/event/series name and payment type; shows what
  it used and the words it could not.
- **📋 WhatsApp** on Reports sends exactly the answer on screen (`finWaQb`).
- The old rows-and-columns table stays below, folded ("Build a detailed table").
- UPI code split waits on UPI codes being recorded per payment.
- Tests: new `test/browser-reports.js` (24 checks); browser-finance and
  browser-expenses updated for Compare moving into Reports.

## Done in b257 — Finance fixes from Gita's list (practice)

- **Fiscal year from 8 October** (`FY_START` in index.html; one line to move
  it to 1 October). Reports' "This/Last/Two fiscal years ago" and "Split by
  Fiscal year" ("Fiscal year 2026–27") use it. A typed "in 2026" stays the
  calendar year.
- **Other currencies in Finance's totals**: the Overview's Gross, Donations
  and Expenses tiles show the actual money per currency ("37 € · $55"), as
  the sales page's totals bar does (`finAgg` → `a.cur`, `finCurs`).
- **Expected Total Expenses** on the Overview (and its table and 📋) while
  any reimbursement is still due, with "Current Expenses" beneath; plain
  "Total Expenses" once squared (`finExpParts`), as Gross works.
- **Gmail, not the mail app**: every email button opens Gmail's compose in
  a new tab (`gmailUrl`).
- **Expenses & Reimbursements: two sections** on one page (`finExpTop` opens
  both, `FIN_EXP_END` closes). Expenses is the left half on a computer
  (compact table: date, what for with who · type · where, amount with
  status); Reimbursements the right, with the Send box and tabs Pending, Paid
  back, Declined (separate now), Links, ⚙️ Settings. Stacked on a phone.
- **One square per person** for pending reimbursements paid back the same
  way (same name, method, currency, details): every expense listed, one
  total, "Mark all N paid back" (`expGroups` / `expGroupHTML`).
- **The note for the record** is typed in the card's Pay back part
  (`[data-pbnote]`), not a pop-up; Decline still asks why if it is empty.
- **Remove a way of paying back for good** (Settings › 🗑, "Bring back"):
  server setting `reimbGone`, action `expMethodGone`; `allMethods` skips them.
- **Reimbursement link on a phone**: one column, buttons full width, and an ×
  (and "Done" when sent) that leaves for https://travelingmonk.com/.
- Tests: browser-finance (80), browser-reports (26), browser-expenses (66).

## Done in b258 — Small things: two-line titles, seller kept, ☰ at the top, Subtract Stock (practice)

Gita's list of small things that are not Finance (thread "Small things").
Live unless marked practice.

- **Language on its own line** under the title, everywhere a title is shown
  (`.lang-tag` is `display:table`), so long and short titles put it in the same
  place. Inside a sentence (`.hint`) it stays inline.
- **An edit keeps the seller**: `doEditBundle` takes the seller from the first
  member that has one and never puts the editor's name in an empty one;
  `doEditSale` already kept it. New `_sales` column `editedBy` (end of
  SALES_HEADERS), set by `editedByNote_` when someone other than the seller
  edits; the sale's drawer shows "Edited by". The screen's optimistic bundle
  edit keeps soldBy/soldById too.
- **☰ at the top left** on phones and narrow windows (under 900px): it rides
  on the top bar's row, beside the buttons and clear of the photographs, then
  stays at the top of the screen when the page scrolls (`snFabPlace`).
- **No "$ Received" for money already in dollars**: `digitalSale` needs a
  payment type that lands in dollars AND a currency other than USD. A figure
  already entered still shows in the drawer.
- **Multiple-book sales list each title once with its count** in the drawer:
  "Sri Radha (English) — 5".
- **No numbers on menu items** (`snRow` drops counts) until a to-do section exists.
- **Add several titles at once** (practice): "Add several titles at once" in
  Add Stock takes a list pasted from a spreadsheet or a CSV file, one title per
  line with its number in any column (`parseStockList`); each title found gets
  its line with the number filled in, anything not recognised is listed and
  left out. Works for "already there" and "not there yet".
- **Subtract Stock** (practice): its own item at the top of Advanced
  (`subtractStockModal`), opening on the place it was opened from (Earthly HQ's
  warehouse at Earthly HQ), listing every title in stock there, with the
  subtracting warning, a reason, and `adjustStockBulk` underneath.
- Tests: new `test/browser-small258.js` (30 checks); browser-sellers expects
  Subtract Stock in practice's Advanced.

## Done in b259 — Finance: what's in hand, one card per person, purchase-day rates (practice)

- **Titles stay Gross, Expenses, Net** and show what has actually come in or
  gone out (Expenses = spent less still owed; Net = collected less spent). A
  blue "Expected …" line sits beneath while anything is pending
  (`finGrossParts` / `finExpParts` / `finNetParts`, `finExHTML`, `.fin-ex-l`),
  in the tiles, tables, Reports measures and 📋 ("   Expected Gross - $X").
- **Expense form**: starts as record-keeping with "Check to receive
  reimbursement" (`#xReimb`); "Same as above" beside pay-back fields that match
  the phone/email given above (`expSameSrc`, `data-same`); no "Take a photo"
  on a computer (`EXP_TOUCH`); required pay-back fields checked before Save.
- **Review even for one expense** (`expReview`, "Check your expense").
- **Paid back in another currency**: the European Central Bank rate on the
  purchase date (Frankfurter, `fxOn`) gives "To pay back: $8.80 (1 EUR = 1.1
  USD on …)" on the review, the confirmation and the card. Stored as `payAmt`
  (server `cleanPayAmt`; kept on edits unless date/currencies change). If the
  rate can't be fetched it says to check before paying.
- **One card per person** (by name) across submissions: each line ✓ Accept /
  ✕ Decline (`FIN.rbNo`, `data-act="rbline"`), "Pay back all N · total" or
  "Pay back 1 of 2 · total", and "Decline all"; one "Why…" for declined lines
  (`finMark`). WhatsApp 📋 gives one total per person.
- **Layout**: small right-aligned "🧾 Add an expense" and "📨 Send
  Reimbursements Link" on each section's title row (the link is now a small
  window, `finSendLinkModal`); Reimbursements Due over the Reimbursements
  half; Type/Status as checkbox filters like the sales log (`finexflt`);
  no Add an expense / Edit Wording on the Finance bar; "← Go to Sales Portal".
- **Reports and Visualize removed for now** (Gita, 2026-10-20): Finance's bar
  is Overview, Expenses & Reimbursements, To do. Old #finance/report|compare|visual
  addresses open the Overview. The qb* builder code stays, unused;
  test/browser-reports.js is paused (TBS_REPORTS=1 runs it) until it returns.
- **⬇️ CSV beside every 📋** (`finCsvBtn`, `finCsvDownload`): Overview (a row per
  place + Total, every figure and its Expected), Expenses (rows listed),
  Reimbursements (the tab open), To do (the tab open). File names are plain
  ASCII, since Chrome names a file "download" when it has · or accents.
- **Charts at the bottom of every Finance screen** ("📊 At a glance",
  `finChartsHTML` / `finChartsMount`, always the last element of #fpBody):
  Overview = where the money comes from (donut), money in and out (actual
  bars with dashed Expected), Gross and Expenses by place, month by month,
  expenses by type. Expenses & Reimbursements = expenses by type, month by
  month, reimbursements by status, still to pay back by person. To do =
  pending payments by place, pending reimbursements by person.
- Tests: browser-finance (98), browser-expenses (66); browser-reports paused.

## Done in b260 — Search finds the menu's actions again (live)
- The search box read actions only off the old four-column admin panel
  (`#adminActions`) and the top bar. Since the left-hand menu went live (b235)
  that panel is empty, so no action was ever found, only places.
- `gsItems` now also reads `#sideNav .sn-item[data-act]` (`GS_BTNS`), even while
  the menu or its section is folded, skipping the menu's own controls
  (`GS_NOT`). Each result is tagged with its menu section (Money, Books…).
- A longer form of a word counts ("tracker" finds Track; `gsScore`), and Track
  Cash also answers to tracker/tracking.
- Choosing a menu row marks the menu open first, so a touch-screen computer
  doesn't take the click as "open the menu".
- Tests: `test/browser-search.js` section 6 runs with the left-hand menu
  (`?menu` serves the test config with `CLASSIC_ADMIN: false`).

## Done in b261 — Finance: compact rows, Pay with a date, rates from the server, Finance in the Activity Log (practice)

- **Exchange rates from the server** (`fxOn` in server/src/core.js, action
  `fxOn`): the European Central Bank's rate on the purchase date (Frankfurter),
  else the open currency-api for that day; kept in the web cache. The page
  asks the server (as the sales side's rates are fetched), never the web itself.
- **Where** on the expense form is limited only by the person's permissions:
  Finance and Universal see every place, closed ones too, marked "(closed)"
  (`placeList`); a reimbursement link still lists only running places.
- **Gmail**: every Gmail button opens in one named tab (`GMAIL_TAB`), so later
  drafts reuse it. A page cannot reach a Gmail tab the person opened themselves.
- **Reimbursements like the sales log**: a row a person with the amount in
  the currency asked for, **Pay** and **Decline**; tapping opens the
  expenses (each can be declined), how to reach them, how to pay them
  (`expGroupHTML`, `FIN.rbOpen`). Paid back / Declined tabs are rows too
  (`finRbDoneHTML`). The To do's Pending Reimbursements uses the same rows.
- **Pay asks the date of payment** (`finPayAsk`, server column `paidOn`,
  today or earlier) and a note.
- **One way of being paid back per form**: the first expense to be paid back
  sets it; the others follow (`lockPay`, `expPaySync`).
- **Expenses like the sales log**: date, what for, amount; tap for who, type,
  where, status, pay back, receipts, Edit, Delete (`FIN.exOpen`). The
  Date/Amount headings sit over their columns and still sort.
- **Finance in the Activity Log**: added, changed, deleted, paid back,
  declined, links made, settings (`actLog` in expenses.js, into `_activity`
  for the expense's season/region/place). Delete undoes added (removes it),
  deleted (brings it back, receipts kept 30 days) and paid/declined (waiting
  again) via action `expUndo`.
- **Activity Log** shows the latest 50, then "Show older" (live fix: it used to
  list up to 1,500 at once).
- Blue lines read just "Expected $X" (and "   Expected - $X" in 📋).
  Cents always two places ($50.80).
- Tests: browser-finance (108), browser-expenses (68).

## Done in b262 — Smaller selling cards in four parts (live)
- Every shelf card (`renderInventory`'s book cards, and the donation card) is laid
  out in four parts: top left the name, language and the region's first two
  prices (`curCurrencies().slice(0,2)`); top right the number in stock with
  "sold N" in grey beneath; bottom Sell and Pre-order. About a third shorter.
- Sold out: no SOLD OUT bubble; the card gets `.out`, the name greys and reads
  "(Out)" after it. All pre-ordered / Display book are a line of small print
  under the prices (`.bk-note`).
- Warehouse extras (Stored At bubbles, At events, In transit, pre-ordered/free)
  sit full width under the top half (`.bk-more`); the SW bubble's name lookup
  now finds `.sw-who` from the card, not `.qtyrow`.
- List view keeps two columns on phones too.
- Tests: round7 checks (Out) with no bubble; sellers expects "35 € · $40" on
  the card (replacing b232's local price only); bookorder ignores "(Out)".
## Done in b263 — the expense form stays still as it redraws (practice)
- Ticking a box, choosing how to be paid back, picking a kind or adding a
  receipt rebuilds the expense form. It used to pop in again and jump to the
  top; now `expHold()` (around `expDraw`) keeps whatever was last touched on
  the same spot on screen, keeps focus and cursor in the field being typed in,
  and the `.modal.still` class drops the pop. "← Change something" on the
  check page returns to where you were (`EXP.formTop`).
- Tests: browser-finance (111).

## Done in b264 — Every book card in four parts; Locations at every level (live)
- One card builder, `qCardHTML` (top left / top right / bottom left / bottom
  right / full width), used by Distribution by Title, the Warehouse Overview
  (season, Earthly HQ, and now region) and Sales by Region's mini cards. The
  selling card (b262) already had this shape.
- Top left everywhere: name, language, and at a region or event the first two
  prices (`qNameHTML`; a season or Earthly HQ has no one price list, so none).
- Distribution by Title: top right N sold; bottom left "incl. N pre-orders" and
  "+N gifts"; bottom right "N distributed" (`qLowHTML`). Mini cards the same.
- Warehouse Overview: top right N in stock with "+N in transit ›" beneath;
  full width the dropdown, now called "Locations" (was "In 4 regions" /
  "At 2 places"). One level down from where you are: Earthly HQ → seasons,
  season → regions, region → warehouse, events and devotees' homes.
- New region-level panel `#whRegionPanel` (shown at a region, not an event),
  with its 📋 stock report.
- Tests: browser-lang expects "Locations"; browser-bookorder reads a card's
  name from `.sc-name`/`.bname`.
## Done in b265 — Expense form: Earthly HQ first, room above titles, exact dollars, dollars last (practice)
- A new expense starts at **Earthly HQ** for anyone who reaches every place
  (Finance, Universal); it can be moved to an event. expenses.js treats
  `rg_hq` as a place of kind `hq` (season `HQ`); `expOptions` takes `start:1`.
- Form: titles have 14px above them (`.exp-form .field,.row2` margin);
  "Check to receive reimbursement" is plain text with a checkbox.
- Dollars: each non-dollar expense gets the rate on its own day, looked up by
  the server on `expSave` (core.js sets `p.usdDay`; the page's own is
  dropped) and kept in `usdDay`. An optional **Exact amount in dollars**
  (`usdAmt`) wins over any rate, and is what is paid back when paid in
  dollars. Code.gs `expUsd_` picks exact, then day rate, then the place's rates.
- Finance shows dollars last and out of brackets: `finDual` → "(500 ден) $9.08".
  The details say how the dollars were worked out.
- Tests: browser-finance (122).

## Done in b266 — Card alignment: Q2 transit, bottom buttons, rows line up, language placement (live)
- Selling card: "In transit" and "Expected" sit in the top right under in stock
  and sold. Sell/Pre-order sit at the bottom of the card (`.bk-btns{margin-top:auto}`),
  level across a row whatever the cards above them hold.
- Warehouse Overview: "Expected: N" under "+N in transit ›" in the top right.
- Distribution by Title / mini cards (`qLowHTML`): gifts bottom left; bottom
  right "N distributed" with "(N Pre-Orders)" on its own line beneath.
- Four-part cards line up across a row: each `.qcard` spans four rows of its
  grid as a subgrid (`@supports (grid-template-rows:subgrid)`), so the bottom
  halves and the Locations row start at the same height side by side. List
  view switches it off. Arrange's Drag / Hide here sit in the fourth row.
- Language: `.lang-tag` is inline (same line as the title) by default, as in
  the sales log and lists; on cards (`.bname/.sc-name/.mc-name`) and buttons it
  sits on its own line under the title.
## Done in b267 — Exchange rates: quicker, a fallback, exact amounts, flags, dollars received (practice)
- **Quicker:** core.js `fxOn` asks its three sources at once, each given
  3.5s (`FX_WAIT`). The page asks as soon as the day and both currencies are
  chosen (`expPrefetch`; `fxOn` shares one request per pair), so the check
  page comes straight up; anything still on its way fills in in place.
- **Fallback:** no rate for the day → the latest rate this server has for the
  pair (`fxLast`, refreshed hourly by `refreshFx` from worker.js's alarm),
  else open.er-api's. Marked `fallback`; the page says "the latest rate".
- **Check page:** "This is an estimate - reimbursement rate may change based
  on current exchange rates." (also on the link's confirmation), and "I have
  the exact numbers for reimbursement" gives each expense its own box
  (`payExact`). The server looks up the day's rate itself on `expSave`
  (`p.payDay`) and keeps it beside an exact amount (`payAmt.est`).
- **Finance:** an exact amount over 10% above the day's figure is flagged
  (`expOver`). An expense with no rate gets one from the fallback
  (`payGuess` in `shown`). Reimbursements Due shows each pay-back currency,
  dollars first (`finMix`); `finTotals` puts dollars first everywhere.
- **Dollars received** (Finance Overview, `finConvModal`): "took X in a
  currency from a place, received $V". Kept in setting `finConv`;
  `convApply` replaces that place's (event over region over season) sales'
  dollars in that currency (`cu` per currency from Code.gs), not sales with
  hand-entered dollars. In the Activity Log.
- Tests: browser-finance (139).

## Done in b268 — Pre-orders under sold; Expected in its own colour (live)
- Distribution by Title and the mini cards: "(N Pre-Orders)" sits in the top
  right under "sold", in the same grey (`qPreHTML`). Bottom left gifts, bottom
  right "N distributed" (`qLowHTML`).
- "Expected" is purple (`.region.expected`), apart from In transit's blue, on
  the selling card and in the Warehouse Overview.
## Done in b269 — Owed in the person's currency with dollars, ~ on estimates, nearest-day rates (practice)
- **What is owed** (`finPayText`): in the currency each person asked for,
  dollars in brackets: "500 € (~$555)"; all in dollars, one figure;
  several currencies "$169.05 + 765 zł (~$370)". Per person, Reimbursements
  Due, To pay back, Paid back rows, 📋. No dollars known: amounts only.
- **~** marks dollars worked out from a rate (`finUsd(n, est)`): sales with
  a non-dollar leg and no hand-entered dollars (`ue` from Code.gs; cleared
  by Dollars received), expenses without exact dollars (`usdExact`). Tiles,
  tables, lists and charts. Logged dollars have none.
- **Fallback rate** = the nearest day's rate this server has found for the
  pair (`fxHist`, every lookup and the hourly refresh; seeded from b267's
  `fxLast`), else open.er-api's. Expenses with no rate at their place get
  dollars this way in `finData`.
- **Dollars received** moved beside 🧾 Add an expense (Expenses &
  Reimbursements); off the Overview.
- **Charts:** colour keys never shrink to nothing beside long figures
  (`.fin-key{flex:none}`). The Expenses screen shows Gross, Expenses and Net
  (bars, and month by month; a month below zero is red).
- Tests: browser-finance (148), browser-expenses (68).

## Done in b270 — Touch-sized buttons, "Consignment" tag, simpler Delete, bold distributed (live)
- **Sell / Pre-order:** 36px tall on touch screens; 26px on computers
  (`@media (hover:hover) and (pointer:fine)`), on shelf cards and in list view.
  Chosen by pointer, not width, so tablets get the touch size.
- **Consignment titles:** the tag on cards reads "Consignment" instead of the
  group's name (`qNameHTML`, shelf card).
- **Delete an event:** type the event's name to confirm; the "it was a test,
  put everything back" choice is gone (always `restoreSold:false`).
  **Delete a region:** "Write them off" (for test regions) removed; remaining
  stock always moves to another region. Season delete already typed the name.
- **Totals tiles:** "+N gifts = **N** distributed", the total in bold (`giftNote`, `.dist-n`).

## Done in b271 — Lines everywhere, half-width Warehouse Overview, distributed-only titles (live)
- **Warehouse Overview** (season, region, Earthly HQ's Seasonal one): `data-after`
  in place of `data-full` — the whole width, or half when an open panel follows
  it (`foldRows` pairs it only with the panel after it). At a region it sits
  beside Sales by Seller.
- **List view, every toggle:** one compact line per title, columns lined up
  down the list (each line a subgrid of its list).
  Selling shelf: name · language · prices | stock · sold | pre-ordered | Sell Pre-order.
  Title cards: name · language | number | gifts | distributed | Locations
  (prices hidden on title lines). Sales by Region's dropdown: one heading row
  (Sold / Gifts / Distributed) with bare numbers beneath (`.mc-head`, `.q-word`).
  An open Locations list or the shelf's Stored At drops to a second line.
  Phones: names may wrap; figures stack in their own narrow column.
- **Distribution by Title** shows only titles distributed at that place (every
  title while arranging, so all can be ordered); "Nothing distributed here yet."
  when empty. The shelf and Warehouse Overview still show every title.
- **Collections by Region / Season** scroll sideways (`.ptg-scroll`) when the
  currencies don't fit.
- Tests: browser-arrange reads the order after ⇅; browser-bookorder gives every
  title a gift (season and Earthly HQ) so Distribution by Title lists them.

## Done in b272 — No overflow, Net in Overview charts, live arrivals, back to where you were, closed-link requests (practice; refresh is app-wide)
- **Standing rule (Gita, 2026-10-21): no visual overflow, ever.** Check every edit at
  computer and phone widths. browser-finance measures every Finance screen
  (`spill`: elements outside their box, anything scrolling sideways) at 1440–360px.
- **Charts:** `.fc-box` is a size container. In a narrow box the bar goes under its label and figure,
  and the months show as a letter over the year. The month chart no longer scrolls sideways.
  The Overview's table becomes labelled blocks below 1060px (`.fin-ovw`) instead of scrolling.
  Negative estimates read "−~$61.55".
- **Net** is in the Overview's by-place chart (`finPairsHTML(rows, series)`) and its month chart.
- **Books** read on two lines: "65 Sold + 13 Gifts", then "= 78 Distributed" (`finSubH`).
- **Exact dollars** are no longer on the reimbursement link's form (`!EXP.pub`). The check page asks
  for them only when the person is paid back in another currency.
- **Live arrivals:** expenses.js bumps the revision on every write (`READS` lists the reads).
  The client's `finHeard(rev)` (from poll and the live line) calls `finQuietRefresh`, which
  waits while a window is open or you are typing, then redraws and keeps your scroll.
- **Refresh returns you to where you were** (`BACKTO`, sessionStorage `tbs_backto`, both apps).
  It brings back the menu/top-bar page that was open (and reopens it), Finance's tabs and dates,
  and the scroll of the page and the open window. The scroll is retried until the page is tall
  enough, and given up if you scroll yourself.
- **Closed reimbursement link:** `expLinkInfo` returns `{closed}`, and the page offers
  "Request for this to be reactivated" (`expLinkAsk`, stored as `ask` on the link).
  Finance sees a red dot on Links and Expenses (`expTodo.asks`). Turning the link on or off clears it.
- **Menu (practice):** "🧾 Add an Expense"; the Money section is called "Laksmi".
- **To do at Finance launch (Gita said yes):** copy practice wording changes (`_labels`) into live.
## Done in b273 — Every section half width when another follows (live)
- On a computer every open panel with another after it shares its line:
  `data-after` is gone, so the plain pairing in `foldRows` applies to the
  warehouse overviews too (region: Totals by Payment + Warehouse Overview,
  then Sales by Seller). At a season the Warehouse Overview moves into
  `#salesFlow` (renderAll) so it can pair with To Do; it moves back for other levels.
- Tests: browser-fold gives every title a gift (Distribution by Title only lists
  distributed titles since b271, which had made it too short for the b236 stack
  checks); browser-round2 checks list-view cards span the list rather than a
  one-column grid. Note: 15 browser tests print FAIL lines without setting an
  exit code, so read their output, not just the exit status.

## Done in b274 — Finance goes live (Gita, 2026-10-21)
- `FIN_ON` (index.html, next to `PRACTICE`) replaces the practice gate on Finance, Add an Expense,
  Reimbursements (links, settings, To do) and Dates & Repeats (place dates/series on the
  season/region/event forms). Setting it to `PRACTICE` sends them back to practice only.
  The server gate in expenses.js `handle` is gone.
- On live, Record Costs becomes 🧾 Add an Expense. Old costs are adopted as expenses (`adopt()`).
  The menu's Money section is "Laksmi".
- **Bring Wording & Settings from Practice** (App Development, Universal, live only):
  - The live page reads practice's `finCarryOut` with this device's practice sign-in
    (`practice:tbs_session`), then hands it to live's `finCarryIn`.
  - It brings the `_labels`, `reimbRules`, `reimbGone`, and `placeDates` and `finSeries`
    (merged, practice wins). Practice expenses, receipts and links stay behind.
  - The step is logged in the Activity Log. `doSaveLabel` is now exported to the worker (build.cjs).
- Still practice-only (Live app changes thread, if Gita picks them): in-place Edit Wording,
  Add several titles, Subtract Stock, View as.

## Done in b275 — Edit Wording in place, Add several titles, Subtract Stock go live (live; with Finance's b274 launch)
- Gita (2026-10-21): these three practice features go live; View as stays practice-only.
- **Edit Wording in place:** the PRACTICE gates are gone from `labelInline`
  (the pencil edits the words where they are; `editLabelModal` stays as the
  fallback when the words can't be found on the page), the tap-the-words handler,
  `lblBodyClass`, `LBL_SKIP` (passing messages get a pencil) and `toast`.
- **Add several titles at once** (Add Stock, paste or CSV): `bulkHTML` ungated.
- **Subtract Stock:** in the menu wherever Add Stock is (`byKey.substock`).
- Tests: browser-buttons and browser-round2 edit wording in place; browser-small258
  expects Subtract Stock in the live menu.

## Done in b276 — Finance menu, wording fixes, Expenses charts, General expenses (live)
- **Menu:** 🧾 Expenses & Reimbursements in the Finance section (`FIN_BTNS`, `SN_ITEMS.finexpenses`,
  action `finexpenses` opens Expenses on its Pending tab).
- **Hiding wording that wouldn't hide:** the Locations toggles (`.wo-toggle`), the seller rows
  (`.sb-line`), link on/off buttons and closing-checklist rows used `data-key` for their own ids,
  which is the label system's attribute. They now use `data-k`.
- **Hiding a button's words hides the button** (`lblHost`), e.g. a menu row with its icon.
  A menu section heading hides the whole section.
- **Hidden wording can come back:** with Edit Wording on, hidden words show faded and struck
  through (`.lbl-hidden`); tap them and ✓ brings them back.
- **Pencils everywhere:** the left-hand menu takes pencils (it is no longer `.no-edit`), and the
  grey words in boxes (placeholders) take one after the box (`lblPlaceholders`, `.ph-pencil`).
  Place names in the breadcrumbs and language tags stay no-edit, since they are data.
- **Finance search** placeholder: "Search for Season, Region, or Event"; the box is empty when
  nothing is chosen.
- **Expenses tab charts:** Expenses by type, Expenses by month, Expenses by Season/Region/Event
  (one level under the page; none at an event). The income charts are on the Overview only.
  `finMonthsHTML` draws a single month when it is the only series.
- **Expenses and Reimbursements** side by side stretch to the same height (`.fin-two`).
- **Reimbursement Settings:** the currency ticks start all on, ready to untick.
- **General** in "Whose expense?" (Finance only): `forEmail:'*general'` saves `forName:'General'`
  with no email; record-keeping only (server refuses reimbursement; the tick box is hidden).
- Tests: new browser-wording276; browser-finance (menu, charts, search, height, currencies);
  expenses.js (General).

## Done in b277 — Kinds of expense are Finance's own list (live)
- `expCats` (server prop, expenses.js `getCats`/`catList`): starts as just "Card machine fee";
  "Other" (with its own words) is always last and can't be removed. `expOptions.categories`
  and `expRulesGet.cats` give the list.
- `expCatAdd` / `expCatGone` (Finance: `mayPay`), each in the Activity Log. An expense keeps a kind
  since removed when it is edited; a new one can't choose it (it becomes Other).
- Form: Finance typing a kind that isn't there gets "＋ Add “…”" (`comboBind`'s new `add`
  argument). Settings: "Kinds of expense" chips with 🗑, and an Add box.
- Tests: expenses.js (list, add, remove, keep); browser-finance (Settings and form).

## Done in b278 — No Finance To do on live, expense payment types, steady windows, General pool (live)
- **Finance To do** is practice-only everywhere now: the expense form's footer and Settings' footer
  join the menu and Finance bar (already gated).
- **How expenses were paid** is Finance's own list (prop `expPays`, expenses.js `getPays`/`payList`):
  it starts as the payment types the places already use (no Gift/Other), and Finance adds with "＋ Add"
  on the form or in Settings ("How expenses were paid", 🗑 to remove). `expPayAdd`/`expPayGone`,
  in the Activity Log. Sales' payment types are untouched.
- **Windows (every pop-up):** a tap outside and Esc no longer close them; only ✕, Cancel or
  finishing. Every window gets a ✕ if it had none (`openModal`). Windows sit at the top
  (`.modal{margin:0 auto auto}`) so they don't slide when their contents change, and the same window
  drawn again keeps its scroll and doesn't pop in again.
- **"Your expenses"** (`expList` without scope, `ownList`): only expenses that are yours by name;
  General ones, or ones entered for someone else, are only in Finance's pool (scope:'all').
  Who may edit them (`mine`) is unchanged.
- Tests: expenses.js (payment types, the pool); browser-finance (no To do, payment types,
  windows stay open and still, ✕).

## Done in b279

Live app changes (Gita, 2026-10-21):
- **Expense form stays on the field you change.** After a redraw it used to snap back to the last
  spot tapped. Now `expHold` anchors on the element just changed or clicked (`_expTrig`, within
  1.5s), then falls back to the focused field, then the last tap.
- **Finance-only places.** Finance (`mayPay`) can type a place that isn't in the system into
  "Where" on the expense form and choose "＋ Add". This is `finPlaceAdd`: the place is stored in
  prop `finPlaces` as {id:'fp_…', name, parent}, where parent is '' (Earthly HQ), a season or a
  region. The same name under the same parent is kept once, and each add goes in the Activity Log.
  - It is never added to the sales side. Only Finance users see it in "Where" (`placeList`/`placeOf`
    kind 'fin').
  - In the Finance search it sits under its parent, tagged "Finance only".
  - `finData.finPlaces`, plus `x.f` on expenses there, let it be chosen as a Finance scope
    (`finScopeF().f`).
- **Single lines show the original amount in its own grey column.** On Finance's Expenses rows the
  original amount (`.fx-o`, blank for dollars) and the dollars (`.fx-a`) sit in fixed-width
  columns, so every row lines up. Reimbursement rows (pending and done) work the same way
  (`.li-orig` + `.li-amt`, `finPaySplit`), and the done badge is fixed width.
- Tests:
  - expenses.js: Finance-only places (who may add, dedupe, not for an event, Finance-only in
    Where, not on the sales side, an expense there, finData).
  - browser-finance: the form stays put on a currency change, "＋ Add" in Where, "Finance only" in
    search, and the columns line up.

## Done in b280 — Sub-regions (practice only)

Gita, 2026-10-21 (thread "Sub-regions within a region", Option A). Europe Tour 2026 had Madrid and
Barcelona as two regions with two warehouses. The Spain shipment was split between them by hand, and
the shared "Shipping to Spain" costs were filed under Barcelona. A region can now be split into
**sub-regions**: one warehouse, one set of prices, one closing, but each event belongs to one
sub-region (or none, "general"), so a city's sales can be looked at on their own.
- **Gate:** `SUBR_ON = PRACTICE`. On the live app nothing shows (the server action exists, unused).
- **Storage:** one `_meta` setting `subRegions` = { regions: { rg_…: [{id:'sr_…', name}] },
  events: { ev_…: 'sr_…' } }, sent in the state as `subRegions`.
  - Server action `setSubRegions` {regionId, list?, events?}, admin only. A removed sub-region's
    events go back to general, and an event can only go in its own region's sub-region.
  - Client mirror: `subApply`.
- **Region page:** chips under the breadcrumb read "All of <region> · <sub-regions> · ⚙"
  (`curSub`, sessionStorage `tbs_subr` per region).
  - With one chosen, `renderAll` draws the whole page through `withSub`/`subState`: the other
    sub-regions' events, and the general part's sales and costs (warehouse sales, region-wide
    costs), are left out. Stock is untouched, since the warehouse is shared.
  - A note says that selling straight from the warehouse counts for the whole region.
  - The place picker groups events by sub-region (optgroups).
- **⚙ / 🗺 Sub-regions** (left menu, region level; `subRegionsModal`): add, rename and remove
  sub-regions, and say which one each event is in.
- **Event form:** "Sub-region" select when the region has any; it defaults to the chip being looked at.
- **Collections by Region** (season): each region's sub-regions beneath it, then "<region>, general"
  (`cbr-sub` rows, for reading; the region's line is the one that adds up).
- **WhatsApp report** (`buildReport`):
  - On All, the books section gains "— BY SUB-REGION —": each sub-region's Big Books and
    Adventures as "N Sold + N Gifts = N Distributed".
  - The payments section gains "— BY SUB-REGION (after costs) —".
  - With one sub-region chosen, the report is that sub-region's.
- **Finance:**
  - Scope ids `sr_…` (`finSubOf`, `finScopeF().u/uE`), with a sub-region picker in the bar. The
    place search lists sub-regions under their region, tagged, with their events beneath.
  - A region with sub-regions breaks down "By Sub-region" plus "<region>, general".
  - A sub-region's page counts its own events' money and costs. Under the tiles,
    `finSubShareHTML` shows its share of the region's general expenses, split by books
    distributed, and "Net after its share". This sits beside Net, never in it.
- **Not done yet:** a warehouse sale can't be put in a sub-region (it counts as general), and the
  old Europe Tour Spain data hasn't been merged. Both are waiting on Gita.
- Tests: browser-subregions.js (26 checks, incl. overflow at 390 and 1150 px).

## Done in b281 — the left-hand menu follows Finance

Gita, 2026-10-22: "the left-hand menu isn't changing to reflect where you are". On the sales pages
it already did. Inside Finance, the menu's place section (Season / Region / Event Admin, with Edit
Region, Sub-regions, Close…) stayed wherever the sales pages had been left.
- `finSyncPlace()` runs after every `finGo`. It sets `CUR_LEVEL`/`CUR_REGION`/`CUR_LOC` from
  Finance's place, so a sub-region also picks its chip, then redraws the menu (`renderAdmin`).
- This works only within the season the tab has open. A place in another season leaves the menu as
  it was.
- "Go to Sales Portal" now lands on the same place.
- Tests: browser-subregions (+3: Region, Event, Season Admin as Finance moves).

## Done in b282

Live app changes (Gita, 2026-10-22):
- **A long caption that refused to stay hidden.** The Finance Overview note ("In dollars, at each
  place's own rates…") was hidden, but it came back after every redraw. The server keeps only the
  first 300 characters of a wording key (Code.gs `doSaveLabel`), while the page looked the note up
  by its full key.
  - `normLabelKey` now clips to `LBL_KEY_MAX` (300).
  - `applyLabels` matches a cut-short key by how the words begin.
  - Wording Gita already saved works as it is.
- **"Go to Sales Portal" in the left-hand menu** for anyone with Finance (`finleave`, top of the
  Finance group). It is shown only while in Finance (`body:not(.fin-mode)` hides it).
- Tests: browser-finance covers the long note staying hidden at another place and after a refresh,
  plus the menu row and where it goes.

## Done in b300
Live app changes (Gita, 2026-10-23 16:20 IST).
- Navigation drop-downs: the path's trailing drop-down (`.crumb-more select`) lists at 13px, the Events… size; every path select is 13px.
- ≈ replaces ~ as the "approximate" mark everywhere (totals, payment table, Collections by Region, Finance's finUsd/finEstMark, notes). redNegatives accepts both.
- Totals cards: whole numbers only (`usd0`, `cashWhole` with a no-break space before the symbol); seller "My cash" too. Elsewhere money keeps its cents.
- Book tiles (`.tc-book`) carry Uncategorized estimates: `big.est` = qty of UNCAT rows with est, `aotm.est` = aqty of rows with uncatAEst. Computer: `.tc-est` "Estimated: N" top right (`.has-est` grid); phone (≤560px): `.value-est` "(N Estimated)" at 10.5px under the pre-orders.
- `.value-pre` never breaks inside "(40 pre-orders)" (nowrap, inline-block).
- `layoutTotals()` rewritten: book cards one width (the widest's need), money cards after them, the totals card `flex:1 1 0` taking the rest, Pending at its own width. Tries one line with everything unwrapped, then the money cards' small print wrapped, then the books', then all, then `.totals.tot-sq` (tighter padding/gap/figure size). Otherwise books share their own line(s) equally (two to a line if three won't fit) and the money cards go beneath (totals grows 100:1 over Pending). `.tc-coll .label` never wraps.
- Earthly HQ card: Q2 reads "Exp:" / "Don:" (`.tc-ab`); on a phone the HQ card keeps Q2 top right beside Net Sales (grid "q1 q2" / "q3 q3" / "q4 q4").
- Finance tabs back to Overview / Expenses / Reimbursements (FIN_SECS, SN_ITEMS.finreimb, the Finance menu button). The bar's button and its window are "Reimbursement Links".
- Portal button live: `hdrPortal()` shows #portalBtn wherever SIDE_NAV and Finance are; `body.hdr2` (hiding name/Report/Refresh) stays practice-only. The `finleave` menu row is gone (renderSideNav deletes it); "Leave Finance" stays for Finance-only people.
- Refresh in Finance: an inline head script adds `html.fin-boot` on a #finance address, hiding `body > *` until init() decides (removed there; 4 s safety). A frame of the sales masthead painted before init was the desktop flash.
- Practice: Uncategorized calculator rewritten: known = Confirmed, or typed and not empty; the anchor is a Confirmed one, else the last typed, else whichever is known; an emptied box is the app's again once you leave it (blur), never filled while focused; edit opens unchanged.
- Practice: "WhatsApp Reports" (`waReportsModal`, act `wareports`) replaces Specialty Reports and Report in the practice menu: 1. a searchable place (season, regions, sub-regions, events; `waPlaces`), 2. optional extra places (＋ Add a location, ✕ to remove), 3. sections (REPORT_SECTIONS), Generate Report, Copy / Send…. Built with buildReport's combo (locs/groups/title) plus new `opts.saleOk` so sub-regions count their warehouse sales. Sections remembered (localStorage tbs_wareports).
- SERVER_BUILD b300.
- Tests: new browser-b300 (42); truthclient, browser-finance, browser-expenses updated.

## Done in b299
Live app changes (Gita, 2026-10-23 14:24 IST).
- Dollars received: $253 is recorded as $253, not $252.98. convApply rounds each sale's dollars, then gives the rounding remainder to the biggest sale of each place and currency, so the parts add up to exactly what was entered.
- Deleting Dollars received from the Activity Log refreshes Finance (FIN.D, device cache and expense list dropped, then refetched).
- The sales app counts at Finance's Dollars received rates: Code.gs convFxMap_() sends `convFx` (loc → {cur: amt/usd}, event → region → season) with the season state; ratesAt() lays it over the frozen rates.
- "~" in the sales app on dollars worked out from a rate (usdExact, usdCostExact, legExact): totals cards, the payment table, Collections by Region. None where every currency is at a fixed rate (Dollars received, a closed place's) or dollars were entered.
- Cents always shown: usd2() for dollars; cashFmt for amounts in any currency. Book prices keep their old look (priceFmt).
- Pop-ups with the ✕: a "Close" button in the footer is removed (openModal); an emptied footer is hidden (.m-foot:empty) but kept, as some windows fill it later. Cancel stays.
- Edit Season (and the whole menu) acts on the place Finance shows: finSyncPlace switches the sales side's season quietly when Finance is in another (FIN.syncTo), and Earthly HQ to Earthly HQ. Entering Finance from the sales side opens at the sales place (salesFinScope).
- Phone: a little room under Report/Refresh before the yellow line.
- Finance on a phone: the joined section tabs are live (approved). The Reimbursements tab and menu item read "Reimbursement Links".
- "Pending Payments" back everywhere except the Overview table's column (and its CSV).
- Totals bar: layoutTotals() sets widths in JS. Cards are equal across a line; where they don't fit, the card with the least in it shrinks to its own width, then the next. Small print (gifts, pre-orders, currencies) may wrap so fewer lines are needed; of the layouts with fewest lines, the one taking least height wins. Runs after render, on resize and once fonts load. HQ's Q4 is titled "Collections by Currency"; .tc-coll columns can no longer overlap.
- WhatsApp report: Total Collections, Expenses, Donations and Net Sales as on the totals card ("=" hard figures, "≈" from a rate); "Net after expenses" gone.
- Pre-order Deliver from anywhere is live (deliverModal → deliverPickModal). Its list: "Name (warehouse)" with only the name bold, the rest grey (combo items take `html`).
- Service worker v2: the page is kept under one name and always refreshed from the server (no-cache); v1 opened a copy kept under "./" since install on a slow signal (Gita saw b265).
- Refreshing in Finance shows Finance at once (FIN.boot), not the sales page first.
- "Go to Sales Portal" sits first in the menu while in Finance (was inside the folded Finance group).
- Practice only: Uncategorized Sales has Confirmed/Estimated per kind before each number (server `aest` column; est is the Big Books'). A known number makes the other an estimate from what is left, coloured like the currency adder (rp-auto), with "Based on N Big Books, M is the estimated number of Adventures sold." (and the reverse). Once typed, even emptied, a number is never refilled.
- Practice only: the top bar has a fixed "📈 Finance Portal" / "🏠 Sales Portal" button and the Activity Log; Refresh is gone, Report is in Advanced, your name sits above Sign Out (body.hdr2, hdrPortal).
- Tests: browser-b293 (+6 b299), browser-b297, browser-expenses (+1), browser-subregions (+2), browser-sellers, browser-round2/6, browser-finance, truthclient and chg2 updated for the wording and cents.

## Done in b298
Live app changes (Gita, 2026-10-23 12:21 IST).
- Dollars received: several currencies in one entry ("85 € + 6250 ден + $5 = $253"). Server convSet takes parts[]; core looks up each currency's day rate (fxOn, nearest-day fallback) and the dollars (less any dollars in the pile) are shared out by worth, evenly if a rate is missing. Rows keep `parts`; old single-currency rows still read. Total collections fills a row per currency taken at that place.
- Deletes of Dollars received (window and Activity Log) ask in the app's own window (askSure) instead of the browser's confirm(), which some phones and in-app browsers answer "no" silently. Finance and Universal may delete (mayPay).
- Totals bar: every card grows by the same share of spare room (no extra grow on Total Collections).
- Finance Overview table: only Sold and Gross per kind; tapping Sold opens Gifted and Distributed (FIN.ovwOpen, .fo-<kind>).
- One Net colour (--net #2a78d6, the Finance charts' Net) for Net Sales on the totals cards, the payment table's net rows, Collections by Region's USD column and Finance's Net.
- "Pending Payments" reads "Pending" in Finance and on the totals bar (the sales-side panel keeps its name beside "Pre-orders pending").
- "Costs" reads "Expenses" everywhere: totals cards, payment table, WhatsApp report, spreadsheets' headers, the old costs window.
- Earthly HQ card: Q1 Net Sales, Q2 Expenses and Donations, Q3 Total Collections, Q4 by currency (.tc-hq).
- A sub-region's Summary (its old warehouse) adds up the whole sub-region (subWhHere in scopedSales/scopedAllCosts); Finance the same (finScopeF).
- Pre-order Deliver (practice): server stockWhere lists every place in every season and Earthly HQ holding the titles; the picker names each with its region and season.
- Finance: a line between the path and the sections on a phone and narrow window; practice only, on a phone the sections are one joined bar and the two actions sit on their own row (for Gita's approval).
- Uncategorized Sales (practice): the hint spells the sum out.
- Tests: browser-b297 (+6 b298), browser-finance (+7), browser-subregions (+1), wording updates in truthclient, browser-expenses.

## Done in b297
Live app changes (Gita, 2026-10-23 09:47 IST). Folds in b296 (PR #97, Live app emergency).
- Finance Dollars received: "Total collections" tick fills Took with the place's collections in that currency (totalAt via finScopeF(at)).
- Negative figures red everywhere (redNegatives over NET_SEL; .fin-neg).
- Finance table headings sit right over their figures.
- Finance Overview table: groups Big Books / Adventures / Other (Sold, Gifted, Distributed, Gross), then Total Gross, Donations, Pending, Expenses, Net, Margin; two-row header, scrolls sideways with place names sticky. "Other" is no longer counted inside Big Books (finAgg ot/otg/otu). CSV uses the same columns.
- Earthly HQ totals: Net Sales big, Total Collections small.
- Totals bar: flex, each card as wide as it needs, spans the row; AoTM first; Other and Total Pending hidden at 0.
- Switching season keeps the scroll position (woJump no longer scrolls).
- Finance place search sits level with the path (28px).
- Sub-regions: "<sub> Summary" opens the sub-region's warehouse event (subWarehouse); the warehouse isn't listed twice. Same in Finance.
- Srila Prabhupada's picture is the same size as Gurudeva's (265:360, 84px high).
- Practice: Deliver/Fulfil can take stock from Earthly HQ (hqStockMap fetches wh_hq).
- Tests: test/browser-b297.js (16), browser-subregions (+2), browser-finance and browser-expenses updated.

## Done in b296

- **Dollars received can't silently blow up a place's figures** (Gita, live emergency, 2026-10-23): she wrote down 250.13 ден fetched $253 at Macedonia (1 ден = $1.01, real ≈ $0.018), and every denar sale there counted about 55× too high. Removing the entry (🗑 in Dollars received) restores it, since `finConv` is applied at read time.
  - Before saving, `finConvModal` asks `fxOn(date, cur, 'USD')`; if the dollars are more than double or less than half the usual amount it asks "Please check the numbers. X is usually about $Y, not $Z. Save it anyway?". No rate found: saves without asking.
  - Activity Log Delete: `convSet` / `convDel` log `{type:'exp', op:'convSet'|'convDel', id, was}`; `expUndo` puts `finConv` back (an added one goes, a changed one goes back, a removed one returns). Finance only.
  - Tests: browser-finance +4 (asks, Cancel saves nothing, OK saves, Activity Log Delete restores). SERVER_BUILD b296.

## Done in b295

Live app changes (Gita, 2026-10-23). Live unless marked practice.
- **Every figure has room** (Gita's standing rule: make the space, scroll left to right when needed): the payment table (`.ptg`) sizes its columns to their contents (`minmax(max-content,auto)`) inside `.ptg-scroll`; `fitCards` widens a card grid's columns to its widest card (cards no longer squeeze their names), run after `renderAll`, on wording changes and on resize. On a phone some card grids go one per row as a result.
- **Same heading everywhere**: the season line always shows, reading "Earthly HQ" at Earthly HQ (and in Finance with no place chosen), so nothing jumps.
- **Seasons closed last, A to Z** (`seasonsOrdered_` in Code.gs: getState, everywhere_, financeData_).
- **Finance section switch**: the b293 fade (`#fpBody.fin-in`) is gone; new figures replace the old in one frame.
- **Phone Expenses**: one amount on the line (the dollars); the original currency moves into the details (`.fx-odet`).
- **Reimbursement links**: "Anywhere" reads "General" (client combos, server `placeLabel`, error text).
- **Finance place search on every section**: `finSearchHTML` sits in the nav beside the path (`#fpNav .fin-search`), no longer in the Overview's date filters.
- **Buttons under the shelf** (`#invMulti`, `data-n`): one row on a computer, two to a line on a phone (a third takes the full line). Uncategorized Sales shows only for Universal and Finance (`financeMe` U/F/FA).
- **Total Collections tile in four parts** (`.tc-coll`, `tc-q1..q4`): total; costs (red) and donations (donation colour); currencies; Net Sales = collections − costs − donations. Phone: total, currencies, costs and donations without words, Net Sales.
- **Live now**: Edit Finance-Only Locations (`finPlaceEdit` gate removed; menu button for F/U), and a season's name opening at its Warehouse Overview (`woJump`).
- **Activity Log: edited sales are logged** (Gita): `editSale`, `editBundle`, `markPaid`, `markPaidBundle` and an Uncategorized edit leave `ACTIVITY_SKIP`; `saleSnap_` words the sale and its payment before and after ("payment 150 PLN Cash → 140 PLN Card"). No Delete on these. New sales still stay out.
- **Activity Log's loading wheel stops**: `.sp-loading{display:flex}` beat `[hidden]`, so the spinner never went away; `.sp-loading[hidden]{display:none}`.
- **Practice favicon** on deep blue #1F5F8B, the complement of the saffron robe.
- **Practice: Deliver**: "Fulfilled from" lists only places that hold every copy needed (`covers`).
- **Practice: Uncategorized Sales**: Big Books sold and Adventures sold (new sales column `aqty`; `qty` stays Big Books); Big Books fill in from the total (less any Adventures at their usual price) until typed; radios "Estimated # of Books Sold" / "Confirmed # of Books Sold" (`est`). Books add into the Big Books and AoTM tiles, no card of their own; Finance gets `qa` and shares the money by count (`finAgg`).

## Done in b294

- **Practice has its own tab icon** (Gita, 2026-10-23): Gurudeva on a yellow square (`favicon-practice*.png/.ico`, `apple-touch-icon-practice.png`); a small script in `<head>` swaps the icon links when the address has `?practice`. Live keeps the plain icon. Gurudeva's robe stays as it is.

## Done in b293

Live app changes (Gita, 2026-10-22). Live unless marked practice.
- **Upload Sales Spreadsheet is live** (`SUP_ON = true`): event menu "📤 Upload Sales Spreadsheet".
- **Finance steps in without a flash**: changing section no longer reloads everything ("Adding everything up…"); the figures fade in over the old ones (`#fpBody.fin-in`), links refresh quietly (`finLinksQuiet`), and wording is applied before the page shows (`finRender` wraps `finRender0` + `applyLabels`).
- **Wording edits inside a searchable drop-down stay open**: `labelInline` holds the list open (`.pp-list.lbl-hold`) and puts focus back after.
- **Reimbursement Settings as squares**: `.rs-tiles` / `.rs-tile`, four across on a computer (two at ≤1100px), one under another on a phone (≤560px); choices listed vertically.
- **Phone Expenses date** MM/DD/YY (`finShortDate`, `.fx-dl` / `.fx-ds`).
- **Spanish** is deep rose, no longer green (`LANG_HUES[2]`).
- **Reorganize Menu** lists only items the menu can show (no Finance To do, Edit Book Display, Record Costs, etc.).
- **Closed places last, then A to Z** in every place menu (`closedSort`), Sales and Finance.
- **The path at the top as links** (`crumbLink` / `crumbNext`): Earthly HQ › season › region › sub-region › event are links to their pages; a ▾ beside each (a transparent native select, `.crumb-more`) lists the others at that level; the last step is a drop-down of what is below ("Regions…", "Events…"). Replaces "⌂ Seasonal HQ" and "🏠 Warehouse" in the pickers. New acts: `goregion`, `gosub`, `goevent`; `setSub(id, rid)`.
- **Finance's path is the Sales one** (`finNav`): same links, words, order and marks; the chip reads Earthly HQ / Season / Region / Event.
- **Dollars received live**: tapping any "~$" figure (`finEstMark`), for people who may edit Finance.
- **Practice: Deliver** offers only "Delivered from outside the system" under "Fulfilled from" (another region is a place in the list).
- **Practice: Uncategorized Sales** (`UNCAT_ON = PRACTICE`, `uncatModal`, server `uncatSale` / `doUncatSale`): a total, books = total ÷ the usual Big Book price here, rounded down (editable), "This is an estimate" (new sales column `est`). Stored as one sales row of type `UNCAT` with no title and qty = books; nothing comes off a shelf. Counts in Big Books sold (totals, sellers, sales by region, WhatsApp, Finance via `b:'uncat'`), with an "Uncategorized Sales" card. Edit replaces it in place (`editId`); delete from the sales log.
- Tests: `test/browser-b293.js` (new), and updates to browser-finance, browser-expenses, browser-search, browser-subregions, browser-round2.

## Done in b292
Gita's next list (Live app changes, 2026-10-22), on the same PR as b291.
- Finance To do is gone everywhere, practice too (FIN_SECS, FIN_BTNS; an old #finance/todo address opens the Overview).
- Finance-only people (no sales side) get Send Reimbursements Link and Add an Expense on the Finance bar too, beside Leave Finance.
- App Development › Reorganize Menu is drag and drop: drag a section by its heading or an item by its row, into any section; a dashed gap shows where it lands. Every item is listed, the place's own actions too (Change Event Order, Change Regional Order, Edit/Rename, Sub-regions, Upload Sales Spreadsheet, Close/Reopen, Delete), arranged once for every level (SN_PLACE_KEY). Change Event Order and Change Regional Order are now two menu items (they were one key, so one hid the other).
- The menu's round ☰ no longer sits over an open window.
- Practice: delivering a pre-order asks "Fulfilled from" in a searchable drop-down of every warehouse, store and open event, each with its copies, starting where you are (deliverPickModal); Another region and Outside the tour stay below.

## Done in b291
Gita's list of 16 (Live app changes, 2026-10-22) and two later asks.
- Live: Finance holds still. Its menus and page colour no longer change while you move between places; only the figures change. The left-hand menu and Finance's own menu redraw only when the place really changed. The page scrolls to the top only for a new section.
- Live: Reimbursement Settings start at the Finance person's region, and each pay-back method is an on/off tick (rsDraw/rsSave store only what differs from the inherited setting).
- Live: the Add an Expense window has only the ✕ (the Finance To do and Close buttons are gone).
- Live: Finance's top row has 🧾 Add an Expense where "← Go to Sales Portal" was (that link is in the menu).
- Live: Dollars received is off the Expenses screen. Practice: every "~$…" figure on a Finance screen is a button that opens Dollars received for the exact amount (finEstMark).
- Live: a General expense shows no "Who".
- Live: Send Reimbursements Link asks "For" which place (defaults to where you are; FIN.sendPlace). The email's subject is "One-time reimbursement link" and its body is Gita's text (reimbEmail).
- Live: a link's form always accepts its own place, including Earthly HQ, Finance-only places and closed places (server inReach/options). Before, those links said "Choose where the expense belongs."
- Live: reimbursement links can be deleted (🗑 Delete link in the link's details, expLinkDel). Expenses already sent through it stay.
- Live: turning Edit Wording off removes every pencil. While it is on, the menu reads "Turn off Editing Wording".
- Live: the events drop-down says "X Summary" for a region or sub-region (was "All of X"), with its events indented under it.
- Practice: picking a season's name opens its page at the Warehouse Overview, unfolded (woJump).
- Live: Send Reimbursements Link sits beside Add an Expense on the Finance bar (off the Reimbursements title row).
- Live: on a phone the Expenses list's Dollars column is wide enough that the figures sit right under their title.
- Live: closing a region closes its open events at the same moment (Code.gs regionEventsSet_); reopening it reopens those, and an event closed on its own stays closed.
- Live: on a phone the top total cards show the title, the number sold, then the pre-orders on a line of their own.

## Done in b290

Practice first, then the wording merge (Gita, 2026-10-22):
- Finance › Edit Finance-Only Locations (practice only): choose a Finance-only place from a searchable list; rename it, move it under Earthly HQ, a season or a region, or remove it once no expense is recorded there. Server `finPlaceEdit` (expenses.js), refused on live for now.
- Bring Wording & Settings from Practice: three-way. Starting practice over (practiceReset) keeps prop `labelsBase`, live's wording at that copy. `finCarryOut` hands it over with practice's wording; `finCarryIn` with `plan:true` sorts each difference: changed only in practice comes over, changed only in live stays, changed in both is listed with both versions. Nothing is written until each of those has a choice (`choices` {key: 'practice'|'live'}). Before the first practice copy since b289 there's no record, so every difference is listed to choose.

## Done in b287

Live fixes after b286 (Gita, 2026-10-22):
- Finance never sits blank: a device copy that won't draw is dropped and the figures fetched afresh once; if the server doesn't answer (45 s limit) Finance says why with "↻ Try again". The device copy is skipped when it would be over ~900 KB or there's no room, so it never crowds out the rest of the app's storage.
- Phone cards with no Sell button: the room under "N distributed" halved (16px to 8px).
- The Consignment bubble greys out with the language bubble when nothing is in stock (a closed place).

## Done in b286

Live app changes (Gita, 2026-10-22, 18 points plus payment-type groups).

- **Activity Log complete and fast.** Universal gets the whole log from the server (every season and Earthly HQ; it used to send only the season the device was on, 9 of 284 entries). The season page and Earthly HQ show it all, entries from another season tagged with its name; regions and events still show their own. The log is fetched quietly a few seconds after the app opens and kept on the device (one copy), so it opens at once.
- **Finance opens at once.** The figures last seen are kept on the device per person (live and practice apart) and shown straight away, then refreshed by themselves. The server keeps the sums (`financeData_`) until anything is saved or five minutes pass (expenses.js `finSums`), 112 ms to 11 ms on a copy of the live data.
- Selling cards: on a phone a card without Sell/Pre-order has 16px under its gifts/distributed line. "N distributed" is bold as a whole wherever it appears. The consignment bubble sits on its own line under the title, the same size and shape as the language bubble.
- Expense form: choosing Where from the search list no longer moves the form (the anchor is the search box, not the list row that has just closed).
- Finance charts: "Income by Source" (centre: Gross); while payments are pending, two rings: "Income by Source (Actual)" (Gross) and "(Expected)" (Expected Gross). As many charts a row as fit, none wider than half (auto-fill). Expenses by place has its own colours (`VIZ_PLACE`).
- **Expenses and Reimbursements are two screens** (`FIN_SECS` expenses / reimb; Reimbursement Settings is a tab of Reimbursements; left menu has both). Reimbursements has its own charts (waiting by person, paid back by month).
- Links: one line each (name and Turn Back On / Turn off), the rest in a dropdown; a link someone asked to have back comes first, in colour, with a red border.
- Reimbursements: when some are waiting outside the place being looked at, a red note lists where, with "Show every season" (Gita's link submission for Skopje was in another season).
- Reimbursement form: "Same as above" is offered only when there is something above to copy, and never wipes what was typed. "Pay me back in a different currency" is a checkbox; the currency menu shows only when it is ticked (otherwise paid back in the currency spent).
- Reimbursement Settings: currencies are checkboxes only, ticked to start with as the place selected has them; ticked differently they become that place's own.
- Pencils on drop-down menus: in Edit Wording a ✏️ beside each menu lists its choices; each opens the usual window, and the wording shows in the menu (`lblOptions`).
- **Payment types in groups:** Cash, Digital Payments (accounts indented under it), Card, Other, Gift, Mixed (two or more forms of payment). In Payments taken here, ⇤/⇥ bring a type out from under Digital Payments or put it back, ▲▼ arrange (the group moves as one). Saved per place as meta `payTop` (`setPayTypes` `top`), sent in state as `payTop`. A type added later goes under Digital Payments.

## Done in b283

Live app changes (Gita, 2026-10-22):
- **A region's new payment type didn't stick.** In Edit Payment Types, a name typed in "Add another"
  was lost unless "Add" was pressed before Save. Save now keeps it, and Enter adds it.
- **Payment type is a searchable dropdown** on every sales form: sale, pre-order, edit, and each
  part of a Mixed payment (`ptSearchable`, applied by a MutationObserver on `#modal`).
  - The `<select>` stays hidden as the source of truth. The search sets it and fires `change`, and
    when code sets it (Mixed, editing a sale) the search shows it (`box._set` in `comboBind`).
- **Universal, Finance (F) and coordinators can "＋ Add" a payment type** there, the same way as
  kinds of expense.
  - Server `addPayType` (Code.gs `doAddPayType`, in COORD_EXTRA, so a coordinator can add only in
    their own region).
  - It joins the event's own list if the event has one, else its region's. A place still following
    the tour starts from `PAY_TYPES`. It goes before Other/Gift, and the same name twice is kept once.
  - core.js lets a signed-in Finance user run just this action as the owner would (`finAdd`).
- **App Development › Reorganize Menu** (Universal), live.
  - Move sections and their items with ▲▼, or move an item into another section.
  - Saved for everyone as meta `menuOrder` {sections, items} (`setMenuOrder`, owner only), and sent in
    state as `menuOrder`. `snOrdered()` builds the menu from it.
  - "Back to the original order" clears it. The place section's own actions are not reordered.
- SERVER_BUILD b283 (Code.gs changed).
- Tests: browser-paytypes283 (12), browser-menuorder283 (10), and expenses.js b283 permission checks.
  browser-round4/round6 now choose the type through the search.

## Done in b284 — bring a separately made region in as a sub-region (practice only)

Gita, 2026-10-22: "I want to add the already-populated regions to this". Madrid and Barcelona were
made as two regions, each with its own warehouse.
- **Sub-regions window › ⤵ Bring in another region…** (`mergeRegionModal`) asks four things: the
  region to bring in, its sub-region's name (its own name by default), the sub-region for this
  region's own events (only when it has none yet), and the combined region's name. The merged
  region's name must be typed to confirm.
- **Server `mergeRegion` (`doMergeRegion`):**
  - Re-points every column that names the old region to the target: events, holders, shipments
    (from/to), consignment partners, sales' `fulfilBy`, org-chart scope, mismatches' `placeId`,
    cash and change (`BANK_<id>` → `BANK_<target>`), and expenses (`regionId`; region-wide ones
    go to the old warehouse id, `placeLabel` renamed).
  - Its prices are dropped.
  - The old warehouse becomes an EVENT of the target, named "<sub> (warehouse)", with the same id
    and the same closedAt. Sales, costs and cash recorded there stay where they are, now in the
    sub-region. Its books move to the target's warehouse (TRANSFER moves).
  - The old region row is deleted. An existing sub-region of the same name is reused.
  - Everything changed is stored in `_meta` `mergeUndo:<fromId>`. The Activity Log entry carries
    undo {type:'merge'}, and `undoMerge_` puts it all back (books as far as still in the target
    warehouse).
- Lost on a merge: the old region's coordinator/seller links, payment-type list, book order,
  hidden titles and frozen closing rates. Its places use the target's from then on.
- Tests: browser-subregions (+11: the window, the name check, the region gone, events and old
  warehouse in the sub-region, books moved, sales and the expense still Madrid's, undo).

## Done in b285 — sub-regions chosen in the place picker; a container region asks less (practice only)

Gita, 2026-10-22: "The new bubble line is too much. remove it." and "If there are no events in the
region, then we don't need [the question for its own events] … Spain is just the container".
- The line of sub-region chips under the bar (`.subr-bar`/`.subr-chip`, action `subpick`) is gone.
  The place picker does it instead: each sub-region's group starts with "🗺 All of <sub>" (value
  `__sub:<id>`), and the warehouse reads "🏠 Warehouse · all of <region>" and clears the choice.
  Inside a sub-region the picker is drawn from the whole region (`wholeRegion`, `SUB_FULL`), so
  you can move between sub-regions. Sub-regions with no events still get their group.
- The grey warehouse note stays. The ⚙ chip went with the chips: Sub-regions is in the menu.
- `mergeRegionModal`: no "<region>'s own events go in the sub-region" field when the region has no
  events (or already has sub-regions); the server already makes no extra sub-region for an empty
  `intoSub`.
- Client only; SERVER_BUILD stays b284.
- Tests: browser-subregions 47 (chip checks replaced by picker checks; container-region checks).

## Done in b288 — Upload Sales Spreadsheet into an event (practice only)

Gita, 2026-10-22: sales taken somewhere else (her ISV form sheet) go into an event in one go.
- **Event menu › 📤 Upload Sales Spreadsheet** (`salesUploadModal`, Universal, `SUP_ON` = PRACTICE).
  Reads a CSV (`csvRows`, quoted cells, tab files too) by its headings: Book/Title, Payment/Method,
  Amount (currency from "(USD)" in the heading), Type (Sale, Pre-Order, Donation, Gift), Name,
  Phone, Date/Time (`supDate`: "6/7/2026, 5:33:15 PM", "07.06.2026 17:33", ISO; month first unless a
  day over 12 says otherwise, with a choice shown for the first date).
- Titles match by exact name, or the only title of that name in any language (`supFindBook`);
  anything else ("Sri Radha (Signed)", "Govardhana" when there are two languages) must be chosen,
  or "Leave these rows out". Payment methods match the place's types ignoring case/spaces, "credit
  card" → Card; an unknown one becomes "＋ New: Venmo", added to the place's list on upload
  (`addPayType`).
- Every row has a tick box. Blank rows and rows with no book or amount are listed as left out. A
  name like "test" / "Not a Preorder" starts unticked. A row already at the event (same title,
  kind and amount within a minute) starts unticked as "already in the app".
- Upload waits until every title is chosen and the event has the copies for the ticked sales
  (with ＋ Add New Stock / ⇄ Transfer Existing Stock; the file is kept in `SUP` while you do).
- **Server `importSales` (`doImportSales`):** checks stock for the whole file first, then records
  each row through `doSell` / `doDonate` with the page's own sale ids (a resend changes nothing).
  In MUTATING_ACTIONS (closed places refuse it), owner only. Activity Log: "Uploaded 46 sales,
  10 pre-orders and 1 donation from a spreadsheet (file.csv) into <place>", undo {type:'sales'}
  deletes every row and puts the copies back.
- SERVER_BUILD b288. Test: browser-salesupload288 (23, a made-up file shaped like Gita's).

## Done in b289 — sub-regions go live; warehouse sales ask which sub-region; no split of shared costs

Gita, 2026-10-22, answering the open questions: keep the name "Sub-regions"; "Don't split them. Show
shared costs only on the whole region" (a per-book cost may come later, once printing costs are
caught); "When someone sells straight from the warehouse … Yes, always ask"; "Now. Put them on live";
and leave the old Madrid/Barcelona data as it is (she will bring Madrid in herself).
- **Live:** `SUBR_ON = true`. The Sub-regions window, Bring in another region, the place-picker
  groups, Collections, the report and Finance's sub-region scopes are all live now.
- **Warehouse sales:** a sale, pre-order, several-books sale or donation recorded at a region's
  warehouse, in a region with sub-regions, asks "Which sub-region is this for?" (`subAskHTML`,
  `#csSub`): the sub-regions, then "All of <region> (none of them)". Nothing is preselected unless
  the page is on one sub-region; it will not record until one is chosen. An edit shows the current
  answer (old untagged sales: "none of them").
  - Sent as `subRegion` on sell / sellBundle / donate / editSale / editBundle. After the action the
    server's dispatcher calls `tagSaleSub_`, which keeps it in meta `subRegions.sales` keyed by the
    sale id (a bundle's id for several books): valid only at a region warehouse, for one of that
    region's sub-regions; anything else removes the tag. Removing a sub-region drops its tags.
    Old payloads have no `subRegion`, so recorded sessions replay unchanged.
  - Client `saleSub(x)` = the event's sub-region, else the tag. Used by `subState` (a sub-region's
    page), `subParts` (each part now carries a `sale` test, used by the report's By sub-region blocks
    and Collections by Region) — costs still go by place.
  - Finance: `financeData_` gives each warehouse sale `u` (its tag). `finFiltered` and the pending
    list count `!x.e && x.u === f.u` in a sub-region; By Sub-region adds them to their sub-region and
    takes them out of "general"; a sub-region's By Event starts with "Sold from the warehouse".
- **Shared costs:** the "Shared with all of <region> … its share … Net after its share" line
  (`finSubShare`, `.fin-share`) is gone. A sub-region shows its own costs only; shared ones show on
  the region (and its ", general" row).
- The grey "Selling straight from the warehouse counts for all of …" note is gone (it now asks).
- SERVER_BUILD b289.
- Tests: browser-subregions 58 (+11: the question, refusing without an answer, the server tag,
  page/report/Collections/Finance counting it, preselect, donation, events don't ask, live on).
