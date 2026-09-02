const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const svgCaptcha = require('svg-captcha');

const { pool, init, migrate, newSlug } = require('./db');
const { decorate, choosePair } = require('./scoring');
const { login, requireAdmin, issueHuman, checkHuman, issueUser, requireUser,
        verify, bearer, hashSecret, verifySecret, issuePoll, checkPoll } = require('./auth');
const { sendMagicLink } = require('./mailer');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, ''); // e.g. https://app.sambruk.se/ideas

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// ---------- Static frontend ----------
app.use('/css', express.static(path.join(PUBLIC_DIR, 'css')));
app.use('/js', express.static(path.join(PUBLIC_DIR, 'js')));
app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets')));
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'assets', 'favicon.ico')));

const sendPage = (file) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, file));
app.get('/', sendPage('index.html'));
app.get('/results', sendPage('results.html'));
app.get('/admin', sendPage('admin.html'));
app.get('/share', sendPage('share.html'));
app.get('/skapa', sendPage('skapa.html'));
app.get('/sa-funkar-det', sendPage('sa-funkar-det.html'));

// Public-facing base URL as seen through the reverse proxy (works on any domain).
function publicBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const prefix = req.headers['x-forwarded-prefix'] || '';
  return `${proto}://${host}${prefix}`;
}

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
});

// Avsändaren är fritext som skaparen väljer själv (namn eller organisation) och
// visas för deltagarna. Trimmas och kapas — den ska rymmas under rubriken.
const label = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 80);

// Parse a batch of ideas. Accepts an array, or a string where ideas are
// separated by a BLANK line — so a single idea may span several lines.
// Max 200 alternativ per anrop — nog för alla rimliga fall, och sätter tak för
// hur mycket en enda begäran kan skriva till databasen.
const MAX_IDEAS_PER_REQUEST = 200;
function parseIdeas(input) {
  const list = Array.isArray(input)
    ? input.map((s) => String(s))
    : String(input || '').split(/\n[ \t]*\n+/);
  return list.map((s) => s.replace(/\s+$/, '').replace(/^\s+/, ''))
    .filter(Boolean).slice(0, MAX_IDEAS_PER_REQUEST);
}

// Rubriken visas i stora bokstäver för deltagarna — den behöver inte vara en roman.
const MAX_TITLE = 300;
const title_ = (t) => String(t).trim().slice(0, MAX_TITLE);

// ---------- Anti-abuse: CAPTCHA, rate-limit, human gate ----------

// CAPTCHA answers kept in memory (single instance). id -> { answer, exp }.
const captchaStore = new Map();
const CAPTCHA_TTL_MS = 1000 * 60 * 10;
setInterval(() => {
  const now = Date.now();
  for (const [id, rec] of captchaStore) if (rec.exp < now) captchaStore.delete(id);
}, 1000 * 60 * 5).unref();

// Fixed-window rate limiter per IP. ip -> { count, reset }.
const RATE_MAX = Number(process.env.RATE_LIMIT_PER_MIN || 40);
const rlStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of rlStore) if (rec.reset < now) rlStore.delete(ip);
}, 1000 * 60 * 5).unref();

function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let rec = rlStore.get(ip);
  if (!rec || rec.reset < now) { rec = { count: 0, reset: now + 60000 }; rlStore.set(ip, rec); }
  rec.count++;
  if (rec.count > RATE_MAX) {
    return res.status(429).json({ error: 'För många röster på kort tid — vänta en stund.' });
  }
  next();
}

// Require a valid CAPTCHA-issued "human" token (body.human or X-Human-Token header).
function requireHuman(req, res, next) {
  const token = (req.body && req.body.human) || req.headers['x-human-token'];
  if (checkHuman(token)) return next();
  return res.status(428).json({ error: 'captcha', needCaptcha: true });
}

const canonPair = (a, b) => `${Math.min(a, b)}-${Math.max(a, b)}`;

// ---------- Delningsnyckel (slug) ----------

// Publika rutter adresseras med slug (`?q=k7p2m9x4qd`). De gamla löpnumren
// fungerar fortfarande — utdelade QR-koder och länkar ska inte sluta gälla.
// Middleware:t skriver om req.params.id till det numeriska id:t, så resten av
// koden kan fortsätta arbeta med ett id.
function resolveQuestion(req, res, next) {
  const key = String(req.params.id || '');
  if (/^\d+$/.test(key)) return next();
  if (!/^[a-z2-9]{6,32}$/.test(key)) return res.status(404).json({ error: 'Not found' });
  pool.query(`SELECT id FROM questions WHERE slug = $1`, [key])
    .then(({ rows }) => {
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      req.params.id = String(rows[0].id);
      next();
    })
    .catch((err) => { console.error(err); res.status(500).json({ error: 'Internal error' }); });
}

