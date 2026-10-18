# Who can do what — the permission rules

The single reference for logins and permissions. Decided by the owner in
October 2026 (the Permission Review, then follow-up answers). Build and test
against this file; change it first when a rule changes.

Status: **Stage 1 built** (people, roles, sign-in, delegation, emergency
links, names). Stages 2–4 below are not built yet.

---

## 1. Everyone signs in with Google

- Every person signs in with a Google account. No emailed sign-in links
  (they would need a web domain and an email service; decided against).
- Each person has a **display name**, which they can change. It starts as
  their Google name. The app uses it everywhere a person is named: the sales
  log, the Activity Log, "Hand your cash to **Gita**", and so on.
- **Emergency sales links** stay, for someone who steps in at the last
  minute: a link with **Seller** permissions for one event, no login. It stops
  working when the event closes. Event Leads and above can make one.

## 2. Roles

A person holds **one or more roles**, each tied to its own place — for
example *Seller at Yoga Studio* and *Regional Assistant for Italy*. They may do
whatever any of their roles allows, each only within that role's reach.

| Role | Short | Reach |
|---|---|---|
| Seller | S | one event |
| Event Lead | EL | one event |
| Regional Lead | RL | one region and its events |
| Regional Assistant | RA | one region and its events |
| Seasonal Lead | SL | one season and everything in it |
| Seasonal Assistant | SA | one season and everything in it |
| Finance | F | everything |
| Finance Assistant | FA | everything |
| Universal | U | everything, and can give any login |

- **Assistants see everything their lead sees, but change nothing** (with the
  exceptions in the table: recording costs, entering "$ Received").
- **Costs and profit** (cost totals, money after costs) are seen only by
  Finance, the Finance Assistant (view) and Universal. Everyone may *record* a
  cost.
- A role **ends by itself** when its place closes: an event role when the
  event closes, a region role when the region closes, a season role when the
  season closes. Reopening the place brings it back.

## 3. Giving and removing logins

- You may give **any role below your own**, at a place **within your reach**:
  - Universal → any role, anywhere.
  - Seasonal Lead → Seasonal Assistant, Regional Lead, Regional Assistant,
    Event Lead, Seller — within their season.
  - Regional Lead → Regional Assistant, Event Lead, Seller — within their region.
  - Event Lead → Seller — at their own event.
  - Assistants and Finance roles give no logins (assistants can see who has access).
- Removing: the same people, for roles they could give. An Event Lead removes
  only Sellers they added themselves.
- Someone who signs in with no role leaves a **request**. Anyone who can give
  logins sees it and can give them a role within their own limits, or decline.
- The owners listed in Cloudflare's `ADMIN_EMAILS` are always Universal and
  cannot be removed in the app, so nobody can be locked out.

## 4. The permission table

**✓** can, within their reach · **own** only their own entries / own event ·
**view** see but not change · **–** no

