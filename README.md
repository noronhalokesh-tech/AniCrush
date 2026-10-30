# AniCrash server

Keeps AniCrash accounts (email or mobile number) and progress on a server, so a player's level, lives and
power-up stats follow them from one phone or PC to another.

## Run it on your own computer (testing)
1. Install Node.js 18 or newer (nodejs.org).
2. In this folder:   `npm install`   then   `npm start`
3. It listens on http://localhost:3000 and keeps data in `anicrash-data.json` next to `server.js` (back this file up).

In the apps, open **Server settings** on the login screen and enter the address:
* Windows app on the same PC:  `http://localhost:3000`
* Android emulator:            `http://10.0.2.2:3000`
* A real phone on your Wi-Fi:  `http://<your PC's LAN IP>:3000`  (allow port 3000 in the Windows firewall)

## Put it on the internet (so any device can use it)
Use a host that gives you **HTTPS** and a **persistent disk** for the data file, e.g. Render, Railway or Fly.io
(a `Dockerfile` is included; mount a volume at `/data`). Then enter your https address in the apps' Server settings.
Environment variables: `PORT`, `DATA_FILE` (default `./anicrash-data.json`), `TRUST_PROXY=1` when behind a proxy/host.

Do not run it over plain http on the public internet: passwords travel in the request.

## API (all JSON)
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/register | `{id, name, password}` | `{token, user}` |
| POST | /api/login | `{id, password}` | `{token, user}` |
| GET | /api/me | (Bearer token) | `{user}` |
| POST | /api/sync | `{deltas:{...}, level, bestScore, lives, livesAt}` | `{user}` |
| POST | /api/logout | (Bearer token) | `{ok}` |
| GET | /api/players | (Bearer token) | `{players:[{name, level, levelsCleared, gold, silver, me}]}` |
| GET | /health | - | `{ok:true}` (the apps check this every 15 seconds for the Online/Offline status) |

`id` is an email address or a mobile number (accounts are keyed by the email, or the last 10 digits of the mobile).
Passwords are hashed with scrypt; session tokens are random and only their hash is stored (valid 90 days).

## How devices stay in step
Each device sends only what it changed since its last sync (deltas). The server adds the counters together,
keeps the highest level and best score, and returns the merged account. So playing on two devices
never loses progress.

## Coins = earned - spent (current design)
The server keeps `goldEarned` / `silverEarned` and `goldSpent` / `silverSpent`. **The coins a player has = earned - spent**
(`gold` / `silver` are also returned, already worked out). All four only ever go up, so devices can never disagree and a lost or repeated
message can never put the wrong amount in the wallet. The shop adds to `...Spent`. Accounts from an older server start with nothing spent, so
their balance becomes everything they ever earned (a one-time upgrade; take a copy of `anicrash-data.json` first if you want to keep the old numbers).
The text below about gold / silver "balances" describes the older design; only the power-up stock is still a balance.

## Gold, silver and power-up stock (older notes)
Accounts now also carry `gold`, `silver` and the power-up stock (`stockSwap`, `stockPin`, `stockPot`, `stockInsect`, `stockWeed`;
every new account starts with 5 of each), plus `goldEarned` / `silverEarned` totals and more usage counters.
* **Totals** (score, levels cleared, coins earned, ...) only ever go up.
* **Balances** (gold, silver, stock) go up and down, so a device sends *signed changes* and the server never lets one drop below 0.
* The server merges them and returns the full account; the apps keep whatever they earned since their last send, so coins can no longer
  fall back to 0. Old accounts are upgraded automatically the first time the new server starts.
* **Update an existing server:** stop it, replace `server.js` with this one (keep `anicrash-data.json`), start it again.

## Gold and silver stay in step on every device
* Every device keeps its own copy and saves it to disk the moment coins are earned or spent (so nothing is lost offline).
* When it can reach the server it sends only what changed (a signed change for gold / silver / stock), tagged with a unique `reqId`.
  If the reply is lost and the device sends the same change again, the server recognises the `reqId` and does not count it twice.
* The server answers with the merged account; the device takes that value and re-adds anything it earned in the meantime.
  So Windows and Android always converge on the same numbers, and a new login on any device starts from the server's numbers.
* **Every server must run this `server.js`** (including a Termux one). With an older one the apps show "This server is out of date" and coins stay on the device only.
* `GET /health` and every sync answer include `api: 2`; that is how the apps tell the server is new enough.

## Not included yet
Email / SMS verification and password reset (they need an email or SMS provider), and anti-cheat
(the game runs on the device, so the server trusts the numbers it receives within sane limits).

## Fixing a balance by hand
If an account's gold / silver was damaged by an older version, stop the server and run
`node set-balance.js you@example.com 227 6454` (the coins you want the player to HAVE: gold, then silver; optionally five more numbers for the power-up stock), then start the server.
A backup of the data file is saved next to it. The devices adopt the new numbers at their next sync.
