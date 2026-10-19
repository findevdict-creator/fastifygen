import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigLoader } from '../../src/config/ConfigLoader.js';
import { ModuleEmitter } from '../../src/generation/emitters/ModuleEmitter.js';
import { RuntimeSchemaBuilder } from '../../src/generation/RuntimeSchemaBuilder.js';
import { SchemaIntrospector } from '../../src/introspection/SchemaIntrospector.js';
import type { TableModel } from '../../src/introspection/types.js';
import { ConfigPath, Labels } from '../../ui/src/lib/ConfigPath.js';
import { RelationNames } from '../../ui/src/lib/RelationNames.js';
import { RoutePlanner } from '../../ui/src/lib/RoutePlanner.js';
import { connect, databaseUrl, resetDatabase } from '../helpers/database.js';

/** The UI's copies of generator rules, checked against the generator itself. */
describe('UI logic', () => {
  const keyed = { name: 'company', primaryKey: ['id'] } as TableModel;
  const keyless = { name: 'audit_log', primaryKey: [] as string[] } as TableModel;

  it.each([
    ['defaults', {}],
    ['read-only table', { overrides: { company: { readOnly: true } } }],
    ['fewer actions and a custom format', { permissions: { actions: ['create'], format: '{table}.{action}' } }],
    ['renamed route', { api: { prefix: '/v1' }, overrides: { company: { routeName: 'firms' } } }],
  ])('plans the same routes as the generator: %s', (_name, draft) => {
    const config = new ConfigLoader({ env: {} }).parse({ database: { url: 'postgres://x/y' }, ...draft });
    const emitter = new ModuleEmitter(config);
    const planner = new RoutePlanner(draft);
    for (const table of [keyed, keyless]) {
      expect(planner.routes(table).map((route) => `${route.method} ${route.permission}`)).toEqual(
        emitter.routesFor(table).map((route) => `${route.method} ${emitter.permissionName(route.action, table.name)}`),
      );
    }
    const prefix = (draft as { api?: { prefix?: string } }).api?.prefix ?? '/items';
    const segment = (draft as { overrides?: { company?: { routeName?: string } } }).overrides?.company?.routeName ?? 'company';
    expect(planner.routes(keyed)[0]?.path).toBe(`${prefix}/${segment}`);
  });

  it('edits nested config values and drops emptied sections', () => {
    const start = { api: { prefix: '/items' }, overrides: { users: { readOnly: true } } };
    expect(ConfigPath.set(start, ['api', 'maxLimit'], 10)).toEqual({ ...start, api: { prefix: '/items', maxLimit: 10 } });
    expect(ConfigPath.set(start, ['overrides', 'users', 'readOnly'], undefined)).toEqual({ api: { prefix: '/items' } });
    expect(start.overrides.users.readOnly).toBe(true);
    expect(ConfigPath.get(start, ['overrides', 'users', 'readOnly'])).toBe(true);
    expect(Labels.humanize('defaultLimit')).toBe('Default limit');
    expect(Labels.humanize('ssl')).toBe('SSL');
  });

  it('flags env references without requiring them when validating', () => {
    const loader = new ConfigLoader({ env: {} });
    const raw = { database: { url: '${DATABASE_URL}', schema: '${DB_SCHEMA:-public}' } };
    expect(loader.validate(raw)).toEqual([]);
    expect(loader.missingEnv(raw)).toEqual(['DATABASE_URL']);
    expect(loader.validate({ database: { url: 'x' }, nope: 1 })).toEqual(['(root): unknown property "nope"']);
  });

  describe.skipIf(!databaseUrl)('relation names (Postgres)', () => {
    let knex: Knex;
    beforeAll(async () => {
      knex = connect();
      await resetDatabase(knex);
    });
    afterAll(async () => knex?.destroy());

    it('names one-to-many fields the way the generated API does', async () => {
      const config = new ConfigLoader({ env: {} }).parse({ database: { url: databaseUrl } });
      const model = await new SchemaIntrospector(knex, config).introspect();
      const runtime = new RuntimeSchemaBuilder(config).build(model);
      for (const table of model.tables) {
        expect([...RelationNames.oneToMany(table).values()].sort(), table.name).toEqual(
          Object.keys(runtime.tables[table.name]!.oneToMany).sort(),
        );
      }
    });
  });
});
