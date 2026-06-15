-- Omröstning — pairwise wiki survey schema

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);

-- Single-use magic links for passwordless e-mail login.
CREATE TABLE IF NOT EXISTS login_tokens (
    token         TEXT PRIMARY KEY,
    email         TEXT NOT NULL,
    exp           TIMESTAMPTZ NOT NULL,
    used          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS questions (
    id            SERIAL PRIMARY KEY,
    owner_id      INTEGER REFERENCES users(id) ON DELETE CASCADE, -- NULL = super-admin/official
    title         TEXT NOT NULL,                 -- the survey question
    description   TEXT DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'active', -- draft | active | closed
    allow_suggestions BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_questions_owner ON questions(owner_id);

CREATE TABLE IF NOT EXISTS ideas (
    id            SERIAL PRIMARY KEY,
    question_id   INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    text          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'approved', -- pending | approved | rejected
    source        TEXT NOT NULL DEFAULT 'seed',     -- seed | user
    wins          INTEGER NOT NULL DEFAULT 0,
    losses        INTEGER NOT NULL DEFAULT 0,
    appearances   INTEGER NOT NULL DEFAULT 0,       -- times shown in a decided pair
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ideas_question ON ideas(question_id);
CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(question_id, status);

CREATE TABLE IF NOT EXISTS votes (
    id            SERIAL PRIMARY KEY,
    question_id   INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    winner_id     INTEGER REFERENCES ideas(id) ON DELETE CASCADE, -- NULL if skipped
    loser_id      INTEGER REFERENCES ideas(id) ON DELETE CASCADE,
    left_id       INTEGER,
    right_id      INTEGER,
    skipped       BOOLEAN NOT NULL DEFAULT FALSE,
    voter         TEXT,                              -- anonymous session id
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_votes_question ON votes(question_id);
