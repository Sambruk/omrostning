const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const svgCaptcha = require('svg-captcha');

const { pool, init } = require('./db');
const { decorate, choosePair } = require('./scoring');
const { login, requireAdmin, issueHuman, checkHuman } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// ---------- Static frontend ----------
app.use('/css', express.static(path.join(PUBLIC_DIR, 'css')));
app.use('/js', express.static(path.join(PUBLIC_DIR, 'js')));
app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets')));

const sendPage = (file) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, file));
app.get('/', sendPage('index.html'));
app.get('/results', sendPage('results.html'));
app.get('/admin', sendPage('admin.html'));
app.get('/share', sendPage('share.html'));

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

// Parse a batch of ideas. Accepts an array, or a string where ideas are
// separated by a BLANK line — so a single idea may span several lines.
function parseIdeas(input) {
  const list = Array.isArray(input)
    ? input.map((s) => String(s))
    : String(input || '').split(/\n[ \t]*\n+/);
  return list.map((s) => s.replace(/\s+$/, '').replace(/^\s+/, '')).filter(Boolean);
}

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

// Active questions (for the public landing / selector).
app.get('/api/questions', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT q.id, q.title, q.description, q.allow_suggestions,
            count(i.*) FILTER (WHERE i.status = 'approved') AS idea_count
       FROM questions q
       LEFT JOIN ideas i ON i.question_id = q.id
      WHERE q.status = 'active'
      GROUP BY q.id
      ORDER BY q.created_at DESC`
  );
  res.json(rows);
}));

// One question's metadata.
app.get('/api/questions/:id', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, title, description, status, allow_suggestions FROM questions WHERE id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
}));

// Next pair to vote on — excludes pairs this voter has already decided/skipped.
app.get('/api/questions/:id/pair', wrap(async (req, res) => {
  const qid = req.params.id;
  const voter = req.query.voter || null;
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
app.post('/api/questions/:id/vote', rateLimit, requireHuman, wrap(async (req, res) => {
  const qid = req.params.id;
  const { winner_id, loser_id, left_id, right_id, skipped, voter } = req.body || {};

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
app.post('/api/questions/:id/ideas', requireHuman, wrap(async (req, res) => {
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
app.get('/api/questions/:id/results', wrap(async (req, res) => {
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

// =====================================================================
// ADMIN API
// =====================================================================

app.post('/api/admin/login', wrap(async (req, res) => {
  const token = login((req.body || {}).password);
  if (!token) return res.status(401).json({ error: 'Fel lösenord' });
  res.json({ token });
}));

app.get('/api/admin/questions', requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT q.*,
            count(i.*) FILTER (WHERE i.status = 'approved') AS approved_count,
            count(i.*) FILTER (WHERE i.status = 'pending')  AS pending_count,
            (SELECT count(*) FROM votes v WHERE v.question_id = q.id AND v.skipped = FALSE) AS vote_count
       FROM questions q
       LEFT JOIN ideas i ON i.question_id = q.id
      GROUP BY q.id
      ORDER BY q.created_at DESC`
  );
  res.json(rows);
}));

app.post('/api/admin/questions', requireAdmin, wrap(async (req, res) => {
  const { title, description, allow_suggestions, status, seeds } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title required' });
  const { rows } = await pool.query(
    `INSERT INTO questions (title, description, allow_suggestions, status)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [title.trim(), (description || '').trim(), allow_suggestions !== false, status || 'active']
  );
  const q = rows[0];
  const seedList = parseIdeas(seeds);
  for (const text of seedList) {
    await pool.query(
      `INSERT INTO ideas (question_id, text, status, source) VALUES ($1,$2,'approved','seed')`,
      [q.id, text.slice(0, 1000)]
    );
  }
  res.json(q);
}));

app.patch('/api/admin/questions/:id', requireAdmin, wrap(async (req, res) => {
  const { title, description, status, allow_suggestions } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE questions SET
       title = COALESCE($2, title),
       description = COALESCE($3, description),
       status = COALESCE($4, status),
       allow_suggestions = COALESCE($5, allow_suggestions)
     WHERE id = $1 RETURNING *`,
    [req.params.id, title, description, status,
     typeof allow_suggestions === 'boolean' ? allow_suggestions : null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
}));

app.delete('/api/admin/questions/:id', requireAdmin, wrap(async (req, res) => {
  await pool.query(`DELETE FROM questions WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

// Reset all votes/scores for a question (keeps the alternatives). For test runs.
app.post('/api/admin/questions/:id/reset', requireAdmin, wrap(async (req, res) => {
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
  await pool.query(`DELETE FROM ideas WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

// Export results.
app.get('/api/admin/questions/:id/export', requireAdmin, wrap(async (req, res) => {
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

init()
  .then(() => app.listen(PORT, () => console.log(`[hackaton-ideas] listening on ${PORT}`)))
  .catch((err) => { console.error('Startup failed', err); process.exit(1); });
