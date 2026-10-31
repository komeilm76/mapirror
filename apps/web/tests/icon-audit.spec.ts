import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/** UI source tree. */
const SOURCE = resolve(import.meta.dirname, '../src');

/** Installed Material Design Icons stylesheet, resolved through the web workspace dependency. */
const MDI_CSS = resolve(
  import.meta.dirname,
  '../node_modules/@mdi/font/css/materialdesignicons.css',
);

/** Unicode emoji presentation, flags, modifiers, and text-default pictographs forced into emoji presentation. */
const EMOJI =
  /(?:\p{Emoji_Presentation}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\p{Extended_Pictographic}\uFE0F)/u;

/** Recursively lists source files with one of the requested extensions. */
function filesUnder(directory: string, extensions: readonly string[]): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path, extensions));
    else if (extensions.some((extension) => path.endsWith(extension))) files.push(path);
  }
  return files;
}

describe('the UI icon set is deliberate and drawable', () => {
  it('loads the self-hosted MDI font and the icons actually used by controls', () => {
    const stylesheet = readFileSync(MDI_CSS, 'utf8');
    const main = readFileSync(resolve(SOURCE, 'main.ts'), 'utf8');
    const vuetify = readFileSync(resolve(SOURCE, 'plugins/vuetify.ts'), 'utf8');

    expect(main).toContain('@mdi/font/css/materialdesignicons.css');
    expect(vuetify).toContain("icons: { defaultSet: 'mdi' }");
    expect(stylesheet).toContain('font-family: "Material Design Icons"');
    expect(stylesheet).toContain('materialdesignicons-webfont.woff2');
    for (const name of ['close', 'eye', 'eye-off']) {
      expect(stylesheet, `the MDI font must define ${name}`).toMatch(
        new RegExp(`\\.mdi-${name}::before\\s*\\{\\s*content:`, 'u'),
      );
    }

    const tokens = readFileSync(resolve(SOURCE, 'styles/tokens.css'), 'utf8');
    expect(tokens).toMatch(/--mm-icon-size-20:\s*20px/u);
    expect(tokens).toMatch(/--mm-icon-size-24:\s*24px/u);

    const typography = readFileSync(resolve(SOURCE, 'styles/typography.css'), 'utf8');
    expect(typography).toMatch(
      /\.v-icon\.mm-icon-20\s*\{[^}]*font-size:\s*var\(--mm-icon-size-20\)/u,
    );
    expect(typography).toMatch(
      /\.v-icon\.mm-icon-24\s*\{[^}]*font-size:\s*var\(--mm-icon-size-24\)/u,
    );
    expect(typography).toMatch(
      /\.v-btn\.mm-icon-control\s*\{[^}]*min-width:\s*var\(--mm-touch-target\)[^}]*min-height:\s*var\(--mm-touch-target\)/u,
    );
  });

  it('uses no emoji or platform emoji flags in Vue or CSS UI source', () => {
    const offenders = filesUnder(SOURCE, ['.vue', '.css'])
      .map((path) => ({ path, match: EMOJI.exec(readFileSync(path, 'utf8'))?.[0] }))
      .filter((entry) => entry.match !== undefined)
      .map(({ path, match }) => `${path}: ${match}`);

    expect(offenders).toEqual([]);
  });
});
