import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * `docker/nginx.conf`, read as a document (task `P1-DOCK-02`).
 *
 * nginx is not in the test environment, so the cases below cannot ask it whether the syntax is right. They ask everything
 * that can be asked without it — and the questions are the ones an unprivileged container actually fails on:
 *
 * - **a path nginx cannot write.** The official image's defaults are `/var/run` (pid), `/var/cache/nginx` (temp) and
 *   `/var/log/nginx` (logs), all root-owned. Measured on nginx 1.29.0 as a non-root user:
 *   `mkdir() "/var/cache/nginx/client_temp" failed (13: Permission denied)` — the container dies before serving a byte.
 *   Every path in this file is under `/tmp`, or a stream.
 * - **a port it cannot bind.** Below 1024 needs `CAP_NET_BIND_SERVICE`; the image grants nothing.
 * - **a `user` directive.** It is only meaningful when the master process is root, and it makes a non-root start emit a
 *   warning on every boot.
 * - **a missing semicolon.** The one syntax error a text check can catch, and the one most likely to be introduced by a
 *   later edit. See `braces and semicolons` below.
 *
 * What was *not* assumed: this file was also run for real. A locally built nginx 1.29.0 (`--without-pcre`,
 * `--without-http_gzip_module`) accepted it with `nginx -t`, started as a non-root user, and served the built bundle —
 * `index.html` as `text/html`, the JS as `application/javascript`, the CSS as `text/css`, the font as `font/woff2`, and no
 * version in the `Server` header (pass 39, `docs/16-changelog.md`).
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The file these cases describe. */
const CONFIG = 'docker/nginx.conf';

/** Its contents. */
const text = readFileSync(join(ROOT, CONFIG), 'utf8');

/**
 * The file's lines without comments and blank lines.
 *
 * @returns Trimmed directive lines.
 */
function directives(): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * The value of the first directive whose name matches.
 *
 * @param name - Directive name, e.g. `pid`.
 * @returns The value with its semicolon removed, or `undefined`.
 */
function directive(name: string): string | undefined {
  const pattern = new RegExp(`^${name}\\s+(.+);$`, 'u');
  for (const line of directives()) {
    const match = pattern.exec(line);
    if (match !== null) return match[1]?.trim();
  }
  return undefined;
}

