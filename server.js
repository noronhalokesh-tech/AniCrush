// AniCrash server: accounts (email or mobile) + progress sync, so a player's stats follow them across devices.
// No native modules: data is kept in one JSON file (anicrash-data.json) that is saved safely after every change.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'anicrash-data.json');
const SESSION_DAYS = 90;

// ---------------- storage ----------------
let data = { users: {}, sessions: {} };
try {
  if (fs.existsSync(DATA_FILE)) data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  data.users = data.users || {}; data.sessions = data.sessions || {}; data.orders = data.orders || {};
  for (const u of Object.values(data.users)) { u.gold = u.gold || 0; u.silver = u.silver || 0; u.swap ??= 1; u.pinwheel ??= 2; u.flowerpot ??= 2; u.life ??= 0; }   // migrate accounts to wallet fields
} catch (e) {
  console.error('Could not read ' + DATA_FILE + ' - fix or move it, then start again.', e.message);
  process.exit(1);
}
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

const userJson = u => ({
  id: u.id, kind: u.kind, name: u.name, created: u.created, lastLogin: u.lastLogin,
  level: u.level, bestScore: u.bestScore, totalScore: u.totalScore,
  lives: u.lives, livesAt: u.livesAt, livesUsed: u.livesUsed,
  levelsCleared: u.levelsCleared, levelsFailed: u.levelsFailed,
  bigAnimals: u.bigAnimals, biggerAnimals: u.biggerAnimals, goldenAnimals: u.goldenAnimals,
  swapsUsed: u.swapsUsed, pinwheelsUsed: u.pinwheelsUsed, flowerPotsUsed: u.flowerPotsUsed,
  secondsPlayed: u.secondsPlayed,
  gold: u.gold || 0, silver: u.silver || 0, swap: u.swap ?? 1, pinwheel: u.pinwheel ?? 2, flowerpot: u.flowerpot ?? 2, life: u.life || 0,
  srv: 4                                   // payment-backed inventory fields are enabled
});

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
app.get('/health', (req, res) => res.json({ ok: true }));

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
    data.users[n.id] = {
      id: n.id, kind: n.kind, name, salt, hash, created: nowIso(), lastLogin: nowIso(),
      level: 1, bestScore: 0, totalScore: 0, lives: 5, livesAt: 0, livesUsed: 0, levelsCleared: 0, levelsFailed: 0,
      bigAnimals: 0, biggerAnimals: 0, goldenAnimals: 0, swapsUsed: 0, pinwheelsUsed: 0, flowerPotsUsed: 0, secondsPlayed: 0,
      gold: 0, silver: 0, swap: 1, pinwheel: 2, flowerpot: 2, life: 0
    };
    const token = newSession(n.id);
    persist(); flushNow();
    res.json({ token, user: userJson(data.users[n.id]) });
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
    persist(); flushNow();
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

// Progress of every registered player (names and numbers only - no email or phone). Needs a signed-in player.
app.get('/api/players', auth, (req, res) => {
  const list = Object.values(data.users).map(u => ({
    name: u.name, level: u.level, levelsCleared: u.levelsCleared, bestScore: u.bestScore,
    gold: u.gold || 0, silver: u.silver || 0, swap: u.swap ?? 1, pinwheel: u.pinwheel ?? 2, flowerpot: u.flowerpot ?? 2, life: u.life || 0, you: u.id === req.user.id
  }));
  list.sort((a, b) => b.level - a.level || b.gold - a.gold || b.silver - a.silver || a.name.localeCompare(b.name));
  res.json({ players: list.slice(0, 100) });
});

// Each device sends only what it changed since its last sync (deltas); the server adds them up,
// keeps the highest level / best score, and returns the merged account for the device to adopt.
app.post('/api/sync', auth, (req, res) => {
  const b = req.body || {}, d = b.deltas || {}, u = req.user;
  const num = (v, max) => { v = Math.floor(Number(v)); return Number.isFinite(v) && v > 0 ? Math.min(v, max) : 0; };
  const currencyDelta = (v, max) => { v = Math.floor(Number(v)); return Number.isFinite(v) ? Math.max(-max, Math.min(v, max)) : 0; };
  u.totalScore += num(d.totalScore, 5e6);
  u.levelsCleared += num(d.levelsCleared, 1000);
  u.levelsFailed += num(d.levelsFailed, 1000);
  u.livesUsed += num(d.livesUsed, 1000);
  u.bigAnimals += num(d.bigAnimals, 5000);
  u.biggerAnimals += num(d.biggerAnimals, 5000);
  u.goldenAnimals += num(d.goldenAnimals, 5000);
  u.swapsUsed += num(d.swapsUsed, 5000);
  u.pinwheelsUsed += num(d.pinwheelsUsed, 5000);
  u.flowerPotsUsed += num(d.flowerPotsUsed, 5000);
  u.secondsPlayed += num(d.secondsPlayed, 86400);
  u.gold = Math.max(0, Math.min(10000000, (u.gold || 0) + currencyDelta(d.gold, 100000)));
  u.silver = Math.max(0, Math.min(100000000, (u.silver || 0) + currencyDelta(d.silver, 1000000)));
  u.level = Math.max(u.level, Math.min(num(b.level, 1e6), u.level + 200));
  u.bestScore = Math.max(u.bestScore, num(b.bestScore, 1e8));
  const lives = Math.floor(Number(b.lives)), at = Math.floor(Number(b.livesAt));
  if (Number.isFinite(lives) && lives >= 0 && lives <= 5 && Number.isFinite(at) && at > u.livesAt) { u.lives = lives; u.livesAt = at; }
  persist();
  res.json({ user: userJson(u) });
});

