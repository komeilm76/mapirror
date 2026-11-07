import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
const tsconfig = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')) as {
  readonly compilerOptions?: { readonly allowImportingTsExtensions?: boolean };
};

describe('Vitest native config-loader import contract', () => {
  it('uses explicit .ts extensions for local config modules', () => {
    expect(config).toContain("from './apps/web/alias.ts'");
    expect(config).toContain("from './vitest.projects.ts'");
    expect(config).not.toContain("from './apps/web/alias'");
    expect(config).not.toContain("from './vitest.projects'");
  });

  it('allows TypeScript extension imports in the root no-emit typecheck', () => {
    expect(tsconfig.compilerOptions?.allowImportingTsExtensions).toBe(true);
  });
});
