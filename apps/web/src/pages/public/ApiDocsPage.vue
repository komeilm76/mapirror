<script setup lang="ts">
/** Anonymous public API guide with same-origin, copyable cURL examples (`P3-WEB-04`, screen S4). */

import { useTimeoutFn } from '@vueuse/core';
import { computed, ref } from 'vue';

interface ApiEndpoint {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly curlPath: string;
  readonly outputFile?: string;
  readonly description: string;
  readonly parameters: readonly string[];
  readonly notes: readonly string[];
  readonly responseExample?: string;
  readonly responseNote?: string;
}

const apiOrigin = window.location.origin;
const copiedExample = ref<string | null>(null);
const failedExample = ref<string | null>(null);
const copiedReset = useTimeoutFn(
  () => {
    copiedExample.value = null;
  },
  2_000,
  { immediate: false },
);

const publicErrors = [
  {
    status: '400',
    code: 'VALIDATION_ERROR',
    when: 'A query parameter or version label is invalid.',
  },
  { status: '400', code: 'BAD_REQUEST', when: 'The HTTP request itself is malformed.' },
  {
    status: '404',
    code: 'NOT_FOUND',
    when: 'A country is unknown or unpublished, or a version is not ready.',
  },
  {
    status: '410',
    code: 'VERSION_FILE_MISSING',
    when: 'A ready download row has no file on disk.',
  },
  {
    status: '429',
    code: 'RATE_LIMITED',
    when: 'The public request limit was reached; wait for Retry-After.',
  },
  { status: '500', code: 'INTERNAL_ERROR', when: 'An unexpected server error occurred.' },
  { status: '503', code: 'DB_UNAVAILABLE', when: 'The database is temporarily unavailable.' },
] as const;

const ERROR_EXAMPLE = JSON.stringify(
  {
    error: {
      code: 'NOT_FOUND',
      message: 'The requested public country does not exist.',
      requestId: '9f1c2d1e-4b7a-4c2f-9e3a-1a2b3c4d5e6f',
    },
  },
  null,
  2,
);

/** Copies one displayed command and reports clipboard permission failures without hiding the text. */
async function copyCommand(id: string, command: string): Promise<void> {
  copiedExample.value = null;
  failedExample.value = null;
  copiedReset.stop();

  try {
    if (typeof navigator.clipboard?.writeText !== 'function')
      throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(command);
    copiedExample.value = id;
    copiedReset.start();
  } catch {
    failedExample.value = id;
  }
}

/** Produces a same-origin shell command with every dynamic argument kept inside quotes. */
function curlCommand(path: string, outputFile?: string): string {
  const url = new URL(path, apiOrigin).href;
  const output = outputFile === undefined ? '' : ` --output ${shellQuote(outputFile)}`;
  return `curl --fail --show-error --location${output} ${shellQuote(url)}`;
}