// Skapa en slug som inte krockar med en befintlig.
async function uniqueSlug() {
  for (let i = 0; i < 10; i++) {
    const slug = newSlug();
    const { rows } = await pool.query(`SELECT 1 FROM questions WHERE slug = $1`, [slug]);
    if (!rows.length) return slug;
  }
  throw new Error('Could not generate a unique slug');
}

// ---------- Per-poll access password ----------

// Never let the stored hash leave the server; expose only a has_password flag.
function publicQuestion(row) {
  if (!row) return row;
  const { access_password, ...rest } = row;
  return { ...rest, has_password: !!access_password };
}

async function pollSecret(qid) {
  const { rows } = await pool.query(`SELECT access_password FROM questions WHERE id = $1`, [qid]);
  return rows[0] ? rows[0].access_password : undefined;
}

const pollTokenFrom = (req) => req.headers['x-poll-token'] || (req.body && req.body.poll) || '';

// Gate for a password-protected poll: voting, suggesting and results all need
// the pass issued by POST /api/questions/:id/access.
function requirePollAccess(req, res, next) {
  pollSecret(req.params.id).then((secret) => {
    if (secret === undefined) return res.status(404).json({ error: 'Not found' });
    if (!secret) return next();
    if (checkPoll(pollTokenFrom(req), req.params.id)) return next();
    return res.status(401).json({ error: 'Omröstningen är lösenordsskyddad', locked: true });
  }).catch((err) => { console.error(err); res.status(500).json({ error: 'Internal error' }); });
}

// Slow down password guessing: 12 attempts per minute and IP.
const accessRl = new Map();
function accessLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let rec = accessRl.get(ip);
  if (!rec || rec.reset < now) { rec = { count: 0, reset: now + 60000 }; accessRl.set(ip, rec); }
  if (++rec.count > 12) return res.status(429).json({ error: 'För många försök — vänta en minut.' });
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of accessRl) if (rec.reset < now) accessRl.delete(ip);
}, 1000 * 60 * 5).unref();

// Does this request come from someone who may bypass the password (the poll's
// owner, or the super-admin for an official poll)?
async function isManager(req, qid) {
  const p = verify(bearer(req));
  if (!p) return false;
  if (p.role === 'admin') {
    const { rows } = await pool.query(`SELECT 1 FROM questions WHERE id = $1 AND owner_id IS NULL`, [qid]);
    return rows.length > 0;
  }
  if (p.role === 'user' && p.uid) {
    const { rows } = await pool.query(`SELECT 1 FROM questions WHERE id = $1 AND owner_id = $2`, [qid, p.uid]);
    return rows.length > 0;
  }
  return false;
}

// =====================================================================
// PUBLIC API
// =====================================================================

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Issue a fresh CAPTCHA (SVG, self-hosted — no external service).
app.get('/api/captcha', wrap(async (req, res) => {
  const c = svgCaptcha.create({ size: 5, noise: 3, color: true, ignoreChars: '0o1ilI', width: 180, height: 64 });
  const id = crypto.randomBytes(16).toString('hex');
  captchaStore.set(id, { answer: c.text.toLowerCase(), exp: Date.now() + CAPTCHA_TTL_MS });
  res.json({ id, svg: c.data });
}));

// Verify a CAPTCHA answer -> issue an 8h "human" token.
app.post('/api/captcha/verify', wrap(async (req, res) => {
  const { id, answer } = req.body || {};
  const rec = captchaStore.get(id);
  if (rec) captchaStore.delete(id); // one-shot
  if (!rec || rec.exp < Date.now() || String(answer || '').trim().toLowerCase() !== rec.answer) {
    return res.status(400).json({ error: 'Fel kod — försök igen.' });
  }
  res.json({ token: issueHuman() });
}));

// QR code (SVG) pointing at the public voting page, optionally for one question.
app.get('/api/qr.svg', wrap(async (req, res) => {
  const q = req.query.q ? `/?q=${encodeURIComponent(req.query.q)}` : '/';
  const url = publicBase(req) + q;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 320,
    color: { dark: '#1a1c2c', light: '#ffffff' } });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(svg);
}));

// NOTE: there is intentionally NO endpoint that lists/enumerates polls.
// Every poll is reachable only via its own shared link (?q=ID) — no catalog.

