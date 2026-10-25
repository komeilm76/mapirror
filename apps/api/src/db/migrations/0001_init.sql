-- 0001_init.sql — phase-1 tables (task P1-DB-01)
--
-- Forward-only and re-runnable on a fresh database, per `03-data-model.md` §4. The SQL is copied from
-- `03-data-model.md` §2.1, §2.2 and §2.11 rather than invented here: a test walks those sections and asserts
-- every table and index named there exists after this file has run, so the document and the database cannot
-- drift apart.
--
-- The phase-2 catalog tables (`countries`, `country_cache`, `map_versions`, …) are **not** here: they arrive
-- with `0002_*` (`P2-DB-01`), which is also where the trigram search index needs the extension created below.

-- Required: `countries` name search uses a `gin_trgm_ops` index (`03-data-model.md` §2.3). Creating it early
-- means a server without the contrib package fails loudly at migration time, not months later when the search
-- index cannot be built.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Optional: the search also strips accents, but the query still works without it — so a server whose contrib
-- package is missing must not be blocked by this line. A `DO` block is the only way to make one statement's
-- failure non-fatal in plpgsql.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS unaccent;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'unaccent is not available on this server; country search will not fold accents';
END
$$;

-- 03-data-model.md §2.1
CREATE TABLE admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL,
  password_hash text NOT NULL,                 -- argon2id
  is_active     boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive: `Admin` and `admin` are the same account, in the schema and not only in the service layer.
CREATE UNIQUE INDEX admins_username_key ON admins (lower(username));

-- 03-data-model.md §2.2
CREATE TABLE admin_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     uuid NOT NULL REFERENCES admins (id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL,                 -- sha256(token), 32 bytes
  token_prefix text NOT NULL,                  -- first 8 chars, for display/debug only
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  user_agent   text,
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- The document says "sha256(token), 32 bytes"; a truncated or hex-encoded hash stores fine and then never
  -- matches a presented token, which is a support ticket rather than an error. Enforced here instead.
  CONSTRAINT admin_tokens_hash_length CHECK (octet_length(token_hash) = 32)
);

CREATE UNIQUE INDEX admin_tokens_hash_key ON admin_tokens (token_hash);
CREATE INDEX admin_tokens_admin_idx ON admin_tokens (admin_id, expires_at DESC);

-- 03-data-model.md §2.11
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES admins (id) ON DELETE SET NULL,
  actor_name  text NOT NULL,          -- snapshot, survives admin deletion
  action      text NOT NULL,          -- 'auth.login', 'cache.publish', 'version.delete', ...
  target_type text,
  target_id   text,
  metadata    jsonb NOT NULL DEFAULT '{}',
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The audit screen reads newest first, and filters by action; both paths get an index.
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);
