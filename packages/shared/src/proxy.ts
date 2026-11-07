/**
 * Outbound proxy administration and health-check contracts (`P6-OPS-04`).
 *
 * Proxy endpoints intentionally exclude embedded credentials, paths and query parameters: the value is persisted in the
 * settings table and should identify only a transport endpoint. Authentication can be added later with an explicit
 * encrypted-secret design rather than storing a password in ordinary settings.
 *
 * @module proxy
 */

import { z } from 'zod';

interface EndpointUrl {
  readonly protocol: string;
  readonly hostname: string;
  readonly username: string;
  readonly password: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly port: string;
  readonly host: string;
}

type EndpointUrlConstructor = new (value: string) => EndpointUrl;

/** Uses the runtime's standard WHATWG URL parser without coupling shared contracts to browser or Node type libraries. */
function parseEndpointUrl(value: string): EndpointUrl {
  const urlConstructor = (globalThis as unknown as { readonly URL: EndpointUrlConstructor }).URL;
  return new urlConstructor(value);
}

/** Valid HTTP, HTTPS or SOCKS5 proxy endpoint. Credentials and URL routing components are deliberately forbidden. */
export const ProxyEndpointSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .superRefine((value, context) => {
    let url: EndpointUrl;
    try {
      url = parseEndpointUrl(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'Enter a complete proxy URL.' });
      return;
    }

    if (!['http:', 'https:', 'socks5:'].includes(url.protocol)) {
      context.addIssue({
        code: 'custom',
        message: 'Proxy URL must use http, https, or socks5.',
      });
    }
    if (url.hostname === '') {
      context.addIssue({ code: 'custom', message: 'Proxy URL must include a host.' });
    }
    if (url.username !== '' || url.password !== '') {
      context.addIssue({
        code: 'custom',
        message:
          'Do not put credentials in the proxy URL; authenticated proxies are not supported.',
      });
    }
    if (
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search !== '' ||
      url.hash !== '' ||
      value.includes('?') ||
      value.includes('#')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Proxy URL must contain only the scheme, host, and optional port.',
      });
    }
    if (url.port !== '' && (!/^\d+$/u.test(url.port) || Number(url.port) < 1)) {
      context.addIssue({ code: 'custom', message: 'Proxy port must be between 1 and 65535.' });
    }
  })
  .transform((value) => {
    const url = parseEndpointUrl(value);
    return `${url.protocol}//${url.host}`;
  });

/** Strict request for testing the entered endpoint without applying it. Omitted endpoint means test current routing. */
export const ProxyTestRequestSchema = z
  .object({ endpoint: ProxyEndpointSchema.optional() })
  .strict();

/** Strict request to validate and apply an endpoint. */
export const ProxyApplyRequestSchema = z.object({ endpoint: ProxyEndpointSchema }).strict();

/** One status from an external service check. */
export const ProxyHealthCheckSchema = z
  .object({
    id: z.enum([
      'geofabrik-index',
      'geofabrik-region-page',
      'geofabrik-pbf-head',
      'geofabrik-md5',
      'geofabrik-pbf-range',
    ]),
    label: z.string().min(1).max(100),
    method: z.enum(['GET', 'HEAD']),
    url: z.url({ protocol: /^https?$/ }),
    status: z.number().int().min(100).max(599).nullable(),
    statusText: z.string().max(200).nullable(),
    expected: z.string().min(1).max(100),
    passed: z.boolean(),
    reason: z.string().min(1).max(300),
    durationMs: z.number().int().nonnegative().max(60_000),
  })
  .strict();

/** Complete, sanitized result of checking every HTTP operation used for Geofabrik catalog and downloads. */
export const ProxyHealthReportSchema = z
  .object({
    checkedAt: z.iso.datetime(),
    proxyUsed: z.boolean(),
    endpoint: ProxyEndpointSchema.nullable(),
    passed: z.boolean(),
    checks: z.array(ProxyHealthCheckSchema).length(5),
  })
  .strict();

/** Safe current-proxy view. There are deliberately no credential fields. */
export const ProxyConfigurationSchema = z
  .object({ configured: z.boolean(), endpoint: ProxyEndpointSchema.nullable() })
  .strict();

/** Response after saving and activating an endpoint, followed by health checks through the active transport. */
export const ProxyApplyResponseSchema = z
  .object({
    applied: z.boolean(),
    configuration: ProxyConfigurationSchema,
    health: ProxyHealthReportSchema,
  })
  .strict();

export type ProxyEndpoint = z.infer<typeof ProxyEndpointSchema>;
export type ProxyTestRequest = z.infer<typeof ProxyTestRequestSchema>;
export type ProxyApplyRequest = z.infer<typeof ProxyApplyRequestSchema>;
export type ProxyHealthCheck = z.infer<typeof ProxyHealthCheckSchema>;
export type ProxyHealthReport = z.infer<typeof ProxyHealthReportSchema>;
export type ProxyConfiguration = z.infer<typeof ProxyConfigurationSchema>;
export type ProxyApplyResponse = z.infer<typeof ProxyApplyResponseSchema>;