// One question's metadata. For a password-protected poll nothing is revealed
// (not even the title) until the visitor has unlocked it.
app.get('/api/questions/:id', resolveQuestion, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, slug, title, description, status, allow_suggestions, creator_label, access_password
       FROM questions WHERE id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  // Utkast är "dolt" enligt gränssnittet — då ska det också vara dolt utåt.
  // Skaparen och super-admin når sitt eget utkast för förhandsgranskning.
  if (rows[0].status === 'draft' && !await isManager(req, req.params.id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (rows[0].access_password && !checkPoll(pollTokenFrom(req), req.params.id)) {
    return res.status(401).json({ error: 'Omröstningen är lösenordsskyddad', locked: true });
  }
  res.json(publicQuestion(rows[0]));
}));

// Unlock a password-protected poll -> 12h pass for voting and results.
// The creator (or the super-admin, for official polls) unlocks without typing it.
app.post('/api/questions/:id/access', accessLimit, resolveQuestion, wrap(async (req, res) => {
  const qid = req.params.id;
  const secret = await pollSecret(qid);
  if (secret === undefined) return res.status(404).json({ error: 'Not found' });
  if (!secret) return res.json({ token: issuePoll(qid), open: true });
  const password = String((req.body || {}).password || '');
  if (!password && await isManager(req, qid)) return res.json({ token: issuePoll(qid), manager: true });
  if (!verifySecret(password, secret)) return res.status(401).json({ error: 'Fel lösenord' });
  res.json({ token: issuePoll(qid) });
}));

// Next pair to vote on — excludes pairs this voter has already decided/skipped.
app.get('/api/questions/:id/pair', resolveQuestion, requirePollAccess, wrap(async (req, res) => {
  const qid = req.params.id;
  const voter = req.query.voter || null;
  const { rows: qs } = await pool.query(`SELECT status FROM questions WHERE id = $1`, [qid]);
  if (!qs[0]) return res.status(404).json({ error: 'Not found' });
  if (qs[0].status !== 'active') return res.json({ pair: null, closed: true });
  const { rows: ideas } = await pool.query(
    `SELECT * FROM ideas WHERE question_id = $1 AND status = 'approved'`, [qid]
  );
  if (ideas.length < 2) return res.json({ pair: null });

  // Build the set of pair-keys this voter has already seen.
  const seen = new Set();
  if (voter) {
    const { rows } = await pool.query(
      `SELECT winner_id AS a, loser_id AS b FROM votes
         WHERE question_id = $1 AND voter = $2 AND winner_id IS NOT NULL
       UNION ALL
       SELECT left_id AS a, right_id AS b FROM votes
         WHERE question_id = $1 AND voter = $2 AND left_id IS NOT NULL AND right_id IS NOT NULL`,
      [qid, voter]
    );
    for (const r of rows) if (r.a != null && r.b != null) seen.add(canonPair(r.a, r.b));
  }

  const totalPairs = (ideas.length * (ideas.length - 1)) / 2;
  if (seen.size >= totalPairs) return res.json({ pair: null, exhausted: true });

  // Try the active-sampling picker a few times for an unseen pair...
  let pick = null;
  for (let i = 0; i < 40 && !pick; i++) {
    const p = choosePair(ideas);
    if (p && !seen.has(canonPair(p[0].id, p[1].id))) pick = p;
  }
  // ...otherwise enumerate unseen pairs and take the least-seen one.
  if (!pick) {
    let best = null, bestApp = Infinity;
    for (let x = 0; x < ideas.length; x++) {
      for (let y = x + 1; y < ideas.length; y++) {
        if (seen.has(canonPair(ideas[x].id, ideas[y].id))) continue;
        const app = ideas[x].appearances + ideas[y].appearances;
        if (app < bestApp) { bestApp = app; best = [ideas[x], ideas[y]]; }
      }
    }
    if (!best) return res.json({ pair: null, exhausted: true });
    pick = Math.random() < 0.5 ? best : [best[1], best[0]];
  }
  res.json({ pair: pick.map((i) => ({ id: i.id, text: i.text })) });
}));

