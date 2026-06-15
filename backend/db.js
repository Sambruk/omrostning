const { Pool } = require('pg');

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

module.exports = { pool, init };
