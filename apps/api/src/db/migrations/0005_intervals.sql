-- 0005_intervals.sql — interval schedules and durable run history (P4-INT-01)

CREATE TYPE interval_frequency AS ENUM ('daily', 'weekly', 'monthly');

CREATE TABLE intervals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  frequency      interval_frequency NOT NULL,
  time_of_day    time NOT NULL DEFAULT '03:00',
  weekday        smallint CHECK (weekday BETWEEN 1 AND 7),
  day_of_month   smallint CHECK (day_of_month BETWEEN 1 AND 28),
  keep_versions  smallint NOT NULL DEFAULT 3 CHECK (keep_versions >= 1),
  only_if_changed boolean NOT NULL DEFAULT true,
  enabled        boolean NOT NULL DEFAULT true,
  next_run_at    timestamptz NOT NULL,
  last_run_at    timestamptz,
  last_status    text,
  created_by     uuid REFERENCES admins(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intervals_shape CHECK (
    (frequency = 'daily' AND weekday IS NULL AND day_of_month IS NULL)
    OR (frequency = 'weekly' AND weekday IS NOT NULL AND day_of_month IS NULL)
    OR (frequency = 'monthly' AND weekday IS NULL AND day_of_month IS NOT NULL)
  )
);
CREATE INDEX intervals_due_idx ON intervals (next_run_at) WHERE enabled;

CREATE TABLE interval_countries (
  interval_id uuid NOT NULL REFERENCES intervals(id) ON DELETE CASCADE,
  country_id  uuid NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
  PRIMARY KEY (interval_id, country_id)
);
CREATE INDEX interval_countries_country_idx ON interval_countries (country_id, interval_id);

CREATE TABLE interval_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interval_id       uuid NOT NULL REFERENCES intervals(id) ON DELETE CASCADE,
  triggered_by      text NOT NULL CHECK (triggered_by IN ('schedule', 'manual')),
  status            text NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  countries_total   int NOT NULL DEFAULT 0,
  countries_ok      int NOT NULL DEFAULT 0,
  countries_failed  int NOT NULL DEFAULT 0,
  countries_skipped int NOT NULL DEFAULT 0,
  bytes_downloaded  bigint NOT NULL DEFAULT 0,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  error_message     text
);
CREATE INDEX interval_runs_interval_idx ON interval_runs (interval_id, started_at DESC);
CREATE UNIQUE INDEX interval_runs_one_active ON interval_runs (interval_id) WHERE status = 'running';

CREATE TABLE interval_run_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES interval_runs(id) ON DELETE CASCADE,
  country_id    uuid REFERENCES countries(id) ON DELETE SET NULL,
  country_slug  text NOT NULL,
  country_name  text NOT NULL,
  job_id        uuid,
  status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'skipped', 'downloaded', 'failed')),
  version       text,
  bytes         bigint NOT NULL DEFAULT 0,
  error_code    text,
  error_message text
);
CREATE UNIQUE INDEX interval_run_items_unique ON interval_run_items (run_id, country_slug);
