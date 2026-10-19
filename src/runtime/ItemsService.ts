import type { Knex } from 'knex';
import { InvalidPayloadError, MethodNotAllowedError, NotFoundError } from './errors.js';
import { ItemsRepository } from './ItemsRepository.js';
import { PermissionChecker } from './PermissionChecker.js';
import type { SchemaOverview } from './SchemaOverview.js';
import type { Accountability, Item, PrimaryKey, Query, ReadManyResult } from './types.js';

export interface ServiceContext {
  knex: Knex;
  schema: SchemaOverview;
  accountability: Accountability;
}

type FieldsQuery = Pick<Query, 'fields'>;

/**
 * Business logic for one table: permissions, read-only tables, transactions
 * and the row-level security setting. Extend it per table to add custom
 * logic, e.g. override {@link prepareCreate} to hash a password.
 */
export class ItemsService {
  protected readonly knex: Knex;
  protected readonly schema: SchemaOverview;
  protected readonly accountability: Accountability;
  protected readonly permissions: PermissionChecker;

  constructor(
    readonly table: string,
    ctx: ServiceContext,
  ) {
    this.knex = ctx.knex;
    this.schema = ctx.schema;
    this.accountability = ctx.accountability;
    this.permissions = new PermissionChecker(ctx.schema, ctx.accountability);
    ctx.schema.table(table);
  }

  // ---- Reads ---------------------------------------------------------------

  async readByQuery(query: Query): Promise<ReadManyResult> {
    this.permissions.assert('read', this.table);
    return this.transaction(async (repository) => {
      const data = await repository.readMany(query);
      if (query.meta.length === 0) return { data };
      const meta: NonNullable<ReadManyResult['meta']> = {};
      for (const kind of query.meta) meta[kind] = await repository.count(query, kind);
      return { data, meta };
    });
  }

  async readOne(key: PrimaryKey, query: FieldsQuery): Promise<Item> {
    this.permissions.assert('read', this.table);
    return this.transaction((repository) => repository.readOne(key, query));
  }

  // ---- Writes --------------------------------------------------------------
  // Each write returns the saved items when the caller may read them, else null.

  async createOne(data: unknown, query: FieldsQuery = { fields: ['*'] }): Promise<Item | null> {
    const items = await this.createMany([data], query);
    return items ? (items[0] ?? null) : null;
  }

  async createMany(items: unknown[], query: FieldsQuery = { fields: ['*'] }): Promise<Item[] | null> {
    this.assertWritable('create');
    if (!Array.isArray(items) || items.length === 0) throw new InvalidPayloadError('Payload must contain at least one item');
    const prepared = await Promise.all(items.map((item) => this.prepareCreate(this.asObject(item))));
    return this.transaction(async (repository) => {
      const keys = await repository.createMany(prepared);
      return this.readBack(repository, keys.map((key) => repository.keyOf(key)), query);
    });
  }

  async updateOne(key: PrimaryKey, data: unknown, query: FieldsQuery = { fields: ['*'] }): Promise<Item | null> {
    this.assertWritable('update');
    const changes = await this.prepareUpdate(this.asObject(data));
    return this.transaction(async (repository) => {
      const updated = await repository.updateMany([key], changes);
      if (updated === 0) throw new NotFoundError();
      const items = await this.readBack(repository, [key], query);
      return items ? (items[0] ?? null) : null;
    });
  }

  /** Same changes for every key (`PATCH /items/:table` with `{ keys, data }`). */
  async updateMany(keys: PrimaryKey[], data: unknown, query: FieldsQuery = { fields: ['*'] }): Promise<Item[] | null> {
    this.assertWritable('update');
    this.assertKeys(keys);
    const changes = await this.prepareUpdate(this.asObject(data));
    return this.transaction(async (repository) => {
      await repository.updateMany(keys, changes);
      return this.readBack(repository, keys, query);
    });
  }

