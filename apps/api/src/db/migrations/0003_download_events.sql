-- 0003_download_events.sql — record completed and interrupted map streams (P2-API-09)
--
-- Mirrors 03-data-model.md §2.10. IP addresses are stored only as a salted hash; the API never persists raw addresses.

CREATE TABLE download_events (
  id           bigserial PRIMARY KEY,
  country_id   uuid NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
  version_id   uuid REFERENCES map_versions(id) ON DELETE SET NULL,
  channel      text NOT NULL CHECK (channel IN ('public','admin')),
  bytes_sent   bigint NOT NULL DEFAULT 0,
  ip_hash      text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX download_events_country_idx ON download_events (country_id, created_at DESC);
