-- 0007_metrics_samples.sql — bounded-rate process/container metrics sampling (P5-MON-01)

CREATE TABLE metrics_samples (
  sampled_at       timestamptz PRIMARY KEY,
  cpu_percent      real,
  load1            real,
  load5            real,
  load15           real,
  mem_used_bytes   bigint,
  mem_total_bytes  bigint,
  disk_used_bytes  bigint,
  disk_total_bytes bigint,
  cache_size_bytes bigint
);
