# The app's server on Cloudflare (Phase 2)

This folder is the new home for the app's records: a free Cloudflare server
that runs **the same app rules (Code.gs)** as Google does today, with the
records in a real database instead of hidden spreadsheet tabs. Google keeps
making the readable spreadsheets.

Nothing here is switched on yet. The app still talks to Google until
`config.js` is changed in Phase 3, after the records are copied across and
every total is compared.

## What is in it

| File | What it does |
|---|---|
| `src/worker.js` | The front door. Every request goes to one "Durable Object", which answers them one at a time (the job Google's script lock did, without the queue). |
| `src/core.js` | The server itself: sign-in, then Code.gs. Also the **bridge** to Google for the spreadsheets. |
| `src/sqlstore.js` | Where the records live: the Durable Object's own SQLite database, looking to Code.gs exactly like the sheets did. |
| `src/google.js` | Stand-ins for the few Google services the rules use (ids, dates, exchange rates). |
| `src/auth.js` | Signing in with Google for the owner's app. Links never sign in. |
| `build.cjs` | Wraps Code.gs for Cloudflare, unchanged, each time it is deployed. There is only ever one copy of the rules. |
| `wrangler.toml` | Cloudflare's settings for it. |

## How we know it behaves the same

- `test/workergolden.js`: every recorded session (653 requests) replayed through this server and through Google. **Every reply and every record is identical.** The only steps left out are the spreadsheet work, which stays with Google.
- `test/golden.js --store=sqlite`: the database alone (with the server's memory emptied before every request) gives identical results to Sheets.
- `test/auth.js`: sign-in, checked with a stand-in Google signing key. It refuses forged, expired, wrong-app and non-admin sign-ins, and ends sessions on sign-out.
- `test/bridge.js`: Google builds the spreadsheets from this server's records, and never writes them into its own sheets.
- `test/browser-cloudflare.js`: the real page in a browser against this server on Cloudflare's own runtime. It signs in, records a sale, comes back still signed in, opens a coordinator's link with no sign-in, and signs out.

## Cost

Free: Cloudflare Workers Free plan, with a SQLite Durable Object.

Daily limits are far above what the tour uses: 100,000 requests a day and 5 GB of storage. If ever needed, the $5/month Workers Paid plan lifts them. That is a setting in the dashboard; no code or data changes.

## Setting it up (once)

These steps put the server online. It starts empty, and **nothing uses it until Phase 3**.

1. **Cloudflare account.** Sign up free at dash.cloudflare.com. Note the *Account ID*, shown on the right of the Workers & Pages overview.
2. **An API token for GitHub.** In Cloudflare: My Profile › API Tokens › Create Token › template **"Edit Cloudflare Workers"** › Create. Copy the token.
3. **Give both to GitHub.** In the repository: Settings › Secrets and variables › Actions › New repository secret:
   - `CLOUDFLARE_API_TOKEN`: the token
   - `CLOUDFLARE_ACCOUNT_ID`: the account id

   From then on, merging a change to the server (or to Code.gs) puts it live automatically. The Actions tab shows each run, and **Run workflow** there deploys by hand. The server's address will be like `https://tbs-server.<your-subdomain>.workers.dev`.
4. **Google sign-in for the owner's app.**
   1. Go to console.cloud.google.com › APIs & Services › Credentials › Create credentials › OAuth client ID › *Web application*.
   2. Under **Authorized JavaScript origins**, add `https://gitagovindadasi108.github.io`.
   3. Copy the *Client ID*. (If asked to set up the consent screen first: choose External, and give an app name and your email.)
5. **The server's settings.** In Cloudflare: Workers & Pages › tbs-server › Settings › Variables and Secrets:
   - `GOOGLE_CLIENT_ID`: the Client ID from step 4 (a Text variable)
   - `ADMIN_EMAILS`: the Google accounts allowed into the owner's app, separated by commas (Text)
   - `REPORT_URL`: the Apps Script web app address, the one in `config.js` today, ending `/exec` (Text)
   - `REPORT_SECRET`: a long random phrase you make up (type **Secret**)

   These survive every deploy.

## Phase 3: switching over

Run from the **Apps Script editor**: pick the function in the menu at the
top, press **Run**, and read the **Execution log** below.

1. **Connect Google to the server.** In Apps Script › Project Settings ›
   Script properties, add:
   - `CF_URL`: `https://tbs-server.gitagovinda.workers.dev/`
   - `CF_SECRET`: the same phrase as `REPORT_SECRET`

   This changes nothing yet; it only lets the functions below reach the
   server.
2. **Rehearse: `copyToCloudflare`.** Every record is copied to the server,
   replacing what is there, and every season (and Earthly HQ) is compared:
   every sale, count and total. The log ends with one line per season, e.g.
   `Europe Tour: identical — 2,114 sales · 31,540 PLN · …`.
   The app keeps working on Google. Run it as often as you like.
3. **Switch: `switchToCloudflare`.** At a quiet moment. Saves are held for
   the few seconds it takes to make a last copy and compare it. If anything
   differs, **nothing switches** and the app carries on on Google. If all is
   identical, the records now live on the server:
   - phones still pointed at Google are passed on to the server, so nothing
     is lost while they catch up;
   - the spreadsheets are drawn from the server's records.
4. **Point the app at the server:** merge the pull request that changes
   `config.js`. After about a minute, reload the app. The owner's app asks
   you to sign in with Google once; links work as before.

**Going back:** point `config.js` back at Google (revert that pull request).
When the page has updated, run **`copyBackFromCloudflare`**: every record,
including anything saved on the server since, is copied back into the
sheets, and the app works on Google as before.

## Live updates (Phase 4)

Every open app keeps one open line (a WebSocket) to the server, at `/live`.
When anyone saves anything, the server sends the new revision number down
every line at once, and each app fetches the change: a sale on one phone
shows on the others in well under a second.

- The line carries only that number, the same thing the sign-in-free
  "ping" already gives, so it needs no sign-in. Reading and saving still go
  through the ordinary requests and their sign-in.
- The app still checks by itself, but only once a minute while the line is
  open. If the line drops, it checks every few seconds again and reconnects
  on its own.
- A form that is open is never redrawn underneath you. The change is fetched
  the moment the form closes.
- Cost: still free. The lines use Cloudflare's "hibernation", so the server
  sleeps while nobody is saving, and the keep-alive messages every 30 seconds
  are answered by Cloudflare without waking it.
- Nothing to set up. It comes with the server, and the app turns it on by
  itself when `config.js` points at Cloudflare (on Google it stays off).

Tested end to end in `test/browser-cloudflare.js`: two apps, with their own
checks set to once an hour, see each other's sales within a second. A dropped
line comes back by itself.

## Trying it on your own computer

```
cd server
npm install
npm run dev        # the server at http://127.0.0.1:8787, with its own local database
```

## Adding admins

In the app: **App Admin › 🔑 Admins**.
- **Someone asks:** they open the app and sign in with Google. You see
  "1 waiting" on the button; open it and press **Approve** or **Decline**.
- **You add them:** type their Google address under "Add an admin". They
  can sign in straight away.
- **Remove** signs someone out everywhere at once.

The addresses in `ADMIN_EMAILS` (Cloudflare) are permanent admins and cannot
be removed in the app, so nobody can ever be locked out.

For anyone outside Google's test-user list to sign in at all, the Google
sign-in app must be published: Google Auth Platform › Audience › **Publish
app** (free, no review for name-and-email sign-in).
