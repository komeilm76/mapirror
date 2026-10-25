/**
 * The colour tokens, and the two Vuetify themes built from them (`P1-WEB-02`).
 *
 * `13-ui-ux.md` §2 is the specification; this module is its only implementation. The palette is written in the
 * document's own names so a reader can hold the two side by side, and `tests/tokens.spec.ts` parses that table and
 * fails if any hex differs — in either direction, so a colour cannot be added to the doc and forgotten here, or added
 * here and left undocumented.
 *
 * ## What is deliberately *not* here
 *
 * Spacing, radius, motion and the type scale are in `tokens.css` / `typography.css`. They are CSS custom properties
 * because nothing in TypeScript computes with them, and duplicating them here would create a second source for a
 * number that only a stylesheet consumes.
 *
 * ## Two names for "surface", and why
 *
 * The document calls the page background `surface` and the card colour `surface-variant`. Vuetify calls the page
 * background `background` and *everything that floats* — cards, menus, dialogs — `surface`. Both vocabularies are
 * reasonable and they cannot both win, so the mapping is made here, once, and stated in the doc:
 *
 * | `13-ui-ux.md` §2 | Vuetify key | Why |
 * |---|---|---|
 * | `surface` (page background) | `background` | `v-app` paints `background`; this is the page |
 * | `surface-variant` (cards, table headers) | `surface` **and** `surface-variant` | `v-card`, `v-menu`, `v-dialog` paint `surface`, and a menu on the page colour would be invisible |
 *
 * The test asserts all three, so the table above is code, not a comment.
 *
 * @module styles/tokens
 */

import type { ThemeDefinition } from 'vuetify';

/**
 * One theme's colours, in the names `13-ui-ux.md` §2 uses.
 *
 * `border` is for **decorative** division (table rows, section rules). `border-strong` is for boundaries a user must
 * see to operate the interface — an input outline, a switch track — because WCAG 1.4.11 asks 3:1 of those and the
 * dividing line does not. The document gained the second token in this task, after measuring the first at 1.25:1
 * against the page background and finding it described as the token for "input borders"; see `16-changelog.md`
 * pass 30.
 */
export interface Palette {
  readonly primary: string;
  readonly 'primary-darken-1': string;
  readonly secondary: string;
  readonly accent: string;
  readonly success: string;
  readonly warning: string;
  readonly error: string;
  /** Page background. */
  readonly surface: string;
  /** Cards, table headers, menus, dialogs — anything above the page. */
  readonly 'surface-variant': string;
  /** Decorative division: table rows, section rules. */
  readonly border: string;
  /** Boundaries that carry meaning: input outlines, switch tracks, focus-adjacent edges (3:1). */
  readonly 'border-strong': string;
  /** Body ink. */
  readonly 'text-primary': string;
  /** Meta, captions, secondary ink. */
  readonly 'text-secondary': string;
}

/**
 * The light palette — the public site's default.
 *
 * Chosen from Tailwind's scale (teal-700 primary, indigo-700 secondary) for a reason an operator can act on: those
 * steps are the darkest shades that still read as their hue, so the same hex works as a link, as an icon and as a
 * filled button, and no component has to invent a second shade for "on white".
 */
export const LIGHT_PALETTE: Palette = {
  primary: '#0F766E',
  'primary-darken-1': '#115E59',
  secondary: '#4338CA',
  accent: '#B45309',
  success: '#15803D',
  warning: '#B45309',
  error: '#B91C1C',
  surface: '#FFFFFF',
  'surface-variant': '#F6F7F9',
  border: '#E3E6EA',
  'border-strong': '#7C848C',
  'text-primary': '#111827',
  'text-secondary': '#4B5563',
};

/**
 * The dark palette — the admin panel's default.
 *
 * The same hues one or two steps lighter, because a teal that is readable *on* white is barely distinguishable *from*
 * dark grey. Not an inverted light theme: the surfaces are `#0F1115`/`#171A21` rather than pure black, which keeps
 * elevation legible on an OLED panel and stops the white table text from vibrating.
 */
export const DARK_PALETTE: Palette = {
  primary: '#5EEAD4',
  'primary-darken-1': '#2DD4BF',
  secondary: '#A5B4FC',
  accent: '#FBBF24',
  success: '#4ADE80',
  warning: '#FBBF24',
  error: '#F87171',
  surface: '#0F1115',
  'surface-variant': '#171A21',
  border: '#262B35',
  'border-strong': '#6B7280',
  'text-primary': '#E5E7EB',
  'text-secondary': '#9CA3AF',
};

/** Theme name for the public/light theme. Vuetify's own vocabulary, so `useTheme().global.current.dark` is right. */
export const LIGHT_THEME_NAME = 'light';

/** Theme name for the admin/dark theme. */
export const DARK_THEME_NAME = 'dark';

/** The colours that can carry text on the page and on a card — the set §7's contrast rule applies to. */
export const INK_COLOURS = [
  'text-primary',
  'text-secondary',
  'primary',
  'secondary',
  'accent',
  'success',
  'warning',
  'error',
] as const;

