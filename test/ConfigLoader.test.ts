import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, ConfigLoader } from '../src/config/ConfigLoader.js';
import { configSchema } from '../src/config/config.schema.js';

describe('ConfigLoader', () => {
  it('applies defaults to a minimal config', () => {
    const config = new ConfigLoader({ env: {} }).parse({ database: { url: 'postgres://localhost/app' } });

    expect(config.database.schema).toBe('public');
    expect(config.output.dir).toBe('./generated');
    expect(config.tables).toEqual({ include: ['*'], exclude: ['knex_migrations', 'knex_migrations_lock'] });
    expect(config.api).toEqual({ prefix: '/items', defaultLimit: 100, maxLimit: 1000 });
    expect(config.tenancy).toEqual({ enabled: true, column: 'tenant_id', rls: true, settingName: 'app.tenant_id' });
    expect(config.auth).toEqual({ mode: 'jwt', tenantClaim: 'tenant_id', permissionsClaim: 'permissions' });
    expect(config.permissions).toEqual({ format: '{action}:{table}', actions: ['create', 'read', 'update', 'delete'] });
    expect(config.overrides).toEqual({});
  });

  it('does not modify the input object', () => {
    const raw = { database: { url: 'postgres://localhost/app' } };
    new ConfigLoader({ env: {} }).parse(raw);
    expect(raw).toEqual({ database: { url: 'postgres://localhost/app' } });
  });

  it('substitutes environment variables and fallbacks', () => {
    const config = new ConfigLoader({ env: { DATABASE_URL: 'postgres://db/app', DB_PORT: '6543' } }).parse({
      database: { url: '${DATABASE_URL}', host: 'x', database: 'y', port: '${DB_PORT}', schema: '${DB_SCHEMA:-app}' },
    });

    expect(config.database.url).toBe('postgres://db/app');
    expect(config.database.port).toBe(6543);
    expect(config.database.schema).toBe('app');
  });

  it('reports every missing environment variable', () => {
    const parse = () =>
      new ConfigLoader({ env: {} }).parse({ database: { url: '${DATABASE_URL}', password: '${DB_PASSWORD}' } });

    expect(parse).toThrow(ConfigError);
    expect(parse).toThrow(/\$\{DATABASE_URL\}[\s\S]*\$\{DB_PASSWORD\}/);
  });

  it('rejects unknown properties and bad values with readable messages', () => {
    try {
      new ConfigLoader({ env: {} }).parse({
        database: { url: 'postgres://localhost/app' },
        auth: { mode: 'magic' },
        tenancy: { colum: 'tenant_id' },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues).toEqual(
        expect.arrayContaining([
          '/auth/mode: must be one of jwt, header, none',
          '/tenancy: unknown property "colum"',
        ]),
      );
    }
  });

  it('requires either a url or host and database', () => {
    expect(() => new ConfigLoader({ env: {} }).parse({ database: { host: 'localhost' } })).toThrow(
      /set either "url" or both "host" and "database"/,
    );
  });

  it('loads a file and resolves the output folder next to it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fastifygen-'));
    const file = path.join(dir, 'config.json');
    await writeFile(file, JSON.stringify({ database: { url: 'postgres://localhost/app' }, output: { dir: 'api' } }));

    const loaded = await new ConfigLoader({ env: {} }).load(file);

    expect(loaded.path).toBe(file);
    expect(loaded.outputDir).toBe(path.join(dir, 'api'));
  });

  it('names the file when it is not valid JSON', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fastifygen-'));
    const file = path.join(dir, 'config.json');
    await writeFile(file, '{ nope');

    await expect(new ConfigLoader().load(file)).rejects.toThrow(`Config file ${file} is not valid JSON`);
  });

  it('keeps schema/config.schema.json in sync with the source', async () => {
    const written = JSON.parse(await readFile(new URL('../schema/config.schema.json', import.meta.url), 'utf8'));
    expect(written).toEqual(configSchema);
  });
});
