import { readFile } from 'node:fs/promises';
import knexFactory, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigLoader } from '../src/config/ConfigLoader.js';
import { SchemaIntrospector } from '../src/introspection/SchemaIntrospector.js';
import type { DatabaseModel, TableModel } from '../src/introspection/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

// Needs a throwaway Postgres database: the sample schema drops and recreates `public`.
describe.skipIf(!databaseUrl)('SchemaIntrospector (Postgres)', () => {
  let knex: Knex;
  let model: DatabaseModel;
  const table = (name: string): TableModel => {
    const found = model.tables.find((t) => t.name === name);
    if (!found) throw new Error(`table ${name} not introspected`);
    return found;
  };
  const column = (tableName: string, columnName: string) => {
    const found = table(tableName).columns.find((c) => c.name === columnName);
    if (!found) throw new Error(`column ${tableName}.${columnName} not introspected`);
    return found;
  };

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: databaseUrl });
    await knex.raw(await readFile(new URL('../examples/sample-schema.sql', import.meta.url), 'utf8'));
    const config = new ConfigLoader({ env: {} }).parse({ database: { url: databaseUrl } });
    model = await new SchemaIntrospector(knex, config).introspect();
  });

  afterAll(async () => {
    await knex?.destroy();
  });

  it('lists included tables and leaves out excluded ones', () => {
    expect(model.tables.map((t) => t.name)).toEqual([
      'audit_log',
      'company',
      'employee',
      'project',
      'project_members',
      'tenants',
      'users',
    ]);
  });

  it('reads primary keys, including composite ones', () => {
    expect(table('company').primaryKey).toEqual(['id']);
    expect(table('project_members').primaryKey).toEqual(['project_id', 'employee_id']);
    expect(table('audit_log').primaryKey).toEqual([]);
    expect(model.warnings).toEqual([expect.stringContaining('"audit_log" has no primary key')]);
  });

  it('marks tables with the tenant column as tenant-scoped', () => {
    expect(table('company').tenantScoped).toBe(true);
    expect(table('tenants').tenantScoped).toBe(false);
  });

  it('maps column types, nullability and defaults', () => {
    expect(column('company', 'id')).toMatchObject({ dataType: 'int4', readOnly: true, hasDefault: true, isPrimaryKey: true });
    expect(column('company', 'name')).toMatchObject({
      fullType: 'character varying(255)',
      nullable: false,
      maxLength: 255,
      comment: 'Legal name',
      tsType: 'string',
      jsonSchema: { type: 'string', maxLength: 255 },
    });
    expect(column('company', 'status')).toMatchObject({
      dataType: 'company_status',
      enumValues: ['active', 'inactive', 'archived'],
      defaultValue: "'active'::company_status",
      tsType: '"active" | "inactive" | "archived"',
    });
    expect(column('company', 'tags')).toMatchObject({
      isArray: true,
      dataType: 'text',
      tsType: 'string[]',
      jsonSchema: { type: 'array', items: { type: 'string' } },
    });
    expect(column('company', 'revenue')).toMatchObject({ nullable: true, numericPrecision: 12, numericScale: 2, tsType: 'string' });
    expect(column('company', 'founded').jsonSchema).toEqual({ type: 'string', format: 'date' });
    expect(column('company', 'created_at')).toMatchObject({ tsType: 'Date', defaultValue: 'now()' });
    expect(column('employee', 'id')).toMatchObject({ dataType: 'int8', hasDefault: true, readOnly: false });
    expect(column('employee', 'full_name')).toMatchObject({ readOnly: true, hasDefault: true });
    expect(column('project', 'id')).toMatchObject({ readOnly: false, hasDefault: true });
  });

  it('resolves domains to their base type', () => {
    expect(column('users', 'email')).toMatchObject({ dataType: 'varchar', maxLength: 320 });
  });

  it('reads unique constraints', () => {
    expect(table('users').uniqueConstraints).toEqual([{ name: 'users_tenant_email_unique', columns: ['tenant_id', 'email'] }]);
  });

  it('reads foreign keys in both directions', () => {
    expect(table('employee').manyToOne).toEqual(
      expect.arrayContaining([
        {
          constraintName: 'employee_company_id_fkey',
          columns: ['company_id'],
          foreignSchema: 'public',
          foreignTable: 'company',
          foreignColumns: ['id'],
          onDelete: 'CASCADE',
          onUpdate: 'NO ACTION',
        },
        expect.objectContaining({ columns: ['manager_id'], foreignTable: 'employee', onDelete: 'SET NULL' }),
      ]),
    );
    expect(table('company').oneToMany).toEqual(
      expect.arrayContaining([
        { constraintName: 'employee_company_id_fkey', table: 'employee', columns: ['company_id'], referencedColumns: ['id'] },
        expect.objectContaining({ table: 'project', columns: ['company_id'] }),
      ]),
    );
    expect(table('employee').oneToMany.map((r) => `${r.table}.${r.columns.join(',')}`).sort()).toEqual([
      'employee.manager_id',
      'project_members.employee_id',
    ]);
  });

  it('lists the enums the included tables use', () => {
    expect(model.enums).toEqual([{ name: 'company_status', values: ['active', 'inactive', 'archived'] }]);
  });

  it('honours include patterns and per-table skips', async () => {
    const config = new ConfigLoader({ env: {} }).parse({
      database: { url: databaseUrl },
      tables: { include: ['company', 'employee', 'proj*'], exclude: ['project_members'] },
      overrides: { project: { skip: true } },
    });
    const filtered = await new SchemaIntrospector(knex, config).introspect();

    expect(filtered.tables.map((t) => t.name)).toEqual(['company', 'employee']);
    // project is skipped, so company no longer lists it as a one-to-many relation.
    expect(filtered.tables[0]?.oneToMany.map((r) => r.table)).toEqual(['employee']);
  });
});
