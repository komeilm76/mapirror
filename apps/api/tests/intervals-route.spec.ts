import { describe, expect, it } from 'vitest';

import { buildTestApp, TEST_ADMIN_IDENTITY } from './helpers/test-app';

const TOKEN = `mm_${'A'.repeat(43)}`;
const COUNTRY_ID = '00000000-0000-4000-8000-000000000001';

async function appWithAdmin() {
  return buildTestApp({ authVerify: () => Promise.resolve(TEST_ADMIN_IDENTITY) });
}

describe('interval route semantic validation', () => {
  it('returns 422 for frequency-specific fields that do not match the selected frequency', async () => {
    const app = await appWithAdmin();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/_admin/api/intervals',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          name: 'Daily',
          frequency: 'daily',
          weekday: 1,
          countryIds: [COUNTRY_ID],
        },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('SEMANTIC_ERROR');
    } finally {
      await app.close();
    }
  });

  it('returns 422 for an empty country selection before touching PostgreSQL', async () => {
    const app = await appWithAdmin();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/_admin/api/intervals',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { name: 'Empty', frequency: 'daily', countryIds: [] },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('SEMANTIC_ERROR');
    } finally {
      await app.close();
    }
  });

  it('returns 400 for malformed time values and unrecognized fields', async () => {
    const app = await appWithAdmin();
    try {
      const invalidTime = await app.inject({
        method: 'POST',
        url: '/_admin/api/intervals',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          name: 'Bad time',
          frequency: 'daily',
          timeOfDay: '25:00',
          countryIds: [COUNTRY_ID],
        },
      });
      expect(invalidTime.statusCode).toBe(400);
      expect(invalidTime.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');

      const unknownField = await app.inject({
        method: 'POST',
        url: '/_admin/api/intervals',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          name: 'Unknown',
          frequency: 'daily',
          countryIds: [COUNTRY_ID],
          cron: '* * * * *',
        },
      });
      expect(unknownField.statusCode).toBe(400);
      expect(unknownField.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    } finally {
      await app.close();
    }
  });
});
