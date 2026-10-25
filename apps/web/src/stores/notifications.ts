/**
 * Toasts (`P1-WEB-04`; presentation is `P1-WEB-07`'s).
 *
 * `13-ui-ux.md` §5 fixes the behaviour, and each clause is a line of this file:
 *
 * | Rule | Here |
 * |---|---|
 * | "success 3 s, error persists with a close button" | `TIMEOUT_BY_KIND` — `error: null` means "until dismissed" |
 * | "one toast at a time per action" | {@link useNotifications}'s `push` **replaces** an identical `kind`+`message` instead of stacking a second copy |
 * | error states name the request id | every toast can carry one, and the host renders it in small mono text |
 *
 * The store is deliberately small and dependency-free — no timers, no Vuetify, no DOM — because the *client* writes to
 * it from a `fetch` callback, where a reactive component might not be mounted yet, and because a store that schedules
 * its own dismissal cannot be tested without fake timers in every case that touches it. The host component
 * (`components/common/ToastHost.vue`) owns the countdown, and Vuetify's `v-snackbar` owns the animation.
 *
 * @module stores/notifications
 */

import { defineStore } from 'pinia';

/** How a toast reads: a success is reassurance, an error is a demand. */
export type NotificationKind = 'success' | 'info' | 'error';

/**
 * Auto-dismiss delay in milliseconds, per kind — or `null` for "until dismissed" (`13-ui-ux.md` §5).
 *
 * `null` rather than `0`, because `0` is the dangerous spelling: Vuetify's `v-snackbar` takes `-1` for "never" and
 * `0` for "right now" (`startTimeout()` schedules `setTimeout(…, 0)`), so an error marked `0` **appears and vanishes in
 * the same tick**. That is what the first version of this table said, and it looked correct in a test that asserted on
 * the toast immediately after mounting — measured in pass 32: the same assertion failed 1 run in 3, and the DOM was
 * empty because Vuetify had dismissed it. `null` keeps the framework's convention in the host, where it belongs.
 */
export const TIMEOUT_BY_KIND: Record<NotificationKind, number | null> = {
  success: 3_000,
  info: 5_000,
  error: null,
};

/**
 * Most toasts on screen at once.
 *
 * Three is the point at which a burst stops being informative and starts covering the page it is about; the oldest
 * goes first, because the newest failure is the one the reader just caused.
 */
export const MAX_VISIBLE = 3;

/** A toast on screen. */
export interface AppNotification {
  readonly id: number;
  readonly kind: NotificationKind;
  /** The sentence: what happened, or that it worked. */
  readonly message: string;
  /** One line of "what to do", when the caller has one. */
  readonly detail: string | null;
  /** `04-api.md` §0.2's id, so a screenshot can be matched to a log line. */
  readonly requestId: string | null;
  /** Countdown in milliseconds, or `null` for a toast that waits for its close button. */
  readonly timeout: number | null;
}

/** What `push` accepts. */
export interface NotificationInput {
  readonly kind?: NotificationKind;
  readonly message: string;
  readonly detail?: string;
  readonly requestId?: string | null;
}

/** Extra context for {@link useNotifications}'s `error`. */
export interface ErrorNotificationOptions {
  readonly detail?: string;
  readonly requestId?: string | null;
}

/**
 * The toast queue.
 *
 * `lastId` lives in state rather than in a module variable so two Pinia instances (two mounts) do not share a counter
 * — a shared one makes a `v-for` key collide across apps, which Vue reports as a duplicate-key warning and renders as
 * a toast that does not update.
 */
export const useNotifications = defineStore('notifications', {
  state: (): { items: AppNotification[]; lastId: number } => ({ items: [], lastId: 0 }),

  actions: {
    /**
     * Shows a toast.
     *
     * @param input - The message and its context.
     * @returns The toast's id, so a caller can dismiss it when its action finishes.
     */
    push(input: NotificationInput): number {
      const kind = input.kind ?? 'info';

      // The same action failing twice is one problem: a double-clicked "Retry" must not stack two copies of one
      // sentence, and neither must two screens reporting the same outage.
      const duplicate = this.items.find(
        (item) => item.kind === kind && item.message === input.message,
      );
      if (duplicate !== undefined) return duplicate.id;

      this.lastId += 1;
      const item: AppNotification = {
        id: this.lastId,
        kind,
        message: input.message,
        detail: input.detail ?? null,
        requestId: input.requestId ?? null,
        timeout: TIMEOUT_BY_KIND[kind],
      };

      this.items.push(item);
      // Oldest first: a stack that grows without bound covers the page, and the toast a reader has had on screen
      // longest is the one they have already read.
      if (this.items.length > MAX_VISIBLE) this.items.shift();
      return item.id;
    },

    /**
     * Shows a success toast (3 s, no close button needed but it has one).
     *
     * @param message - What worked.
     * @returns The toast's id.
     */
    success(message: string): number {
      return this.push({ kind: 'success', message });
    },

    /**
     * Shows an error toast. It stays until dismissed (`13-ui-ux.md` §5).
     *
     * @param message - What failed, in a sentence a person can act on.
     * @param options - What to do next, and the request id from the envelope.
     * @returns The toast's id.
     */
    error(message: string, options: ErrorNotificationOptions = {}): number {
      return this.push({ kind: 'error', message, ...options });
    },

    /**
     * Removes one toast — the close button, or Vuetify reporting its countdown expired.
     *
     * @param id - The toast to remove; a stale id is ignored, because a timeout and a click can both arrive.
     */
    dismiss(id: number): void {
      this.items = this.items.filter((item) => item.id !== id);
    },

    /** Removes every toast, e.g. on sign-out: a message about the old session must not follow the new one. */
    clear(): void {
      this.items = [];
    },
  },
});
