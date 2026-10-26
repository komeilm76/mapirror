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

  it('has a place for the SPA fallback', () => {
    // `P1-DOCK-03` turns this into `try_files $uri /index.html`. Asserted here so that the file it grows still has the
    // block, and the next task edits a line rather than adding one.
    expect(directives().filter((line) => line.startsWith('try_files '))).toHaveLength(1);
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
        expect(line.endsWith(';'), `directive without a semicolon: ${line}`).toBe(true);
        expect(line.split(';')).toHaveLength(2);
      }
      expect(depth, `unbalanced braces at: ${line}`).toBeGreaterThan(-1);
    }
    expect(depth, 'every block must be closed').toBe(0);
  });
});
