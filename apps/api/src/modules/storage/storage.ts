/**
 * Validated paths and no-follow filesystem operations for the local cache (`P2-JOB-06`, L6 / ADR-006).
 *
 * Callers name cache artifacts by validated catalog identity, never by joining untrusted strings to `CACHE_DIR`. Every
 * operation rechecks parent directories, refuses symlink traversal, opens leaf files with `O_NOFOLLOW`, and unlinks
 * only a named leaf or an encountered symlink component (unlink removes the link, never its target).
 *
 * @module modules/storage/storage
 */

import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FileHandle } from 'node:fs/promises';

/** Safe reference to one storage-owned cache artifact or temporary file. */
export interface StorageFile {
  /** Relative, forward-slash path persisted in `map_versions.storage_path`; empty for temporary artifacts. */
  readonly relativePath: string;
  /** Creates and validates the parent directories, refusing symlinks and non-directories. */
  ensureParent(): Promise<void>;
  /** Reads the current file length, or zero when the file does not exist. */
  size(): Promise<bigint>;
  /** Opens a regular file without following a leaf symlink. */
  open(mode: 'read' | 'write' | 'append'): Promise<FileHandle>;
  /** Removes only a file or the first encountered symlink, never recursively removing a directory or following a link. */
  remove(): Promise<void>;
}

/** Cache-owned filesystem operations. */
export interface CacheStorage {
  /** Creates a version artifact reference from validated path components. */
  versionFile(slug: string, version: string, filename: string): StorageFile;
  /** Reconstructs and validates the three-part relative path stored in `map_versions`. */
  versionFileAt(relativePath: string): StorageFile;
  /** Creates the worker's private `.partial/<uuid>.part` reference. */
  partFile(jobId: string): StorageFile;
  /** Atomically installs a part file at its final version path on the cache filesystem. */
  installPart(part: StorageFile, target: StorageFile): Promise<void>;
  /** Writes and removes the fixed readiness-probe artifact, proving the cache accepts a non-empty write. */
  probeWritable(): Promise<void>;
}

interface FileSpec {
  readonly components: readonly string[];
  readonly relativePath: string;
  readonly kind: 'part' | 'version' | 'probe';
}

/** Reserved cache-root filename used by the API readiness probe. */
export const CACHE_PROBE_FILE = '.readyz';

const UUID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/u;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}\.osm\.pbf$/u;

/**
 * Builds a cache storage boundary rooted at `cacheDirectory`.
 *
 * The configured root itself may be a deliberate operator symlink; it is canonicalized once. Symlinks below that
 * canonical root are never traversed. The cache volume must remain writable only by the API service/operator because
 * portable Node filesystem APIs cannot make a multi-component path walk atomic against a hostile concurrent writer.
 *
 * @param cacheDirectory - Operator-configured cache root.
 * @returns Validated path builders and safe file operations.
 */
