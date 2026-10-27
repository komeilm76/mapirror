-- 0002_catalog.sql — phase-2 catalog and queue tables (task P2-DB-01)
--
-- Forward-only. The definitions and indexes mirror `03-data-model.md` §2.3–§2.6; offline parity tests and fresh-DB
-- integration tests compare the document, this migration, the Kysely interfaces, and the PostgreSQL objects.

-- 03-data-model.md §2.3
CREATE TABLE countries (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source                   text NOT NULL DEFAULT 'geofabrik',
  source_id                text NOT NULL,
  parent_id                text,
  slug                     text NOT NULL,
  name                     text NOT NULL,
  iso_alpha2               text[] NOT NULL DEFAULT '{}',
  iso_other                text[] NOT NULL DEFAULT '{}',
  source_pbf_url           text,
  source_size_hint_bytes   bigint,
  catalog_synced_at        timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT countries_slug_fmt CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$')
);

CREATE UNIQUE INDEX countries_source_key ON countries (source, source_id);
CREATE UNIQUE INDEX countries_slug_key ON countries (slug);
CREATE INDEX countries_name_trgm ON countries USING gin (name gin_trgm_ops);
CREATE INDEX countries_iso_idx ON countries USING gin (iso_alpha2);

-- parent_id is a source-hierarchy id, not a local FK: source parents can be absent from the catalog.

-- 03-data-model.md §2.4
CREATE TABLE country_cache (
  country_id            uuid PRIMARY KEY REFERENCES countries(id) ON DELETE CASCADE,
  is_public             boolean NOT NULL DEFAULT false,
  public_since          timestamptz,
  update_state          text NOT NULL DEFAULT 'unknown'
                          CHECK (update_state IN ('unknown','up_to_date','update_available')),
  available_version     text,
  available_size_bytes  bigint,
  available_at          timestamptz,
  update_checked_at     timestamptz,
  versions_ready_count  int NOT NULL DEFAULT 0,
  total_size_bytes      bigint NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX country_cache_public_idx ON country_cache (is_public) WHERE is_public;
CREATE INDEX country_cache_update_idx ON country_cache (update_state)
  WHERE update_state = 'update_available';

-- 03-data-model.md §2.5
CREATE TABLE map_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id       uuid NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
  version          text NOT NULL,
  origin           text NOT NULL CHECK (origin IN ('geofabrik_snapshot','geofabrik_latest','upload')),
  source_url       text,
  source_filename  text NOT NULL,
  data_timestamp   timestamptz,
  file_size_bytes  bigint NOT NULL,
  checksum_md5     text,
  checksum_sha256  text,
  storage_path     text NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','ready','failed')),
  failure_reason   text,
  job_id           uuid,
  uploaded_by      uuid REFERENCES admins(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  ready_at         timestamptz,
  CONSTRAINT mv_version_fmt CHECK (version ~ '^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$'),
  CONSTRAINT mv_ready_needs_checksum CHECK (
    status <> 'ready' OR checksum_md5 IS NOT NULL OR checksum_sha256 IS NOT NULL
  ),
  CONSTRAINT mv_size_positive CHECK (status <> 'ready' OR file_size_bytes > 0),
  CONSTRAINT mv_unique_version UNIQUE (country_id, version)
);

CREATE INDEX mv_country_ready_idx ON map_versions (country_id, ready_at DESC)
  WHERE status = 'ready';
CREATE INDEX mv_status_idx ON map_versions (status) WHERE status <> 'ready';

-- 03-data-model.md §2.6
CREATE TYPE job_type AS ENUM ('download','import','update_check','catalog_sync','prune');
CREATE TYPE job_status AS ENUM ('queued','running','succeeded','failed','canceled');

CREATE TABLE jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             job_type NOT NULL,
  status           job_status NOT NULL DEFAULT 'queued',
  priority         smallint NOT NULL DEFAULT 0,
  payload          jsonb NOT NULL,
  result           jsonb,
  error_code       text,
  error_message    text,
  phase            text,
  progress_bytes   bigint NOT NULL DEFAULT 0,
  total_bytes      bigint,
  speed_bps        bigint,
  attempts         smallint NOT NULL DEFAULT 0,
  max_attempts     smallint NOT NULL DEFAULT 3,
  run_after        timestamptz NOT NULL DEFAULT now(),
  cancel_requested boolean NOT NULL DEFAULT false,
  locked_by        text,
  locked_at        timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_by       uuid REFERENCES admins(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jobs_claim_idx ON jobs (priority DESC, run_after) WHERE status = 'queued';
CREATE INDEX jobs_running_idx ON jobs (locked_at) WHERE status = 'running';
CREATE INDEX jobs_recent_idx ON jobs (created_at DESC);
CREATE UNIQUE INDEX jobs_one_active_download ON jobs (((payload->>'countryId')::uuid), (payload->>'version'))
  WHERE type = 'download' AND status IN ('queued','running');
