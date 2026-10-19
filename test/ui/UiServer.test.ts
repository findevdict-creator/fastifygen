import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Knex } from 'knex';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigTemplate } from '../../src/config/ConfigTemplate.js';
import { UiServer } from '../../src/ui-server/UiServer.js';
import { connect, databaseUrl, resetDatabase } from '../helpers/database.js';

const headers = { 'x-fastifygen-ui': '1', host: '127.0.0.1:4321' };

async function server(env: Record<string, string | undefined> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fastifygen-ui-'));
  const configPath = path.join(dir, 'config.json');
  const app = await new UiServer({ configPath, env, staticDir: dir }).build();
  const call = (options: InjectOptions) => app.inject({ ...options, headers: { ...headers, ...options.headers } });
  return { dir, configPath, app, call };
}

describe('UiServer', () => {
  it('answers only same-machine requests that carry the UI header', async () => {
    const { app } = await server();
    expect((await app.inject({ url: '/api/state', headers: { host: '127.0.0.1:4321' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/state', headers: { ...headers, host: 'evil.example:4321' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/state', headers: { ...headers, host: 'localhost:4321' } })).statusCode).toBe(200);
  });

  it('starts from the defaults when there is no config yet', async () => {
    const { call, configPath } = await server();
    const state = (await call({ url: '/api/state' })).json();
    expect(state).toMatchObject({ configPath, exists: false, config: null, defaults: ConfigTemplate.build(), issues: [] });
    expect(state.schema.properties.database).toBeDefined();
  });

  it('saves a valid config as written, keeping ${VAR} references, and reports unset variables', async () => {
    const { call, configPath } = await server({});
    const config = { ...ConfigTemplate.build(), api: { prefix: '/v1' } };
    const saved = await call({ method: 'PUT', url: '/api/config', payload: { config } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().missingEnv).toEqual(['DATABASE_URL']);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(config);

    const state = (await call({ url: '/api/state' })).json();
    expect(state).toMatchObject({ exists: true, config, missingEnv: ['DATABASE_URL'], issues: [] });
  });

  it('refuses to save an invalid config and says why', async () => {
    const { call, configPath } = await server();
    const response = await call({ method: 'PUT', url: '/api/config', payload: { config: { database: { url: 'x' }, api: { maxLimit: 'lots' } } } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.issues).toEqual(['/api/maxLimit: must be integer']);
    expect(existsSync(configPath)).toBe(false);
  });

  it('reports an unreachable database in one line', async () => {
    const { call } = await server();
    const response = await call({ method: 'POST', url: '/api/connection', payload: { config: { database: { url: 'postgres://x:y@127.0.0.1:1/none' } } } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.message).toMatch(/^Cannot connect to the database: /);
  });

  it('serves the frontend for any other page', async () => {
    const { dir, call } = await server();
    await writeFile(path.join(dir, 'index.html'), '<div id="root"></div>');
    const page = await call({ url: '/schema' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('id="root"');
    expect((await call({ url: '/api/nope' })).statusCode).toBe(404);
  });
});

describe.skipIf(!databaseUrl)('UiServer with Postgres', () => {
  let knex: Knex;
  let ui: Awaited<ReturnType<typeof server>>;
  const config = { database: { url: databaseUrl }, overrides: { audit_log: { skip: true } } };

  beforeAll(async () => {
    knex = connect();
    ui = await server();
  });

  beforeEach(async () => {
    await resetDatabase(knex);
  });

  afterAll(async () => {
    await ui?.app.close();
    await knex?.destroy();
  });

  it('tests the connection', async () => {
    const response = await ui.call({ method: 'POST', url: '/api/connection', payload: { config } });
    expect(response.json()).toMatchObject({ ok: true, serverVersion: expect.stringMatching(/^\d+/) });
  });

  it('lists skipped tables too, so they can be brought back', async () => {
    const model = (await ui.call({ method: 'POST', url: '/api/introspect', payload: { config } })).json();
    expect(model.tables.map((table: { name: string }) => table.name)).toContain('audit_log');
    expect(model.skipped).toEqual(['audit_log']);
  });

  it('previews without writing, then generates', async () => {
    const preview = (await ui.call({ method: 'POST', url: '/api/preview', payload: { config } })).json();
    expect(preview.dryRun).toBe(true);
    expect(preview.outputDir).toBe(path.join(ui.dir, 'generated'));
    expect(preview.tables).not.toContain('audit_log');
    expect(preview.files.every((file: { status: string; content?: string }) => file.status === 'created' && file.content === undefined)).toBe(true);
    expect(preview.permissions.company).toEqual({ read: 'read:company', create: 'create:company', update: 'update:company', delete: 'delete:company' });
    expect(existsSync(preview.outputDir)).toBe(false);

    const file = (await ui.call({ url: '/api/preview/file?path=src/permissions.ts' })).json();
    expect(file.content).toContain('"read:company"');

    const generated = (await ui.call({ method: 'POST', url: '/api/generate', payload: { config } })).json();
    expect(generated.dryRun).toBe(false);
    expect(existsSync(path.join(generated.outputDir, 'src/modules/company/CompanyRoutes.ts'))).toBe(true);

    const again = (await ui.call({ method: 'POST', url: '/api/preview', payload: { config } })).json();
    const statuses = new Set(again.files.map((file: { status: string }) => file.status));
    expect(statuses).toEqual(new Set(['unchanged', 'kept']));
  });
});
