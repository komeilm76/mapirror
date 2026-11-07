import { describe, expect, it } from 'vitest';

import { parseStoredOutboundProxyValue } from '../src/server';

describe('stored outbound proxy startup value', () => {
  it('rehydrates the decoded JSONB endpoint value and canonicalizes it', () => {
    expect(parseStoredOutboundProxyValue('HTTP://Proxy.Example.test:80/')).toBe(
      'http://proxy.example.test',
    );
  });

  it.each([
    null,
    { endpoint: 'http://proxy.example.test' },
    'ftp://proxy.example.test',
    'http://user:password@proxy.example.test',
    'http://proxy.example.test/path',
  ])('rejects malformed or unsafe stored values: %s', (value) => {
    expect(parseStoredOutboundProxyValue(value)).toBeNull();
  });
});
