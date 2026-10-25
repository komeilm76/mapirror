import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue';

import ToastHost from '../src/components/common/ToastHost.vue';
import { createAppVuetify } from '../src/plugins/vuetify';
import { useNotifications } from '../src/stores/notifications';

/**
 * Toasts on screen (`P1-WEB-04`).
 *
 * The store's tests prove the queue; this file proves the queue reaches a person. Two facts matter and neither is
 * visible in the store:
 *
 * 1. **The text is in the DOM**, with the request id in small print (`13-ui-ux.md` §5's error-state rule, applied to the
 *    toast).
 * 2. **It is announced, not just drawn.** Vuetify renders the snackbar content as `role="status"` with
 *    `aria-live="polite"` — §7 requires that for toasts and progress — and the test reads the attribute rather than
 *    trusting the component to keep it.
 *
 * The snackbar teleports into `.v-overlay-container` on `document.body`, so every assertion here reads the document
 * rather than the mount container. That is Vuetify's design, not an accident of the harness: an overlay must not be
 * clipped by the page it covers.
 */

/** An app that renders the host with a real Vuetify, so the snackbar resolves. */
const mounted: VueApp<Element>[] = [];

function mountHost(pinia: Pinia): HTMLElement {
  const Root = defineComponent({ setup: () => () => h(ToastHost) });
  const app = createApp(Root);
  app.use(pinia);
  app.use(createAppVuetify());
  mounted.push(app);

  const container = document.createElement('div');
  document.body.append(container);
  app.mount(container);
  return container;
}

/** Mounts the host and lets the overlay render. */
async function mountWith(pinia: Pinia): Promise<HTMLElement> {
  const container = mountHost(pinia);
  await nextTick();
  await flushPromises();
  return container;
}

/**
 * Waits for `count` snackbars to be in the document.
 *
 * Vuetify mounts the overlay into a teleport and only then runs its transition, which is a frame later than the mount
 * — so reading the DOM one `flushPromises` after `mount()` is a race that passes alone and fails in a full-suite run
 * (measured: this file was green in isolation and red once, in the middle of 200 other tests). `waitFor` polls the real
 * clock instead of guessing a delay.
 */
async function waitForSnackbars(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(document.body.querySelectorAll('.v-snackbar')).toHaveLength(count);
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
});

describe('a toast on screen', () => {
  it('renders nothing when the queue is empty', async () => {
    // A host that renders an empty snackbar leaves a translucent bar in the corner with nothing in it.
    await mountWith(createPinia());

    expect(document.body.querySelector('.v-snackbar')).toBeNull();
  });

  it('shows the message, the advice and the request id', async () => {
    const pinia = createPinia();
    useNotifications(pinia).error('The update could not be queued.', {
      detail: 'Try again, or check the jobs page.',
      requestId: '9f1c2d1e',
    });

    await mountWith(pinia);
    await waitForSnackbars(1);

    const text = document.body.textContent ?? '';
    expect(text).toContain('The update could not be queued.');
    expect(text).toContain('Try again, or check the jobs page.');
    expect(text).toContain('Request 9f1c2d1e');
  });

  it('leaves the small print out when there is none', async () => {
    const pinia = createPinia();
    useNotifications(pinia).success('Country deleted.');

    await mountWith(pinia);
    await waitForSnackbars(1);

    const text = document.body.textContent ?? '';
    expect(text).toContain('Country deleted.');
    expect(text).not.toContain('Request');
  });

  it('is announced by a screen reader, without stealing focus', async () => {
    // §7: `aria-live` for toasts. `polite` rather than `assertive`: the reader is usually mid-keystroke in a form, and
    // an interrupting announcement is how a toast becomes a worse interruption than the error.
    const pinia = createPinia();
    useNotifications(pinia).error('The server could not be reached.');

    await mountWith(pinia);
    await waitForSnackbars(1);

    const live = document.body.querySelector('[role="status"]');
    expect(live).not.toBeNull();
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.textContent).toContain('The server could not be reached.');
  });

  it('keeps one snackbar per toast, so a second failure is not hidden behind the first', async () => {
    // The alternative — one snackbar showing the head of the queue — means the second error waits for the first to be
    // dismissed, and an error that is waiting is an error nobody saw.
    const pinia = createPinia();
    const toasts = useNotifications(pinia);
    toasts.error('First failure.');
    toasts.error('Second failure.');

    await mountWith(pinia);
    await waitForSnackbars(2);

    expect(document.body.querySelectorAll('.v-snackbar').length).toBe(2);
    expect(document.body.textContent).toContain('First failure.');
    expect(document.body.textContent).toContain('Second failure.');
  });

  it('keeps an error on screen after the moment it appeared', async () => {
    // The regression test for pass 32's second defect. The store used to mark an error with `timeout: 0`, and Vuetify
    // reads `0` as "dismiss on the next tick" — so the toast was in the DOM only between the render and the timer, and
    // a test that asserted immediately after mounting passed while a user would see nothing at all. Waiting real time
    // before looking is the whole point of this case.
    const pinia = createPinia();
    useNotifications(pinia).error('The disk is full.');

    await mountWith(pinia);
    await waitForSnackbars(1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(document.body.querySelectorAll('.v-snackbar')).toHaveLength(1);
    expect(document.body.textContent).toContain('The disk is full.');
  });

  it('dismisses when the button is pressed', async () => {
    const pinia = createPinia();
    const toasts = useNotifications(pinia);
    toasts.error('The disk is full.');

    await mountWith(pinia);
    await waitForSnackbars(1);

    const dismiss = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Dismiss',
    );
    expect(dismiss).toBeDefined();

    dismiss?.click();
    await nextTick();
    await flushPromises();

    expect(toasts.items).toEqual([]);
  });
});
