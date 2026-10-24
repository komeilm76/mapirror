/**
 * Prettier configuration (task `P1-REPO-03`).
 *
 * Formatting is Prettier's job alone; ESLint runs with `eslint-config-prettier` so the two never
 * argue. Values follow `docs/09-development.md` §9: 100 columns, single quotes, trailing commas.
 *
 * @type {import('prettier').Config}
 */
export default {
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: true,
  quoteProps: 'as-needed',
  trailingComma: 'all',
  bracketSpacing: true,
  arrowParens: 'always',
  endOfLine: 'lf',
  vueIndentScriptAndStyle: false,
  overrides: [
    {
      files: ['*.md'],
      options: { proseWrap: 'preserve' },
    },
  ],
};
