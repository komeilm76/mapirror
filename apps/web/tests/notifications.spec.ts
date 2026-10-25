import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import { MAX_VISIBLE, TIMEOUT_BY_KIND, useNotifications } from '../src/stores/notifications';

/**
 * The toast queue (`P1-WEB-04`).
 *
 * Three behaviours from `13-ui-ux.md` §5 are the whole reason this is a store and not a `ref` in a component: errors
 * persist while successes do not, one action produces one toast, and a burst cannot cover the page it is reporting on.
 */

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('kinds', () => {
  it('keeps a success for three seconds and an error until it is dismissed', () => {
    expect(TIMEOUT_BY_KIND.success).toBe(3_000);
    // `null`, never `0`: Vuetify reads `0` as "dismiss on the next tick", so an error marked `0` appears and vanishes
    // in the same breath (pass 32 — the host maps `null` to Vuetify's own `-1`).
    expect(TIMEOUT_BY_KIND.error).toBeNull();

    const toasts = useNotifications();
    toasts.success('Country deleted.');
    toasts.error('That did not work.');

    expect(toasts.items.map((item) => [item.kind, item.timeout])).toEqual([
      ['success', 3_000],
      ['error', null],
    ]);
  });

  it('defaults a bare push to `info`', () => {
    // The neutral kind exists so a caller with nothing to celebrate or apologise for does not have to claim one.
    expect(useNotifications().push({ message: 'Copying…' })).toBe(1);
    expect(useNotifications().items[0]?.kind).toBe('info');
  });
});

describe('one action, one toast', () => {
  it('replaces an identical message instead of stacking a second copy', () => {
    // A double-clicked "Retry" fails twice with one sentence. Two identical toasts read as two problems, and the second
    // covers the first at the bottom of the screen.
    const toasts = useNotifications();

    const first = toasts.error('The server could not be reached.');
    const second = toasts.error('The server could not be reached.');

    expect(second).toBe(first);
    expect(toasts.items).toHaveLength(1);
  });

  it('keeps two different messages apart', () => {
    const toasts = useNotifications();

    toasts.error('The server could not be reached.');
    toasts.error('The disk is full.');

    expect(toasts.items).toHaveLength(2);
  });

  it('does not merge a success into an error that happens to share its words', () => {
    // Same words, different meaning: "Saved" as a reassurance and "Saved" as a complaint are two different facts, and
    // merging them by message alone would drop one.
    const toasts = useNotifications();

    toasts.success('Saved.');
    toasts.error('Saved.');

    expect(toasts.items).toHaveLength(2);
  });
});

describe('a burst', () => {
  it('keeps the newest few and drops the oldest', () => {
    // Errors persist, so without a cap four failing dashboards tile the screen from the bottom right corner to the
    // middle. The oldest is the one the reader has already read.
    const toasts = useNotifications();
    const ids = ['One.', 'Two.', 'Three.', 'Four.'].map((message) => toasts.error(message));

    expect(toasts.items).toHaveLength(MAX_VISIBLE);
    expect(toasts.items.map((item) => item.message)).toEqual(['Two.', 'Three.', 'Four.']);
    // ...and the ids are unique, because a `v-for` key that repeats renders a toast that never updates.
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('dismissing', () => {
  it('removes one, and ignores an id that is already gone', () => {
    // A countdown expiring and a close button can both fire for the same toast; the second call must be a no-op, not an
    // error.
    const toasts = useNotifications();
    const first = toasts.error('First.');
    toasts.success('Second.');

    toasts.dismiss(first);
    toasts.dismiss(first);

    expect(toasts.items.map((item) => item.message)).toEqual(['Second.']);
  });

  it('clears everything, which is what sign-out does', () => {
    // A message about the old session must not follow the new one onto the login page.
    const toasts = useNotifications();
    toasts.error('Your session has ended. Sign in again.');
    toasts.success('Saved.');

    toasts.clear();

    expect(toasts.items).toEqual([]);
  });
});

describe('the context a toast carries', () => {
  it('passes the detail and the request id to the host', () => {
    const toasts = useNotifications();

    toasts.error('The update could not be queued.', {
      detail: 'Retry, or check the jobs page.',
      requestId: 'abc',
    });

    expect(toasts.items[0]).toMatchObject({
      detail: 'Retry, or check the jobs page.',
      requestId: 'abc',
    });
  });

  it('leaves them null when there is nothing to say', () => {
    // `null`, not `''`: an empty detail line is a blank row in the toast, and the host's `v-if` is about absence.
    const toasts = useNotifications();
    toasts.success('Saved.');

    expect(toasts.items[0]?.detail).toBeNull();
    expect(toasts.items[0]?.requestId).toBeNull();
  });
});
