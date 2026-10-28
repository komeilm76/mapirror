/**
 * Session-local tracking state for the global job drawer (`P2-WEB-06`).
 *
 * The drawer is mounted by `AdminLayout`, not by the page that queued a job. Keeping only UUIDs here lets it keep polling
 * while Vue Router swaps page components without turning a server projection into a second source of truth. The API
 * list page can always rediscover jobs after a full reload.
 *
 * @module stores/jobProgress
 */

import { defineStore } from 'pinia';

/** Job UUIDs have already been validated by the enqueue/list response schemas. */
export const useJobProgress = defineStore('job-progress', {
  state: () => ({
    /** Whether the shell's job drawer is visible. */
    isOpen: false,
    /** Job ids tracked in this SPA session, newest first. */
    jobIds: [] as string[],
    /** Number of queued + running jobs reported by the list API for the shell badge. */
    activeCount: 0,
    /** Bump to re-fetch an already tracked job after an explicit "View progress" action. */
    refreshKey: 0,
  }),
  actions: {
    /** Track a job and show the drawer; safe to call repeatedly for the same id. */
    track(jobId: string): void {
      if (!this.jobIds.includes(jobId)) this.jobIds = [jobId, ...this.jobIds];
      this.refreshKey += 1;
      this.isOpen = true;
    },
    /** Update the shell badge only after a validated jobs-list response. */
    setActiveCount(count: number): void {
      this.activeCount = Math.max(0, count);
    },
    /** Open the drawer without changing which jobs are tracked. */
    open(): void {
      this.isOpen = true;
    },
    /** Close the drawer; polling continues in the persistent admin shell. */
    close(): void {
      this.isOpen = false;
    },
    /** Forget a terminal job from the session's tracked set. */
    forget(jobId: string): void {
      this.jobIds = this.jobIds.filter((trackedId) => trackedId !== jobId);
    },
  },
});
