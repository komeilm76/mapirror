import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp, parseEnv } from '../../src/index';
import { issueToken } from '../../src/modules/auth/tokens';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();
const BOUNDARY = 'mapirror-import-boundary';
const VALID_PBF_HEADER = Buffer.from([0, 0, 0, 11, 0x0a, 0x09, ...Buffer.from('OSMHeader')]);
type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

interface ImportContext {
  readonly app: FastifyInstance;
  readonly token: string;
  readonly adminId: string;
  readonly countryId: string;
  readonly temporaryDirectory: string;
}

async function withImportApp(
  maxUploadBytes: number,
  run: (context: ImportContext) => Promise<void>,
): Promise<void> {
  await withFreshDatabase(
    async (database, name) => {
      const admin = await database.db
        .insertInto('admins')
        .values({ username: `import-admin-${randomUUID().slice(0, 8)}`, password_hash: 'unused' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const token = await issueToken(database.db, admin.id, { ttlHours: 12 });
      const country = await database.db
        .insertInto('countries')
        .values({ source_id: 'europe/finland', slug: 'finland', name: 'Finland' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const temporaryDirectory = await mkdtemp(join(tmpdir(), 'mapirror-import-api-'));
      const cacheDirectory = await mkdtemp(join(tmpdir(), 'mapirror-import-cache-'));
      const app = await buildApp({
        config: parseEnv({
          DATABASE_URL: dsnFor(name),
          TMP_DIR: temporaryDirectory,
          CACHE_DIR: cacheDirectory,
          MAX_UPLOAD_BYTES: String(maxUploadBytes),
        }),
        database,
      });
      try {
        await run({
          app,
          token: token.token,
          adminId: admin.id,
          countryId: country.id,
          temporaryDirectory,
        });
      } finally {
        await app.close();
        await Promise.all([
          rm(temporaryDirectory, { recursive: true, force: true }),
          rm(cacheDirectory, { recursive: true, force: true }),
        ]);
      }
    },
    { prefix: 'importroute', migrate: true },
  );
}

function multipartRequest(
  context: ImportContext,
  fields: Record<string, string>,
  options: { filename?: string; file?: Buffer; fileFirst?: boolean; mimetype?: string } = {},
): Promise<InjectResponse> {
  const filename = options.filename ?? 'finland.osm.pbf';
  const file = options.file ?? VALID_PBF_HEADER;
  const fieldParts = Object.entries(fields).map(([name, value]) =>
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ),
  );
  const filePart = Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${options.mimetype ?? 'application/octet-stream'}\r\n\r\n`,
    ),
    file,
    Buffer.from('\r\n'),
  ]);
  const body = Buffer.concat([
    ...(options.fileFirst === true ? [filePart, ...fieldParts] : [...fieldParts, filePart]),
    Buffer.from(`--${BOUNDARY}--\r\n`),
  ]);
  return context.app.inject({
    method: 'POST',
    url: '/_admin/api/imports',
    headers: {
      authorization: `Bearer ${context.token}`,
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    },
    payload: body,
  });
}

function code(response: InjectResponse): string {
  return response.json<{ error: { code: string } }>().error.code;
}

const validFields = (countryId: string, version = '261030') => ({ countryId, version });

describe('POST /_admin/api/imports', () => {
  it.skipIf(skipReason !== null)(
    'streams a valid PBF into UUID staging and commits its session and queued job together',
    async () => {
      await withImportApp(1024, async (context) => {
        const response = await multipartRequest(context, validFields(context.countryId), {
          fileFirst: true,
        });
        expect(response.statusCode).toBe(202);
        const body = response.json<{ uploadId: string; jobId: string; version: string }>();
        expect(body).toMatchObject({ version: '261030' });

        const session = await context.app.db.db
          .selectFrom('upload_sessions')
          .selectAll()
          .where('id', '=', body.uploadId)
          .executeTakeFirstOrThrow();
        expect(session).toMatchObject({
          country_id: context.countryId,
          version: '261030',
          original_name: 'finland.osm.pbf',
          size_bytes: String(VALID_PBF_HEADER.byteLength),
          status: 'received',
          job_id: body.jobId,
          created_by: context.adminId,
        });
        expect(session.temp_path).toMatch(/^[\da-f-]{36}\.osm\.pbf$/u);
        await expect(
          readFile(join(context.temporaryDirectory, session.temp_path)),
        ).resolves.toEqual(VALID_PBF_HEADER);
        const job = await context.app.db.db
          .selectFrom('jobs')
          .select(['type', 'status', 'payload'])
          .where('id', '=', body.jobId)
          .executeTakeFirstOrThrow();
        expect(job).toMatchObject({
          type: 'import',
          status: 'queued',
          payload: {
            uploadId: body.uploadId,
            countryId: context.countryId,
            version: '261030',
            replace: false,
          },
        });
        const status = await context.app.inject({
          method: 'GET',
          url: `/_admin/api/imports/${body.uploadId}`,
          headers: { authorization: `Bearer ${context.token}` },
        });
        expect(status.statusCode).toBe(200);
        expect(status.json()).toEqual({
          status: 'received',
          sizeBytes: String(VALID_PBF_HEADER.byteLength),
          checksumMd5: null,
          jobId: body.jobId,
          error: null,
        });

        const canceled = await context.app.inject({
          method: 'POST',
          url: `/_admin/api/jobs/${body.jobId}/cancel`,
          headers: { authorization: `Bearer ${context.token}` },
          payload: {},
        });
        expect(canceled.statusCode).toBe(202);
        expect(canceled.json()).toEqual({
          jobId: body.jobId,
          status: 'canceled',
          accepted: true,
          cancelRequested: true,
        });
        await expect(
          readFile(join(context.temporaryDirectory, session.temp_path)),
        ).rejects.toMatchObject({
          code: 'ENOENT',
        });
        const canceledSession = await context.app.db.db
          .selectFrom('upload_sessions')
          .select('status')
          .where('id', '=', body.uploadId)
          .executeTakeFirstOrThrow();
        expect(canceledSession.status).toBe('failed');
      });
    },
  );

  it.skipIf(skipReason !== null)(
    'maps unsupported extension/media/header to 415, invalid fields to 400, and size overflow to 413',
    async () => {
      await withImportApp(15, async (context) => {
        const extension = await multipartRequest(context, validFields(context.countryId), {
          filename: 'finland.zip',
        });
        expect(extension.statusCode).toBe(415);
        expect(code(extension)).toBe('UNSUPPORTED_FORMAT');

        const mimeType = await multipartRequest(context, validFields(context.countryId), {
          mimetype: 'text/plain',
        });
        expect(mimeType.statusCode).toBe(415);
        expect(code(mimeType)).toBe('UNSUPPORTED_FORMAT');

        const header = await multipartRequest(context, validFields(context.countryId), {
          file: Buffer.from('not a pbf'),
        });
        expect(header.statusCode).toBe(415);
        expect(code(header)).toBe('UNSUPPORTED_FORMAT');

        const invalidVersion = await multipartRequest(
          context,
          validFields(context.countryId, 'bad/version'),
        );
        expect(invalidVersion.statusCode).toBe(400);
        expect(code(invalidVersion)).toBe('VALIDATION_ERROR');

        const missingVersion = await multipartRequest(context, { countryId: context.countryId });
        expect(missingVersion.statusCode).toBe(400);
        expect(code(missingVersion)).toBe('VALIDATION_ERROR');

        const oversized = await multipartRequest(context, validFields(context.countryId), {
          file: Buffer.concat([VALID_PBF_HEADER, Buffer.from([1, 2])]),
        });
        expect(oversized.statusCode).toBe(413);
        expect(code(oversized)).toBe('FILE_TOO_LARGE');

        expect(
          await context.app.db.db.selectFrom('upload_sessions').select('id').execute(),
        ).toHaveLength(0);
        expect(
          await context.app.db.db
            .selectFrom('jobs')
            .select('id')
            .where('type', '=', 'import')
            .execute(),
        ).toHaveLength(0);
      });
    },
  );

  it.skipIf(skipReason !== null)(
    'rejects a duplicate country/version before accepting a second job',
    async () => {
      await withImportApp(1024, async (context) => {
        const first = await multipartRequest(context, validFields(context.countryId));
        expect(first.statusCode).toBe(202);
        const duplicate = await multipartRequest(context, validFields(context.countryId));
        expect(duplicate.statusCode).toBe(409);
        expect(code(duplicate)).toBe('VERSION_DUPLICATE');
        expect(
          await context.app.db.db.selectFrom('upload_sessions').select('id').execute(),
        ).toHaveLength(1);
      });
    },
  );
});
