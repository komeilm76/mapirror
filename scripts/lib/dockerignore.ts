/**
 * `.dockerignore` matching, in one place (tasks `P1-REPO-06`, `P1-DOCK-01`).
 *
 * Two callers ask the same question — "would this path be in the build context?" — and they must agree: the
 * hygiene check (`scripts/check-hygiene.ts`) asserts that secrets are excluded and the files an image needs are
 * kept, and the Dockerfile test (`scripts/tests/dockerfile.spec.ts`) asserts that every `COPY` source survives
 * that same filtering. A `COPY` of an ignored path is a build that fails with `not found`, hours later, on a
 * machine that is not this one.
 *
 * Docker's rules, to the extent this repository needs them: one pattern per line, `#` comments, `!` re-includes,
 * the **last** matching line wins, `*` and `?` never cross `/`, `**` does, and a pattern that names a directory
 * covers everything under it.
 *
 * @module scripts/lib/dockerignore
 */

/**
 * Turns one `.dockerignore` line into a regular expression.
 *
 * @param rawPattern - A single pattern, with any leading `!` already removed.
 * @returns The compiled matcher, anchored and allowing trailing path segments.
 */
function patternToRegExp(rawPattern: string): RegExp {
  // `secrets/` means the directory and everything under it, so the trailing slash is not part of the match —
  // without this, `secrets/admin_password` slipped through a pattern that read as covering it.
  const pattern = rawPattern.replace(/\/+$/u, '');
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') index += 1;
        source += '.*';
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
    }
  }
  return new RegExp(`^${source}(/.*)?$`, 'u');
}

/**
 * Splits a `.dockerignore` file into patterns.
 *
 * @param contents - The file's text.
 * @returns The patterns, in file order, with comments and blank lines removed.
 */
export function parseDockerIgnore(contents: string): string[] {
  return contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Decides whether `.dockerignore` excludes a path, with ignore-file semantics.
 *
 * A `!` line re-includes; stripping the `!` instead would let `!.env.example` satisfy a "secrets are excluded"
 * assertion for `.env.example`, and `!.env` would hide a leak.
 *
 * @param path - Repository-relative path to test, with `/` separators.
 * @param patterns - Patterns from {@link parseDockerIgnore}.
 * @returns `true` when the path would be excluded from the build context.
 */
export function isExcludedFromBuild(path: string, patterns: readonly string[]): boolean {
  let excluded = false;
  for (const line of patterns) {
    const negated = line.startsWith('!');
    const pattern = negated ? line.slice(1) : line;
    if (patternToRegExp(pattern).test(path)) excluded = !negated;
  }
  return excluded;
}
