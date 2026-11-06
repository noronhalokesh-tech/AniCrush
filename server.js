// AniCrash server: accounts (email or mobile) + progress sync, so a player's stats, coins and power-ups follow them across devices.
// Data is kept in a PostgreSQL database (set DATABASE_URL) or, without it, in one JSON file (anicrash-data.json).
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { console.log('nodemailer is not installed: run npm install'); }

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
  stockInsect: [START_STOCK, 10000], stockWeed: [START_STOCK, 10000],
  stockGun: [START_STOCK, 10000], stockGrenade: [START_STOCK, 10000]
};
const BALANCE_CEILING = 1e9;

// ---------------- storage ----------------
let data = { users: {}, sessions: {} };
function loadFile() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Could not read ' + DATA_FILE + ' - fix or move it, then start again.', e.message);
    process.exit(1);
  }
  return null;
}
function adopt(d) { data = d || { users: {}, sessions: {} }; data.users = data.users || {}; data.sessions = data.sessions || {}; }

// ---- storage: a PostgreSQL database when DATABASE_URL is set (free ones: Neon, Supabase), otherwise the JSON file ----
// The whole account book is one JSON document in one row. That is plenty for a small game, and it needs no schema changes.
const DATABASE_URL = process.env.DATABASE_URL || '';
let pool = null;
async function initStorage() {
  if (!DATABASE_URL) { adopt(loadFile()); console.log('Storage: file ' + DATA_FILE); return; }
  const { Pool } = require('pg');
  const local = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
  pool = new Pool({ connectionString: DATABASE_URL, max: 3, ssl: local ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await pool.query('CREATE TABLE IF NOT EXISTS anicrash_state (id integer PRIMARY KEY, doc jsonb NOT NULL, updated timestamptz NOT NULL DEFAULT now())');
  const r = await pool.query('SELECT doc FROM anicrash_state WHERE id = 1');
  if (r.rows.length) { adopt(r.rows[0].doc); console.log('Storage: database (' + Object.keys(data.users).length + ' players loaded)'); }
  else {
    const f = loadFile();      // first start on the database: bring over an existing JSON file, if there is one
    adopt(f);
    await pool.query('INSERT INTO anicrash_state (id, doc) VALUES (1, $1) ON CONFLICT (id) DO NOTHING', [JSON.stringify(data)]);
    console.log('Storage: database (new' + (f ? ', imported ' + Object.keys(data.users).length + ' players from ' + DATA_FILE : '') + ')');
  }
}
// Coins are now kept as earned minus spent (both only ever go up, so devices can never disagree). Accounts from an older server
// start with nothing spent, i.e. their balance becomes everything they ever earned. Old 'gold' / 'silver' balances are dropped.
// accounts made by an older server version are upgraded in place (new counters start at 0, power-up stock at START_STOCK)
function upgrade(u) {
  for (const k of Object.keys(TOTALS)) if (!Number.isFinite(u[k])) u[k] = 0;
  for (const [k, [start]] of Object.entries(BALANCES)) if (!Number.isFinite(u[k])) u[k] = start;
  if (!Number.isFinite(u.level) || u.level < 1) u.level = 1;
  for (const k of ['bestScore', 'lives', 'livesAt', 'levelAt']) if (!Number.isFinite(u[k])) u[k] = k === 'lives' ? 5 : 0;
}

let timer = null, writing = false, dirty = false;
function flushFile() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, DATA_FILE);              // write-then-rename: the file is never left half-written
}
async function flushDb() {
  if (writing) { dirty = true; return; }       // a write is running: it will run again straight after
  writing = true;
  try {
    do {
      dirty = false;
      try { await pool.query('UPDATE anicrash_state SET doc = $1, updated = now() WHERE id = 1', [JSON.stringify(data)]); }
      catch (e) { console.error('Database write failed (will retry):', e.message); dirty = true; await new Promise(r => setTimeout(r, 2000)); }
    } while (dirty);
  } finally { writing = false; }
}
function flush() {
  timer = null;
  if (pool) flushDb(); else flushFile();
}
function persist() { if (!timer) timer = setTimeout(flush, 150); }
async function shutdown() {
  if (timer) { clearTimeout(timer); timer = null; }
  try { if (pool) { dirty = false; await pool.query('UPDATE anicrash_state SET doc = $1, updated = now() WHERE id = 1', [JSON.stringify(data)]); } else flushFile(); } catch (e) { console.error(e.message); }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { if (!pool && timer) { try { flushFile(); } catch (e) {} } });

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
    level: u.level, levelAt: u.levelAt, bestScore: u.bestScore, lives: u.lives, livesAt: u.livesAt
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
app.get('/health', (req, res) => res.json({ ok: true, api: API_VERSION, mail: MAIL_ON }));

