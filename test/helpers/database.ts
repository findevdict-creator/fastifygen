import { readFile } from 'node:fs/promises';
import knexFactory, { type Knex } from 'knex';
import { ConfigLoader } from '../../src/config/ConfigLoader.js';
import type { GeneratorConfig } from '../../src/config/types.js';
import { RuntimeSchemaBuilder } from '../../src/generation/RuntimeSchemaBuilder.js';
import { SchemaIntrospector } from '../../src/introspection/SchemaIntrospector.js';
import { SchemaOverview } from '../../src/runtime/SchemaOverview.js';
import type { Accountability } from '../../src/runtime/types.js';

export const databaseUrl = process.env.TEST_DATABASE_URL;

export const TENANT_A = '11111111-1111-1111-1111-111111111111';
export const TENANT_B = '22222222-2222-2222-2222-222222222222';

export interface Seeded {
  companies: { acme: number; globex: number; initech: number };
  employees: { ann: string; bob: string; cid: string; dee: string };
  projects: { rocket: number };
}

export function testConfig(overrides: Record<string, unknown> = {}): GeneratorConfig {
  return new ConfigLoader({ env: {} }).parse({
    database: { url: databaseUrl },
    overrides: { users: { hiddenColumns: ['password_hash'] }, audit_log: { readOnly: true } },
    ...overrides,
  });
}

/** Recreates the sample schema and fills it with two tenants' data. */
export async function resetDatabase(knex: Knex): Promise<Seeded> {
  await knex.raw(await readFile(new URL('../../examples/sample-schema.sql', import.meta.url), 'utf8'));
  await knex('tenants').insert([
    { id: TENANT_A, name: 'Tenant A' },
    { id: TENANT_B, name: 'Tenant B' },
  ]);
  await knex('users').insert({ tenant_id: TENANT_A, email: 'alice@a.test', password_hash: 'hash-a' });

  const [acme, globex, initech] = (await knex('company')
    .insert([
      { tenant_id: TENANT_A, name: 'Acme', status: 'active', tags: ['b2b', 'eu'], revenue: '1000.50', metadata: { tier: 'gold' } },
      { tenant_id: TENANT_A, name: 'Globex', status: 'inactive', tags: [], revenue: null },
      { tenant_id: TENANT_B, name: 'Initech', status: 'active', tags: ['us'], revenue: '42.00' },
    ])
    .returning('id')) as { id: number }[];

  const [ann] = (await knex('employee')
    .insert({ tenant_id: TENANT_A, company_id: acme!.id, first_name: 'Ann', last_name: 'Archer', salary: '5000.00' })
    .returning('id')) as { id: string }[];
  const [bob, cid, dee] = (await knex('employee')
    .insert([
      { tenant_id: TENANT_A, company_id: acme!.id, manager_id: ann!.id, first_name: 'Bob', last_name: 'Baker', salary: '4000.00' },
      { tenant_id: TENANT_A, company_id: globex!.id, first_name: 'Cid', last_name: 'Cole', salary: null },
      { tenant_id: TENANT_B, company_id: initech!.id, first_name: 'Dee', last_name: 'Dunn', salary: '3000.00' },
    ])
    .returning('id')) as { id: string }[];

  const [rocket] = (await knex('project')
    .insert({ tenant_id: TENANT_A, company_id: acme!.id, title: 'Rocket' })
    .returning('id')) as { id: number }[];
  await knex('project_members').insert([
    { project_id: rocket!.id, employee_id: ann!.id, tenant_id: TENANT_A, role: 'lead' },
    { project_id: rocket!.id, employee_id: bob!.id, tenant_id: TENANT_A },
  ]);

  return {
    companies: { acme: acme!.id, globex: globex!.id, initech: initech!.id },
    employees: { ann: ann!.id, bob: bob!.id, cid: cid!.id, dee: dee!.id },
    projects: { rocket: rocket!.id },
  };
}

export async function buildSchema(knex: Knex, config = testConfig()): Promise<SchemaOverview> {
  const model = await new SchemaIntrospector(knex, config).introspect();
  return new SchemaOverview(new RuntimeSchemaBuilder(config).build(model));
}

export function connect(url = databaseUrl): Knex {
  return knexFactory({ client: 'pg', connection: url, pool: { min: 0, max: 4 } });
}

export function accountability(tenantId: string | null, permissions: string[] = ['*']): Accountability {
  return { userId: null, tenantId, permissions };
}
