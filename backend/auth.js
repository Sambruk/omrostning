const crypto = require('node:crypto');

const SECRET = process.env.TOKEN_SECRET || 'dev-secret-change-me';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
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

module.exports = { login, requireAdmin, issueHuman, checkHuman };
