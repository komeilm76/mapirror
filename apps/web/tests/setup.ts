/**
 * jsdom support for the web project (`P1-WEB-01`).
 *
 * jsdom implements the DOM, not a browser: it has no layout engine and therefore no `matchMedia`, no
 * `ResizeObserver` and no `visualViewport`. Vuetify's layout system and VueUse's media composables ask for all three
 * on the first render, so a component test without them fails with `window.matchMedia is not a function` — an error
 * about the harness, not about the component.
 *
 * These are **stubs of browser APIs, not of our code**: each one answers the way a real browser at a default desktop
 * size would. Nothing here changes what the application does, which is why it may live in a setup file rather than in
 * a per-test mock — a test that replaced our own module with a fake would be a test of the fake.
 *
 * @module tests/setup
 */

import { afterEach, vi } from 'vitest';

/** A minimal `matchMedia` whose listener API Vuetify and VueUse both use. */
function stubMatchMedia(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  );
}

/** A `ResizeObserver` that reports nothing and calls no callback. */
class StubResizeObserver {
  observe(): void {
    // Nothing to measure: jsdom has no layout, so there is no size to report. The point is that the constructor and
    // the four methods exist, so Vuetify's `useResizeObserver` can register and unregister without throwing.
  }
  unobserve(): void {
    // See above.
  }
  disconnect(): void {
    // See above.
  }
}

/** A `visualViewport` with the fields Vuetify reads when it positions an overlay. */
const STUB_VISUAL_VIEWPORT = {
  width: 1280,
  height: 720,
  offsetLeft: 0,
  offsetTop: 0,
  scale: 1,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

stubMatchMedia();
vi.stubGlobal('ResizeObserver', StubResizeObserver);
vi.stubGlobal('visualViewport', STUB_VISUAL_VIEWPORT);

afterEach(() => {
  // Every stub above is global; leaving them in place after a case is how one test's fake becomes the next one's
  // reality. Re-applying them (rather than removing) keeps the next case starting from the same browser-shaped world.
  vi.unstubAllGlobals();
  stubMatchMedia();
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  vi.stubGlobal('visualViewport', STUB_VISUAL_VIEWPORT);

  // And the URL. `createWebHistory()` reads `window.location` — one location for the whole jsdom — so a case that
  // navigates to `/_site/admin/catalog` leaves the *next* case's brand-new router starting there, and since `P1-WEB-02`
  // the theme follows the route, the app under test would mount dark for no visible reason. Measured: a fresh app
  // rendered `v-theme--dark` on the public home page because an earlier case had pushed an admin path.
  window.history.replaceState({}, '', '/');
});
