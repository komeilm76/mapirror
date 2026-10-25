import { describe, expect, it } from 'vitest';

import {
  DATA_LICENSE,
  DATA_SOURCE,
  attributionLine,
  detailLicense,
  listLicense,
} from '@mapirror/shared';

/**
 * Pins the attribution strings. ODbL makes attribution a licence condition, and a typo or a missing
 * "© OpenStreetMap contributors" is a compliance problem that no type checker can see.
 */
describe('licence constants', () => {
  it('matches 04-api.md §3', () => {
    expect(DATA_LICENSE).toEqual({
      name: 'ODbL 1.0',
      attribution: '© OpenStreetMap contributors',
      url: 'https://www.openstreetmap.org/copyright',
    });
    expect(DATA_SOURCE).toEqual({
      name: 'Geofabrik GmbH',
      url: 'https://download.geofabrik.de',
    });
  });

  it('uses the actual © character, not "(c)"', () => {
    expect(DATA_LICENSE.attribution).toContain('©');
    expect(DATA_LICENSE.attribution).toMatch(/OpenStreetMap contributors$/);
  });
});

describe('response blocks', () => {
  it('list responses carry licence + attribution only', () => {
    expect(listLicense()).toEqual({
      name: 'ODbL 1.0',
      attribution: '© OpenStreetMap contributors',
      url: 'https://www.openstreetmap.org/copyright',
    });
    expect(listLicense().source).toBeUndefined();
  });

  it('detail responses also name the source', () => {
    expect(detailLicense()).toMatchObject({
      name: 'ODbL 1.0',
      attribution: '© OpenStreetMap contributors',
      source: 'Geofabrik GmbH',
      sourceUrl: 'https://download.geofabrik.de',
    });
  });

  it('returns a fresh object each time, so a caller cannot corrupt the constant', () => {
    const first = listLicense();
    first.attribution = 'mutated';
    expect(listLicense().attribution).toBe('© OpenStreetMap contributors');
    expect(DATA_LICENSE.attribution).toBe('© OpenStreetMap contributors');
  });
});

describe('attributionLine', () => {
  it('names the data, the licence and the source in one line', () => {
    expect(attributionLine()).toBe(
      '© OpenStreetMap contributors — data ODbL 1.0, via Geofabrik GmbH',
    );
  });
});
