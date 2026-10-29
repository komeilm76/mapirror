/**
 * Safe, upload-id-addressed staging files under `TMP_DIR` (`P4-IMP-01`).
 *
 * The original filename is metadata only; it never becomes a path component. PostgreSQL stores the generated relative
 * path, and this module reconstructs only the one supported shape (`<uuid>.osm.pbf`).
 *
 * @module modules/storage/upload-storage
 */

import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FileHandle } from 'node:fs/promises';

/** One generated upload staging file. */
export interface UploadFile {
  /** Safe, root-relative path persisted in `upload_sessions.temp_path`. */
  readonly relativePath: string;
  /** Opens an empty new regular file, refusing an existing file or symlink instead of overwriting it. */
  openForWrite(): Promise<FileHandle>;
  /** Returns the current size, or zero when the file does not exist. */
  size(): Promise<bigint>;
  /** Removes only this regular file or a leaf symlink; returns false when it was absent. */
  remove(): Promise<boolean>;
}

/** Upload staging operations rooted at the operator-configured temporary directory. */
export interface UploadStorage {
  /** Builds a path for a PostgreSQL UUID. */
  file(uploadId: string): UploadFile;
  /** Reconstructs a validated path read from `upload_sessions.temp_path`. */
  fileAt(relativePath: string): UploadFile;
}

const UUID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;
const UPLOAD_PATH_PATTERN = /^([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})\.osm\.pbf$/iu;

/**
 * Creates a staging storage boundary at `temporaryDirectory`.
 *
 * The configured root may be an intentional operator symlink and is canonicalized once. Descendants are not
 * accepted as paths: every leaf is a UUID plus a fixed suffix, and opens use `O_NOFOLLOW | O_EXCL`.
 *
 * @param temporaryDirectory - Operator-configured `TMP_DIR`.
 * @returns Validated staging file builders.
 */
export function createUploadStorage(temporaryDirectory: string): UploadStorage {
  if (typeof temporaryDirectory !== 'string' || temporaryDirectory.trim() === '') {
    throw new TypeError('temporaryDirectory must not be empty');
  }

  const configuredRoot = resolve(temporaryDirectory);
  let rootPromise: Promise<string> | undefined;

  async function getRoot(): Promise<string> {
    if (rootPromise !== undefined) return rootPromise;
    const pending = (async () => {
      await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
      const root = await realpath(configuredRoot);
      const details = await lstat(root);
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new UploadStorageError('Upload staging root must resolve to a real directory.');
      }
      return root;
    })().catch((error: unknown) => {
      if (rootPromise === pending) rootPromise = undefined;
      throw error;
    });
    rootPromise = pending;
    return pending;
  }

  function makeFile(uploadId: string): UploadFile {
    const relativePath = `${uploadId}.osm.pbf`;
    const file: UploadFile = {
      relativePath,
      openForWrite: async () => {
        const path = join(await getRoot(), relativePath);
        return open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      },
      size: async () => {
        const path = join(await getRoot(), relativePath);
        try {
          const details = await lstat(path);
          if (!details.isFile() || details.isSymbolicLink()) {
            throw new UploadStorageError('Upload staging path is not a regular file.');
          }
          return BigInt(details.size);
        } catch (error) {
          if (hasCode(error, 'ENOENT')) return 0n;
          throw error;
        }
      },
      remove: async () => {
        const path = join(await getRoot(), relativePath);
        try {
          const details = await lstat(path);
          if (!details.isFile() && !details.isSymbolicLink()) {
            throw new UploadStorageError('Refusing to remove a non-file upload staging entry.');
          }
          await unlink(path);
          return true;
        } catch (error) {
          if (hasCode(error, 'ENOENT')) return false;
          throw error;
        }
      },
    };
    return Object.freeze(file);
  }

  return Object.freeze({
    file: (uploadId: string) => {
      if (typeof uploadId !== 'string' || !UUID_PATTERN.test(uploadId)) {
        throw new UploadStorageError('Invalid upload session identifier.');
      }
      return makeFile(uploadId.toLowerCase());
    },
    fileAt: (relativePath: string) => {
      if (typeof relativePath !== 'string') {
        throw new UploadStorageError('Invalid upload staging path.');
      }
      const match = UPLOAD_PATH_PATTERN.exec(relativePath);
      if (match === null) throw new UploadStorageError('Invalid upload staging path.');
      return makeFile((match[1] as string).toLowerCase());
    },
  });
}

/** Safe staging-path failure without echoing an untrusted path. */
export class UploadStorageError extends Error {
  /** @param message - Safe explanation with no filesystem path. */
  constructor(message: string) {
    super(message);
    this.name = 'UploadStorageError';
  }
}

/** Checks an error code without casting a non-error into an assumed shape. */
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
