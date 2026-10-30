-- 0006_interval_run_item_job_index.sql — indexed one-to-one link from download jobs to run items (P4-INT-05)

-- Worker completion finds the country item by its linked job id. Keep that lookup bounded as run history accumulates,
-- and make accidental reuse of one download job across multiple run items impossible.
CREATE UNIQUE INDEX interval_run_items_job_idx
  ON interval_run_items (job_id)
  WHERE job_id IS NOT NULL;
