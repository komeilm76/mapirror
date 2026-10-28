import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  contrastRatio,
  DARK_PALETTE,
  FILL_COLOURS,
  INK_COLOURS,
  LIGHT_PALETTE,
  themeFrom,
  type Palette,
} from '../src/styles/tokens';
import { createAppVuetify } from '../src/plugins/vuetify';

/**
 * The design tokens, checked against the document that specifies them (`P1-WEB-02`).
 *
 * Every case here parses `13-ui-ux.md` rather than restating a number. That is the whole design: a palettes test
 * written as `expect(LIGHT_PALETTE.primary).toBe('#0F766E')` passes while the document says something else, and the
 * document is what a designer, a reviewer and the next agent read. Three kinds of case:
 *
 * 1. **Parity** — every colour, length and duration in §2 exists in the code with the same value, and every value in
 *    the code is in §2. Both directions, so a token cannot be added to one and forgotten in the other.
 * 2. **Contrast** — the ratios §7 promises, computed from the palettes that actually ship (including the `on-` label
 *    colours, which Vuetify would otherwise pick with an APCA heuristic rather than the WCAG one the doc states).
 * 3. **Discipline** — no component may hold a hex, and neither may a stylesheet outside the token module. This is the
 *    task's own acceptance criterion, and it is the one that decays the moment nobody is looking.
 */

/** The repository root, from this file's location. */
const REPO = resolve(import.meta.dirname, '../../..');

/** The specification. */
const DOC = readFileSync(resolve(REPO, 'docs/13-ui-ux.md'), 'utf8');

/**
 * The body of one `##`/`###` section, without its heading.
 *
 * @param heading - A literal heading line, e.g. `### Color`.
 * @returns The lines between that heading and the next heading of the same or a higher level.
 */
function section(heading: string): string {
  const start = DOC.indexOf(heading);
  expect(start, `13-ui-ux.md must contain "${heading}"`).toBeGreaterThan(-1);
  const rest = DOC.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /u);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Rows of a markdown table as trimmed cells, skipping the header and the separator line. */
function tableRows(text: string): string[][] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2)
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    );
}

/** Every `#rrggbb` in a cell, or `null` when there is none. */
function hexIn(cell: string): string | null {
  return /#[0-9a-fA-F]{6}\b/u.exec(cell)?.[0] ?? null;
}

/** The colour table of §2, as `token → { light, dark }`. */
function documentedPalette(): Map<string, { light: string; dark: string }> {
  const table = new Map<string, { light: string; dark: string }>();
  for (const row of tableRows(section('### Color'))) {
    const name = /^`([a-z0-9-]+)`$/u.exec(row[0] ?? '')?.[1];
    const light = hexIn(row[1] ?? '');
    const dark = hexIn(row[2] ?? '');
    if (name === undefined || light === null || dark === null) continue;
    table.set(name, { light, dark });
  }
  return table;
}

/**
 * The `--mm-*` declarations of one of the app's stylesheets, as a map.
 *
 * A regex rather than a CSS parser: the file is hand-written, the declarations are one per line, and a parser
 * dependency would be a third thing to keep current. A stylesheet that stopped being shaped that way would fail the
 * parity cases loudly rather than silently return nothing — the `expect(...).toBeGreaterThan(0)` in each case is there
 * for exactly that.
 *
 * @param file - Path relative to `apps/web`, e.g. `src/styles/tokens.css`.
 * @returns Property name → declared value, trimmed.
 */
function customProperties(file: string): Map<string, string> {
  const css = readFileSync(resolve(import.meta.dirname, '..', file), 'utf8');
  const found = new Map<string, string>();
  for (const match of css.matchAll(/(--mm-[a-z0-9-]+)\s*:\s*([^;]+);/gu)) {
    const [, name, value] = match;
    // **First** declaration wins, not last: the reduced-motion block at the bottom of `tokens.css` re-declares the two
    // motion durations as `0ms`, and the value §2 specifies is the base one. Reading the file top-down is also how a
    // browser resolves the cascade's base layer, so the map means what the stylesheet means.
    if (name !== undefined && value !== undefined && !found.has(name))
      found.set(name, value.trim());
  }
  expect(found.size, `${file} must declare --mm-* properties`).toBeGreaterThan(4);
  return found;
}

/** All files under a directory, recursively, filtered by extension. */
function walk(directory: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path, extensions));
    else if (extensions.some((extension) => path.endsWith(extension))) found.push(path);
  }
  return found;
}