// ---- e-mail codes (TurboSMTP or any SMTP service) ----
// Set SMTP_USER (Consumer Key) and SMTP_PASS (Consumer Secret). Optional: SMTP_HOST (default pro.turbo-smtp.com), SMTP_PORT (default 587), MAIL_FROM.
// Without them the server still works but only prints each code in its log (handy for testing), and /health says mail:false.
const MAIL_ON = !!(process.env.SMTP_USER && process.env.SMTP_PASS && nodemailer);
const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER || 'no-reply@localhost';
const mailer = MAIL_ON ? nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'pro.turbo-smtp.com',
  port: Number(process.env.SMTP_PORT || 587),
  secure: ['465', '25025'].includes(String(process.env.SMTP_PORT || 587)),
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000      // fail fast (a blocked port would otherwise hang for minutes)
}) : null;
const CODE_MINUTES = 10, CODE_TRIES = 5;
const codes = new Map();     // 'reg:id' / 'rst:id' -> { hash, exp, tries, extra }
setInterval(() => { const t = Date.now(); for (const [k, v] of codes) if (v.exp < t) codes.delete(k); }, 60000).unref();

async function sendCode(kind, id, extra) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  codes.set(kind + ':' + id, { hash: sha(code + ':' + id), exp: Date.now() + CODE_MINUTES * 60000, tries: 0, extra });
  const what = kind === 'reg' ? 'finish creating your AniCrash account' : 'reset your AniCrash password';
  if (!mailer) { console.log('[mail off] code for ' + id + ' (' + kind + '): ' + code); return true; }
  try {
    await mailer.sendMail({
      from: MAIL_FROM, to: id, subject: 'Your AniCrash code: ' + code,
      text: 'Your AniCrash code is ' + code + '.\n\nEnter it in the app to ' + what + '. It works for ' + CODE_MINUTES + ' minutes.\nIf you did not ask for this, ignore this e-mail.',
      html: '<p>Your AniCrash code is</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">' + code + '</p><p>Enter it in the app to ' + what + '. It works for ' + CODE_MINUTES + ' minutes.<br>If you did not ask for this, ignore this e-mail.</p>'
    });
    return true;
  } catch (e) { console.error('mail failed: ' + e.message); codes.delete(kind + ':' + id); return false; }
}

// checks a code: returns the stored entry (and uses it up) or an error string
function checkCode(kind, id, given) {
  const k = kind + ':' + id, c = codes.get(k);
  if (!c || c.exp < Date.now()) { codes.delete(k); return 'The code has expired. Ask for a new one.'; }
  if (++c.tries > CODE_TRIES) { codes.delete(k); return 'Too many wrong codes. Ask for a new one.'; }
  const g = sha(String(given || '').trim() + ':' + id);
  if (!crypto.timingSafeEqual(Buffer.from(g), Buffer.from(c.hash))) return 'That code is not right.';
  codes.delete(k);
  return c;
}

