import { describe, expect, it } from 'vitest';

import {
  compareSchema,
  EXPECTED_MIGRATIONS,
  SCHEMA_SKEW_CODE,
  SchemaSkewError,
} from '../src/index';
import { listMigrationFiles } from '../src/db/migrator';

/**
 * Acceptance test for `P1-DB-04`, the half that needs no server: the comparison between what the code ships, what
 * is on disk and what the database has applied — and the constant that catches an image built without its `.sql`
 * files.
 *
 * The boot path itself (migrate, then refuse when the schema is behind or ahead) is covered in
 * `tests/integration/version-check.spec.ts` against real databases, and in `tests/db-stage.spec.ts` for the
 * refusal-and-close behaviour.
 */

describe('EXPECTED_MIGRATIONS', () => {
  it('names exactly the migration files that ship', async () => {
    // The rule from `03-data-model.md` §4: a migration and this constant change in the same commit. Without this
    // test the constant is a comment that rots — and its whole job is to notice a build whose `.sql` files are
    // missing, which it cannot do if it is stale.
    const onDisk = (await listMigrationFiles()).map((file) => file.name);

    expect([...EXPECTED_MIGRATIONS]).toEqual(onDisk);
  });

  it('is ordered, so the boot log reads in apply order', () => {
    expect([...EXPECTED_MIGRATIONS]).toEqual([...EXPECTED_MIGRATIONS].sort());
  });
});

describe('compareSchema', () => {
  const expected = ['0001_init', '0002_catalog'];

  it('reports nothing for a database that matches the build', () => {
    const report = compareSchema({ expected, onDisk: expected, applied: expected });

    expect(report.pending).toEqual([]);
    expect(report.unknown).toEqual([]);
    expect(report.missingFromDisk).toEqual([]);
    expect(report.unexpectedOnDisk).toEqual([]);
  });

  it('reports the database as behind when a file has not been applied', () => {
    const report = compareSchema({ expected, onDisk: expected, applied: ['0001_init'] });

    expect(report.pending).toEqual(['0002_catalog']);
    expect(report.unknown).toEqual([]);
  });

  it('reports the database as ahead when it has a migration this build does not ship', () => {
    // The rollback case: an older image against a newer schema. Forward-only migrations mean the code cannot
    // "undo" it, and the columns it selects may be gone.
    const report = compareSchema({
      expected: ['0001_init'],
      onDisk: ['0001_init'],
      applied: ['0001_init', '0002_catalog'],
    });

    expect(report.unknown).toEqual(['0002_catalog']);
    expect(report.pending).toEqual([]);
  });

  it('notices a migration file missing from the image', () => {
    // The reason this check is not simply "does the database match the directory": if the directory is empty
    // because the Docker build copied the wrong path, an empty database looks perfectly consistent.
    const report = compareSchema({ expected, onDisk: ['0001_init'], applied: ['0001_init'] });

    expect(report.missingFromDisk).toEqual(['0002_catalog']);
  });

  it('notices a migration file the constant does not know about', () => {
    const report = compareSchema({
      expected: ['0001_init'],
      onDisk: ['0001_init', '0002_catalog'],
      applied: ['0001_init'],
    });

    expect(report.unexpectedOnDisk).toEqual(['0002_catalog']);
  });

  it('treats an empty database with an empty directory as legitimate — and the constant catches it', () => {
    // The subtle half: with no files and no applied migrations, `pending` and `unknown` are both empty, so the
    // directory-vs-database comparison alone would call this healthy. `missingFromDisk` is what refuses it.
    const report = compareSchema({ expected, onDisk: [], applied: [] });

    expect(report.pending).toEqual([]);
    expect(report.unknown).toEqual([]);
    expect(report.missingFromDisk).toEqual(expected);
  });

  it('describes both directions at once, rather than stopping at the first difference', () => {
    const report = compareSchema({
      expected: ['0001_init', '0002_catalog'],
      onDisk: ['0001_init', '0003_metrics'],
      applied: ['0001_init', '0009_future'],
    });

    expect(report.pending).toEqual(['0003_metrics']);
    expect(report.unknown).toEqual(['0009_future']);
    expect(report.missingFromDisk).toEqual(['0002_catalog']);
    expect(report.unexpectedOnDisk).toEqual(['0003_metrics']);
  });
});

describe('SchemaSkewError', () => {
  it('carries the startup code and the report an operator needs', () => {
    const report = compareSchema({
      expected: ['0001_init'],
      onDisk: ['0001_init'],
      applied: ['0001_init', '0002_catalog'],
    });
    const error = new SchemaSkewError('database is ahead', report);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SchemaSkewError');
    // A startup code, not an HTTP one: this never reaches a response.
    expect(error.code).toBe(SCHEMA_SKEW_CODE);
    expect(error.report.unknown).toEqual(['0002_catalog']);
    expect(error.message).toBe('database is ahead');
  });
});