describe('the colour tokens are the ones the document specifies', () => {
  it('has a row in §2 for every palette key, and a palette key for every row', () => {
    const documented = documentedPalette();

    // Both directions. A token added to the doc with no implementation is a design the build does not have; a token in
    // the build with no doc row is a colour nobody can defend in review.
    expect([...documented.keys()].sort()).toEqual(Object.keys(LIGHT_PALETTE).sort());
    expect(Object.keys(DARK_PALETTE).sort()).toEqual(Object.keys(LIGHT_PALETTE).sort());
  });

  it('matches §2 exactly, in both themes', () => {
    for (const [token, expected] of documentedPalette()) {
      expect(LIGHT_PALETTE[token as keyof Palette], `light ${token}`).toBe(expected.light);
      expect(DARK_PALETTE[token as keyof Palette], `dark ${token}`).toBe(expected.dark);
    }
  });
});

describe('every promised contrast ratio holds, computed from the shipping palettes', () => {
  /** The two surfaces a colour can sit on, per §2's own table. */
  const surfaces = (palette: Palette) => ({
    background: palette.surface,
    card: palette['surface-variant'],
  });

  for (const [name, palette] of [
    ['light', LIGHT_PALETTE],
    ['dark', DARK_PALETTE],
  ] as const) {
    it(`keeps body text at 4.5:1 in the ${name} theme`, () => {
      // §7: "≥ 4.5:1 body". Every ink on every surface it is used on — a link in a table cell sits on the card colour,
      // not on the page, and that is the pair nobody checks by eye.
      for (const [surfaceName, surface] of Object.entries(surfaces(palette))) {
        for (const ink of INK_COLOURS) {
          const ratio = contrastRatio(palette[ink], surface);
          expect(ratio, `${ink} on ${surfaceName} (${name})`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`keeps meaningful boundaries at 3:1 in the ${name} theme`, () => {
      // §7 and WCAG 1.4.11: a boundary a user must see to operate the interface. `border` is deliberately *not* in this
      // list — it is the decorative hairline, and the doc says so.
      for (const [surfaceName, surface] of Object.entries(surfaces(palette))) {
        const ratio = contrastRatio(palette['border-strong'], surface);
        expect(ratio, `border-strong on ${surfaceName} (${name})`).toBeGreaterThanOrEqual(3);
      }
    });

    it(`gives every filled colour a label that reads at 4.5:1 in the ${name} theme`, () => {
      // The `on-<fill>` colours are computed by `themeFrom` — deliberately, because Vuetify's own `getForeground` picks
      // by APCA and the contract here is WCAG. This asserts what ships rather than what we meant.
      const theme = themeFrom(palette, name === 'dark');
      for (const fill of FILL_COLOURS) {
        const label = theme.colors?.[`on-${fill}`];
        expect(label, `on-${fill} must be defined`).toBeTruthy();
        const ratio = contrastRatio(label as string, palette[fill]);
        expect(ratio, `on-${fill} on ${fill} (${name})`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('documents the decorative hairline as exempt, rather than silently breaking the rule', () => {
    // `border` is below 3:1 in both themes — that is correct for a divider and fatal for an input. The sentence below is
    // what makes the difference a decision; without it the next reader "fixes" the palette or, worse, uses `border` for
    // a field and ships a 1.25:1 control.
    expect(contrastRatio(LIGHT_PALETTE.border, LIGHT_PALETTE.surface)).toBeLessThan(3);
    expect(contrastRatio(DARK_PALETTE.border, DARK_PALETTE.surface)).toBeLessThan(3);
    expect(section('### Color')).toMatch(/Decorative division/u);
    expect(section('### Color')).toMatch(/`border-strong`.*3:1/u);
  });
});

describe('the theme contains only the colours the document names', () => {
  /** The two themes, as pairs, so neither case re-spells the palette list. */
  const themes: readonly (readonly ['light' | 'dark', Palette])[] = [
    ['light', LIGHT_PALETTE],
    ['dark', DARK_PALETTE],
  ];

  /**
   * Every value §2 names, upper-cased — plus white and black, which are what `bestOn` computes for a label.
   *
   * Written as a keyed walk rather than `Object.values(palette)`: `Palette` is an interface with no index signature, so
   * `Object.values` falls through to its `any[]` overload and quietly removes the check's teeth.
   */
  function allowedValues(): Set<string> {
    const values = new Set<string>(['#FFFFFF', '#000000']);
    for (const palette of [LIGHT_PALETTE, DARK_PALETTE]) {
      for (const key of Object.keys(palette) as (keyof Palette)[]) {
        values.add(palette[key].toUpperCase());
      }
    }
    return values;
  }

  /**
   * The merged theme — the one that ships — not just what `themeFrom` returned.
   *
   * `createVuetify` merges its own Material palettes *under* the themes it is given, so a key our module never mentions
   * arrives with a colour from another design system. That is how the neutral toast ended up `#2196F3` (Vuetify's
   * `info`, with no `on-info`, so Vuetify derived the label by APCA) and how the dark theme acquired a lavender
   * `surface-bright`. The table of measured leftovers is in `styles/tokens.ts`.
   */
  function shippedColours(name: 'light' | 'dark'): Record<string, string> {
    return createAppVuetify().theme.themes.value[name]?.colors ?? {};
  }

  it('inherits no colour from Vuetify, in either theme', () => {
    for (const [name] of themes) {
      const colours = shippedColours(name);
      // A map that lost its keys would make the check below pass on nothing.
      expect(Object.keys(colours).length, name).toBeGreaterThan(15);

      // White and black are allowed because they are what `bestOn` computes for a label; everything else must be a hex
      // from §2's table. This is the invariant that makes "no colour outside the token module" true of the *theme* and
      // not merely of the source files — a Vuetify default cannot come back without failing here.
      const allowed = allowedValues();
      const foreign = Object.entries(colours).filter(
        ([, value]) => !allowed.has(String(value).toUpperCase()),
      );

      expect(foreign, `${name} theme colours that are not in 13-ui-ux.md §2`).toEqual([]);
    }
  });

  it('gives the informational state a colour and a label of ours', () => {
    // §2 has no `info` row, and the document is right not to invent one: an informational message is not a fifth
    // semantic colour. So `info` is an alias of `secondary` — a documented colour, not a new one — and it carries a
    // label `bestOn` computed, because Vuetify would otherwise pick one by APCA.
    for (const [name, palette] of themes) {
      const theme = themeFrom(palette, name === 'dark');
      const label = theme.colors?.['on-info'];

      expect(theme.colors?.info, name).toBe(palette.secondary);
      expect(label, `on-info must be defined (${name})`).toBeTruthy();
      expect(
        contrastRatio(label as string, palette.secondary),
        `on-info (${name})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('no component holds a colour', () => {
  // The task's acceptance criterion, as a scan rather than a habit. Components are `.vue`; the only TypeScript allowed a
  // hex is the token module itself, because that is what a token *is*.
  const colourLiteral = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/u;
  const sources = walk(resolve(import.meta.dirname, '../src'), ['.vue', '.ts', '.css']);

  it('finds the sources it is scanning, so the scan is not vacuous', () => {
    expect(sources.length).toBeGreaterThan(8);
    expect(sources.some((path) => path.endsWith('.vue'))).toBe(true);
  });

  it('finds colours only in the token module and the stylesheets', () => {
    // The stylesheets hold `rgb(var(--v-theme-…))` — a reference, not a colour — and one `rgb(0 0 0 / 16%)` shadow,
    // which is §2's shadow token spelled out. Everything else must be a theme key.
    const allowed = [
      'src/styles/tokens.ts',
      'src/styles/tokens.css',
      'src/styles/typography.css',
      'src/styles/shell.css',
      'src/styles/catalog.css',
    ];
    const offenders: string[] = [];

    for (const path of sources) {
      const name = relative(resolve(import.meta.dirname, '..'), path).replaceAll('\\', '/');
      if (allowed.includes(name)) continue;
      const body = readFileSync(path, 'utf8');
      body.split('\n').forEach((line, index) => {
        if (colourLiteral.test(line)) offenders.push(`${name}:${String(index + 1)} ${line.trim()}`);
      });
    }

    expect(offenders, 'components use theme keys, not colours').toEqual([]);
  });

  it('keeps the three stylesheets free of literal colours other than the documented shadow', () => {
    // A weaker promise for the files that are allowed literals: the only one is `--mm-shadow-overlay`, so a new
    // `background: #fafafa` in a stylesheet still fails.
    for (const name of [
      'src/styles/tokens.css',
      'src/styles/typography.css',
      'src/styles/shell.css',
      'src/styles/catalog.css',
    ]) {
      const lines = readFileSync(resolve(import.meta.dirname, '..', name), 'utf8')
        .split('\n')
        .filter((line) => colourLiteral.test(line) && !line.includes('var(--v-theme-'))
        .filter((line) => !line.includes('--mm-shadow-overlay'))
        // `--mm-font-ui` names no colour; the regex's `rgb(` branch cannot match it, but the `#` branch could match an
        // id selector or a URL fragment, and this keeps the assertion honest about what it is for.
        .filter((line) => !line.includes('url('));
      expect(lines, name).toEqual([]);
    }
  });
});

describe('the lengths and durations in tokens.css are the ones in §2', () => {
  const spacingSection = section('### Space, radius, elevation, motion');
  const tokens = customProperties('src/styles/tokens.css');

  it('uses the documented spacing scale, and nothing else', () => {
    const row = tableRows(spacingSection).find((cells) => cells[0] === 'Spacing scale');
    const documented = (row?.[1] ?? '').split('/').map((value) => Number(value.trim()));
    expect(documented.length).toBe(8);

    const implemented = [...tokens.entries()]
      .filter(([name]) => /^--mm-space-\d+$/u.test(name))
      .map(([, value]) => Number.parseFloat(value));
    expect(implemented.sort((a, b) => a - b)).toEqual(documented);
  });

  it('uses the documented radii', () => {
    const row = tableRows(spacingSection).find((cells) => cells[0] === 'Radius');
    const documented = [...(row?.[1] ?? '').matchAll(/`(?:sm|md|lg|pill)\s+(\d+)`/gu)].map(
      (match) => Number(match[1]),
    );
    expect(documented).toEqual([8, 12, 16, 999]);

    for (const [suffix, value] of [
      ['sm', 8],
      ['md', 12],
      ['lg', 16],
      ['pill', 999],
    ] as const) {
      expect(tokens.get(`--mm-radius-${suffix}`), suffix).toBe(`${String(value)}px`);
    }
  });

  it('uses the documented motion durations and easing', () => {
    // §2: "150 ms ease-out for hover/focus, 200 ms for dialogs". Read out of the table, so the numbers cannot be
    // changed in the CSS alone.
    const row = tableRows(spacingSection).find((cells) => cells[0] === 'Motion');
    const durations = [...(row?.[1] ?? '').matchAll(/(\d+)\s*ms/gu)].map((match) =>
      Number(match[1]),
    );
    expect(durations).toEqual([150, 200]);
    expect(tokens.get('--mm-motion-fast')).toBe(`${String(durations[0])}ms`);
    expect(tokens.get('--mm-motion-dialog')).toBe(`${String(durations[1])}ms`);
    expect(row?.[1]).toContain('ease-out');
    expect(tokens.get('--mm-ease-out')).toBe('ease-out');
  });

  it('uses the documented focus ring, touch target and container widths', () => {
    const row = (label: string) =>
      tableRows(spacingSection).find((cells) => cells[0] === label)?.[1] ?? '';

    const focus = [...row('Focus ring').matchAll(/(\d+)\s*px/gu)].map((match) => Number(match[1]));
    expect(focus).toEqual([2, 2]);
    expect(tokens.get('--mm-focus-ring-width')).toBe('2px');
    expect(tokens.get('--mm-focus-ring-offset')).toBe('2px');

    expect(row('Touch target')).toContain('44');
    expect(tokens.get('--mm-touch-target')).toBe('44px');

    // "Admin max 1440 px …, public max 1120 px".
    const container = row('Container');
    expect(container).toContain('1440');
    expect(container).toContain('1120');
    expect(tokens.get('--mm-container-admin')).toBe('1440px');
    expect(tokens.get('--mm-container-public')).toBe('1120px');
  });

  it('gives the overlay shadow a token, from the value §2 states', () => {
    expect(section('### Space, radius, elevation, motion')).toContain('0 8px 24px rgba(0,0,0,.16)');
    const shadow = tokens.get('--mm-shadow-overlay') ?? '';
    // Same shadow, modern syntax: "1 px `border` token; shadows only for overlays". The alpha and the offsets are what
    // the document specifies; `rgb(0 0 0 / 16%)` is the same colour as `rgba(0,0,0,.16)`.
    expect(shadow).toContain('0 8px 24px');
    expect(shadow).toMatch(/rgb\(0 0 0 \/ 16%\)/u);
  });

  it('honours prefers-reduced-motion by zeroing the durations it just defined', () => {
    // §7: "prefers-reduced-motion disables transitions and chart animation". Zeroing the tokens is how; the assertion
    // is that the block exists and really zeroes both, so a component written against them cannot animate.
    const css = readFileSync(resolve(import.meta.dirname, '../src/styles/tokens.css'), 'utf8');
    const block =
      /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/u.exec(css)?.[1] ?? '';
    expect(block).toContain('--mm-motion-fast: 0ms');
    expect(block).toContain('--mm-motion-dialog: 0ms');
    expect(block).toMatch(/transition-duration: 0\.01ms !important/u);
  });
});

describe('the type system is the one §2 describes, and stays inside its budget', () => {
  const typography = section('### Typography');
  const fonts = customProperties('src/styles/typography.css');

  it('sets the display size inside the documented range, at the documented weight', () => {
    const row = tableRows(typography).find((cells) => cells[0] === 'Display (page titles)');
    const [min, max] = [...(row?.[2] ?? '').matchAll(/(\d+)/gu)].map((match) => Number(match[1]));
    const weight = Number(/(\d{3})\s*$/u.exec(row?.[2] ?? '')?.[1]);

    const size = Number.parseFloat(fonts.get('--mm-text-display') ?? '');
    expect(size).toBeGreaterThanOrEqual(min ?? 0);
    expect(size).toBeLessThanOrEqual(max ?? 0);
    expect(Number(fonts.get('--mm-text-display-weight'))).toBe(weight);
  });

  it('sets the two documented body sizes and their weight', () => {
    const row = tableRows(typography).find((cells) => cells[0] === 'UI / body');
    expect(row?.[2]).toContain('14 px');
    expect(row?.[2]).toContain('16 px');
    expect(fonts.get('--mm-text-ui')).toBe('14px');
    expect(fonts.get('--mm-text-public-body')).toBe('16px');
    expect(fonts.get('--mm-text-ui')).toBe(
      `${/14 px/u.exec(row?.[2] ?? '')?.[0].split(' ')[0] ?? ''}px`,
    );
    expect(fonts.get('--mm-weight-regular')).toBe(String(/(\d{3})/u.exec(row?.[2] ?? '')?.[1]));
  });

  it('sets the mono size inside its documented range', () => {
    const row = tableRows(typography).find((cells) => cells[0] === 'Code / checksums');
    const [min, max] = [...(row?.[2] ?? '').matchAll(/(\d+)/gu)].map((match) => Number(match[1]));
    for (const name of ['--mm-text-mono', '--mm-text-mono-small']) {
      const size = Number.parseFloat(fonts.get(name) ?? '');
      expect(size, name).toBeGreaterThanOrEqual(min ?? 0);
      expect(size, name).toBeLessThanOrEqual(max ?? 0);
    }
  });

  it('makes numeric text tabular, as the Numeric row requires', () => {
    expect(typography).toContain('font-variant-numeric: tabular-nums');
    const css = readFileSync(resolve(import.meta.dirname, '../src/styles/tokens.css'), 'utf8');
    expect(css).toMatch(/\.mm-tabular \{[^}]*font-variant-numeric: tabular-nums/u);
  });

  it('ships the display font inside the 40 kB budget the document sets', () => {
    // The rule from §2: "If either adds > 40 kB total …, fall back to the system stack". Inter (48 256 B) is therefore
    // gone and Space Grotesk (22 288 B) stayed. This is the assertion that keeps that sentence true: grow the file and
    // the build fails here, with the number it broke.
    const budget = 40 * 1024;
    const font = resolve(import.meta.dirname, '../src/assets/fonts/space-grotesk-latin-wght.woff2');
    const { size } = statSync(font);
    expect(
      size,
      `display font is ${String(size)} B; the budget is ${String(budget)} B`,
    ).toBeLessThan(budget);
    // The license the OFL requires to travel with the file.
    expect(
      statSync(resolve(import.meta.dirname, '../src/assets/fonts/OFL.txt')).size,
    ).toBeGreaterThan(1000);
  });

  it('declares the font the way §2 and a fast first paint require', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/styles/typography.css'), 'utf8');
    expect(css).toContain("font-family: 'Space Grotesk'");
    expect(css).toContain('font-display: swap');
    // `unicode-range` is what stops a browser downloading a Latin subset for text that cannot use it; the doc's promise
    // "subset to Latin" is only real if the subset is declared.
    expect(css).toContain('unicode-range:');
    expect(fonts.get('--mm-font-display')).toContain('Space Grotesk');
    // The fallback stack, verbatim from §2, is what the body actually uses — the measurement's conclusion, in code.
    expect(fonts.get('--mm-font-ui')).toBe("-apple-system, 'Segoe UI', Roboto, sans-serif");
  });
});