// registering needs an e-mail address, and the address is verified with a code. Step 1 sends the code, step 2 creates the account.
app.post('/api/register/start', async (req, res) => {
  try {
    if (limited('reg:' + req.ip, 20, 600000)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    const b = req.body || {};
    const n = normalizeId(b.id);
    if (!n || n.kind !== 'email') return res.status(400).json({ error: 'Please register with a valid e-mail address.' });
    const name = String(b.name || '').trim();
    if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Please enter your name.' });
    const pw = String(b.password || '');
    if (pw.length < 6 || pw.length > 200) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    if (getUser(n.id)) return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
    if (limited('mail:' + n.id, 4, 600000)) return res.status(429).json({ error: 'Too many codes sent to this address. Try again in a few minutes.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashPw(pw, salt);
    if (!(await sendCode('reg', n.id, { name, salt, hash }))) return res.status(502).json({ error: 'The e-mail could not be sent. Check the address and try again.' });
    res.json({ sent: true, mail: MAIL_ON });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/register/verify', (req, res) => {
  try {
    const b = req.body || {};
    const n = normalizeId(b.id);
    if (!n || n.kind !== 'email') return res.status(400).json({ error: 'Please register with a valid e-mail address.' });
    if (limited('regv:' + req.ip, 40, 600000)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    if (getUser(n.id)) return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
    const c = checkCode('reg', n.id, b.code);
    if (typeof c === 'string') return res.status(400).json({ error: c });
    const u = { id: n.id, kind: 'email', name: c.extra.name, salt: c.extra.salt, hash: c.extra.hash, created: nowIso(), lastLogin: nowIso(), level: 1, levelAt: 0, bestScore: 0, lives: 5, livesAt: 0 };
    upgrade(u);
    data.users[n.id] = u;
    const token = newSession(n.id);
    persist();
    res.json({ token, user: userJson(u) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

// the old one-step register (no e-mail check) is closed: old apps have to be updated
app.post('/api/register', (req, res) => res.status(410).json({ error: 'Please update the AniCrash app: registering now needs an e-mail address and a code.' }));

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

// ---- forgot password: find the account, then set a new password ----
// An e-mail account gets a code by e-mail. An older account made with a mobile number (no e-mail to write to) is checked with its registered name.
app.post('/api/forgot/find', async (req, res) => {
  try {
    if (limited('ffip:' + req.ip, 40, 600000)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    const n = normalizeId((req.body || {}).id);
    if (!n) return res.status(400).json({ error: 'Enter a valid email address or a 10-digit mobile number.' });
    const u = getUser(n.id);
    if (!u) return res.status(404).json({ error: 'No account was found for this ' + n.kind + '.' });
    if (u.kind === 'email') {
      if (limited('mail:' + u.id, 4, 600000)) return res.status(429).json({ error: 'Too many codes sent to this address. Try again in a few minutes.' });
      if (!(await sendCode('rst', u.id, null))) return res.status(502).json({ error: 'The e-mail could not be sent. Try again later.' });
      return res.json({ found: true, mode: 'code', mail: MAIL_ON });
    }
    const nm = String(u.name || '');
    res.json({ found: true, mode: 'name', hint: nm.length ? nm[0] + '***' : '' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/forgot/reset', async (req, res) => {
  try {
    const b = req.body || {};
    const n = normalizeId(b.id);
    if (!n) return res.status(400).json({ error: 'Enter a valid email address or a 10-digit mobile number.' });
    if (limited('frip:' + req.ip, 30, 600000) || limited('fracct:' + n.id, 12, 600000))
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    const u = getUser(n.id);
    if (!u) return res.status(404).json({ error: 'No account was found.' });
    const pw = String(b.password || '');
    if (pw.length < 6 || pw.length > 200) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    if (u.kind === 'email') {
      const c = checkCode('rst', u.id, b.code);
      if (typeof c === 'string') return res.status(403).json({ error: c });
    } else {
      const given = String(b.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const real = String(u.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (!given || given !== real) return res.status(403).json({ error: 'That is not the name this account was registered with.' });
    }
    u.salt = crypto.randomBytes(16).toString('hex');
    u.hash = await hashPw(pw, u.salt);
    for (const [k, sess] of Object.entries(data.sessions)) if (sess.userId === u.id) delete data.sessions[k];   // every device has to log in again
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
  // the level only goes up - except when a hunter sent the player back: that change carries a newer time (levelAt) and is taken exactly
  const lat = whole(b.levelAt);
  if (lvl > 0 && lat > u.levelAt && lat <= Date.now() + 86400000) { u.level = Math.max(1, Math.min(lvl, u.level)); u.levelAt = lat; }
  else if (lvl > 0) u.level = Math.max(u.level, Math.min(lvl, u.level + 200));
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
initStorage().then(() => {
  for (const u of Object.values(data.users)) upgrade(u);
  app.listen(PORT, HOST, () => console.log(`AniCrash server listening on ${HOST}:${PORT}`));
}).catch(e => { console.error('Could not start the storage:', e.message); process.exit(1); });
