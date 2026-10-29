-- 0004_upload_sessions.sql — persist staged public-admin imports (P4-IMP-01)
--
-- Mirrors 03-data-model.md §2.8. `temp_path` is a validated root-relative UUID filename under TMP_DIR,
-- never an original client filename or an absolute path.

CREATE TABLE upload_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id    uuid NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
  version       text NOT NULL,
  original_name text NOT NULL,
  temp_path     text NOT NULL,
  size_bytes    bigint NOT NULL DEFAULT 0,
  checksum_md5  text,
  status        text NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received','installing','installed','failed','expired')),
  job_id        uuid,
  created_by    uuid REFERENCES admins(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  CONSTRAINT upload_sessions_size_nonnegative CHECK (size_bytes >= 0)
);

-- A staged file has one owning row; a path collision cannot attach two sessions to one file.
CREATE UNIQUE INDEX upload_sessions_temp_path_key ON upload_sessions (temp_path);

-- Expiry cleanup skips active installs and visits the earliest-expiring staged/terminal rows first.
CREATE INDEX upload_sessions_expiry_idx ON upload_sessions (expires_at, id)
  WHERE status <> 'installing';