| Action | S | EL | RL | RA | SL | SA | F | FA | U |
|---|---|---|---|---|---|---|---|---|---|
| **Selling** | | | | | | | | | |
| Sell books, take pre-orders, record donations | ✓ | ✓ | ✓ | view | ✓ | view | view | view | ✓ |
| Edit or delete a sale | own | ✓ | ✓ | – | ✓ | – | – | – | ✓ |
| Deliver a pre-order | – | ✓ | ✓ | – | ✓ | – | – | – | ✓ |
| Mark a pending payment as paid | own | ✓ | ✓ | – | ✓ | – | – | – | ✓ |
| Hand over change owed to a customer | own | ✓ | ✓ | – | ✓ | – | – | – | ✓ |
| Accept or decline another region’s pre-order request | – | – | ✓ | – | ✓ | – | – | – | ✓ |
| “My sales” tile on the top bar | ✓ | – | – | – | – | – | – | – | – |
| **Money** | | | | | | | | | |
| See money totals | own | ✓ | ✓ | view | ✓ | view | ✓ | ✓ | ✓ |
| Deliver cash to the Event Lead (two taps) | ✓ | ✓ | – | – | – | – | – | – | – |
| Cash Tracker | – | ✓ | ✓ | view | ✓ | view | ✓ | view | ✓ |
| Change owed and Pending Payments lists | own | ✓ | ✓ | view | ✓ | view | view | view | ✓ |
| “$ Received”: the dollars that actually arrived | – | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Record a cost | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Record an expense (for the records or to be paid back), with receipts | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| See every expense and the Finance To do; record one for someone else | – | – | – | – | – | – | ✓ | ✓ | ✓ |
| Pay back or decline an expense; Reimbursement Settings | – | – | – | – | – | – | ✓ | view | ✓ |
| See cost totals and money after costs | – | – | – | – | – | – | ✓ | view | ✓ |
| **Stock** | | | | | | | | | |
| See stock in their region | – | view | view | view | view | view | view | view | view |
| See stock in every warehouse, everywhere | – | – | view | view | view | view | view | view | view |
| Transfer between the region’s warehouse and its events | – | own | ✓ | view | ✓ | view | view | view | ✓ |
| Move stock between warehouses (regions, seasons, Earthly HQ) | – | – | ✓ | view | ✓ | view | view | view | ✓ |
| Receive books in transit | – | own | ✓ | view | ✓ | view | view | view | ✓ |
| Add Stock from outside the tour | – | – | ✓ | view | ✓ | view | view | view | ✓ |
| Set a count outright; correct or delete a shipment | – | – | – | – | – | – | – | – | ✓ |
| Closing counts | – | own | ✓ | view | ✓ | view | view | view | ✓ |
| Devotee storage (sub-warehouses) | – | own | ✓ | view | ✓ | view | view | view | ✓ |
| **Setup** | | | | | | | | | |
| Create places | – | – | ✓ | view | ✓ | view | view | view | ✓ |
| Close or reopen places | – | own | ✓ | view | ✓ | view | – | – | ✓ |
| Add new book titles | – | – | ✓ | view | ✓ | view | – | – | ✓ |
| Prices and currencies | – | own | ✓ | view | ✓ | view | view | view | ✓ |
| Payment types | – | own | ✓ | view | ✓ | view | view | view | ✓ |
| Payment QR codes | – | own | ✓ | view | ✓ | view | view | view | ✓ |
| Edit Book Display | – | own | ✓ | view | ✓ | view | view | view | ✓ |
| Consignment: groups, books, prices, payouts | – | own | ✓ | view | ✓ | view | view | view | ✓ |
| Sell consignment books | ✓ | ✓ | ✓ | view | ✓ | view | view | view | ✓ |
| Edit Wording | – | – | – | – | – | – | – | – | ✓ |
| **People** | | | | | | | | | |
| Give logins | – | ✓ | ✓ | view | ✓ | view | – | – | ✓ |
| Emergency sales links | – | ✓ | ✓ | – | ✓ | – | – | – | ✓ |
| Remove someone’s access | – | own | ✓ | view | ✓ | view | – | – | ✓ |
| **Records** | | | | | | | | | |
| WhatsApp and Speciality Reports | – | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| See the Activity Log | own | ✓ | ✓ | view | ✓ | view | view | view | ✓ |
| Undo from the Activity Log | own | ✓ | ✓ | – | ✓ | – | – | – | ✓ |
| Google spreadsheets | – | – | view | view | view | view | view | view | ✓ |

Notes on the table:
- **Expenses** (b237) are enforced by the server already (server/src/expenses.js),
  ahead of Stage 2, and work for every role, including those that still see
  "Not quite yet". Not yet rows in the 🔐 Permissions window.
- **Deliver a pre-order** is for leads, not Sellers: a pre-order means there was
  no copy to give, so handing it over happens higher up.
- **Set a count outright** is Universal only. A **closing count that does not
  match** is not written over the records: it is flagged (see 5.4).
- **Deliver cash** is only between a Seller and their Event Lead, two taps (the
  Seller hands over, the Event Lead confirms). Everything beyond that is the
  Cash Tracker.
- For a Seller, **money totals** means only the cash they collected themselves.
- **Create places**: a Regional Lead creates events, a Seasonal Lead regions,
  Universal seasons — each only below themselves. **Close**: an Event Lead
  closes their own event; anyone higher closes anything below them.
- **Event Leads may move books into devotee storage** (sub-warehouses).
- **Spreadsheets** are view-only for everyone but Universal; view-only still
  allows *File → Make a copy*. Event-level people have no file of their own.