describe('the web server config', () => {
  it('exists and is the whole configuration', () => {
    expect(existsSync(join(ROOT, CONFIG))).toBe(true);
    // An `http` block with one `server` in it: the image copies this file over `/etc/nginx/nginx.conf`, so anything not
    // written here is whatever the base image happened to ship.
    expect(directives()).toContain('events {');
    expect(directives()).toContain('http {');
    expect(directives().filter((line) => line.startsWith('server {'))).toHaveLength(1);
    expect(text).toContain('include /etc/nginx/mime.types;');
    expect(directive('worker_processes')).toBe('auto');
  });

  it('writes nothing to a directory belonging to root', () => {
    // The pid, the request-body temp files and the proxy buffers are the three things nginx creates at startup.
    expect(directive('pid')).toBe('/tmp/nginx.pid');
    for (const name of [
      'client_body_temp_path',
      'proxy_temp_path',
      'fastcgi_temp_path',
      'uwsgi_temp_path',
      'scgi_temp_path',
    ]) {
      const value = directive(name);
      expect(value, `${name} must be set`).toBeDefined();
      expect(value, `${name} must be writable by uid 101`).toMatch(/^\/tmp\//u);
    }
    // And nothing anywhere in the file points at the three root-owned trees — a `location` or a log path added later
    // would otherwise reintroduce the failure in a place these cases do not name.
    expect(directives().filter((line) => line.includes('/var/'))).toEqual([]);
  });

  it('logs to the process streams a container collects', () => {
    // `stderr` is nginx's own token for fd 2: no path is opened, which also survives a stderr that cannot be opened.
    expect(directive('error_log')).toBe('stderr warn');
    expect(directive('access_log')).toBe('/dev/stdout');
    // A file inside the container is a file nobody reads.
    expect(directives().filter((line) => /^(error|access)_log\s+\S*\.log/u.test(line))).toEqual([]);
  });

  it('listens on a port an unprivileged process can bind', () => {
    const listen = directive('listen');

    expect(listen).toBeDefined();
    expect(Number(listen)).toBeGreaterThan(1023);
    // `P1-DOCK-02`'s image declares this port; `web-dockerfile.spec.ts` holds the two files to the same number.
    expect(listen).toBe('8080');
  });

  it('serves the bundle and hides what it is running', () => {
    expect(directive('root')).toBe('/usr/share/nginx/html');
    expect(directive('index')).toBe('index.html');
    // The server version in the `Server` header and in every error page tells a stranger which nginx to point an exploit
    // at. Measured with the probe: the header is `Server: nginx`, with no `/1.29.0`.
    expect(directive('server_tokens')).toBe('off');
    expect(directive('sendfile')).toBe('on');
  });

  it('leaves the two things only root may set alone', () => {
    // `user` is a no-op for a non-root master and makes it warn on every start.
    expect(directives().filter((line) => line.startsWith('user '))).toEqual([]);
    // `daemon off` is the `CMD`'s argument (`-g "daemon off;"`); a second copy here would be two places to change.
    expect(directives().filter((line) => line.startsWith('daemon '))).toEqual([]);
  });

  it('has an SPA fallback, and a catch-all that does not use it', () => {
    // `P1-DOCK-03` fills in the map; what belongs here is the shape. The SPA fallback exists (a reload on a deep link must
    // not 404), and the catch-all does **not** fall back to the shell (a typo in an asset name must stay a 404, or the
    // browser reports a syntax error in a script named `index.html`). `nginx-routing.spec.ts` asserts which location has
    // which.
    const fallbacks = directives().filter((line) => line.startsWith('try_files '));
    expect(fallbacks).toContain('try_files $uri /index.html;');
    expect(fallbacks).toContain('try_files $uri =404;');
  });

  it('braces and semicolons', () => {
    // The one syntax check a text file can make: a directive ends in `;`, a block opens with `{` and closes with `}`.
    // A dropped semicolon is accepted by this parser and refused by nginx — but it is refused here too, which is the
    // difference between a failing test and a container that will not start.
    let depth = 0;
    for (const line of directives()) {
      if (line === '}' || line.endsWith(' }')) {
        depth -= 1;
      } else if (line.endsWith('{')) {
        depth += 1;
      } else {
        // A quoted value may contain a semicolon of its own (`https "; upgrade-insecure-requests";`), so the count is taken
        // with quoted runs removed — otherwise a correct line looks like two directives.
        const unquoted = line.replace(/"[^"]*"/gu, '""');
        expect(line.endsWith(';'), `directive without a semicolon: ${line}`).toBe(true);
        expect(unquoted.split(';')).toHaveLength(2);
      }
      expect(depth, `unbalanced braces at: ${line}`).toBeGreaterThan(-1);
    }
    expect(depth, 'every block must be closed').toBe(0);
  });
});

/**
 * The tuning `P1-DOCK-03` is about: how a multi-gigabyte import and a 773 MB download get through a proxy that also has to
 * compress JSON, and what the API is told about the client on the other side.
 *
 * Every number here was measured against a real nginx 1.29.0 with this file (pass 40), and two of the cases are recorded
 * with the failure they replace:
 *
 * - **`proxy_buffering off` — the usual advice — costs compression.** Measured: a 10 kB JSON list came back with no
 *   `Content-Encoding` while buffering was off, and with `Content-Encoding: gzip` the moment it was back on. What made
 *   buffering dangerous was its temp file, and `proxy_max_temp_file_size 0` removes exactly that: 200 MB through this
 *   proxy left the worker's RSS unchanged at 2.7 MB and wrote **zero** files to `/tmp/proxy_temp`.
 * - **`proxy_set_header X-Forwarded-Proto $scheme` would downgrade.** `$scheme` on this hop is always `http`; the API's idea
 *   of the browser's scheme would be wrong behind the TLS proxy. The value is passed through instead.
 */
describe('the proxy tuning', () => {
  it('streams an upload instead of spooling it', () => {
    // DOCK-4: without this, nginx writes up to 8 GiB to its own disk before the API sees the first byte — double the disk
    // and a progress bar that moves only after the upload finished.
    expect(directive('proxy_request_buffering')).toBe('off');
  });

  it('streams a download without giving up compression', () => {
    // `proxy_buffering on` plus no temp file: in-memory buffering is what lets nginx gzip a proxied response, and a zero
    // temp-file size is what keeps a 773 MB `.osm.pbf` off the disk and out of memory (it is passed through with
    // backpressure once the 32 kB of buffers are full).
    expect(directive('proxy_buffering')).toBe('on');
    expect(directive('proxy_max_temp_file_size')).toBe('0');
    // The trap this replaces, kept out of the file by name: with buffering off, nginx cannot compress what it forwards.
    expect(directive('proxy_request_buffering')).not.toBe('on');
  });

  it('waits long enough for a large file, and not long enough to hang on a dead API', () => {
    // 60 s of silence is the default, and a slow client reading 773 MB over a home connection is silent for longer than
    // that. A connection to an API that is not there should fail in seconds, not a minute.
    expect(directive('proxy_read_timeout')).toBe('3600s');
    expect(directive('proxy_send_timeout')).toBe('3600s');
    expect(directive('proxy_connect_timeout')).toBe('5s');
  });

  it('accepts an import as large as the API does, plus headroom', () => {
    // The API's own `413` is the one the SPA can render (`MAX_UPLOAD_BYTES`, default 8 GiB). An nginx `413` would answer
    // with an HTML page instead of the error envelope, so the ceiling here has to be *above* the API's.
    const limit = directive('client_max_body_size') ?? '';
    const gib = Number(/^(\d+)g$/u.test(limit) ? /^(\d+)g$/u.exec(limit)?.[1] : Number.NaN);

    expect(limit).toMatch(/^\d+g$/u);
    expect(gib * 1024 ** 3).toBeGreaterThan(8 * 1024 ** 3);
  });

  it('tells the API who the client is, and over which scheme', () => {
    // The rate limiter keys on this address (`client-ip.ts`); `$proxy_add_x_forwarded_for` appends rather than replaces, so
    // an outer proxy's chain survives. `$host` is the browser's host name, which is what a link built by the API should say.
    expect(directive('proxy_set_header X-Real-IP')).toBe('$remote_addr');
    expect(directive('proxy_set_header X-Forwarded-For')).toBe('$proxy_add_x_forwarded_for');
    expect(directive('proxy_set_header X-Forwarded-Host')).toBe('$host');
    expect(directive('proxy_set_header Host')).toBe('$host');
    // Passed through, never `$scheme`: this hop is plain http, and the browser's is not (measured, pass 40 — `$scheme` would
    // tell the API `http` on a site served over https).
    expect(directive('proxy_set_header X-Forwarded-Proto')).toBe('$http_x_forwarded_proto');
    expect(text).not.toMatch(/X-Forwarded-Proto\s+\$scheme/u);
  });

  it('speaks HTTP/1.1 to the API, with a chunked body allowed through', () => {
    // HTTP/1.0 (the default) cannot carry a chunked request body, so a streamed import would be collected first — the
    // opposite of `proxy_request_buffering off`. An empty `Connection` header is what stops nginx sending `close`.
    expect(directive('proxy_http_version')).toBe('1.1');
    expect(text).toContain('proxy_set_header Connection "";');
  });

  it('compresses the three text types the SPA downloads, and nothing already compressed', () => {
    // The bundle: 435 kB of JavaScript and 113 kB of CSS, 145 kB and 17 kB gzipped.
    expect(directive('gzip')).toBe('on');
    expect(directive('gzip_vary')).toBe('on');
    expect(directive('gzip_proxied')).toBe('any');
    const types = directive('gzip_types') ?? '';

    for (const type of ['application/javascript', 'application/json', 'text/css']) {
      expect(types, `${type} must be compressed`).toContain(type);
    }
    // A `.osm.pbf` is compressed already; gzipping a gigabyte of it would burn CPU for a smaller file than the source.
    expect(types).not.toContain('protobuf');
    expect(types).not.toContain('octet-stream');
    // `text/html` is always included by nginx when `gzip` is on, so listing it is noise — but a *minimum* length keeps small
    // answers (an error envelope, a probe) uncompressed, where gzip costs more than it saves.
    expect(Number(directive('gzip_min_length'))).toBeGreaterThanOrEqual(1024);
  });

  it('keeps the probes and the assets out of the request log', () => {
    // A probe answers every ten seconds for ever; an asset request is noise next to the API calls an operator is reading
    // the log for. Both are still errors in the error log (a missing asset is a real signal).
    for (const probe of ['/healthz', '/readyz']) {
      const block = new RegExp(`location = ${probe} \\{[^}]*access_log off;`, 'u');
      expect(text, `${probe} must not be logged`).toMatch(block);
    }
  });
});