export function createCacheStorage(cacheDirectory: string): CacheStorage {
  if (typeof cacheDirectory !== 'string' || cacheDirectory.trim() === '') {
    throw new TypeError('cacheDirectory must not be empty');
  }
  const configuredRoot = resolve(cacheDirectory);
  const specs = new WeakMap<StorageFile, FileSpec>();
  let rootPromise: Promise<string> | undefined;

  async function getRoot(): Promise<string> {
    if (rootPromise !== undefined) return rootPromise;
    const pending = (async () => {
      await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
      const root = await realpath(configuredRoot);
      const details = await lstat(root);
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new StoragePathError('Cache root must resolve to a real directory.');
      }
      return root;
    })().catch((error: unknown) => {
      if (rootPromise === pending) rootPromise = undefined;
      throw error;
    });
    rootPromise = pending;
    return pending;
  }

  function makeFile(spec: FileSpec): StorageFile {
    const file: StorageFile = {
      relativePath: spec.relativePath,
      ensureParent: async () => {
        await resolvePath(spec, true);
      },
      size: async () => {
        const path = await resolvePath(spec, false);
        const details = await lstatIfExists(path);
        if (details === undefined) return 0n;
        assertRegular(details);
        return details.size;
      },
      open: async (mode) => {
        if (spec.kind === 'version' && mode !== 'read') {
          throw new StoragePathError('Final version files may only be written by atomic install.');
        }
        if (spec.kind === 'probe' && mode !== 'write') {
          throw new StoragePathError('Readiness probe file supports only its bounded write.');
        }
        const path = await resolvePath(spec, mode !== 'read');
        const existing = await lstatIfExists(path);
        if (existing !== undefined) assertRegular(existing);
        const flags =
          mode === 'read'
            ? constants.O_RDONLY
            : mode === 'append'
              ? constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
              : constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC;
        return open(path, flags | constants.O_NOFOLLOW, 0o600);
      },
      remove: async () => {
        const root = await getRoot();
        let parent = root;
        for (const component of spec.components.slice(0, -1)) {
          const candidate = join(parent, component);
          const parentDetails = await lstatIfExists(candidate);
          if (parentDetails === undefined) return;
          if (parentDetails.isSymbolicLink()) {
            // Removing the unexpected link itself is safe and prevents cancellation cleanup getting stuck behind it.
            await unlink(candidate);
            return;
          }
          if (!parentDetails.isDirectory() || (await realpath(candidate)) !== candidate) {
            throw new StoragePathError('Refusing to unlink through a non-directory cache parent.');
          }
          parent = candidate;
        }
        const path = join(parent, spec.components.at(-1) as string);
        const details = await lstatIfExists(path);
        if (details === undefined) return;
        if (!details.isFile() && !details.isSymbolicLink()) {
          throw new StoragePathError('Refusing to unlink a non-file cache entry.');
        }
        // unlink() removes a symlink itself rather than following it. Parent components were walked without following.
        await unlink(path);
      },
    };
    Object.freeze(file);
    specs.set(file, spec);
    return file;
  }

  async function resolvePath(spec: FileSpec, createParents: boolean): Promise<string> {
    const root = await getRoot();
    let parent = root;
    for (const component of spec.components.slice(0, -1)) {
      const candidate = join(parent, component);
      if (createParents) {
        try {
          await mkdir(candidate, { mode: 0o700 });
        } catch (error) {
          if (!hasCode(error, 'EEXIST')) throw error;
        }
      }
      const details = await lstatIfExists(candidate);
      if (details === undefined) {
        if (!createParents) return join(root, ...spec.components);
        throw new StoragePathError('Cache path parent disappeared during directory creation.');
      }
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new StoragePathError('Cache path contains a symlink or non-directory parent.');
      }
      if ((await realpath(candidate)) !== candidate) {
        throw new StoragePathError('Cache path parent resolves outside its validated directory.');
      }
      parent = candidate;
    }
    return join(parent, spec.components.at(-1) as string);
  }

  function createVersionFile(slug: string, version: string, filename: string): StorageFile {
    if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
      throw new StoragePathError('Invalid cache country slug.');
    }
    if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
      throw new StoragePathError('Invalid cache version label.');
    }
    if (typeof filename !== 'string' || !FILENAME_PATTERN.test(filename)) {
      throw new StoragePathError('Invalid cache artifact filename.');
    }
    return makeFile({
      components: [slug, version, filename],
      relativePath: `${slug}/${version}/${filename}`,
      kind: 'version',
    });
  }

  return {
    versionFile: createVersionFile,
    versionFileAt: (relativePath) => {
      if (typeof relativePath !== 'string' || relativePath.includes('\\')) {
        throw new StoragePathError('Invalid relative cache storage path.');
      }
      const components = relativePath.split('/');
      if (components.length !== 3 || components.some((component) => component.length === 0)) {
        throw new StoragePathError('Cache storage path must have exactly three components.');
      }
      const [slug, version, filename] = components;
      return createVersionFile(slug as string, version as string, filename as string);
    },
    partFile: (jobId) => {
      if (typeof jobId !== 'string' || !UUID_PATTERN.test(jobId)) {
        throw new StoragePathError('Invalid cache job identifier.');
      }
      return makeFile({
        components: ['.partial', `${jobId}.part`],
        relativePath: '',
        kind: 'part',
      });
    },
    installPart: async (part, target) => {
      const partSpec = specs.get(part);
      const targetSpec = specs.get(target);
      if (partSpec?.kind !== 'part' || targetSpec?.kind !== 'version') {
        throw new StoragePathError('Atomic install requires a cache part and version file.');
      }
      const sourcePath = await resolvePath(partSpec, true);
      const targetPath = await resolvePath(targetSpec, true);
      const sourceDetails = await lstatIfExists(sourcePath);
      if (sourceDetails === undefined)
        throw new StoragePathError('Cache part file does not exist.');
      assertRegular(sourceDetails);
      const targetDetails = await lstatIfExists(targetPath);
      if (targetDetails !== undefined) assertRegular(targetDetails);
      await rename(sourcePath, targetPath);
    },
    probeWritable: async () => {
      const probe = makeFile({
        components: [CACHE_PROBE_FILE],
        relativePath: '',
        kind: 'probe',
      });
      try {
        const handle = await probe.open('write');
        try {
          await handle.writeFile('x');
        } finally {
          await handle.close();
        }
      } finally {
        await probe.remove().catch(() => undefined);
      }
    },
  };
}

/** Safe storage input/path failure with no operator-controlled path echoed into the message. */
export class StoragePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoragePathError';
  }
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function assertRegular(details: Awaited<ReturnType<typeof lstat>>): void {
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new StoragePathError('Cache artifact is not a regular file.');
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