const STORE_SKUS = {
  powerup_bundle: { amount: 4900, description: 'AniCrash power-up bundle', reward: { swap: 2, pinwheel: 3, flowerpot: 3 } },
  life_bundle: { amount: 9900, description: 'AniCrash five life vouchers', reward: { life: 5 } },
  coin_bundle: { amount: 19900, description: 'AniCrash coin bundle', reward: { gold: 50, silver: 2000 } }
};

function walletSnapshot(u) {
  return { gold: u.gold || 0, silver: u.silver || 0, lives: u.lives || 0,
    swap: u.swap ?? 1, pinwheel: u.pinwheel ?? 2, flowerpot: u.flowerpot ?? 2, life: u.life || 0 };
}

async function razorpayRequest(method, endpoint, body) {
  const keyId = process.env.RAZORPAY_KEY_ID || '';
  const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
  const mode = (process.env.PAYMENTS_MODE || 'test').toLowerCase();
  if (!keyId || !keySecret) throw Object.assign(new Error('Payment provider is not configured.'), { status: 503 });
  if ((mode === 'test' && !keyId.startsWith('rzp_test_')) || (mode === 'live' && !keyId.startsWith('rzp_live_'))) throw Object.assign(new Error('Payment key does not match PAYMENTS_MODE.'), { status: 503 });
  const response = await fetch('https://api.razorpay.com/v1' + endpoint, {
    method, headers: {
      Authorization: 'Basic ' + Buffer.from(keyId + ':' + keySecret).toString('base64'),
      'Content-Type': 'application/json'
    }, body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Razorpay API error', response.status, payload.error?.code || 'unknown');
    throw Object.assign(new Error('Payment provider request failed.'), { status: 502 });
  }
  return payload;
}

app.post('/api/store/orders', auth, async (req, res) => {
  try {
    if (limited('order:' + req.user.id, 12, 60000)) return res.status(429).json({ error: 'Too many checkout attempts. Try again shortly.' });
    const sku = String((req.body || {}).sku || '');
    const product = STORE_SKUS[sku];
    if (!product) return res.status(400).json({ error: 'Unknown store item.' });
    const orderId = 'ac_' + crypto.randomBytes(16).toString('hex');
    const link = await razorpayRequest('POST', '/payment_links', {
      amount: product.amount, currency: 'INR', accept_partial: false,
      reference_id: orderId, description: product.description,
      notify: { sms: false, email: false }, reminder_enable: false,
      notes: { account_id: req.user.id, order_id: orderId, sku }
    });
    if (!link.id || !link.short_url) throw new Error('Payment provider returned an incomplete payment link.');
    data.orders[orderId] = { id: orderId, accountId: req.user.id, sku, amount: product.amount,
      currency: 'INR', gateway: 'razorpay', gatewayId: link.id, status: 'created', createdAt: Date.now() };
    persist(); flushNow();
    res.status(201).json({ orderId, checkoutUrl: link.short_url, gateway: 'razorpay', status: 'created' });
  } catch (e) { res.status(e.status || 503).json({ error: e.message || 'Could not create checkout.' }); }
});

app.post('/api/store/orders/:orderId/verify', auth, async (req, res) => {
  try {
    const order = data.orders[req.params.orderId];
    if (!order || order.accountId !== req.user.id) return res.status(404).json({ error: 'Order not found.' });
    if (order.status === 'paid') return res.json({ orderId: order.id, verified: true, status: 'paid', wallet: order.wallet });
    const link = await razorpayRequest('GET', '/payment_links/' + encodeURIComponent(order.gatewayId));
    if (link.status !== 'paid' || link.amount !== order.amount || link.amount_paid !== order.amount || link.currency !== order.currency) {
      return res.json({ orderId: order.id, verified: false, status: link.status || 'created' });
    }
    if (order.status === 'paid') return res.json({ orderId: order.id, verified: true, status: 'paid', wallet: order.wallet });
    const product = STORE_SKUS[order.sku];
    if (!product) return res.status(400).json({ error: 'Store item is no longer available.' });
    for (const [field, amount] of Object.entries(product.reward)) req.user[field] = (req.user[field] || 0) + amount;
    order.status = 'paid'; order.paidAt = Date.now(); order.paymentId = link.payments?.[0]?.payment_id || null;
    order.wallet = walletSnapshot(req.user);
    persist(); flushNow();
    res.json({ orderId: order.id, verified: true, status: 'paid', wallet: order.wallet });
  } catch (e) { res.status(e.status || 503).json({ error: e.message || 'Could not verify payment.' }); }
});

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`AniCrash server listening on ${HOST}:${PORT} (data: ${DATA_FILE})`));