  /** Different changes per item; each item carries its primary key (`PATCH /items/:table` with an array). */
  async updateBatch(items: unknown[], query: FieldsQuery = { fields: ['*'] }): Promise<Item[] | null> {
    this.assertWritable('update');
    if (!Array.isArray(items) || items.length === 0) throw new InvalidPayloadError('Payload must contain at least one item');
    const pk = this.schema.table(this.table).primaryKey;
    const updates = await Promise.all(
      items.map(async (item) => {
        const { keyFields, rest } = this.splitKey(this.asObject(item), pk);
        return { key: keyFields, changes: await this.prepareUpdate(rest) };
      }),
    );
    return this.transaction(async (repository) => {
      const keys = updates.map(({ key }) => (pk.length === 1 ? (key[pk[0] as string] as string | number) : key));
      for (const [index, { changes }] of updates.entries()) {
        await repository.updateMany([keys[index] as PrimaryKey], changes);
      }
      return this.readBack(repository, keys, query);
    });
  }

  async deleteOne(key: PrimaryKey): Promise<void> {
    this.assertWritable('delete');
    await this.transaction(async (repository) => {
      const deleted = await repository.deleteMany([key]);
      if (deleted === 0) throw new NotFoundError();
    });
  }

  async deleteMany(keys: PrimaryKey[]): Promise<void> {
    this.assertWritable('delete');
    this.assertKeys(keys);
    await this.transaction((repository) => repository.deleteMany(keys));
  }

  // ---- Extension points ----------------------------------------------------

  /** Runs before an item is inserted. Override to transform or validate input. */
  protected async prepareCreate(data: Item): Promise<Item> {
    return data;
  }

  /** Runs before an item is updated. Override to transform or validate input. */
  protected async prepareUpdate(data: Item): Promise<Item> {
    return data;
  }

  protected createRepository(trx: Knex.Transaction): ItemsRepository {
    return new ItemsRepository(this.table, {
      knex: trx,
      schema: this.schema,
      tenantId: this.accountability.tenantId,
      onRelatedTable: (table) => this.permissions.assert('read', table),
    });
  }

  /**
   * Runs `fn` in a transaction. When row-level security is on, the tenant id
   * is set with `set_config(..., true)` (the same as `SET LOCAL`), so Postgres
   * policies see it for this transaction only.
   */
  protected async transaction<T>(fn: (repository: ItemsRepository, trx: Knex.Transaction) => Promise<T>): Promise<T> {
    return this.knex.transaction(async (trx) => {
      const { tenancy } = this.schema;
      if (tenancy.enabled && tenancy.rls && this.accountability.tenantId !== null) {
        await trx.raw('select set_config(?, ?, true)', [tenancy.settingName, this.accountability.tenantId]);
      }
      return fn(this.createRepository(trx), trx);
    });
  }

  // ---- Internals -----------------------------------------------------------

  private async readBack(repository: ItemsRepository, keys: PrimaryKey[], query: FieldsQuery): Promise<Item[] | null> {
    if (!this.permissions.can('read', this.table) || keys.length === 0) return null;
    return repository.readByKeys(keys, query);
  }

  private assertWritable(action: 'create' | 'update' | 'delete'): void {
    if (this.schema.table(this.table).readOnly) {
      throw new MethodNotAllowedError(`"${this.table}" is read-only`);
    }
    this.permissions.assert(action, this.table);
  }

  private assertKeys(keys: unknown): asserts keys is PrimaryKey[] {
    if (!Array.isArray(keys) || keys.length === 0) throw new InvalidPayloadError('"keys" must be a non-empty array');
  }

  private asObject(data: unknown): Item {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new InvalidPayloadError('Each item must be an object');
    }
    return { ...(data as Item) };
  }

  private splitKey(item: Item, pk: string[]): { keyFields: Record<string, string | number>; rest: Item } {
    if (pk.length === 0) throw new InvalidPayloadError(`"${this.table}" has no primary key, so items cannot be updated by key`);
    const keyFields: Record<string, string | number> = {};
    const rest: Item = { ...item };
    for (const column of pk) {
      const value = item[column];
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new InvalidPayloadError(`Each item needs its primary key "${column}"`);
      }
      keyFields[column] = value;
      delete rest[column];
    }
    return { keyFields, rest };
  }
}
