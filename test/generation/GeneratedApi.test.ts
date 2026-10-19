import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProjectGenerator, type GenerationResult } from '../../src/generation/ProjectGenerator.js';
import { SchemaIntrospector } from '../../src/introspection/SchemaIntrospector.js';
import { TENANT_A, TENANT_B, connect, databaseUrl, resetDatabase, testConfig, type Seeded } from '../helpers/database.js';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const outputDir = path.join(repoRoot, 'test/.generated/api');

type ApplicationClass = new (options: { knex: Knex; logger?: boolean }) => { build(): Promise<FastifyInstance> };

/** Generates a project from the sample schema, then drives the generated app over HTTP. */
describe.skipIf(!databaseUrl)('generated API (Postgres)', () => {
  let knex: Knex;
  let seeded: Seeded;
  let result: GenerationResult;
  let app: FastifyInstance;
  let token: (tenantId: string, permissions: string[]) => string;

  const config = testConfig();
  const get = (url: string, auth?: string) =>
    app.inject({ method: 'GET', url, headers: auth ? { authorization: `Bearer ${auth}` } : {} });
  const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload: unknown, auth: string) =>
    app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${auth}` } });

  beforeAll(async () => {
    knex = connect();
    seeded = await resetDatabase(knex);
    await rm(outputDir, { recursive: true, force: true });
    const model = await new SchemaIntrospector(knex, config).introspect();
    result = await new ProjectGenerator(config).generate(model, outputDir);
    await symlink(path.join(repoRoot, 'node_modules'), path.join(outputDir, 'node_modules'));

    process.env.JWT_SECRET = 'test-secret-that-is-long-enough';
    const { Application } = (await import(path.join(outputDir, 'src/app.ts'))) as { Application: ApplicationClass };
    app = await new Application({ knex, logger: false }).build();
    await app.ready();
    token = (tenantId, permissions) =>
      (app as unknown as { jwt: { sign(payload: object): string } }).jwt.sign({ sub: 'u1', tenant_id: tenantId, permissions });
  }, 60_000);

  beforeEach(async () => {
    seeded = await resetDatabase(knex);
  });

  afterAll(async () => {
    await app?.close();
    await knex?.destroy();
  });

  describe('generated files', () => {
    it('writes modules, core, wiring and RLS policies', () => {
      const paths = result.files.map((file) => file.path);
      expect(paths).toEqual(
        expect.arrayContaining([
          'src/core/ItemsService.ts',
          'src/core/query/FilterApplier.ts',
          'src/modules/company/CompanyRoutes.ts',
          'src/modules/company/company.schemas.ts',
          'src/modules/company/company.types.ts',
          'src/modules/company/CompanyController.ts',
          'src/modules/project_members/ProjectMembersService.ts',
          'src/modules/index.ts',
          'src/schema.ts',
          'src/permissions.ts',
          'src/app.ts',
          'src/auth/AuthHook.ts',
          'sql/rls.sql',
          'package.json',
        ]),
      );
      expect(paths.some((p) => p.includes('knex_migrations'))).toBe(false);
      expect(result.warnings).toEqual([expect.stringContaining('audit_log')]);
    });

    it('type-checks', async () => {
      await expect(run(path.join(repoRoot, 'node_modules/.bin/tsc'), ['--noEmit', '-p', outputDir])).resolves.toBeTruthy();
    }, 60_000);

    it('declares every package its code imports, with types', async () => {
      const pkg = JSON.parse(await readFile(path.join(outputDir, 'package.json'), 'utf8'));
      const declared = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]);
      const files = (await readdir(outputDir, { recursive: true }))
        .filter((file) => file.endsWith('.ts') && !file.startsWith('node_modules'));
      const imported = new Set<string>();
      for (const file of files) {
        for (const [, specifier] of (await readFile(path.join(outputDir, file), 'utf8')).matchAll(/from '([^'.][^']*)'/g)) {
          if (specifier!.startsWith('node:')) continue;
          imported.add(specifier!.startsWith('@') ? specifier!.split('/').slice(0, 2).join('/') : specifier!.split('/')[0]!);
        }
      }
      expect(imported.size).toBeGreaterThan(0);
      for (const name of imported) {
        expect(declared, `package.json is missing "${name}"`).toContain(name);
        const own = JSON.parse(await readFile(path.join(repoRoot, 'node_modules', name, 'package.json'), 'utf8'));
        const bundlesTypes = Boolean(own.types ?? own.typings) || existsSync(path.join(repoRoot, 'node_modules', name, 'index.d.ts'));
        if (!bundlesTypes) expect(declared, `package.json is missing "@types/${name}"`).toContain(`@types/${name}`);
      }
    });

    it('signs development tokens the API accepts', async () => {
      const tokenScript = path.join(outputDir, 'scripts/token.ts');
      await run(path.join(repoRoot, 'node_modules/.bin/tsc'), [
        '--noEmit', '--ignoreConfig', '--strict', '--skipLibCheck', '--types', 'node',
        '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', tokenScript,
      ]);
      const { stdout } = await run(
        path.join(repoRoot, 'node_modules/.bin/tsx'),
        [tokenScript, '--tenant', TENANT_A, '--permissions', 'read:company'],
        { cwd: outputDir, env: { ...process.env, JWT_SECRET: process.env.JWT_SECRET } },
      );
      const response = await get('/items/company?fields=name', stdout.trim());
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual([{ name: 'Acme' }, { name: 'Globex' }]);
      expect((await send('POST', '/items/company', { name: 'X' }, stdout.trim())).statusCode).toBe(403);
    }, 60_000);

    it('lists every permission', async () => {
      const permissions = await readFile(path.join(outputDir, 'src/permissions.ts'), 'utf8');
      expect(permissions).toContain('"create:company"');
      expect(permissions).toContain('"read:audit_log"');
      expect(permissions).not.toContain('"create:audit_log"');
    });

    it('rewrites generated files but keeps files you own on the next run', async () => {
      const controller = path.join(outputDir, 'src/modules/company/CompanyController.ts');
      await writeFile(controller, `${await readFile(controller, 'utf8')}\n// my change\n`);
      const model = await new SchemaIntrospector(knex, config).introspect();
      const again = await new ProjectGenerator(config).generate(model, outputDir);
      const status = (file: string) => again.files.find((f) => f.path === file)?.status;

      expect(status('src/modules/company/CompanyController.ts')).toBe('kept');
      expect(status('src/modules/company/CompanyRoutes.ts')).toBe('unchanged');
      expect(await readFile(controller, 'utf8')).toContain('// my change');
    });
  });

  describe('HTTP', () => {
    it('serves Directus-style queries and serializes every column type', async () => {
      await knex('company').where({ id: seeded.companies.acme }).update({ founded: '1999-12-31', archived_at: '2024-05-01T10:00:00Z' });
      const response = await get(
        '/items/company?filter[status][_eq]=active&fields=name,founded,archived_at,created_at,revenue,tags,metadata,employee.first_name&meta=*',
        token(TENANT_A, ['read:company', 'read:employee']),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.meta).toEqual({ total_count: 2, filter_count: 1 });
      expect(body.data[0]).toMatchObject({
        name: 'Acme',
        founded: '1999-12-31',
        archived_at: '2024-05-01T10:00:00.000Z',
        revenue: '1000.50',
        tags: ['b2b', 'eu'],
        metadata: { tier: 'gold' },
        employee: [{ first_name: 'Ann' }, { first_name: 'Bob' }],
      });
      expect(body.data[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const globex = await get('/items/company?filter[name][_eq]=Globex&fields=archived_at,founded', token(TENANT_A, ['*']));
      expect(globex.json().data).toEqual([{ archived_at: null, founded: null }]);
    });

    it('nests many-to-one items even though the column is an integer', async () => {
      const response = await get('/items/employee?fields=first_name,company_id.name&limit=1', token(TENANT_A, ['*']));
      expect(response.json().data).toEqual([{ first_name: 'Ann', company_id: { name: 'Acme' } }]);
    });

    it('reads by id, including composite keys', async () => {
      const company = await get(`/items/company/${seeded.companies.acme}?fields=name`, token(TENANT_A, ['*']));
      expect(company.json()).toEqual({ data: { name: 'Acme' } });
      const member = await get(
        `/items/project_members/${seeded.projects.rocket},${seeded.employees.ann}?fields=role`,
        token(TENANT_A, ['*']),
      );
      expect(member.json()).toEqual({ data: { role: 'lead' } });
    });

    it('creates, updates and deletes', async () => {
      const auth = token(TENANT_A, ['*']);
      const created = await send('POST', '/items/company?fields=id,name,tenant_id', { name: 'Hooli', tags: ['ai'] }, auth);
      expect(created.statusCode).toBe(200);
      const { id } = created.json().data;
      expect(created.json().data).toMatchObject({ name: 'Hooli', tenant_id: TENANT_A });

      const updated = await send('PATCH', `/items/company/${id}?fields=name`, { name: 'Hooli XYZ' }, auth);
      expect(updated.json()).toEqual({ data: { name: 'Hooli XYZ' } });

      const batch = await send('PATCH', '/items/company?fields=name', [{ id, name: 'Hooli 3' }], auth);
      expect(batch.json()).toEqual({ data: [{ name: 'Hooli 3' }] });

      expect((await send('DELETE', `/items/company/${id}`, undefined, auth)).statusCode).toBe(204);
      expect((await get(`/items/company/${id}`, auth)).statusCode).toBe(404);
    });

    it('validates bodies with the generated schemas', async () => {
      const auth = token(TENANT_A, ['*']);
      const unknown = await send('POST', '/items/company', { name: 'X', nope: 1 }, auth);
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().errors[0].extensions.code).toBe('INVALID_PAYLOAD');

      expect((await send('POST', '/items/company', { tags: [] }, auth)).statusCode).toBe(400);
      expect((await send('POST', '/items/company', { name: 'X', status: 'bogus' }, auth)).statusCode).toBe(400);
      expect((await send('POST', '/items/company', { name: 'X', tenant_id: TENANT_B }, auth)).statusCode).toBe(400);
      expect((await send('PATCH', `/items/company/${seeded.companies.acme}`, {}, auth)).statusCode).toBe(400);
      expect((await get('/items/company?limit=5000', auth)).statusCode).toBe(400);
    });

    it('requires a valid token and the route’s permission', async () => {
      expect((await get('/items/company')).statusCode).toBe(401);
      expect((await get('/items/company', 'not-a-token')).statusCode).toBe(401);

      const forbidden = await get('/items/company', token(TENANT_A, ['read:employee']));
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json()).toEqual({
        errors: [{ message: 'Missing permission "read:company"', extensions: { code: 'FORBIDDEN' } }],
      });
      expect((await send('POST', '/items/company', { name: 'X' }, token(TENANT_A, ['read:company']))).statusCode).toBe(403);
    });

    it('keeps tenants apart', async () => {
      const response = await get('/items/company?fields=name', token(TENANT_B, ['*']));
      expect(response.json().data).toEqual([{ name: 'Initech' }]);
      expect((await get(`/items/company/${seeded.companies.acme}`, token(TENANT_B, ['*']))).statusCode).toBe(404);
    });

    it('never returns hidden columns', async () => {
      const response = await get('/items/users', token(TENANT_A, ['*']));
      expect(Object.keys(response.json().data[0])).toEqual(['id', 'tenant_id', 'email']);
    });

    it('answers ping and health checks without a token', async () => {
      const ping = await get('/server/ping');
      expect(ping.statusCode).toBe(200);
      expect(ping.body).toBe('pong');
      const health = await get('/server/health');
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: 'ok' });
    });

    it('answers unknown routes and impossible ids in the same error format', async () => {
      const route = await get('/nope?x=1');
      expect(route.statusCode).toBe(404);
      expect(route.json()).toEqual({ errors: [{ message: "Route GET /nope doesn't exist", extensions: { code: 'ROUTE_NOT_FOUND' } }] });

      const auth = token(TENANT_A, ['*']);
      for (const url of ['/items/company/abc', '/items/users/not-a-uuid', '/items/project_members/1,x']) {
        const response = await get(url, auth);
        expect(response.statusCode, url).toBe(404);
        expect(response.json().errors[0].extensions.code).toBe('NOT_FOUND');
      }
      expect((await send('DELETE', '/items/company/abc', undefined, auth)).statusCode).toBe(404);
    });

    it('only serves reads for read-only tables, and no by-id routes without a primary key', async () => {
      const auth = token(TENANT_A, ['*']);
      expect((await get('/items/audit_log', auth)).statusCode).toBe(200);
      expect((await send('POST', '/items/audit_log', { message: 'x' }, auth)).statusCode).toBe(404);
      expect((await get('/items/audit_log/1', auth)).statusCode).toBe(404);
    });
  });

  describe('row-level security', () => {
    it('applies sql/rls.sql and serves requests as an ordinary role', async () => {
      await knex.raw(await readFile(path.join(outputDir, 'sql/rls.sql'), 'utf8'));
      await knex.raw(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fastifygen_app') THEN
            CREATE ROLE fastifygen_app LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS;
          END IF;
        END $$;
        GRANT USAGE ON SCHEMA public TO fastifygen_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fastifygen_app;
      `);
      const url = new URL(databaseUrl!);
      url.username = 'fastifygen_app';
      url.password = 'app';
      const appKnex = connect(url.toString());
      const { Application } = (await import(path.join(outputDir, 'src/app.ts'))) as { Application: ApplicationClass };
      const rlsApp = await new Application({ knex: appKnex, logger: false }).build();
      try {
        const auth = token(TENANT_A, ['*']);
        const list = await rlsApp.inject({ url: '/items/employee?fields=first_name,company_id.name', headers: { authorization: `Bearer ${auth}` } });
        expect(list.json().data).toEqual([
          { first_name: 'Ann', company_id: { name: 'Acme' } },
          { first_name: 'Bob', company_id: { name: 'Acme' } },
          { first_name: 'Cid', company_id: { name: 'Globex' } },
        ]);
        const created = await rlsApp.inject({
          method: 'POST',
          url: '/items/company?fields=name,tenant_id',
          payload: { name: 'Via RLS' },
          headers: { authorization: `Bearer ${auth}` },
        });
        expect(created.json()).toEqual({ data: { name: 'Via RLS', tenant_id: TENANT_A } });
        // Without the per-request setting, the policy hides every tenant-scoped row.
        expect((await appKnex.raw('select count(*)::int as n from company')).rows[0].n).toBe(0);
      } finally {
        await rlsApp.close();
        await appKnex.destroy();
      }
    });
  });
});
