import Fastify, { type FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import qs from 'qs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorMapper } from '../../src/runtime/errors.js';
import { ItemsController } from '../../src/runtime/ItemsController.js';
import type { SchemaOverview } from '../../src/runtime/SchemaOverview.js';
import { TENANT_A, buildSchema, connect, databaseUrl, resetDatabase, type Seeded } from '../helpers/database.js';

/**
 * Wires controllers by hand, the way step 3's generated plugins will, to
 * check the HTTP contract end to end.
 */
describe.skipIf(!databaseUrl)('ItemsController over HTTP (Postgres)', () => {
  let knex: Knex;
  let schema: SchemaOverview;
  let app: FastifyInstance;
  let seeded: Seeded;

  const headers = (permissions = '*') => ({ 'x-tenant': TENANT_A, 'x-permissions': permissions });

  beforeAll(async () => {
    knex = connect();
    seeded = await resetDatabase(knex);
    schema = await buildSchema(knex);

    app = Fastify({ querystringParser: (query) => qs.parse(query, { depth: 10, arrayLimit: 100 }) });
    app.setErrorHandler(ErrorMapper.handler);
    // Stand-in for the generated auth hook.
    app.addHook('onRequest', async (request) => {
      if (request.headers['x-tenant'] === undefined) return;
      request.accountability = {
        userId: null,
        tenantId: String(request.headers['x-tenant']),
        permissions: String(request.headers['x-permissions'] ?? '').split(',').filter(Boolean),
      };
    });

    for (const table of ['company', 'employee', 'project_members']) {
      const controller = new ItemsController(table, { knex, schema });
      await app.register(
        async (plugin) => {
          plugin.route({ method: 'GET', url: '/', handler: controller.readMany });
          plugin.route({ method: 'GET', url: '/:id', handler: controller.readOne });
          plugin.route({ method: 'POST', url: '/', handler: controller.create });
          plugin.route({ method: 'PATCH', url: '/', handler: controller.updateMany });
          plugin.route({ method: 'PATCH', url: '/:id', handler: controller.updateOne });
          plugin.route({ method: 'DELETE', url: '/', handler: controller.deleteMany });
          plugin.route({ method: 'DELETE', url: '/:id', handler: controller.deleteOne });
        },
        { prefix: `/items/${table}` },
      );
    }
  });

  beforeEach(async () => {
    seeded = await resetDatabase(knex);
  });

  afterAll(async () => {
    await app?.close();
    await knex?.destroy();
  });

  it('lists items with bracket-style filters, fields and meta', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/items/employee?filter[company_id][name][_eq]=Acme&fields=first_name,company_id.name&meta=filter_count',
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [
        { first_name: 'Ann', company_id: { name: 'Acme' } },
        { first_name: 'Bob', company_id: { name: 'Acme' } },
      ],
      meta: { filter_count: 2 },
    });
  });

  it('reads one item, including by composite key', async () => {
    const one = await app.inject({ url: `/items/company/${seeded.companies.acme}?fields=name`, headers: headers() });
    expect(one.json()).toEqual({ data: { name: 'Acme' } });

    const member = await app.inject({
      url: `/items/project_members/${seeded.projects.rocket},${seeded.employees.ann}?fields=role`,
      headers: headers(),
    });
    expect(member.json()).toEqual({ data: { role: 'lead' } });
  });

  it('creates one item or many', async () => {
    const one = await app.inject({
      method: 'POST',
      url: '/items/company?fields=name,tenant_id',
      headers: headers(),
      payload: { name: 'Hooli' },
    });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toEqual({ data: { name: 'Hooli', tenant_id: TENANT_A } });

    const many = await app.inject({
      method: 'POST',
      url: '/items/company?fields=name',
      headers: headers(),
      payload: [{ name: 'One' }, { name: 'Two' }],
    });
    expect(many.json()).toEqual({ data: [{ name: 'One' }, { name: 'Two' }] });
  });

  it('updates by id, by keys, and in batches', async () => {
    const one = await app.inject({
      method: 'PATCH',
      url: `/items/company/${seeded.companies.acme}?fields=name`,
      headers: headers(),
      payload: { name: 'Acme Corp' },
    });
    expect(one.json()).toEqual({ data: { name: 'Acme Corp' } });

    const byKeys = await app.inject({
      method: 'PATCH',
      url: '/items/company?fields=status',
      headers: headers(),
      payload: { keys: [seeded.companies.acme, seeded.companies.globex], data: { status: 'archived' } },
    });
    expect(byKeys.json()).toEqual({ data: [{ status: 'archived' }, { status: 'archived' }] });

    const batch = await app.inject({
      method: 'PATCH',
      url: '/items/company?fields=name',
      headers: headers(),
      payload: [{ id: seeded.companies.globex, name: 'Globex 2' }],
    });
    expect(batch.json()).toEqual({ data: [{ name: 'Globex 2' }] });
  });

  it('deletes by id and by keys with 204', async () => {
    const one = await app.inject({ method: 'DELETE', url: `/items/employee/${seeded.employees.cid}`, headers: headers() });
    expect(one.statusCode).toBe(204);

    const many = await app.inject({
      method: 'DELETE',
      url: '/items/employee',
      headers: headers(),
      payload: [seeded.employees.bob],
    });
    expect(many.statusCode).toBe(204);

    const left = await app.inject({ url: '/items/employee?fields=first_name', headers: headers() });
    expect(left.json()).toEqual({ data: [{ first_name: 'Ann' }] });
  });

  it('answers 204 when the caller may write but not read back', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/items/company',
      headers: headers('create:company'),
      payload: { name: 'Blind' },
    });
    expect(response.statusCode).toBe(204);
  });

  it('sends errors in Directus format with the right status', async () => {
    const noAuth = await app.inject({ url: '/items/company' });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.json()).toEqual({ errors: [{ message: 'Authentication required', extensions: { code: 'UNAUTHORIZED' } }] });

    const forbidden = await app.inject({ url: '/items/company', headers: headers('read:employee') });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().errors[0].extensions.code).toBe('FORBIDDEN');

    const notFound = await app.inject({ url: `/items/company/${seeded.companies.initech}`, headers: headers() });
    expect(notFound.statusCode).toBe(404);

    const badQuery = await app.inject({ url: '/items/company?filter[nope][_eq]=1', headers: headers() });
    expect(badQuery.statusCode).toBe(400);
    expect(badQuery.json().errors[0].extensions.code).toBe('INVALID_QUERY');

    const badPayload = await app.inject({ method: 'PATCH', url: '/items/company', headers: headers(), payload: { nope: 1 } });
    expect(badPayload.statusCode).toBe(400);
    expect(badPayload.json().errors[0].extensions.code).toBe('INVALID_PAYLOAD');
  });

  it('maps database constraint errors', async () => {
    const missingColumn = await app.inject({
      method: 'POST',
      url: '/items/employee',
      headers: headers(),
      payload: { first_name: 'No', company_id: seeded.companies.acme },
    });
    expect(missingColumn.statusCode).toBe(400);
    expect(missingColumn.json().errors[0].extensions).toMatchObject({ code: 'NOT_NULL_VIOLATION', field: 'last_name' });

    const badValue = await app.inject({
      method: 'POST',
      url: '/items/company',
      headers: headers(),
      payload: { name: 'X', status: 'nope' },
    });
    expect(badValue.statusCode).toBe(400);
  });
});