/** Quotes one POSIX-shell argument. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const API_ENDPOINTS: readonly ApiEndpoint[] = [
  {
    id: 'countries',
    title: 'List published countries',
    path: '/_public/api/countries',
    curlPath: '/_public/api/countries?page=1&limit=25',
    description:
      'Search the public catalog. Responses contain only published countries with at least one ready version.',
    parameters: [
      '`q`: partial country name or ISO code.',
      '`continent`: exact source parent id, such as `europe`.',
      '`page`, `limit`: decimal pagination; page defaults to 1, limit to 25, and limit is clamped to 100.',
      '`sort`: `name`, `size`, or `updated`.',
    ],
    notes: [
      'Unknown query keys are rejected. Unpublished countries are never listed.',
      '`name` sorts A–Z; `size` sorts the newest ready extract largest first; `updated` sorts by data timestamp newest first. Ties are stable.',
      '`updatedAt` is the newest ready version data timestamp (or `null` when unknown); `sizeBytes` is that version size.',
    ],
    responseExample: JSON.stringify(
      {
        data: [
          {
            slug: 'finland',
            name: 'Finland',
            continent: 'europe',
            iso: ['FI'],
            newestVersion: '261023',
            sizeBytes: 773465008,
            updatedAt: '2026-10-22T20:19:04.000Z',
            downloadUrl: '/_public/api/countries/finland/download?version=latest',
          },
        ],
        meta: { page: 1, limit: 25, total: 1, totalPages: 1 },
        license: {
          name: 'ODbL 1.0',
          attribution: '© OpenStreetMap contributors',
          url: 'https://www.openstreetmap.org/copyright',
        },
      },
      null,
      2,
    ),
  },
  {
    id: 'country',
    title: 'Get country details',
    path: '/_public/api/countries/:slug',
    curlPath: '/_public/api/countries/finland',
    description:
      'Fetch public identity, the newest ready version, and the required data/source attribution.',
    parameters: ['`:slug`: a public country slug, for example `finland`.'],
    notes: [
      'Replace the sample `finland` slug with one returned by the catalog command.',
      'Unknown, malformed, and unpublished slugs share the same 404 response.',
    ],
    responseExample: JSON.stringify(
      {
        slug: 'finland',
        name: 'Finland',
        iso: ['FI'],
        versions: [
          {
            version: '261023',
            dataTimestamp: '2026-10-22T20:19:04.000Z',
            sizeBytes: 773465008,
            checksumMd5: 'd41d8cd98f00b204e9800998ecf8427e',
            downloadUrl: '/_public/api/countries/finland/download?version=261023',
            isLatest: true,
          },
        ],
        latest: '261023',
        updatedAt: '2026-10-22T20:19:04.000Z',
        license: {
          name: 'ODbL 1.0',
          attribution: '© OpenStreetMap contributors',
          url: 'https://www.openstreetmap.org/copyright',
          source: 'Geofabrik GmbH',
          sourceUrl: 'https://download.geofabrik.de',
        },
      },
      null,
      2,
    ),
  },
  {
    id: 'versions',
    title: 'List ready versions',
    path: '/_public/api/countries/:slug/versions',
    curlPath: '/_public/api/countries/finland/versions?page=1&limit=25',
    description:
      'Browse ready releases newest first; use the `isLatest` field to identify the current release.',
    parameters: [
      '`:slug`: a public country slug.',
      '`page`, `limit`: decimal pagination; page defaults to 1, limit to 25, and limit is clamped to 100.',
    ],
    notes: [
      'Replace `finland` with a public slug. Only ready versions are returned; ids and storage paths are omitted.',
      'Versions are ordered newest first by the latest-version timestamp/ready-time rules; `isLatest` marks the current one.',
    ],
    responseExample: JSON.stringify(
      {
        data: [
          {
            version: '261023',
            dataTimestamp: '2026-10-22T20:19:04.000Z',
            sizeBytes: 773465008,
            checksumMd5: 'd41d8cd98f00b204e9800998ecf8427e',
            downloadUrl: '/_public/api/countries/finland/download?version=261023',
            isLatest: true,
          },
        ],
        meta: { page: 1, limit: 25, total: 2, totalPages: 1 },
        license: {
          name: 'ODbL 1.0',
          attribution: '© OpenStreetMap contributors',
          url: 'https://www.openstreetmap.org/copyright',
          source: 'Geofabrik GmbH',
          sourceUrl: 'https://download.geofabrik.de',
        },
      },
      null,
      2,
    ),
  },
  {
    id: 'download',
    title: 'Download a ready version',
    path: '/_public/api/countries/:slug/download?version=latest|<label>',
    curlPath: '/_public/api/countries/finland/download?version=latest',
    outputFile: 'finland-latest.osm.pbf',
    description:
      'Stream one published, ready extract directly to a file; no JSON body is returned.',
    parameters: [
      '`:slug`: a public country slug.',
      '`version`: `latest` (default) or an exact version label.',
    ],
    notes: [
      'Replace `finland` with a public slug. `--fail` makes curl return a failing exit code for HTTP errors.',
      'Single byte ranges, `If-Range`, `If-None-Match`, and `HEAD` are supported; `304` and `HEAD` do not transfer a body. Invalid or multi-range requests fall back to the full `200` response.',
      'The download limit applies when each request starts; an active large transfer is never interrupted. A missing file for a ready version returns `410 VERSION_FILE_MISSING` without exposing its path.',
    ],
    responseNote:
      'The body is the PBF stream. Headers include `Content-Type: application/x-protobuf`, `Content-Length`, `Accept-Ranges`, and an attachment filename. Valid stored MD5 enables `ETag` and `X-Checksum-Md5`; `Last-Modified` describes the file. Explicit version labels use `Cache-Control: public, max-age=31536000, immutable`; `version=latest` uses `no-cache`.',
  },
  {
    id: 'stats',
    title: 'Get public statistics',
    path: '/_public/api/stats',
    curlPath: '/_public/api/stats',
    description:
      'Read anonymous aggregate counts for published maps and completed or interrupted public transfers.',
    parameters: ['No query parameters.'],
    notes: [
      '`countries` counts published countries with a ready version; `totalSizeBytes` sums every ready version in those countries.',
      '`downloads30d` and `totalDownloads` count public body-bearing transfers after the response closes, including interrupted transfers; `HEAD` and `304` are excluded.',
      '`lastPublishedAt` is the newest publication time among visible countries, or `null` when none are published.',
      'The response contains no IP address, IP hash, user-agent, country/version id, or per-user data.',
    ],
    responseExample: JSON.stringify(
      {
        countries: 5,
        totalSizeBytes: 2319000000,
        downloads30d: 128,
        totalDownloads: 1420,
        lastPublishedAt: '2026-10-23T20:20:51.000Z',
      },
      null,
      2,
    ),
  },
];

const endpoints = computed(() =>
  API_ENDPOINTS.map((endpoint) => ({
    ...endpoint,
    command: curlCommand(endpoint.curlPath, endpoint.outputFile),
  })),
);
</script>

<template>
  <section class="mm-public-api-docs" aria-labelledby="public-api-title">
    <header class="mm-public-api-intro">
      <p class="mm-caption mb-1">Public API · anonymous</p>
      <h1 id="public-api-title" class="mm-display">API documentation</h1>
      <p>
        Public JSON endpoints are available without a token at
        <code>{{ apiOrigin }}/_public/api/*</code>. Requests are rate-limited; examples below target
        this mirror and can be copied as shown. Read requests are limited to 60 per IP per minute;
        downloads to 10 per IP per minute. A <code>429 RATE_LIMITED</code> response includes
        <code>Retry-After</code>.
      </p>
    </header>

    <aside class="mm-public-api-note">
      <h2>Quick start</h2>
      <p>
        Start with the catalog command, then replace the sample <code>finland</code> slug with one
        from its response. Byte counts may be numbers or decimal strings when they exceed
        JavaScript's safe integer range.
      </p>
    </aside>

    <nav class="mm-public-api-index" aria-label="Public API endpoints">
      <a v-for="endpoint in endpoints" :key="endpoint.id" :href="`#public-api-${endpoint.id}`">
        {{ endpoint.title }}
      </a>
    </nav>

    <section
      v-for="endpoint in endpoints"
      :id="`public-api-${endpoint.id}`"
      :key="endpoint.id"
      class="mm-public-api-endpoint"
      :aria-labelledby="`public-api-heading-${endpoint.id}`"
    >
      <header class="mm-public-api-endpoint-heading">
        <div>
          <span class="mm-public-api-method">GET</span>
          <code>{{ endpoint.path }}</code>
        </div>
        <h2 :id="`public-api-heading-${endpoint.id}`">{{ endpoint.title }}</h2>
      </header>
      <p>{{ endpoint.description }}</p>

      <section
        class="mm-public-api-subsection"
        :aria-labelledby="`public-api-params-${endpoint.id}`"
      >
        <h3 :id="`public-api-params-${endpoint.id}`">Parameters and behavior</h3>
        <ul>
          <li v-for="parameter in endpoint.parameters" :key="parameter">{{ parameter }}</li>
          <li v-for="note in endpoint.notes" :key="note">{{ note }}</li>
        </ul>
      </section>

      <section class="mm-public-api-subsection" :aria-labelledby="`public-api-curl-${endpoint.id}`">
        <div class="mm-public-api-code-heading">
          <h3 :id="`public-api-curl-${endpoint.id}`">cURL example</h3>
          <button
            class="mm-public-api-copy"
            type="button"
            @click="copyCommand(endpoint.id, endpoint.command)"
          >
            {{ copiedExample === endpoint.id ? 'Copied' : 'Copy command' }}
          </button>
        </div>
        <pre class="mm-public-api-code"><code>{{ endpoint.command }}</code></pre>
        <p
          v-if="copiedExample === endpoint.id || failedExample === endpoint.id"
          class="mm-public-api-copy-status"
          role="status"
          aria-live="polite"
        >
          {{
            copiedExample === endpoint.id
              ? 'Command copied.'
              : 'Clipboard access failed. Select the command above and copy it manually.'
          }}
        </p>
      </section>

      <section
        class="mm-public-api-subsection"
        :aria-labelledby="`public-api-response-${endpoint.id}`"
      >
        <h3 :id="`public-api-response-${endpoint.id}`">
          {{ endpoint.responseExample ? 'Example JSON response' : 'Response' }}
        </h3>
        <p v-if="endpoint.responseNote">{{ endpoint.responseNote }}</p>
        <pre
          v-if="endpoint.responseExample"
          class="mm-public-api-code"
        ><code>{{ endpoint.responseExample }}</code></pre>
      </section>
    </section>

    <section class="mm-public-api-errors" aria-labelledby="public-api-errors-title">
      <h2 id="public-api-errors-title">Errors</h2>
      <p>Every error uses the same JSON envelope and includes a request id for support.</p>
      <pre class="mm-public-api-code"><code>{{ ERROR_EXAMPLE }}</code></pre>
      <div class="mm-public-api-table-wrap">
        <table class="mm-public-api-error-table">
          <caption class="mm-sr-only">
            Common public API error codes
          </caption>
          <thead>
            <tr>
              <th scope="col">HTTP</th>
              <th scope="col">Code</th>
              <th scope="col">When it occurs</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="error in publicErrors" :key="error.code">
              <td data-label="HTTP">{{ error.status }}</td>
              <th scope="row" data-label="Code">
                <code>{{ error.code }}</code>
              </th>
              <td data-label="When it occurs">{{ error.when }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        For <code>429 RATE_LIMITED</code>, wait at least the number of seconds in the
        <code>Retry-After</code> header.
      </p>
    </section>
  </section>
</template>
