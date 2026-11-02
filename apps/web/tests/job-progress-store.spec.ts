import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import { useJobProgress } from '../src/stores/jobProgress';

beforeEach(() => setActivePinia(createPinia()));

describe('job progress store', () => {
  it('tracks newest jobs once, refreshes repeated requests, and manages drawer visibility', () => {
    const store = useJobProgress();
    store.track('job-a');
    store.track('job-b');
    store.track('job-a');
    expect(store.jobIds).toEqual(['job-b', 'job-a']);
    expect(store.refreshKey).toBe(3);
    expect(store.isOpen).toBe(true);

    store.close();
    expect(store.isOpen).toBe(false);
    store.open();
    expect(store.isOpen).toBe(true);
  });

  it('clamps negative activity counts and forgets only the selected job', () => {
    const store = useJobProgress();
    store.setActiveCount(-2);
    expect(store.activeCount).toBe(0);
    store.setActiveCount(4);
    store.track('job-a');
    store.track('job-b');
    store.forget('job-a');
    expect(store.activeCount).toBe(4);
    expect(store.jobIds).toEqual(['job-b']);
    store.forget('missing');
    expect(store.jobIds).toEqual(['job-b']);
  });
});
