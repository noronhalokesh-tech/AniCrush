// AniCrash server: accounts (email or mobile) + progress sync, so a player's stats, coins and power-ups follow them across devices.
// No native modules: data is kept in one JSON file (anicrash-data.json) that is saved safely after every change.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'anicrash-data.json');
const SESSION_DAYS = 90;
const START_STOCK = 5;              // every account starts with this many of each power-up

// ---- the counters a device syncs ----
// "Totals" only ever go up: a device sends how much it added since its last sync and the server adds it to its own total.
// "Balances" (coins, power-up stock) go up AND down (earning, buying, using): a device sends the signed change and the
// server applies it and keeps the result at 0 or more. Either way two devices never overwrite each other.
const TOTALS = {   // name: biggest change accepted in one sync
  totalScore: 5e6, levelsCleared: 1000, levelsFailed: 1000, livesUsed: 1000,
  bigAnimals: 5000, biggerAnimals: 5000, goldenAnimals: 5000,
  swapsUsed: 5000, pinwheelsUsed: 5000, flowerPotsUsed: 5000, insecticidesUsed: 5000, weedKillersUsed: 5000,
  secondsPlayed: 86400, goldEarned: 100000, silverEarned: 2e6,
  goldSpent: 100000, silverSpent: 2e6      // what the player paid in the shop. gold = goldEarned - goldSpent, silver = silverEarned - silverSpent
};
const BALANCES = { // power-up stock only: name: [starting value, biggest change accepted in one sync (up or down)]
  stockSwap: [START_STOCK, 10000], stockPin: [START_STOCK, 10000], stockPot: [START_STOCK, 10000],
  stockInsect: [START_STOCK, 10000], stockWeed: [START_STOCK, 10000]
};
const BALANCE_CEILING = 1e9;

// ---------------- storage ----------------
let data = { users: {}, sessions: {} };
try {
  if (fs.existsSync(DATA_FILE)) data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  data.users = data.users || {}; data.sessions = data.sessions || {};
} catch (e) {
  console.error('Could not read ' + DATA_FILE + ' - fix or move it, then start again.', e.message);
  process.exit(1);
}
// Coins are now kept as earned minus spent (both only ever go up, so devices can never disagree). Accounts from an older server
// start with nothing spent, i.e. their balance becomes everything they ever earned. Old 'gold' / 'silver' balances are dropped.
// accounts made by an older server version are upgraded in place (new counters start at 0, power-up stock at START_STOCK)
function upgrade(u) {
  for (const k of Object.keys(TOTALS)) if (!Number.isFinite(u[k])) u[k] = 0;
  for (const [k, [start]] of Object.entries(BALANCES)) if (!Number.isFinite(u[k])) u[k] = start;
  if (!Number.isFinite(u.level) || u.level < 1) u.level = 1;
  for (const k of ['bestScore', 'lives', 'livesAt']) if (!Number.isFinite(u[k])) u[k] = k === 'lives' ? 5 : 0;
}
for (const u of Object.values(data.users)) upgrade(u);

let timer = null;
function flush() {
  timer = null;
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, DATA_FILE);              // write-then-rename: the file is never left half-written
}
function persist() { if (!timer) timer = setTimeout(flush, 150); }
function flushNow() { if (timer) { clearTimeout(timer); flush(); } }
process.on('SIGINT', () => { flushNow(); process.exit(0); });
process.on('SIGTERM', () => { flushNow(); process.exit(0); });
process.on('exit', flushNow);

const getUser = id => (Object.prototype.hasOwnProperty.call(data.users, id) ? data.users[id] : null);

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString().slice(0, 19);

function normalizeId(input) {
  const t = String(input || '').trim();
  if (t.includes('@')) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(t) ? { id: t.toLowerCase(), kind: 'email' } : null;
  }
  const digits = t.replace(/[\s\-().]/g, '').replace(/^\++/, '');
  if (/^\d{10,15}$/.test(digits)) return { id: digits.slice(-10), kind: 'mobile' };
  return null;
}

function userJson(u) {
  const o = {
    id: u.id, kind: u.kind, name: u.name, created: u.created, lastLogin: u.lastLogin,
    level: u.level, bestScore: u.bestScore, lives: u.lives, livesAt: u.livesAt
  };
  for (const k of Object.keys(TOTALS)) o[k] = u[k];
  for (const k of Object.keys(BALANCES)) o[k] = u[k];
  o.gold = Math.max(0, u.goldEarned - u.goldSpent);          // the coins the player has (apps work it out themselves too)
  o.silver = Math.max(0, u.silverEarned - u.silverSpent);
  return o;
}

async function hashPw(pw, salt) { return (await scrypt(pw, salt, 64)).toString('hex'); }

function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  data.sessions[sha(token)] = { userId, created: nowIso(), lastUsed: nowIso() };
  persist();
  return token;
}

// drop expired sessions once an hour
setInterval(() => {
  const limit = Date.now() - SESSION_DAYS * 86400000;
  let changed = false;
  for (const [k, s] of Object.entries(data.sessions)) if (Date.parse(s.created + 'Z') < limit) { delete data.sessions[k]; changed = true; }
  if (changed) persist();
}, 3600000).unref();

// ---- very small in-memory rate limiter (per IP and per account) ----
const hits = new Map();
function limited(key, max, windowMs) {
  const t = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < t) { hits.set(key, { n: 1, reset: t + windowMs }); return false; }
  h.n++;
  return h.n > max;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (v.reset < t) hits.delete(k); }, 60000).unref();

