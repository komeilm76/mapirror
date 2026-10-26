/**
 * Derives path-safe local catalog slugs from Geofabrik source regions (`P2-SRC-05`, ENG-6 / L6).
 *
 * Source ids remain the upstream identity. Slugs are local, name-based identities suitable for public URLs and cache
 * paths; normalized-name collisions are prefixed by parent and any remaining collisions are resolved deterministically.
 *
 * @module modules/geofabrik/slug
 */

import type { SourceRegion } from './source';

/** Slugs must match `countries_slug_fmt`: lowercase ASCII, start alphanumeric, at most 64 characters. */
const MAX_SLUG_LENGTH = 64;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** Produces a lowercase, ASCII, hyphen-separated representation, or an empty string when nothing survives. */
function normalizedPart(value: string): string {
  const ascii = value
    .normalize('NFKD')
    .replace(/ß/giu, 'ss')
    .replace(/æ/giu, 'ae')
    .replace(/œ/giu, 'oe')
    .replace(/ø/giu, 'o')
    .replace(/ł/giu, 'l')
    .replace(/đ/giu, 'd')
    .replace(/ð/giu, 'd')
    .replace(/þ/giu, 'th')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return ascii;
}

/** Uses the source-id leaf when a display name contains no ASCII letters or digits. */
function nameSlug(region: SourceRegion): string {
  const fromName = normalizedPart(region.name);
  const sourceLeaf = region.id.split('/').at(-1) ?? region.id;
  return fitSlug(fromName || normalizedPart(sourceLeaf) || normalizedPart(region.id) || 'region');
}

/** Fits a normalized candidate into the storage contract. */
function fitSlug(value: string): string {
  const fitted = value.slice(0, MAX_SLUG_LENGTH).replace(/-+$/u, '');
  const safe = /^[a-z0-9]/u.test(fitted) ? fitted : `r-${fitted}`;
  return safe.slice(0, MAX_SLUG_LENGTH).replace(/-+$/u, '') || 'region';
}

/** Prefixes a slug part with another part without violating the storage length cap. */
function prefixSlug(prefix: string, slug: string): string {
  const suffix = normalizedPart(slug) || 'region';
  const fittedSuffix = suffix.slice(0, MAX_SLUG_LENGTH - 2).replace(/-+$/u, '');
  const prefixBudget = MAX_SLUG_LENGTH - fittedSuffix.length - 1;
  const fittedPrefix = (normalizedPart(prefix) || 'region')
    .slice(0, prefixBudget)
    .replace(/-+$/u, '');
  return fitSlug(fittedPrefix.length === 0 ? fittedSuffix : `${fittedPrefix}-${fittedSuffix}`);
}

/** Adds a source-id tie-breaker without losing the trailing, region-identifying part of a long candidate. */
function appendSourceIdSlug(slug: string, sourceId: string): string {
  const base = normalizedPart(slug) || 'region';
  const source = (normalizedPart(sourceId) || 'region').slice(0, 24).replace(/-+$/u, '');
  const baseBudget = MAX_SLUG_LENGTH - source.length - 1;
  const fittedBase = (base.length > baseBudget ? base.slice(-baseBudget) : base).replace(
    /^-+/u,
    '',
  );
  return fitSlug(`${fittedBase}-${source}`);
}

/** Parent label from the index when possible, otherwise from its source-id leaf. */
function parentSlug(region: SourceRegion, parent: SourceRegion | undefined): string {
  const parentName = normalizedPart(parent?.name ?? '');
  const parentIdLeaf = normalizedPart(region.parentId?.split('/').at(-1) ?? '');
  return parentName || parentIdLeaf || 'region';
}

/** Appends a stable numeric disambiguator while keeping the final slug within 64 characters. */
function withNumericSuffix(slug: string, suffix: number): string {
  const tail = `-${String(suffix)}`;
  const head = slug.slice(0, MAX_SLUG_LENGTH - tail.length).replace(/-+$/u, '');
  return `${head}${tail}`;
}

/** Stable source-id comparator independent of locale settings. */
function compareSourceIds(left: SourceRegion, right: SourceRegion): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

/** Groups input regions by a derived slug. */
function groupBySlug(
  regions: readonly SourceRegion[],
  slugFor: (region: SourceRegion) => string,
): Map<string, SourceRegion[]> {
  const groups = new Map<string, SourceRegion[]>();
  for (const region of regions) {
    const slug = slugFor(region);
    const group = groups.get(slug);
    if (group === undefined) groups.set(slug, [region]);
    else group.push(region);
  }
  return groups;
}

