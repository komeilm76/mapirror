#!/usr/bin/env bun
/** Measure a multi-gigabyte public download and sample API/nginx container memory (`P6-PERF-01`). */

const TARGET_BYTES = 3_000_000_000;
const MEMORY_GROWTH_LIMIT_BYTES = 64 * 1024 * 1024;
const MEMORY_SAMPLE_INTERVAL_MS = 1_000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1_000;

type Service = 'api' | 'web';

/** Parsed `docker stats --format '{{.MemUsage}}'` output. */
export interface DockerMemoryUsage {
  readonly usedBytes: number;
  readonly limitBytes: number;
}

/** One memory sample for both containers. */
export interface ContainerMemorySample {
  readonly elapsedSeconds: number;
  readonly apiBytes: number;
  readonly webBytes: number;
}

/** Parses Docker's human-readable memory usage and limit pair into bytes. */
export function parseDockerMemoryUsage(value: string): DockerMemoryUsage {
  const [usage, limit, ...extra] = value.split('/').map((part) => part.trim());
  if (usage === undefined || limit === undefined || extra.length > 0) {
    throw new Error('Docker returned an invalid memory usage pair.');
  }
  return { usedBytes: parseByteQuantity(usage), limitBytes: parseByteQuantity(limit) };
}

/** Parses Docker's supported byte units, including decimal and binary prefixes. */
function parseByteQuantity(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB|TB|TiB)$/u.exec(value);
  if (match === null) throw new Error('Docker returned an unrecognized memory unit.');
  const amount = Number(match[1]);
  const multiplier = BYTE_MULTIPLIERS[match[2] as keyof typeof BYTE_MULTIPLIERS];
  const bytes = amount * multiplier;
  if (!Number.isFinite(bytes) || bytes < 0)
    throw new Error('Docker returned an invalid memory value.');
  return Math.round(bytes);
}

const BYTE_MULTIPLIERS = {
  B: 1,
  kB: 1_000,
  KB: 1_000,
  KiB: 1_024,
  MB: 1_000_000,
  MiB: 1_048_576,
  GB: 1_000_000_000,
  GiB: 1_073_741_824,
  TB: 1_000_000_000_000,
  TiB: 1_099_511_627_776,
} as const;

/** Builds the exact-version public download URL used by the measurement. */
export function buildPublicDownloadUrl(baseUrl: string, countrySlug: string, version: string): URL {
  const base = new URL(baseUrl);
  if (
    (base.protocol !== 'http:' && base.protocol !== 'https:') ||
    base.username !== '' ||
    base.password !== '' ||
    base.search !== '' ||
    base.hash !== ''
  ) {
    throw new Error('BASE_URL must be an HTTP(S) origin without credentials, query, or fragment.');
  }
  const url = new URL(`/_public/api/countries/${encodeURIComponent(countrySlug)}/download`, base);
  url.searchParams.set('version', version);
  return url;
}

/** Parses and validates the Content-Range returned for the requested benchmark window. */
export function parseContentRange(value: string | null): {
  readonly endByte: number;
  readonly totalBytes: number;
} {
  const match = value === null ? null : /^bytes 0-(\d+)\/(\d+)$/iu.exec(value);
  if (match === null) throw new Error('The server did not honor the requested byte range.');
  const endByte = Number(match[1]);
  const totalBytes = Number(match[2]);
  if (
    !Number.isSafeInteger(endByte) ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= endByte
  ) {
    throw new Error('The server returned an invalid Content-Range.');
  }
  return { endByte, totalBytes };
}

/** Runs a child process without a shell and returns its captured output. */
async function runCommand(command: readonly string[]): Promise<string> {
  const child = Bun.spawn({ cmd: [...command], stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `Command ${command[0] ?? 'unknown'} exited with ${exitCode}.`);
  }
  return stdout.trim();
}

/** Finds the current Compose container for a service. */
async function composeContainerId(service: Service): Promise<string> {
  const containerId = await runCommand(['docker', 'compose', 'ps', '-q', service]);
  if (containerId === '') {
    throw new Error(`No running Docker Compose ${service} container was found.`);
  }
  return containerId;
}

/** Reads one container's current memory usage from Docker. */
async function readContainerMemory(containerId: string): Promise<number> {
  const value = await runCommand([
    'docker',
    'stats',
    '--no-stream',
    '--format',
    '{{.MemUsage}}',
    containerId,
  ]);
  return parseDockerMemoryUsage(value).usedBytes;
}

/** Reads API and nginx memory concurrently. */
async function readMemorySample(
  containerIds: Readonly<Record<Service, string>>,
  elapsedSeconds: number,
): Promise<ContainerMemorySample> {
  const [apiBytes, webBytes] = await Promise.all([
    readContainerMemory(containerIds.api),
    readContainerMemory(containerIds.web),
  ]);
  return { elapsedSeconds, apiBytes, webBytes };
}

/** Waits for the next periodic memory sample. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Requires a non-empty environment variable without echoing its value on failure. */
function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') throw new Error(`${name} must be set.`);
  return value;
}

/** Formats bytes using decimal megabytes, matching the task's GB wording. */
function toMegabytesPerSecond(bytes: number, seconds: number): number {
  return Number((bytes / seconds / 1_000_000).toFixed(2));
}