// Cast a vote (or skip). Gated by rate-limit + CAPTCHA "human" token.
app.post('/api/questions/:id/vote', rateLimit, resolveQuestion, requirePollAccess, requireHuman, wrap(async (req, res) => {
  const qid = req.params.id;
  const { winner_id, loser_id, left_id, right_id, skipped, voter } = req.body || {};

  const { rows: qs } = await pool.query(`SELECT status FROM questions WHERE id = $1`, [qid]);
  if (!qs[0]) return res.status(404).json({ error: 'Not found' });
  if (qs[0].status !== 'active') {
    return res.status(403).json({ error: 'Omröstningen är stängd', closed: true });
  }

  if (skipped) {
    await pool.query(
      `INSERT INTO votes (question_id, left_id, right_id, skipped, voter)
       VALUES ($1,$2,$3,TRUE,$4)`,
      [qid, left_id || null, right_id || null, voter || null]
    );
    return res.json({ ok: true });
  }

  if (!winner_id || !loser_id) return res.status(400).json({ error: 'winner_id and loser_id required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Guard: both ideas must belong to this question and be approved.
    const { rows: valid } = await client.query(
      `SELECT id FROM ideas WHERE id = ANY($1) AND question_id = $2 AND status = 'approved'`,
      [[winner_id, loser_id], qid]
    );
    if (valid.length !== 2) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid ideas' });
    }
    // One vote per pair per voter: reject if this voter already decided this pair.
    if (voter) {
      const { rows: dup } = await client.query(
        `SELECT 1 FROM votes
           WHERE question_id = $1 AND voter = $2 AND winner_id IS NOT NULL
             AND least(winner_id, loser_id) = least($3::int, $4::int)
             AND greatest(winner_id, loser_id) = greatest($3::int, $4::int)
           LIMIT 1`,
        [qid, voter, winner_id, loser_id]
      );
      if (dup.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Du har redan röstat på det här paret', duplicate: true });
      }
    }
    await client.query(`UPDATE ideas SET wins = wins + 1, appearances = appearances + 1 WHERE id = $1`, [winner_id]);
    await client.query(`UPDATE ideas SET losses = losses + 1, appearances = appearances + 1 WHERE id = $1`, [loser_id]);
    await client.query(
      `INSERT INTO votes (question_id, winner_id, loser_id, left_id, right_id, voter)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [qid, winner_id, loser_id, left_id || null, right_id || null, voter || null]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Submit a new idea -> goes to moderation queue (pending). Gated by CAPTCHA.
app.post('/api/questions/:id/ideas', resolveQuestion, requirePollAccess, requireHuman, wrap(async (req, res) => {
  const text = (req.body && req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  if (text.length > 280) return res.status(400).json({ error: 'För långt (max 280 tecken)' });

  const { rows: q } = await pool.query(
    `SELECT status, allow_suggestions FROM questions WHERE id = $1`, [req.params.id]
  );
  if (!q[0]) return res.status(404).json({ error: 'Not found' });
  if (q[0].status !== 'active' || !q[0].allow_suggestions) {
    return res.status(403).json({ error: 'Förslag är inte öppna för denna fråga' });
  }
  await pool.query(
    `INSERT INTO ideas (question_id, text, status, source) VALUES ($1,$2,'pending','user')`,
    [req.params.id, text]
  );
  res.json({ ok: true, pending: true });
}));

// Public ranked results.
app.get('/api/questions/:id/results', resolveQuestion, requirePollAccess, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM ideas WHERE question_id = $1 AND status = 'approved'`,
    [req.params.id]
  );
  const totalVotes = await pool.query(
    `SELECT count(*)::int AS c FROM votes WHERE question_id = $1 AND skipped = FALSE`,
    [req.params.id]
  );
  const ideas = rows.map(decorate).sort((a, b) => b.score - a.score || b.votes - a.votes);
  res.json({ ideas, totalVotes: totalVotes.rows[0].c });
}));

// Apply a password change from a PATCH body. Three states: field absent =
// unchanged, empty string/null = remove the password, a string = set it.
async function applyPassword(qid, body, current) {
  if (!Object.prototype.hasOwnProperty.call(body, 'password')) return current;
  const value = body.password ? hashSecret(String(body.password)) : null;
  const { rows } = await pool.query(
    `UPDATE questions SET access_password = $2 WHERE id = $1 RETURNING *`, [qid, value]);
  return rows[0] || current;
}

// =====================================================================
// ADMIN API
// =====================================================================

// Inloggningen mot /admin får inte gå att gissa i obegränsad takt.
// 8 försök per minut och IP; räknaren nollställs vid lyckad inloggning.
const loginRl = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginRl) if (rec.reset < now) loginRl.delete(ip);
}, 1000 * 60 * 5).unref();
function loginLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let rec = loginRl.get(ip);
  if (!rec || rec.reset < now) { rec = { count: 0, reset: now + 60000 }; loginRl.set(ip, rec); }
  if (++rec.count > 8) {
    return res.status(429).json({ error: 'För många inloggningsförsök — vänta en minut.' });
  }
  next();
}

app.post('/api/admin/login', loginLimit, wrap(async (req, res) => {
  const token = login((req.body || {}).password);
  if (!token) return res.status(401).json({ error: 'Fel lösenord' });
  loginRl.delete(req.ip || 'unknown');
  res.json({ token });
}));

