const crypto = require('node:crypto');
const { Pool } = require('pg');

// Delningsnyckeln i länken. Alfabetet saknar 0/1/i/l/o så att koden går att läsa
// upp och skriva av utan förväxling. 31^10 ≈ 8·10^14 möjliga — inte gissningsbar.
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const SLUG_LENGTH = 10;
function newSlug() {
  const bytes = crypto.randomBytes(SLUG_LENGTH);
  let out = '';
  for (let i = 0; i < SLUG_LENGTH; i++) out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  return out;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

// Wait for the database to accept connections, then run any pending migrations.
async function init(retries = 30) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      console.log(`[db] waiting for postgres (${attempt}/${retries})...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('Database not reachable');
}

// Idempotent migrations — the existing data volume won't re-run schema.sql,
// so apply the multi-user additions here on every startup.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS login_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      exp TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_questions_owner ON questions(owner_id);
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS access_password TEXT;
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS creator_label TEXT DEFAULT '';
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS slug TEXT;
  `);
  await backfillSlugs();
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_slug ON questions(slug) WHERE slug IS NOT NULL`
  );
}

// Ge varje omröstning som saknar slug en egen. Körs vid varje start och är
// idempotent — befintliga slugar rörs aldrig, så gamla länkar ändras inte.
async function backfillSlugs() {
  const { rows } = await pool.query(`SELECT id FROM questions WHERE slug IS NULL`);
  for (const row of rows) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await pool.query(`UPDATE questions SET slug = $2 WHERE id = $1`, [row.id, newSlug()]);
        break;
      } catch (err) {
        if (err.code !== '23505') throw err;   // krock: försök med en ny slug
      }
    }
  }
  if (rows.length) console.log(`[db] slug tilldelad ${rows.length} omröstning(ar)`);
}

module.exports = { pool, init, migrate, newSlug };