/** Executes the 3 GB transfer and prints a structured, secret-free measurement report. */
async function main(): Promise<void> {
  const baseUrl = process.env.BASE_URL?.trim() || 'http://127.0.0.1:8080';
  const countrySlug = requiredEnvironment('COUNTRY_SLUG');
  const version = requiredEnvironment('VERSION');
  const url = buildPublicDownloadUrl(baseUrl, countrySlug, version);
  const containerIds: Record<Service, string> = {
    api: await composeContainerId('api'),
    web: await composeContainerId('web'),
  };

  const requestOptions: RequestInit = {
    headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' },
    redirect: 'error',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  };
  const head = await fetch(url, { ...requestOptions, method: 'HEAD' });
  if (head.status !== 200) {
    await head.body?.cancel();
    throw new Error(`HEAD preflight returned HTTP ${head.status}, expected 200.`);
  }
  const resourceBytes = Number(head.headers.get('content-length'));
  if (!Number.isSafeInteger(resourceBytes) || resourceBytes < TARGET_BYTES) {
    throw new Error(
      `The selected published version must be at least ${TARGET_BYTES.toLocaleString()} bytes; ` +
        'choose a larger cached artifact (for example, Europe).',
    );
  }

  const baseline = await readMemorySample(containerIds, 0);
  const samples: ContainerMemorySample[] = [baseline];
  const startedAt = performance.now();
  let samplingError: unknown;
  let stopSampling = false;
  const sampler = (async (): Promise<void> => {
    while (!stopSampling) {
      await delay(MEMORY_SAMPLE_INTERVAL_MS);
      if (stopSampling) return;
      try {
        samples.push(await readMemorySample(containerIds, (performance.now() - startedAt) / 1_000));
      } catch (error) {
        samplingError = error;
        return;
      }
    }
  })();

  let bytesReceived = 0;
  let elapsedSeconds = 0;
  try {
    const response = await fetch(url, {
      ...requestOptions,
      headers: {
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        Range: `bytes=0-${TARGET_BYTES - 1}`,
      },
    });
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new Error(`Range request returned HTTP ${response.status}, expected 206.`);
    }
    const { endByte, totalBytes } = parseContentRange(response.headers.get('content-range'));
    const contentLength = Number(response.headers.get('content-length'));
    if (
      endByte !== TARGET_BYTES - 1 ||
      totalBytes !== resourceBytes ||
      contentLength !== TARGET_BYTES ||
      response.headers.get('content-encoding') !== null
    ) {
      await response.body?.cancel();
      throw new Error('The server returned inconsistent range, size, or encoding headers.');
    }
    if (response.body === null) throw new Error('The download response has no body.');
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      bytesReceived += chunk.byteLength;
    }
    elapsedSeconds = (performance.now() - startedAt) / 1_000;
    if (bytesReceived !== TARGET_BYTES) {
      throw new Error(
        `The streamed response contained ${bytesReceived} bytes, not ${TARGET_BYTES}.`,
      );
    }
  } finally {
    stopSampling = true;
    await sampler;
    samples.push(await readMemorySample(containerIds, (performance.now() - startedAt) / 1_000));
  }
  if (samplingError !== undefined) {
    throw new Error(
      `Docker memory sampling failed: ${samplingError instanceof Error ? samplingError.message : 'unknown error'}`,
    );
  }

  const apiBaseline = baseline.apiBytes;
  const webBaseline = baseline.webBytes;
  const apiPeakGrowth = Math.max(...samples.map((sample) => sample.apiBytes - apiBaseline), 0);
  const webPeakGrowth = Math.max(...samples.map((sample) => sample.webBytes - webBaseline), 0);
  const report = {
    format: 'mapirror-p6-perf-01',
    measuredAt: new Date().toISOString(),
    countrySlug,
    version,
    resourceBytes,
    bytesTransferred: bytesReceived,
    elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
    throughputMBps: toMegabytesPerSecond(bytesReceived, elapsedSeconds),
    memorySampleCount: samples.length,
    sufficientSamples: samples.length >= 3,
    memorySampleIntervalMs: MEMORY_SAMPLE_INTERVAL_MS,
    memorySamples: samples.map((sample) => ({
      elapsedSeconds: Number(sample.elapsedSeconds.toFixed(3)),
      apiBytes: sample.apiBytes,
      nginxBytes: sample.webBytes,
    })),
    memoryGrowthLimitBytes: MEMORY_GROWTH_LIMIT_BYTES,
    apiMemory: {
      baselineBytes: apiBaseline,
      peakGrowthBytes: apiPeakGrowth,
      finalBytes: samples.at(-1)?.apiBytes ?? apiBaseline,
    },
    nginxMemory: {
      baselineBytes: webBaseline,
      peakGrowthBytes: webPeakGrowth,
      finalBytes: samples.at(-1)?.webBytes ?? webBaseline,
    },
  };
  const passed =
    samples.length >= 3 &&
    apiPeakGrowth <= MEMORY_GROWTH_LIMIT_BYTES &&
    webPeakGrowth <= MEMORY_GROWTH_LIMIT_BYTES;
  process.stdout.write(`${JSON.stringify({ ...report, passed }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      `P6-PERF-01 failed: ${error instanceof Error ? error.message : 'unexpected error'}`,
    );
    process.exitCode = 1;
  }
}
