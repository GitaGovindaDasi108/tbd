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

## Phase 3: switching over (later, together)

1. Copy the records from the Google sheets to the server, and compare every total.
2. In Apps Script › Project Settings › Script properties, add:
   - `CF_URL`: the server's address
   - `CF_SECRET`: the same phrase as `REPORT_SECRET`

   **Not before step 1.** From this moment Google draws the spreadsheets from the server's records.
3. In `config.js`:
   - set `APPS_SCRIPT_URL` to the server's address;
   - add `GOOGLE_CLIENT_ID: '<the Client ID>'`.

Going back is putting the old address back in `config.js` and removing `CF_URL`.

## Trying it on your own computer

```
cd server
npm install
npm run dev        # the server at http://127.0.0.1:8787, with its own local database
```