## 5. New features that come with this

1. **"My sales"** — a Seller's top bar shows the books they sold, in place of
   the money tiles.
2. **Cash handover** — "Hand your cash to *Gita*" (the Event Lead by name; a
   choice when there are several); Gita confirms.
3. **Sales by seller** — a panel in the regional section: each seller's books
   sold, cash collected, cash handed to their Event Lead, cash still with them;
   opens into a per-event breakdown. Seen by leads, assistants, Finance,
   Universal.
4. **Count mismatches flagged up** — at closing, a count that differs from the
   records leaves the records as they are and raises a mismatch ("Festival:
   expected 12 Sri Radha (English), counted 10") to the next person up: an
   event's to its Regional Lead, a region's to the Seasonal Lead, a season's to
   Universal. The counter may add a note. That person accepts the count (stock
   changes, with their name and reason) or finds the error and closes it with a
   note. An event may close with a mismatch open ("• Closed, with a count to
   look into"); its region cannot close fully until all are resolved.
5. **Event-level prices and consignment** — an event's own price overrides the
   region's, for that event only; consignment groups can belong to an event.
6. **Names everywhere** (see 1).
7. **Every spreadsheet** carries at the top: *"If you wish to edit this sheet,
   please make a copy. Note that this sheet is being created from the app. If
   you wish for any changes you make to be reflected permanently, you must
   change them in the app itself."*

## 6. Stages

| Stage | What | Status |
|---|---|---|
| 0 | This file | done |
| 1 | People and sign-in: People panel, several roles per person, giving and removing within your limits, requests, display names, emergency links, roles ending when their place closes | **built** — see below for what each role can use yet |
| 2 | Every rule in section 4 enforced by the server; each person sees only what their roles allow | to do |
| 3 | Section 5 features 1–5 | **built** (b223–b225) — see below |
| 4 | Spreadsheets: the note at the top, per-person view-only sharing, each person's own files listed | **built** (b226) — see below |
| later | Payment emails matched automatically; the printing-to-warehouse work merged in | not planned yet |

### What Stage 1 lets each role do, until Stage 2

Stage 1 gives people their logins before the full rules exist, so each role
works through the nearest permission set the app already had, **never a wider
one**:

| Role | Works as, until Stage 2 |
|---|---|
| Universal | the full app (as admins did) |
| Regional Lead | a regional link for their region |
| Event Lead | a sales link for their event, plus the People panel (add Sellers, emergency links) |
| Seller | a sales link for their event |
| Regional / Seasonal Assistant, Seasonal Lead, Finance, Finance Assistant | can sign in and be given roles, but see "your access starts with the next update" |

### Stages 3 and 4, as built

- **My sales, My cash, cash handover, Sales by Seller** (b223): as in section 5.
- **Count mismatches** (b224): an event's go to its Regional Lead; a region's
  go to Universal until the Seasonal Lead can sign in (Stage 2).
- **Event prices and event consignment** (b225): set by Universal and the
  Regional Lead. An Event Lead's "own" comes with Stage 2.
- **Spreadsheets** (b226): the note is the first line of every tab. Each file
  is shared in Google Drive with the people whose roles reach it — Universal
  as editors, everyone else as viewers (they can use *File › Make a copy*):
  Finance and Finance Assistant every file; Seasonal Lead and Assistant their
  season's; Regional Lead and Assistant their region's and its consignment
  groups'; Event Leads and Sellers none. This already applies to the roles
  that cannot use the app yet: they find their files under "Shared with me" in
  Google Drive. Taking a role away takes its access away on the next minute;
  anyone a file was shared with by hand is left alone. A role keeps its view
  after its place closes. **Spreadsheet Links** in the app shows a person only
  their own files (no folders); "Rebuild spreadsheets now" (Universal only)
  replaces the old Sync sheet button.

## 7. For the printing-to-warehouse work

Both halves use this one permission system. The inventory areas above
(Stock) are where printing-to-warehouse joins: books from the printer arrive
either at Earthly HQ's warehouse or straight at a regional warehouse. New
actions for that work should be added to section 4 with a row of their own,
using the same nine roles.
