#!/usr/bin/env bun
/** Inventory and checksum the durable map artifacts in CACHE_DIR. */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** A checksum record for one cached artifact. */
export interface CacheManifestArtifact {
  readonly path: string;
  readonly sizeBytes: string;
  readonly md5: string;
}

/** Versioned manifest format written by this script. */
export interface CacheManifest {
  readonly format: 'mapirror-cache-manifest';
  readonly version: 1;
  readonly generatedAt: string;
  readonly artifacts: readonly CacheManifestArtifact[];
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/u;
const FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}\.osm\.pbf$/u;

/** Returns whether a JSON value is a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns whether a record has exactly the specified own keys. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** Parses and strictly validates a serialized cache manifest. */
export function parseCacheManifest(serialized: string): CacheManifest {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error('cache manifest is not valid JSON.');
  }

  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['format', 'version', 'generatedAt', 'artifacts']) ||
    value.format !== 'mapirror-cache-manifest' ||
    value.version !== 1 ||
    typeof value.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.generatedAt)) ||
    new Date(value.generatedAt).toISOString() !== value.generatedAt ||
    !Array.isArray(value.artifacts)
  ) {
    throw new Error('cache manifest does not match the supported version 1 schema.');
  }

  const seenPaths = new Set<string>();
  for (const artifact of value.artifacts) {
    if (
      !isRecord(artifact) ||
      !hasExactKeys(artifact, ['path', 'sizeBytes', 'md5']) ||
      typeof artifact.path !== 'string' ||
      typeof artifact.sizeBytes !== 'string' ||
      !/^(?:0|[1-9][0-9]*)$/u.test(artifact.sizeBytes) ||
      typeof artifact.md5 !== 'string' ||
      !/^[a-f0-9]{32}$/u.test(artifact.md5)
    ) {
      throw new Error('cache manifest contains an artifact with invalid fields.');
    }

    const [slug, version, filename, ...extra] = artifact.path.split('/');
    if (
      extra.length !== 0 ||
      slug === undefined ||
      version === undefined ||
      filename === undefined ||
      !SLUG_PATTERN.test(slug) ||
      !VERSION_PATTERN.test(version) ||
      !FILENAME_PATTERN.test(filename) ||
      seenPaths.has(artifact.path)
    ) {
      throw new Error('cache manifest contains an invalid or duplicate artifact path.');
    }
    seenPaths.add(artifact.path);
  }

  return value as unknown as CacheManifest;
}

/**
 * Lists regular map artifacts beneath a cache root without traversing symlinks, and hashes them as streams.
 *
 * @param cacheDirectory - Cache volume root.
 * @param generatedAt - Injectable generation time for deterministic tests.
 * @returns Stable, sorted inventory.
 */
export async function createCacheManifest(
  cacheDirectory: string,
  generatedAt = new Date(),
): Promise<CacheManifest> {
  const root = await realpath(cacheDirectory);
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error('CACHE_DIR must resolve to a real directory.');
  }

  const artifacts: CacheManifestArtifact[] = [];
  const walk = async (directory: string): Promise<void> => {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const absolute = join(directory, name);
      const details = await lstat(absolute);
      if (details.isSymbolicLink()) continue;
      if (details.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!details.isFile()) continue;

      const relativePath = relative(root, absolute).split(sep).join('/');
      const [slug, version, filename, ...extra] = relativePath.split('/');
      if (
        extra.length !== 0 ||
        slug === undefined ||
        version === undefined ||
        filename === undefined ||
        !SLUG_PATTERN.test(slug) ||
        !VERSION_PATTERN.test(version) ||
        !FILENAME_PATTERN.test(filename)
      ) {
        continue;
      }

      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const openedDetails = await handle.stat();
        if (!openedDetails.isFile() || openedDetails.size !== details.size) continue;
        const hash = createHash('md5');
        const stream = handle.createReadStream({ autoClose: false });
        for await (const chunk of stream as AsyncIterable<Uint8Array>) hash.update(chunk);
        artifacts.push({
          path: relativePath,
          sizeBytes: String(openedDetails.size),
          md5: hash.digest('hex'),
        });
      } finally {
        await handle.close();
      }
    }
  };

  await walk(root);
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  return {
    format: 'mapirror-cache-manifest',
    version: 1,
    generatedAt: generatedAt.toISOString(),
    artifacts,
  };
}

if (import.meta.main) {
  try {
    const argument = process.argv[2];
    if (argument === '--validate-stdin') {
      if (process.argv.length !== 3) throw new Error('unexpected argument after --validate-stdin.');
      parseCacheManifest(await Bun.stdin.text());
    } else {
      if (argument !== undefined) throw new Error('unknown argument.');
      const cacheDirectory = process.env.CACHE_DIR;
      if (cacheDirectory === undefined || cacheDirectory.trim() === '') {
        throw new Error('CACHE_DIR is not configured.');
      }
      const manifest = await createCacheManifest(cacheDirectory);
      const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
      parseCacheManifest(serialized);
      process.stdout.write(serialized);
    }
  } catch (error) {
    console.error(
      `error: ${error instanceof Error ? error.message : 'could not create or validate cache manifest'}`,
    );
    process.exitCode = 1;
  }
}