/** The colours that are painted as a *fill* and therefore need a legible `on-` colour. */
export const FILL_COLOURS = [
  'primary',
  'secondary',
  'accent',
  'success',
  'warning',
  'error',
] as const;

/** Relative luminance of an `#rrggbb` colour, as WCAG 2.2 §relative-luminance defines it. */
function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  const [r, g, b] = channels.map((channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two `#rrggbb` colours.
 *
 * Exported because the test that enforces §7 uses it, and a second implementation in the test would be a second thing
 * to get wrong: the numbers must describe what ships.
 *
 * @param a - First colour, `#rrggbb`.
 * @param b - Second colour, `#rrggbb`.
 * @returns The ratio, from 1 (identical) to 21 (black on white).
 */
export function contrastRatio(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * The label colour for a filled button of `fill`.
 *
 * Computed here rather than left to Vuetify's `getForeground`, which answers by **APCA** — a newer model whose
 * thresholds are not the ones `13-ui-ux.md` §7 promises. Measured: on the dark theme's pastel fills Vuetify's rule
 * picks black (correct), but the decision is made against a 50-unit APCA cutoff, not against WCAG's 4.5:1, so a
 * future palette could pass Vuetify's check and fail ours. Two candidates, one comparison, no heuristics.
 *
 * @param fill - The background colour, `#rrggbb`.
 * @returns White or black, whichever reads better on it.
 */
export function bestOn(fill: string): string {
  return contrastRatio('#FFFFFF', fill) >= contrastRatio('#000000', fill) ? '#FFFFFF' : '#000000';
}

/**
 * Builds a Vuetify theme from a palette.
 *
 * @param palette - The colours, in the document's names.
 * @param dark - Whether this is the dark theme. Vuetify uses it for overlay and elevation maths, not for colour.
 * @returns A theme definition ready for `createVuetify({ theme: { themes } })`.
 */
export function themeFrom(palette: Palette, dark: boolean): ThemeDefinition {
  const on: Record<string, string> = {};
  for (const name of FILL_COLOURS) on[`on-${name}`] = bestOn(palette[name]);
  // The informational fill is an alias of `secondary` — see the aliases block below — so it needs a label too, and
  // `getForeground`'s APCA rule is exactly what this module exists to avoid.
  on['on-info'] = bestOn(palette.secondary);

  return {
    dark,
    colors: {
      // The mapping table at the top of this module, as code.
      background: palette.surface,
      surface: palette['surface-variant'],
      'surface-variant': palette['surface-variant'],
      // Everything the document names, by the name it uses.
      primary: palette.primary,
      'primary-darken-1': palette['primary-darken-1'],
      secondary: palette.secondary,
      accent: palette.accent,
      success: palette.success,
      warning: palette.warning,
      error: palette.error,
      border: palette.border,
      'border-strong': palette['border-strong'],
      'text-primary': palette['text-primary'],
      'text-secondary': palette['text-secondary'],
      // Vuetify's own "ink on the page / on a card" keys, so unstyled text and default icons are our body colour
      // instead of Vuetify's default `#000`/`#fff`.
      'on-background': palette['text-primary'],
      'on-surface': palette['text-primary'],
      'on-surface-variant': palette['text-primary'],
      // ---- The seven keys Vuetify would otherwise supply itself ----
      //
      // `createVuetify` merges its own Material palettes **under** the themes it is given, so every key this function
      // does not name keeps a colour `13-ui-ux.md` §2 has never heard of — and the leftovers are not harmless. Measured
      // before these lines existed (pass 33), on the shipped themes:
      //
      // | Key | Light | Dark | What it would have done |
      // |---|---|---|---|
      // | `info` | `#2196F3` | `#2196F3`, *and no `on-info`* | the neutral toast's blue, and a label Vuetify derives by APCA |
      // | `surface-bright` | `#FFFFFF` | **`#ccbfd6`** | a lavender "bright surface" in a dark control room |
      // | `surface-light` | `#EEEEEE` | `#424242` | a grey from another palette |
      // | `on-surface-variant` | **`#EEEEEE`** | `#EEEEEE` | near-white ink on a `#F6F7F9` card: **1.04:1** |
      // | `secondary-darken-1` | `#018786` | `#48A9A6` | a Material teal, while our `secondary` is indigo |
      //
      // Each is therefore given a value from the table, not a new colour: the surfaces alias `surface-variant`, the ink
      // aliases `text-primary`, and `info` — a state the document does not name — aliases `secondary` rather than
      // inventing a fourteenth colour. `tests/tokens.spec.ts` asserts the whole colour map contains **no value outside
      // this palette** (white and black excepted, as they are the computed labels), so a future Vuetify default cannot
      // slip back in through a key nobody looked at.
      'surface-bright': palette['surface-variant'],
      'surface-light': palette['surface-variant'],
      'secondary-darken-1': palette.secondary,
      info: palette.secondary,
      ...on,
    },
    variables: {
      // The focus ring of §2, in the theme rather than per component: Vuetify reads these for its own focus styles,
      // and `tokens.css` reads the same two numbers for the global `:focus-visible` rule.
      'focus-opacity': 1,
    },
  };
}