// ---------------- API ----------------
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

app.get('/', (req, res) => res.type('text').send('AniCrash server is running'));
const API_VERSION = 3;   // 3 = coins as earned minus spent, stock, /api/players, repeat-safe syncs. The apps warn when the server is older.
app.get('/health', (req, res) => res.json({ ok: true, api: API_VERSION }));

app.post('/api/register', async (req, res) => {
  try {
    if (limited('reg:' + req.ip, 20, 600000)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    const b = req.body || {};
    const n = normalizeId(b.id);
    if (!n) return res.status(400).json({ error: 'Enter a valid email address or a 10-digit mobile number.' });
    const name = String(b.name || '').trim();
    if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Please enter your name.' });
    const pw = String(b.password || '');
    if (pw.length < 6 || pw.length > 200) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    if (getUser(n.id)) return res.status(409).json({ error: `An account with this ${n.kind} already exists. Please log in.` });
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashPw(pw, salt);
    if (getUser(n.id)) return res.status(409).json({ error: `An account with this ${n.kind} already exists. Please log in.` });
    const u = { id: n.id, kind: n.kind, name, salt, hash, created: nowIso(), lastLogin: nowIso(), level: 1, bestScore: 0, lives: 5, livesAt: 0 };
    upgrade(u);
    data.users[n.id] = u;
    const token = newSession(n.id);
    persist();
    res.json({ token, user: userJson(u) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const b = req.body || {};
    const n = normalizeId(b.id);
    if (!n) return res.status(400).json({ error: 'Enter a valid email address or a 10-digit mobile number.' });
    if (limited('ip:' + req.ip, 60, 600000) || limited('acct:' + n.id, 10, 600000))
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    const u = getUser(n.id);
    if (!u) return res.status(404).json({ error: 'No account found. Please register first.' });
    const h = await hashPw(String(b.password || ''), u.salt);
    if (!crypto.timingSafeEqual(Buffer.from(h), Buffer.from(u.hash))) return res.status(401).json({ error: 'Wrong password.' });
    u.lastLogin = nowIso();
    const token = newSession(u.id);
    persist();
    res.json({ token, user: userJson(u) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

function auth(req, res, next) {
  const m = /^Bearer (\w{64})$/.exec(req.headers.authorization || '');
  if (!m) return res.status(401).json({ error: 'Not signed in.' });
  const h = sha(m[1]);
  const s = data.sessions[h];
  if (!s || Date.now() - Date.parse(s.created + 'Z') > SESSION_DAYS * 86400000 || !getUser(s.userId)) {
    if (s) { delete data.sessions[h]; persist(); }
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
  s.lastUsed = nowIso();
  req.user = getUser(s.userId); req.tokenHash = h;
  next();
}

app.get('/api/me', auth, (req, res) => res.json({ user: userJson(req.user) }));

app.post('/api/logout', auth, (req, res) => { delete data.sessions[req.tokenHash]; persist(); res.json({ ok: true }); });

// Each device sends only what it changed since its last sync (deltas); the server applies them,
// keeps the highest level / best score, and returns the merged account for the device to adopt.
app.post('/api/sync', auth, (req, res) => {
  const b = req.body || {}, d = b.deltas || {}, u = req.user;
  const whole = v => { v = Math.trunc(Number(v)); return Number.isFinite(v) ? v : 0; };
  // Every sync carries an id. If the same id arrives again (the device never got our answer and is resending), its changes
  // are NOT applied a second time - the device just gets the current account back.
  const rid = typeof b.reqId === 'string' && b.reqId.length > 0 && b.reqId.length <= 64 ? b.reqId : '';
  if (!Array.isArray(u.applied)) u.applied = [];
  const again = rid && u.applied.includes(rid);
  if (!again) {
    for (const [k, max] of Object.entries(TOTALS)) {
      const v = whole(d[k]);
      if (v > 0) u[k] += Math.min(v, max);
    }
    for (const [k, [, max]] of Object.entries(BALANCES)) {
      const v = Math.max(-max, Math.min(max, whole(d[k])));
      if (v !== 0) u[k] = Math.max(0, Math.min(BALANCE_CEILING, u[k] + v));
    }
    if (rid) { u.applied.push(rid); if (u.applied.length > 40) u.applied.splice(0, u.applied.length - 40); }
  }
  const lvl = whole(b.level);
  if (lvl > 0) u.level = Math.max(u.level, Math.min(lvl, u.level + 200));
  const best = whole(b.bestScore);
  if (best > 0) u.bestScore = Math.max(u.bestScore, Math.min(best, 1e8));
  const lives = whole(b.lives), at = whole(b.livesAt);
  if (lives >= 0 && lives <= 5 && at > u.livesAt) { u.lives = lives; u.livesAt = at; }
  persist();
  res.json({ user: userJson(u), api: API_VERSION });
});

// Everyone's progress, for the level-progress screen. Names and numbers only - never emails or phone numbers.
app.get('/api/players', auth, (req, res) => {
  const list = Object.values(data.users).map(u => ({
    name: u.name, level: u.level, levelsCleared: u.levelsCleared,
    gold: u.goldEarned, silver: u.silverEarned, me: u.id === req.user.id
  }));
  list.sort((a, b) => b.level - a.level || b.levelsCleared - a.levelsCleared || b.gold - a.gold || b.silver - a.silver);
  res.json({ players: list.slice(0, 100), total: list.length });
});

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.listen(PORT, HOST, () => console.log(`AniCrash server listening on ${HOST}:${PORT} (data: ${DATA_FILE})`));