// Aggregated usage statistics for the super-admin. Deliberately contains ONLY
// counts — never poll titles, e-mail addresses, owners or anyone's results.
// Members' polls stay private; this says how much the service is used, not by whom.
app.get('/api/admin/stats', requireAdmin, wrap(async (req, res) => {
  const { rows: totals } = await pool.query(`
    SELECT
      (SELECT count(*) FROM users)                                              AS accounts,
      (SELECT count(*) FROM users WHERE created_at > now() - interval '30 days') AS accounts_30d,
      (SELECT count(*) FROM users WHERE last_login_at > now() - interval '30 days') AS accounts_active_30d,
      (SELECT count(*) FROM questions)                                          AS polls,
      (SELECT count(*) FROM questions WHERE owner_id IS NULL)                   AS polls_official,
      (SELECT count(*) FROM questions WHERE owner_id IS NOT NULL)               AS polls_member,
      (SELECT count(*) FROM questions WHERE created_at > now() - interval '30 days') AS polls_30d,
      (SELECT count(*) FROM questions WHERE status = 'active')                  AS polls_active,
      (SELECT count(*) FROM questions WHERE status = 'closed')                  AS polls_closed,
      (SELECT count(*) FROM questions WHERE status = 'draft')                   AS polls_draft,
      (SELECT count(*) FROM questions WHERE access_password IS NOT NULL)        AS polls_protected,
      (SELECT count(*) FROM ideas)                                              AS ideas,
      (SELECT count(*) FROM ideas WHERE source = 'user')                        AS ideas_from_participants,
      (SELECT count(*) FROM ideas WHERE status = 'pending')                     AS ideas_pending,
      (SELECT count(*) FROM votes WHERE skipped = FALSE)                        AS votes,
      (SELECT count(*) FROM votes WHERE skipped = TRUE)                         AS votes_skipped,
      (SELECT count(*) FROM votes WHERE skipped = FALSE AND created_at > now() - interval '30 days') AS votes_30d,
      (SELECT count(DISTINCT voter) FROM votes WHERE voter IS NOT NULL)         AS voters,
      (SELECT min(created_at)::date FROM questions)                             AS first_poll_at
  `);
  // Aktivitet per vecka, tolv veckor bakåt — bara antal, inget om innehållet.
  const { rows: weekly } = await pool.query(`
    SELECT to_char(w.wk, 'IYYY-"v"IW') AS week, w.wk::date AS starts,
      (SELECT count(*) FROM users u     WHERE date_trunc('week', u.created_at) = w.wk) AS accounts,
      (SELECT count(*) FROM questions q WHERE date_trunc('week', q.created_at) = w.wk) AS polls,
      (SELECT count(*) FROM votes v     WHERE date_trunc('week', v.created_at) = w.wk
                                          AND v.skipped = FALSE)                       AS votes
      FROM generate_series(date_trunc('week', now()) - interval '11 weeks',
                           date_trunc('week', now()), interval '1 week') AS w(wk)
     ORDER BY w.wk
  `);
  res.json({ totals: totals[0], weekly, generated_at: new Date().toISOString() });
}));

// Admin only manages the OFFICIAL polls it created (owner_id IS NULL),
// never polls owned by user accounts.
async function isOfficialQuestion(qid) {
  const { rows } = await pool.query(`SELECT id FROM questions WHERE id = $1 AND owner_id IS NULL`, [qid]);
  return rows.length > 0;
}
async function isOfficialIdea(ideaId) {
  const { rows } = await pool.query(
    `SELECT i.id FROM ideas i JOIN questions q ON q.id = i.question_id
      WHERE i.id = $1 AND q.owner_id IS NULL`, [ideaId]);
  return rows.length > 0;
}

app.get('/api/admin/questions', requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT q.*,
            count(i.*) FILTER (WHERE i.status = 'approved') AS approved_count,
            count(i.*) FILTER (WHERE i.status = 'pending')  AS pending_count,
            (SELECT count(*) FROM votes v WHERE v.question_id = q.id AND v.skipped = FALSE) AS vote_count
       FROM questions q
       LEFT JOIN ideas i ON i.question_id = q.id
      WHERE q.owner_id IS NULL
      GROUP BY q.id
      ORDER BY q.created_at DESC`
  );
  res.json(rows.map(publicQuestion));
}));

// One official poll incl. has_password (used by the settings panel).
app.get('/api/admin/questions/:id', requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM questions WHERE id = $1 AND owner_id IS NULL`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(publicQuestion(rows[0]));
}));

