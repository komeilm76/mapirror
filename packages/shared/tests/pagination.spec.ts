import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildPageMeta,
  parsePagination,
} from '@mapirror/shared';

/**
 * Pins pagination (D-16). The interesting cases are the hostile ones: a `limit` that would let a caller
 * ask for the whole table, and values that are not numbers at all.
 */
describe('defaults', () => {
  it('matches 04-api.md §0.2: page 1, limit 25, ceiling 100', () => {
    expect(DEFAULT_PAGE).toBe(1);
    expect(DEFAULT_PAGE_SIZE).toBe(25);
    expect(MAX_PAGE_SIZE).toBe(100);
  });
});

describe('parsePagination', () => {
  it('applies the defaults when the query is empty', () => {
    expect(parsePagination({})).toEqual({ page: 1, limit: 25, offset: 0 });
  });

  it('reads numeric strings, as a query string delivers them', () => {
    expect(parsePagination({ page: '3', limit: '50' })).toEqual({
      page: 3,
      limit: 50,
      offset: 100,
    });
  });

  it('computes the offset from page and limit', () => {
    expect(parsePagination({ page: 2, limit: 25 }).offset).toBe(25);
    expect(parsePagination({ page: 5, limit: 10 }).offset).toBe(40);
  });

  it('clamps limit to the ceiling instead of rejecting it', () => {
    expect(parsePagination({ limit: '100000' }).limit).toBe(MAX_PAGE_SIZE);
    expect(parsePagination({ limit: '100000' }).limit).toBe(100);
  });

  it('clamps the page to at least 1', () => {
    expect(parsePagination({ page: '0' }).page).toBe(1);
    expect(parsePagination({ page: '-7' }).page).toBe(1);
  });

  it('clamps limit to at least 1, so a page always has a row or none', () => {
    expect(parsePagination({ limit: '0' }).limit).toBe(1);
    expect(parsePagination({ limit: '-5' }).limit).toBe(1);
  });

  it('floors fractional values', () => {
    expect(parsePagination({ page: '2.9', limit: '10.7' })).toEqual({
      page: 2,
      limit: 10,
      offset: 10,
    });
  });

  it('falls back to the defaults for values that are not numbers', () => {
    expect(parsePagination({ page: 'abc', limit: 'xyz' })).toEqual({
      page: 1,
      limit: 25,
      offset: 0,
    });
    expect(parsePagination({ page: '', limit: '  ' })).toEqual({ page: 1, limit: 25, offset: 0 });
    expect(parsePagination({ page: Number.NaN, limit: Number.POSITIVE_INFINITY })).toEqual({
      page: 1,
      limit: 25,
      offset: 0,
    });
  });

  it('accepts a per-endpoint default, as the catalog list needs (limit 50)', () => {
    expect(parsePagination({}, { defaultLimit: 50 }).limit).toBe(50);
  });

  it('never lets a per-endpoint default exceed the global ceiling', () => {
    expect(parsePagination({}, { defaultLimit: 500 }).limit).toBe(MAX_PAGE_SIZE);
    expect(parsePagination({ limit: '80' }, { maxLimit: 5000 }).limit).toBe(80);
    expect(parsePagination({ limit: '5000' }, { maxLimit: 5000 }).limit).toBe(MAX_PAGE_SIZE);
  });

  it('keeps offset consistent with clamped values', () => {
    // If limit is clamped, offset must follow the clamped value — otherwise page 2 would skip rows that
    // were never sent.
    expect(parsePagination({ page: '2', limit: '100000' })).toEqual({
      page: 2,
      limit: 100,
      offset: 100,
    });
  });
});

describe('buildPageMeta', () => {
  it('computes totalPages by rounding up', () => {
    expect(buildPageMeta(1, 25, 5)).toEqual({ page: 1, limit: 25, total: 5, totalPages: 1 });
    expect(buildPageMeta(1, 25, 26)).toEqual({ page: 1, limit: 25, total: 26, totalPages: 2 });
    expect(buildPageMeta(1, 50, 389)).toEqual({ page: 1, limit: 50, total: 389, totalPages: 8 });
  });

  it('reports 0 pages for an empty result, not 1', () => {
    expect(buildPageMeta(1, 25, 0).totalPages).toBe(0);
  });

  it('treats negative or non-finite totals as empty', () => {
    expect(buildPageMeta(1, 25, -3).total).toBe(0);
    expect(buildPageMeta(1, 25, Number.NaN).total).toBe(0);
  });

  it('floors a fractional total (COUNT(*) is an integer)', () => {
    expect(buildPageMeta(1, 10, 10.9).total).toBe(10);
  });

  it('survives the last page exactly full', () => {
    expect(buildPageMeta(2, 25, 50).totalPages).toBe(2);
    expect(buildPageMeta(2, 25, 51).totalPages).toBe(3);
  });
});
