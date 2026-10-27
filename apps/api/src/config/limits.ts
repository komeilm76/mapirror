/** Maximum in-process job slots for one API process; prevents accidental unbounded polling fan-out. */
export const MAX_WORKER_CONCURRENCY = 32;