app.post('/api/admin/questions', requireAdmin, wrap(async (req, res) => {
  const { title, description, allow_suggestions, status, seeds, password, creator_label } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title required' });
  const { rows } = await pool.query(
    `INSERT INTO questions (title, description, allow_suggestions, status, access_password, creator_label, slug)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [title_(title), (description || '').trim().slice(0, 1000), allow_suggestions !== false,
     status || 'active', password ? hashSecret(String(password)) : null, label(creator_label),
     await uniqueSlug()]
  );
  const q = rows[0];
  const seedList = parseIdeas(seeds);
  for (const text of seedList) {
    await pool.query(
      `INSERT INTO ideas (question_id, text, status, source) VALUES ($1,$2,'approved','seed')`,
      [q.id, text.slice(0, 1000)]
    );
  }
  res.json(publicQuestion(q));
}));

app.patch('/api/admin/questions/:id', requireAdmin, wrap(async (req, res) => {
  if (!await isOfficialQuestion(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const { title, description, status, allow_suggestions, creator_label } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE questions SET
       title = COALESCE($2, title),
       description = COALESCE($3, description),
       status = COALESCE($4, status),
       allow_suggestions = COALESCE($5, allow_suggestions),
       creator_label = COALESCE($6, creator_label)
     WHERE id = $1 RETURNING *`,
    [req.params.id, title ? title_(title) : null, description == null ? null : String(description).slice(0, 1000), status,
     typeof allow_suggestions === 'boolean' ? allow_suggestions : null,
     creator_label === undefined ? null : label(creator_label)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  const updated = await applyPassword(req.params.id, req.body || {}, rows[0]);
  res.json(publicQuestion(updated));
}));

app.delete('/api/admin/questions/:id', requireAdmin, wrap(async (req, res) => {
  if (!await isOfficialQuestion(req.params.id)) return res.status(404).json({ error: 'Not found' });
  await pool.query(`DELETE FROM questions WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

// Reset all votes/scores for a question (keeps the alternatives). For test runs.
app.post('/api/admin/questions/:id/reset', requireAdmin, wrap(async (req, res) => {
  if (!await isOfficialQuestion(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const qid = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const del = await client.query(`DELETE FROM votes WHERE question_id = $1`, [qid]);
    await client.query(
      `UPDATE ideas SET wins = 0, losses = 0, appearances = 0 WHERE question_id = $1`, [qid]
    );
    await client.query('COMMIT');
    res.json({ ok: true, clearedVotes: del.rowCount });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Add seed ideas to an existing question (approved immediately).
app.post('/api/admin/questions/:id/ideas', requireAdmin, wrap(async (req, res) => {
  if (!await isOfficialQuestion(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const texts = parseIdeas(req.body.texts);
  for (const text of texts) {
    await pool.query(
      `INSERT INTO ideas (question_id, text, status, source) VALUES ($1,$2,'approved','seed')`,
      [req.params.id, text.slice(0, 1000)]
    );
  }
  res.json({ ok: true, added: texts.length });
}));

// List ideas for moderation / management.
app.get('/api/admin/questions/:id/ideas', requireAdmin, wrap(async (req, res) => {
  if (!await isOfficialQuestion(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const status = req.query.status;
  const params = [req.params.id];
  let sql = `SELECT * FROM ideas WHERE question_id = $1`;
  if (status) { sql += ` AND status = $2`; params.push(status); }
  sql += ` ORDER BY created_at DESC`;
  const { rows } = await pool.query(sql, params);
  res.json(rows.map((i) => ({ ...decorate(i), status: i.status, source: i.source, created_at: i.created_at })));
}));

// Approve / reject / edit a single idea.
app.patch('/api/admin/ideas/:id', requireAdmin, wrap(async (req, res) => {
  if (!await isOfficialIdea(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const { status, text } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE ideas SET
       status = COALESCE($2, status),
       text = COALESCE($3, text)
     WHERE id = $1 RETURNING *`,
    [req.params.id, status, text ? text.trim().slice(0, 1000) : null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
}));

app.delete('/api/admin/ideas/:id', requireAdmin, wrap(async (req, res) => {
  if (!await isOfficialIdea(req.params.id)) return res.status(404).json({ error: 'Not found' });
  await pool.query(`DELETE FROM ideas WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

// Export results.
app.get('/api/admin/questions/:id/export', requireAdmin, wrap(async (req, res) => {
  if (!await isOfficialQuestion(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const { rows } = await pool.query(
    `SELECT * FROM ideas WHERE question_id = $1 AND status = 'approved'`, [req.params.id]
  );
  const ideas = rows.map(decorate).sort((a, b) => b.score - a.score);
  if (req.query.format === 'csv') {
    const header = 'rank,idea,score,wins,losses,votes\n';
    const body = ideas.map((i, n) =>
      `${n + 1},"${i.text.replace(/"/g, '""')}",${i.score},${i.wins},${i.losses},${i.votes}`
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="results-${req.params.id}.csv"`);
    return res.send(header + body);
  }
  res.json(ideas);
}));

// =====================================================================
// AUTH — passwordless magic-link accounts
// =====================================================================

// Stricter limiter for login-email requests (anti-spam): 6 / min / IP.
const authRl = new Map();
function authLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let rec = authRl.get(ip);
  if (!rec || rec.reset < now) { rec = { count: 0, reset: now + 60000 }; authRl.set(ip, rec); }
  if (++rec.count > 6) return res.status(429).json({ error: 'För många försök — vänta en minut.' });
  next();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Request a magic link.
app.post('/api/auth/request', authLimit, wrap(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Ogiltig e-postadress' });

  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO login_tokens (token, email, exp) VALUES ($1, $2, now() + interval '30 minutes')`,
    [token, email]
  );
  const base = PUBLIC_URL || publicBase(req);
  const link = `${base}/skapa?token=${token}`;
  try { await sendMagicLink(email, link); }
  catch (e) { console.error('[mailer] send failed:', e.message); }
  res.json({ ok: true });
}));

// Verify a magic link -> issue a 30-day user session token.
app.post('/api/auth/verify', wrap(async (req, res) => {
  const token = String((req.body || {}).token || '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT email FROM login_tokens WHERE token = $1 AND used = FALSE AND exp > now() FOR UPDATE`,
      [token]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Länken är ogiltig eller har gått ut.' }); }
    const email = rows[0].email;
    await client.query(`UPDATE login_tokens SET used = TRUE WHERE token = $1`, [token]);
    const { rows: u } = await client.query(
      `INSERT INTO users (email, last_login_at) VALUES ($1, now())
       ON CONFLICT (email) DO UPDATE SET last_login_at = now()
       RETURNING id, email`,
      [email]
    );
    await client.query('COMMIT');
    res.json({ token: issueUser(u[0]), email: u[0].email });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

app.get('/api/auth/me', requireUser, (req, res) => res.json({ email: req.user.email }));

// =====================================================================
// USER — manage your OWN polls (owner-scoped)
// =====================================================================

async function ownsQuestion(qid, uid) {
  const { rows } = await pool.query(`SELECT id FROM questions WHERE id = $1 AND owner_id = $2`, [qid, uid]);
  return rows.length > 0;
}
async function ownsIdea(ideaId, uid) {
  const { rows } = await pool.query(
    `SELECT i.id FROM ideas i JOIN questions q ON q.id = i.question_id WHERE i.id = $1 AND q.owner_id = $2`,
    [ideaId, uid]
  );
  return rows.length > 0;
}

app.get('/api/user/questions', requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT q.*,
            count(i.*) FILTER (WHERE i.status = 'approved') AS approved_count,
            count(i.*) FILTER (WHERE i.status = 'pending')  AS pending_count,
            (SELECT count(*) FROM votes v WHERE v.question_id = q.id AND v.skipped = FALSE) AS vote_count
       FROM questions q
       LEFT JOIN ideas i ON i.question_id = q.id
      WHERE q.owner_id = $1
      GROUP BY q.id
      ORDER BY q.created_at DESC`,
    [req.user.uid]
  );
  res.json(rows.map(publicQuestion));
}));

// One of my polls incl. has_password (used by the settings panel).
app.get('/api/user/questions/:id', requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM questions WHERE id = $1 AND owner_id = $2`, [req.params.id, req.user.uid]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(publicQuestion(rows[0]));
}));

app.post('/api/user/questions', requireUser, wrap(async (req, res) => {
  const { title, description, allow_suggestions, status, seeds, password, creator_label } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title required' });
  const { rows } = await pool.query(
    `INSERT INTO questions (owner_id, title, description, allow_suggestions, status, access_password, creator_label, slug)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.user.uid, title_(title), (description || '').trim().slice(0, 1000), allow_suggestions !== false,
     status || 'active', password ? hashSecret(String(password)) : null, label(creator_label),
     await uniqueSlug()]
  );
  const q = rows[0];
  for (const text of parseIdeas(seeds)) {
    await pool.query(`INSERT INTO ideas (question_id, text, status, source) VALUES ($1,$2,'approved','seed')`,
      [q.id, text.slice(0, 1000)]);
  }
  res.json(publicQuestion(q));
}));

app.patch('/api/user/questions/:id', requireUser, wrap(async (req, res) => {
  if (!await ownsQuestion(req.params.id, req.user.uid)) return res.status(404).json({ error: 'Not found' });
  const { title, description, status, allow_suggestions, creator_label } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE questions SET title = COALESCE($2, title), description = COALESCE($3, description),
       status = COALESCE($4, status), allow_suggestions = COALESCE($5, allow_suggestions),
       creator_label = COALESCE($6, creator_label)
     WHERE id = $1 RETURNING *`,
    [req.params.id, title ? title_(title) : null, description == null ? null : String(description).slice(0, 1000), status,
     typeof allow_suggestions === 'boolean' ? allow_suggestions : null,
     creator_label === undefined ? null : label(creator_label)]
  );
  const updated = await applyPassword(req.params.id, req.body || {}, rows[0]);
  res.json(publicQuestion(updated));
}));

app.delete('/api/user/questions/:id', requireUser, wrap(async (req, res) => {
  if (!await ownsQuestion(req.params.id, req.user.uid)) return res.status(404).json({ error: 'Not found' });
  await pool.query(`DELETE FROM questions WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/user/questions/:id/reset', requireUser, wrap(async (req, res) => {
  if (!await ownsQuestion(req.params.id, req.user.uid)) return res.status(404).json({ error: 'Not found' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const del = await client.query(`DELETE FROM votes WHERE question_id = $1`, [req.params.id]);
    await client.query(`UPDATE ideas SET wins = 0, losses = 0, appearances = 0 WHERE question_id = $1`, [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true, clearedVotes: del.rowCount });
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}));

app.post('/api/user/questions/:id/ideas', requireUser, wrap(async (req, res) => {
  if (!await ownsQuestion(req.params.id, req.user.uid)) return res.status(404).json({ error: 'Not found' });
  const texts = parseIdeas(req.body.texts);
  for (const text of texts) {
    await pool.query(`INSERT INTO ideas (question_id, text, status, source) VALUES ($1,$2,'approved','seed')`,
      [req.params.id, text.slice(0, 1000)]);
  }
  res.json({ ok: true, added: texts.length });
}));

app.get('/api/user/questions/:id/ideas', requireUser, wrap(async (req, res) => {
  if (!await ownsQuestion(req.params.id, req.user.uid)) return res.status(404).json({ error: 'Not found' });
  const params = [req.params.id];
  let sql = `SELECT * FROM ideas WHERE question_id = $1`;
  if (req.query.status) { sql += ` AND status = $2`; params.push(req.query.status); }
  sql += ` ORDER BY created_at DESC`;
  const { rows } = await pool.query(sql, params);
  res.json(rows.map((i) => ({ ...decorate(i), status: i.status, source: i.source, created_at: i.created_at })));
}));

app.patch('/api/user/ideas/:id', requireUser, wrap(async (req, res) => {
  if (!await ownsIdea(req.params.id, req.user.uid)) return res.status(404).json({ error: 'Not found' });
  const { status, text } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE ideas SET status = COALESCE($2, status), text = COALESCE($3, text) WHERE id = $1 RETURNING *`,
    [req.params.id, status, text ? text.trim().slice(0, 1000) : null]
  );
  res.json(rows[0]);
}));

app.delete('/api/user/ideas/:id', requireUser, wrap(async (req, res) => {
  if (!await ownsIdea(req.params.id, req.user.uid)) return res.status(404).json({ error: 'Not found' });
  await pool.query(`DELETE FROM ideas WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/user/questions/:id/export', requireUser, wrap(async (req, res) => {
  if (!await ownsQuestion(req.params.id, req.user.uid)) return res.status(404).json({ error: 'Not found' });
  const { rows } = await pool.query(
    `SELECT * FROM ideas WHERE question_id = $1 AND status = 'approved'`, [req.params.id]);
  const ideas = rows.map(decorate).sort((a, b) => b.score - a.score);
  if (req.query.format === 'csv') {
    const header = 'rank,idea,score,wins,losses,votes\n';
    const body = ideas.map((i, n) =>
      `${n + 1},"${i.text.replace(/"/g, '""')}",${i.score},${i.wins},${i.losses},${i.votes}`).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="results-${req.params.id}.csv"`);
    return res.send(header + body);
  }
  res.json(ideas);
}));

init()
  .then(migrate)
  .then(() => app.listen(PORT, () => console.log(`[omrostning] listening on ${PORT}`)))
  .catch((err) => { console.error('Startup failed', err); process.exit(1); });
