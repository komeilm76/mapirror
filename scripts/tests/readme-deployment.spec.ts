import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

interface ComposeService {
  readonly ports?: readonly string[];
}

interface ComposeDocument {
  readonly services?: Readonly<Record<string, ComposeService>>;
}

describe('README quick start and Ubuntu deployment runbook', () => {
  const readme = read('README.md');
  const deployment = read('docs/12-deployment.md');

  it('uses current project status and links only to existing repository files', () => {
    const packageJson = JSON.parse(read('package.json')) as { readonly version: string };
    expect(readme).toContain('Phase 6 — hardening & release');
    expect(readme).toContain(packageJson.version);
    expect(readme).not.toContain('There is no running application yet');
    expect(readme).not.toContain('when Phase 1 lands');

    for (const match of readme.matchAll(/\]\(([^)]+)\)/gu)) {
      const target = match[1];
      if (target === undefined || /^(?:https?:|mailto:|#)/u.test(target)) continue;
      const path = decodeURIComponent(target.split('#', 1)[0] ?? '');
      expect(existsSync(resolve(ROOT, path)), `README link target ${target}`).toBe(true);
    }
  });

  it('shows the Compose quick start with all required secrets and the actual exposed port', () => {
    const quickStart = readme.split('## Quick start (Docker Compose)')[1]?.split('\n## ')[0] ?? '';
    const envTemplate = read('.env.example');
    const compose = parse(read('compose.yaml')) as ComposeDocument;

    expect(quickStart).toContain('cp .env.example .env');
    expect(quickStart).toContain('chmod 600 .env');
    expect(quickStart).toContain('POSTGRES_PASSWORD');
    expect(quickStart).toContain('ADMIN_PASSWORD');
    expect(quickStart).toContain('at least 12 characters');
    expect(quickStart).toContain('docker compose up -d --build');
    expect(quickStart).toContain('curl -fsS http://localhost:8080/readyz');
    expect(quickStart).toContain('http://localhost:8080/_auth/login');
    expect(envTemplate).toMatch(/^POSTGRES_PASSWORD=/mu);
    expect(envTemplate).toMatch(/^ADMIN_PASSWORD=/mu);
    expect(compose.services?.web?.ports).toContain('127.0.0.1:8080:8080');
  });

  it('has explicit Ubuntu prerequisites, a real checkout command, and safe firewall alternatives', () => {
    const prerequisites = deployment.slice(
      deployment.indexOf('## 1. Server prerequisites'),
      deployment.indexOf('## 2. Install MapMirror'),
    );
    const installation = deployment.slice(
      deployment.indexOf('## 2. Install MapMirror'),
      deployment.indexOf('### What `compose.yaml` starts'),
    );

    expect(prerequisites).toContain(
      'sudo apt install -y ca-certificates curl git gpg openssl ufw unzip',
    );
    expect(prerequisites).toContain('gpg --dearmor');
    expect(prerequisites.indexOf('sudo ufw allow OpenSSH')).toBeLessThan(
      prerequisites.indexOf('sudo ufw enable'),
    );
    expect(prerequisites).toContain('sudo ufw allow 80/tcp');
    expect(prerequisites).toContain('sudo ufw allow 443/tcp');
    expect(prerequisites).toContain('Docker-published ports may bypass UFW');
    expect(prerequisites).toContain("server's **private interface address**");
    expect(prerequisites).not.toContain('ufw allow from <proxy-ip>');

    expect(installation).toContain('git clone --branch arena/5a1becdd-mapirror --single-branch');
    expect(installation).toContain('https://github.com/komeilm76/mapirror.git /opt/mapirror');
    expect(installation).not.toContain('<repo-url>');
    expect(installation).toContain('cp .env.example .env');
    expect(installation).toContain('chmod 600 .env');
    expect(installation).toContain('docker compose up -d --build');
    expect(installation).toContain('Bun is **not required on the Docker host**');
    expect(installation).toContain('curl -fsSL https://bun.com/install | bash');
    expect(installation).toContain('source ~/.bashrc');
    expect(installation).toContain('bun --version');
    expect(installation).toContain('bun install --frozen-lockfile');
    expect(installation).toContain('DATABASE_URL_TEST');
    expect(deployment).toContain('curl -s http://localhost:8080/readyz');
    expect(deployment).toContain('`127.0.0.1:8080:8080`');
    expect(deployment).toContain('Docker-published ports may bypass UFW');
    expect(deployment).toContain('https://maps.example.com/_auth/login');
  });
});