/**
 * Derives unique, path-safe local slugs for all regions in a Geofabrik index.
 *
 * A region's name is normalized first (`Finland` → `finland`). When normalized names collide, the parent name (or the
 * parent id's final component if the parent is not in this index) is prefixed. If those candidates still collide, a
 * normalized source-id suffix is added. A final numeric suffix, assigned in source-id order, resolves even normalized
 * source-id collisions and collisions with another already-derived candidate. Previously assigned slugs are preserved
 * when supplied, so adding a new colliding region does not change existing public URLs or storage paths. Input order
 * does not affect newly derived slugs.
 *
 * @param regions - Parsed Geofabrik regions, including parent records when the index provides them.
 * @param existingSlugs - Previously persisted source-id/slug pairs; all values are reserved, including for absent regions.
 * @returns A map from current upstream source ids to globally unique local slugs.
 * @throws {Error} When source ids repeat or prior slug assignments are unsafe or non-unique.
 */
export function deriveGeofabrikSlugs(
  regions: readonly SourceRegion[],
  existingSlugs: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const sourceIds = new Set<string>();
  for (const region of regions) {
    if (sourceIds.has(region.id))
      throw new Error('Geofabrik region ids must be unique before deriving slugs');
    sourceIds.add(region.id);
  }

  const reservedSlugs = new Set<string>();
  for (const slug of existingSlugs.values()) {
    if (!SAFE_SLUG.test(slug))
      throw new Error('Existing Geofabrik slugs must satisfy the countries slug format');
    if (reservedSlugs.has(slug)) throw new Error('Existing Geofabrik slugs must be unique');
    reservedSlugs.add(slug);
  }

  const byId = new Map(regions.map((region) => [region.id, region]));
  const baseSlug = new Map(regions.map((region) => [region.id, nameSlug(region)]));
  const baseGroups = groupBySlug(regions, (region) => baseSlug.get(region.id) ?? 'region');
  const parentPrefixed = new Map<string, string>();

  for (const region of regions) {
    const base = baseSlug.get(region.id) ?? 'region';
    const collision = (baseGroups.get(base)?.length ?? 0) > 1;
    if (!collision) {
      parentPrefixed.set(region.id, base);
      continue;
    }

    const parent = region.parentId === null ? undefined : byId.get(region.parentId);
    parentPrefixed.set(region.id, prefixSlug(parentSlug(region, parent), base));
  }

  const parentGroups = groupBySlug(regions, (region) => parentPrefixed.get(region.id) ?? 'region');
  const preferred = new Map<string, string>();
  for (const region of regions) {
    const candidate = parentPrefixed.get(region.id) ?? 'region';
    const collision = (parentGroups.get(candidate)?.length ?? 0) > 1;
    const sourceSuffix = normalizedPart(region.id) || 'region';
    preferred.set(region.id, collision ? appendSourceIdSlug(candidate, sourceSuffix) : candidate);
  }

  const assigned = new Map<string, string>();
  const usedSlugs = new Set(reservedSlugs);
  for (const region of [...regions].sort(compareSourceIds)) {
    const existing = existingSlugs.get(region.id);
    if (existing !== undefined) {
      assigned.set(region.id, existing);
      continue;
    }

    const base = baseSlug.get(region.id) ?? 'region';
    let candidate = preferred.get(region.id) ?? 'region';
    const parentCandidate = parentPrefixed.get(region.id) ?? candidate;
    const alreadySourceDisambiguated = (parentGroups.get(parentCandidate)?.length ?? 0) > 1;
    if (usedSlugs.has(candidate) && !alreadySourceDisambiguated) {
      if ((baseGroups.get(base)?.length ?? 0) === 1) {
        const parent = region.parentId === null ? undefined : byId.get(region.parentId);
        candidate = prefixSlug(parentSlug(region, parent), base);
      }
      if (usedSlugs.has(candidate)) candidate = appendSourceIdSlug(candidate, region.id);
    }

    let slug = candidate;
    let suffix = 2;
    while (usedSlugs.has(slug)) {
      slug = withNumericSuffix(candidate, suffix);
      suffix += 1;
    }
    usedSlugs.add(slug);
    assigned.set(region.id, slug);
  }

  return assigned;
}
