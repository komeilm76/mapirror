/** Offline tests for Geofabrik local slugs and collision resolution (`P2-SRC-05`). */

import { describe, expect, it } from 'vitest';

import { deriveGeofabrikSlugs } from '../src/modules/geofabrik/slug';
import type { SourceRegion } from '../src/modules/geofabrik/source';

/** Small source record builder; only identity and hierarchy affect slug derivation. */
function region(id: string, name: string, parentId: string | null = null): SourceRegion {
  return {
    id,
    parentId,
    name,
    isoAlpha2: [],
    isoOther: [],
    pbfUrl: null,
  };
}

describe('deriveGeofabrikSlugs', () => {
  it('uses the normalized region name as its local slug, independent of source hierarchy', () => {
    expect(deriveGeofabrikSlugs([region('europe/finland', 'Finland', 'europe')])).toEqual(
      new Map([['europe/finland', 'finland']]),
    );
  });

  it('normalizes accents, punctuation, repeated separators, and case into ASCII slugs', () => {
    expect(
      deriveGeofabrikSlugs([
        region('africa/cote-divoire', '  Côte d’Ivoire!! '),
        region('europe/sao-tome', 'São Tomé & Príncipe'),
        region('europe/grosse', 'Große Region'),
      ]),
    ).toEqual(
      new Map([
        ['africa/cote-divoire', 'cote-d-ivoire'],
        ['europe/sao-tome', 'sao-tome-principe'],
        ['europe/grosse', 'grosse-region'],
      ]),
    );
  });

  it('prefixes parent names for same-name regions across continents', () => {
    const slugs = deriveGeofabrikSlugs([
      region('europe', 'Europe'),
      region('asia', 'Asia'),
      region('europe/georgia', 'Georgia', 'europe'),
      region('asia/georgia', 'Georgia', 'asia'),
    ]);

    expect(slugs.get('europe/georgia')).toBe('europe-georgia');
    expect(slugs.get('asia/georgia')).toBe('asia-georgia');
  });

  it('preserves a prior slug when a later catalog entry introduces a name collision', () => {
    const europe = region('europe/georgia', 'Georgia', 'europe');
    const asia = region('asia/georgia', 'Georgia', 'asia');
    const existingSlugs = deriveGeofabrikSlugs([europe]);
    const slugs = deriveGeofabrikSlugs([europe, asia], existingSlugs);

    expect(slugs.get('europe/georgia')).toBe('georgia');
    expect(slugs.get('asia/georgia')).toBe('asia-georgia');
  });

  it('reserves slugs for source regions absent from the latest index', () => {
    const slugs = deriveGeofabrikSlugs(
      [region('europe/new-finland', 'Finland', 'europe')],
      new Map([['europe/old-finland', 'finland']]),
    );

    expect(slugs.get('europe/new-finland')).toBe('europe-finland');
    expect(new Set(slugs.values()).size).toBe(1);
  });

  it('uses the final parent-id component when the parent record is absent', () => {
    const slugs = deriveGeofabrikSlugs([
      region('north-america/georgia', 'Georgia', 'north-america'),
      region('europe/georgia', 'Georgia', 'europe'),
    ]);

    expect(slugs.get('north-america/georgia')).toBe('north-america-georgia');
    expect(slugs.get('europe/georgia')).toBe('europe-georgia');
  });

  it('adds source-id suffixes when parent prefixing cannot distinguish siblings', () => {
    const slugs = deriveGeofabrikSlugs([
      region('north-america', 'North America'),
      region('north-america/alpha', 'Springfield', 'north-america'),
      region('north-america/beta', 'Springfield', 'north-america'),
    ]);

    expect(slugs.get('north-america/alpha')).toBe('north-america-springfield-north-america-alpha');
    expect(slugs.get('north-america/beta')).toBe('north-america-springfield-north-america-beta');
  });

  it('resolves collisions introduced by parent prefixes against another region name', () => {
    const slugs = deriveGeofabrikSlugs([
      region('asia/georgia', 'Georgia', 'asia'),
      region('europe/georgia', 'Georgia', 'europe'),
      region('other/asia-georgia', 'Asia Georgia', 'other'),
    ]);

    expect(new Set(slugs.values()).size).toBe(3);
    expect([...slugs.values()].every((slug) => /^[a-z0-9][a-z0-9-]{0,63}$/u.test(slug))).toBe(true);
  });

  it('resolves normalized source-id collisions deterministically, regardless of input order', () => {
    const first = region('parent/a_b', 'Same Name', 'parent');
    const second = region('parent/a-b', 'Same Name', 'parent');
    const forward = deriveGeofabrikSlugs([first, second]);
    const reverse = deriveGeofabrikSlugs([second, first]);

    expect(forward).toEqual(reverse);
    expect(new Set(forward.values()).size).toBe(2);
    expect(forward.get('parent/a-b')).toBe('parent-same-name-parent-a-b');
    expect(forward.get('parent/a_b')).toBe('parent-same-name-parent-a-b-2');
  });

  it('keeps the child name visible when a long parent needs a collision prefix', () => {
    const slugs = deriveGeofabrikSlugs([
      region('parent', 'A Parent Name That Is Deliberately Far Too Long '.repeat(2)),
      region('parent/alpha', 'Georgia', 'parent'),
      region('parent/beta', 'Georgia', 'parent'),
    ]);

    expect(slugs.get('parent/alpha')).toMatch(/-georgia-/u);
    expect(slugs.get('parent/beta')).toMatch(/-georgia-/u);
    for (const slug of slugs.values()) expect(slug.length).toBeLessThanOrEqual(64);
  });

  it('keeps long and non-Latin names within the database slug constraint', () => {
    const slugs = deriveGeofabrikSlugs([
      region('asia/long', `${'Very Long Region '.repeat(8)}Name`),
      region('asia/japan', '日本'),
    ]);

    for (const slug of slugs.values()) expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/u);
    expect(slugs.get('asia/japan')).toBe('japan');
  });

  it('rejects duplicate source ids instead of silently overwriting a slug', () => {
    expect(() =>
      deriveGeofabrikSlugs([
        region('europe/finland', 'Finland'),
        region('europe/finland', 'Other Finland'),
      ]),
    ).toThrow('Geofabrik region ids must be unique before deriving slugs');
  });

  it('rejects unsafe or duplicate prior slugs before reserving them', () => {
    const current = [region('europe/finland', 'Finland')];

    expect(() => deriveGeofabrikSlugs(current, new Map([['old/finland', '../finland']]))).toThrow(
      'Existing Geofabrik slugs must satisfy the countries slug format',
    );
    expect(() =>
      deriveGeofabrikSlugs(
        current,
        new Map([
          ['old/finland', 'finland'],
          ['old/other-finland', 'finland'],
        ]),
      ),
    ).toThrow('Existing Geofabrik slugs must be unique');
  });

  it('returns an empty map for an empty catalog', () => {
    expect(deriveGeofabrikSlugs([])).toEqual(new Map());
  });
});
