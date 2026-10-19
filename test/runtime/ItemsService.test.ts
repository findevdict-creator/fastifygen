import type { Knex } from 'knex';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ItemsService } from '../../src/runtime/ItemsService.js';
import { QueryParser } from '../../src/runtime/query/QueryParser.js';
import type { SchemaOverview } from '../../src/runtime/SchemaOverview.js';
import type { Accountability, Item } from '../../src/runtime/types.js';
import {
  TENANT_A,
  TENANT_B,
  accountability,
  buildSchema,
  connect,
  databaseUrl,
  resetDatabase,
  type Seeded,
} from '../helpers/database.js';

describe.skipIf(!databaseUrl)('ItemsService (Postgres)', () => {
  let knex: Knex;
  let schema: SchemaOverview;
  let seeded: Seeded;
  const parser = new QueryParser({ defaultLimit: 100, maxLimit: 1000 });

  const service = (table: string, who: Accountability = accountability(TENANT_A)) =>
    new ItemsService(table, { knex, schema, accountability: who });
  const read = async (table: string, raw: Record<string, unknown> = {}, who?: Accountability) =>
    service(table, who).readByQuery(parser.parse(raw));
  const names = (items: Item[], field = 'name') => items.map((item) => item[field]);

  beforeAll(async () => {
    knex = connect();
    seeded = await resetDatabase(knex);
    schema = await buildSchema(knex);
  });

  beforeEach(async () => {
    seeded = await resetDatabase(knex);
  });

  afterAll(async () => {
    await knex?.destroy();
  });

  describe('reading', () => {
    it('returns only the current tenant’s items, sorted by primary key', async () => {
      const { data } = await read('company');
      expect(names(data)).toEqual(['Acme', 'Globex']);
      expect(names((await read('company', {}, accountability(TENANT_B))).data)).toEqual(['Initech']);
    });

    it('returns all visible columns for *', async () => {
      const { data } = await read('company', { filter: { name: { _eq: 'Acme' } } });
      expect(data[0]).toMatchObject({
        id: seeded.companies.acme,
        tenant_id: TENANT_A,
        name: 'Acme',
        status: 'active',
        tags: ['b2b', 'eu'],
        revenue: '1000.50',
        metadata: { tier: 'gold' },
      });
    });

    it('reads one item by key and 404s for another tenant’s item', async () => {
      const company = await service('company').readOne(seeded.companies.acme, { fields: ['name'] });
      expect(company).toEqual({ name: 'Acme' });
      await expect(service('company').readOne(seeded.companies.initech, { fields: ['*'] })).rejects.toMatchObject({
        status: 404,
      });
    });

    it('reads composite keys', async () => {
      const member = await service('project_members').readOne(`${seeded.projects.rocket},${seeded.employees.ann}`, {
        fields: ['role'],
      });
      expect(member).toEqual({ role: 'lead' });
    });

    it('sorts, limits and pages', async () => {
      expect(names((await read('company', { sort: '-name' })).data)).toEqual(['Globex', 'Acme']);
      expect(names((await read('employee', { sort: 'first_name', limit: '1', page: '2' })).data, 'first_name')).toEqual([
        'Bob',
      ]);
    });

    it('returns total_count and filter_count', async () => {
      const result = await read('employee', { filter: { salary: { _gte: '4000' } }, meta: '*' });
      expect(result.meta).toEqual({ total_count: 3, filter_count: 2 });
    });

    it('searches text columns case-insensitively', async () => {
      expect(names((await read('company', { search: 'acm' })).data)).toEqual(['Acme']);
      expect(names((await read('company', { search: '100%' })).data)).toEqual([]);
    });
  });

  describe('filters', () => {
    const filtered = async (filter: unknown, table = 'company', field = 'name') =>
      names((await read(table, { filter: JSON.stringify(filter) })).data, field);

    it('supports comparison and list operators', async () => {
      expect(await filtered({ status: { _eq: 'inactive' } })).toEqual(['Globex']);
      expect(await filtered({ status: { _neq: 'inactive' } })).toEqual(['Acme']);
      expect(await filtered({ name: { _in: 'Globex,Nope' } })).toEqual(['Globex']);
      expect(await filtered({ name: { _nin: ['Globex'] } })).toEqual(['Acme']);
      expect(await filtered({ salary: { _between: '3500,4500' } }, 'employee', 'first_name')).toEqual(['Bob']);
      expect(await filtered({ salary: { _gt: 4500 } }, 'employee', 'first_name')).toEqual(['Ann']);
    });

    it('supports null, empty and string operators', async () => {
      expect(await filtered({ revenue: { _null: true } })).toEqual(['Globex']);
      expect(await filtered({ revenue: { _nnull: 'true' } })).toEqual(['Acme']);
      expect(await filtered({ tags: { _empty: true } })).toEqual(['Globex']);
      expect(await filtered({ tags: { _contains: 'eu' } })).toEqual(['Acme']);
      expect(await filtered({ name: { _icontains: 'CM' } })).toEqual(['Acme']);
      expect(await filtered({ name: { _contains: 'CM' } })).toEqual([]);
      expect(await filtered({ name: { _starts_with: 'Glo' } })).toEqual(['Globex']);
      expect(await filtered({ name: { _iends_with: 'ME' } })).toEqual(['Acme']);
    });

    it('supports _and and _or', async () => {
      expect(await filtered({ _or: [{ name: { _eq: 'Acme' } }, { status: { _eq: 'inactive' } }] })).toEqual([
        'Acme',
        'Globex',
      ]);
      expect(await filtered({ _and: [{ status: { _eq: 'active' } }, { name: { _eq: 'Globex' } }] })).toEqual([]);
    });

    it('filters through many-to-one relations', async () => {
      expect(await filtered({ company_id: { name: { _eq: 'Acme' } } }, 'employee', 'first_name')).toEqual(['Ann', 'Bob']);
      expect(await filtered({ manager_id: { first_name: { _eq: 'Ann' } } }, 'employee', 'first_name')).toEqual(['Bob']);
      // Operators on a many-to-one field filter the foreign key column itself.
      expect(await filtered({ company_id: { _eq: seeded.companies.globex } }, 'employee', 'first_name')).toEqual(['Cid']);
    });

    it('filters through one-to-many relations with _some and _none', async () => {
      expect(await filtered({ employee: { salary: { _gt: 4500 } } })).toEqual(['Acme']);
      expect(await filtered({ employee: { _some: { first_name: { _eq: 'Cid' } } } })).toEqual(['Globex']);
      expect(await filtered({ project: { _none: {} } })).toEqual(['Globex']);
    });

    it('rejects unknown fields and operators', async () => {
      await expect(read('company', { filter: { nope: { _eq: 1 } } })).rejects.toMatchObject({ status: 400 });
      await expect(read('company', { filter: { name: { _like: 'x' } } })).rejects.toThrow('Unknown filter operator');
    });

    it('never matches another tenant’s rows through a relation', async () => {
      // Dee belongs to tenant B's Initech; tenant A must not see Initech-linked data.
      expect(await filtered({ employee: { first_name: { _eq: 'Dee' } } })).toEqual([]);
    });
  });

  describe('relational fields', () => {
    it('nests many-to-one items', async () => {
      const { data } = await read('employee', { fields: 'first_name,company_id.name,manager_id.first_name' });
      expect(data).toEqual([
        { first_name: 'Ann', company_id: { name: 'Acme' }, manager_id: null },
        { first_name: 'Bob', company_id: { name: 'Acme' }, manager_id: { first_name: 'Ann' } },
        { first_name: 'Cid', company_id: { name: 'Globex' }, manager_id: null },
      ]);
    });

    it('nests one-to-many items, and a bare alias returns primary keys', async () => {
      const { data } = await read('company', { fields: 'name,employee.first_name,project' });
      expect(data).toEqual([
        { name: 'Acme', employee: [{ first_name: 'Ann' }, { first_name: 'Bob' }], project: [{ id: seeded.projects.rocket }] },
        { name: 'Globex', employee: [{ first_name: 'Cid' }], project: [] },
      ]);
    });

    it('nests several levels deep', async () => {
      const { data } = await read('project_members', { fields: 'role,employee_id.company_id.name' });
      expect(data).toEqual([
        { role: 'lead', employee_id: { company_id: { name: 'Acme' } } },
        { role: 'member', employee_id: { company_id: { name: 'Acme' } } },
      ]);
    });

    it('rejects unknown fields', async () => {
      await expect(read('company', { fields: 'nope' })).rejects.toThrow('Field "nope" does not exist on "company"');
      await expect(read('company', { fields: 'name.first' })).rejects.toThrow('is not a relation');
    });
  });

  describe('hidden columns', () => {
    it('leaves hidden columns out of * and refuses them in fields, filter and sort', async () => {
      const { data } = await read('users');
      expect(Object.keys(data[0]!)).toEqual(['id', 'tenant_id', 'email']);
      await expect(read('users', { fields: 'password_hash' })).rejects.toMatchObject({ status: 403 });
      await expect(read('users', { filter: { password_hash: { _starts_with: 'h' } } })).rejects.toMatchObject({ status: 403 });
      await expect(read('users', { sort: 'password_hash' })).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('permissions', () => {
    it('requires the action permission for the table', async () => {
      await expect(read('company', {}, accountability(TENANT_A, ['read:employee']))).rejects.toMatchObject({
        status: 403,
        message: 'Missing permission "read:company"',
      });
      await expect(read('company', {}, accountability(TENANT_A, ['read:company']))).resolves.toBeTruthy();
      await expect(read('company', {}, accountability(TENANT_A, ['read:*']))).resolves.toBeTruthy();
      await expect(read('company', {}, accountability(TENANT_A, ['*:company']))).resolves.toBeTruthy();
    });

    it('requires read permission on every related table a query reaches', async () => {
      const who = accountability(TENANT_A, ['read:employee']);
      await expect(read('employee', { fields: 'first_name,company_id.name' }, who)).rejects.toThrow('"read:company"');
      await expect(read('employee', { filter: { company_id: { name: { _eq: 'Acme' } } } }, who)).rejects.toThrow(
        '"read:company"',
      );
    });

    it('returns null after a write the caller cannot read back', async () => {
      const created = await service('company', accountability(TENANT_A, ['create:company'])).createOne({ name: 'Hooli' });
      expect(created).toBeNull();
    });

    it('requires a tenant for tenant-scoped tables only', async () => {
      await expect(read('company', {}, accountability(null))).rejects.toMatchObject({ status: 403 });
      expect(names((await read('tenants', {}, accountability(null))).data)).toEqual(['Tenant A', 'Tenant B']);
    });
  });

  describe('writing', () => {
    it('creates items in the current tenant and returns them', async () => {
      const created = await service('company').createOne(
        { name: 'Hooli', tags: ['ai'], metadata: { tier: 'silver' } },
        { fields: ['name', 'tenant_id', 'tags', 'metadata', 'status'] },
      );
      expect(created).toEqual({ name: 'Hooli', tenant_id: TENANT_A, tags: ['ai'], metadata: { tier: 'silver' }, status: 'active' });
    });

    it('creates several items at once, in order', async () => {
      const created = await service('company').createMany([{ name: 'One' }, { name: 'Two' }], { fields: ['name'] });
      expect(created).toEqual([{ name: 'One' }, { name: 'Two' }]);
    });

    it('rejects server-managed, read-only, unknown and nested fields', async () => {
      const company = service('company');
      await expect(company.createOne({ name: 'X', tenant_id: TENANT_B })).rejects.toThrow('"tenant_id" is set by the server');
      await expect(company.createOne({ name: 'X', id: 99 })).rejects.toThrow('"id" is read-only');
      await expect(company.createOne({ name: 'X', nope: 1 })).rejects.toThrow('"nope" does not exist');
      await expect(company.createOne({ name: 'X', employee: [] })).rejects.toThrow('Nested writes are not supported yet');
      await expect(service('employee').createOne({ first_name: 'X', last_name: 'Y', company_id: seeded.companies.acme, full_name: 'Z' })).rejects.toThrow('"full_name" is read-only');
    });

    it('rejects references to another tenant’s items', async () => {
      await expect(
        service('employee').createOne({ first_name: 'Eve', last_name: 'Evans', company_id: seeded.companies.initech }),
      ).rejects.toMatchObject({ status: 400, code: 'INVALID_FOREIGN_KEY' });
      await expect(service('employee').updateOne(seeded.employees.bob, { company_id: seeded.companies.initech })).rejects.toMatchObject({
        code: 'INVALID_FOREIGN_KEY',
      });
    });

    it('updates one item and 404s for another tenant’s item', async () => {
      const updated = await service('company').updateOne(seeded.companies.acme, { name: 'Acme Corp' }, { fields: ['name'] });
      expect(updated).toEqual({ name: 'Acme Corp' });
      await expect(service('company').updateOne(seeded.companies.initech, { name: 'Hacked' })).rejects.toMatchObject({ status: 404 });
      await expect(service('company').updateOne(seeded.companies.acme, {})).rejects.toThrow('no fields to update');
    });

    it('updates many items with the same data, or a batch with different data', async () => {
      const many = await service('company').updateMany([seeded.companies.acme, seeded.companies.globex], { status: 'archived' }, {
        fields: ['name', 'status'],
      });
      expect(many).toEqual([
        { name: 'Acme', status: 'archived' },
        { name: 'Globex', status: 'archived' },
      ]);

      const batch = await service('company').updateBatch(
        [
          { id: seeded.companies.acme, name: 'A2' },
          { id: seeded.companies.globex, name: 'G2' },
        ],
        { fields: ['id', 'name'] },
      );
      expect(batch).toEqual([
        { id: seeded.companies.acme, name: 'A2' },
        { id: seeded.companies.globex, name: 'G2' },
      ]);
    });

    it('deletes items and 404s for another tenant’s item', async () => {
      await service('project_members').deleteOne(`${seeded.projects.rocket},${seeded.employees.bob}`);
      await service('employee').deleteMany([seeded.employees.cid]);
      expect(names((await read('employee')).data, 'first_name')).toEqual(['Ann', 'Bob']);
      expect((await read('project_members')).data).toHaveLength(1);
      await expect(service('company').deleteOne(seeded.companies.initech)).rejects.toMatchObject({ status: 404 });
    });

    it('refuses writes to read-only tables', async () => {
      await expect(service('audit_log').createOne({ message: 'x' })).rejects.toMatchObject({ status: 405 });
    });

    it('lets subclasses transform input', async () => {
      class CompanyService extends ItemsService {
        protected override async prepareCreate(data: Item) {
          return { ...data, name: String(data.name).toUpperCase() };
        }
      }
      const created = await new CompanyService('company', { knex, schema, accountability: accountability(TENANT_A) }).createOne(
        { name: 'loud' },
        { fields: ['name'] },
      );
      expect(created).toEqual({ name: 'LOUD' });
    });
  });

  describe('row-level security', () => {
    it('sets the tenant for Postgres policies inside each transaction', async () => {
      await knex.raw(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fastifygen_app') THEN
            CREATE ROLE fastifygen_app LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS;
          END IF;
        END $$;
        GRANT USAGE ON SCHEMA public TO fastifygen_app;
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO fastifygen_app;
        ALTER TABLE company ENABLE ROW LEVEL SECURITY;
        -- nullif: after a transaction the setting reads as '' on that connection, not NULL.
        CREATE POLICY tenant_isolation ON company
          USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
      `);
      const url = new URL(databaseUrl!);
      url.username = 'fastifygen_app';
      url.password = 'app';
      const appKnex = connect(url.toString());
      try {
        // A raw query with no tenant filter: only the policy keeps tenant B's rows out.
        class RawCompanyService extends ItemsService {
          countAll() {
            return this.transaction(async (_repository, trx) => {
              const rows = await trx.raw('select name from company order by id');
              return (rows.rows as Item[]).map((row) => row.name);
            });
          }
        }
        const rawService = new RawCompanyService('company', { knex: appKnex, schema, accountability: accountability(TENANT_A) });
        expect(await rawService.countAll()).toEqual(['Acme', 'Globex']);
        // Outside a service transaction the setting is gone, so the policy hides everything.
        expect((await appKnex.raw('select name from company')).rows).toEqual([]);
      } finally {
        await appKnex.destroy();
      }
    });
  });
});
