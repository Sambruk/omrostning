const crypto = require('node:crypto');

const SECRET = process.env.TOKEN_SECRET || 'dev-secret-change-me';
// Lösenordet till /admin. `ADMIN` sätts i projektets .env; ADMIN_PASSWORD finns
// kvar som fallback så en tom ADMIN inte låser ute super-admin.
const ADMIN_PASSWORD = process.env.ADMIN || process.env.ADMIN_PASSWORD || '';
const TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function checkPassword(password) {
  if (!ADMIN_PASSWORD || typeof password !== 'string') return false;
  const a = Buffer.from(password);
  const b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function login(password) {
  if (!checkPassword(password)) return null;
  return sign({ role: 'admin', exp: Date.now() + TTL_MS });
}

// Express middleware guarding admin routes.
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (verify(token)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// "Human" pass issued after a passed CAPTCHA. Used to gate voting.
const HUMAN_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours
function issueHuman() {
  return sign({ role: 'human', exp: Date.now() + HUMAN_TTL_MS });
}
function checkHuman(token) {
  const p = verify(token);
  return !!p && p.role === 'human';
}

// ---- User sessions (passwordless / magic-link accounts) ----
const USER_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
function issueUser(user) {
  return sign({ role: 'user', uid: user.id, email: user.email, exp: Date.now() + USER_TTL_MS });
}
function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}
// Middleware: require a valid user token, attaches req.user = { uid, email }.
function requireUser(req, res, next) {
  const p = verify(bearer(req));
  if (p && p.role === 'user' && p.uid) { req.user = { uid: p.uid, email: p.email }; return next(); }
  return res.status(401).json({ error: 'Unauthorized' });
}

// ---- Per-poll access password ----
// Hashed with scrypt (salt per poll). Format: scrypt$<salt>$<hash>.
function hashSecret(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(password), salt, 32).toString('hex')}`;
}
function verifySecret(password, stored) {
  if (!stored || typeof password !== 'string' || !password) return false;
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const got = crypto.scryptSync(password, salt, 32);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Pass issued after a correct poll password. Bound to one poll.
const POLL_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
function issuePoll(qid) {
  return sign({ role: 'poll', qid: Number(qid), exp: Date.now() + POLL_TTL_MS });
}
function checkPoll(token, qid) {
  const p = verify(token);
  return !!p && p.role === 'poll' && Number(p.qid) === Number(qid);
}

module.exports = {
  login, requireAdmin, issueHuman, checkHuman, issueUser, requireUser,
  verify, bearer, hashSecret, verifySecret, issuePoll, checkPoll,
};
