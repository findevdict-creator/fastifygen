import type { Knex } from 'knex';
import { ApiError, ForbiddenError, InvalidPayloadError, InvalidQueryError, NotFoundError } from './errors.js';
import { FieldsResolver, type FieldTree } from './query/FieldsResolver.js';
import { FilterApplier } from './query/FilterApplier.js';
import type { SchemaOverview } from './SchemaOverview.js';
import type { Item, MetaField, PrimaryKey, Query, RuntimeTable } from './types.js';

export interface RepositoryContext {
  /** A Knex instance or an open transaction. */
  knex: Knex | Knex.Transaction;
  schema: SchemaOverview;
  tenantId: string | null;
  /** Called for every related table a query reaches through `fields` or `filter`. */
  onRelatedTable?: (table: string) => void;
}

type KeyObject = Record<string, string | number>;

interface FetchOptions {
  /** Narrows the base rows, e.g. to related keys or primary keys. */
  where?: (qb: Knex.QueryBuilder, alias: string) => void;
  /** Extra columns the caller needs in the rows, beyond the tree's own. */
  extraColumns?: string[];
  query?: Pick<Query, 'filter' | 'search' | 'sort' | 'limit' | 'offset'>;
}

const SEARCHABLE_TEXT = new Set(['text', 'varchar', 'bpchar', 'citext', 'name']);
const SEARCHABLE_INT = new Set(['int2', 'int4', 'int8']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Data access for one table, keyed by table name. Knows nothing about HTTP or
 * permissions; it scopes every query to the tenant and checks every field
 * name against the schema.
 */
export class ItemsRepository {
  protected readonly knex: Knex | Knex.Transaction;
  protected readonly schema: SchemaOverview;
  protected readonly tenantId: string | null;
  protected readonly meta: RuntimeTable;

  constructor(
    readonly table: string,
    protected readonly ctx: RepositoryContext,
  ) {
    this.knex = ctx.knex;
    this.schema = ctx.schema;
    this.tenantId = ctx.tenantId;
    this.meta = ctx.schema.table(table);
    if (ctx.schema.tenantColumn(table) && ctx.tenantId === null) {
      throw new ForbiddenError(`"${table}" requires a tenant`);
    }
  }

  // ---- Reads ---------------------------------------------------------------

  async readMany(query: Query): Promise<Item[]> {
    return this.fetch(this.resolveFields(query.fields), { query });
  }

  async readOne(key: PrimaryKey, query: Pick<Query, 'fields'>): Promise<Item> {
    const [item] = await this.readByKeys([key], query);
    if (!item) throw new NotFoundError();
    return item;
  }

  /** Reads items by primary key, in the order the keys were given. Missing keys are skipped. */
  async readByKeys(keys: PrimaryKey[], query: Pick<Query, 'fields'>): Promise<Item[]> {
    const keyObjects = keys.map((key) => this.parseKey(key));
    const pk = this.requirePrimaryKey();
    const fields = this.resolveFields(query.fields);
    const rows = await this.fetch(fields, {
      where: (qb, alias) => this.whereKeys(qb, alias, keyObjects),
      extraColumns: pk,
    });
    const byKey = new Map(rows.map((row) => [this.keyString(pk.map((column) => row[column])), row]));
    const ordered = keyObjects
      .map((key) => byKey.get(this.keyString(pk.map((column) => key[column]))))
      .filter((row): row is Item => row !== undefined);
    for (const column of pk) {
      if (!fields.columns.includes(column) && !fields.relations.has(column)) {
        for (const row of new Set(ordered)) delete row[column];
      }
    }
    return ordered;
  }

  async count(query: Query, kind: MetaField): Promise<number> {
    const filters = new FilterApplier({ ...this.ctx, knex: this.knex as Knex });
    const qb = this.knex.from(`${this.schema.raw.schema}.${this.table} as t0`).count({ count: '*' });
    filters.scopeTenant(qb, this.table, 't0');
    if (kind === 'filter_count') {
      if (query.filter) filters.apply(qb, this.table, 't0', query.filter);
      if (query.search) this.applySearch(qb, 't0', query.search);
    }
    const [row] = await qb;
    return Number((row as { count: string | number } | undefined)?.count ?? 0);
  }

  // ---- Writes --------------------------------------------------------------

  /** Inserts items and returns their primary keys (empty when the table has no primary key). */
  async createMany(items: unknown[]): Promise<KeyObject[]> {
    if (items.length === 0) throw new InvalidPayloadError('Payload must contain at least one item');
    const rows = items.map((item) => {
      const row = this.sanitizePayload(item, 'create');
      const tenantColumn = this.schema.tenantColumn(this.table);
      if (tenantColumn) row[tenantColumn] = this.tenantId;
      return row;
    });
    await this.assertReferencesInTenant(rows);
    const insert = this.knex(`${this.schema.raw.schema}.${this.table}`).insert(rows);
    if (this.meta.primaryKey.length === 0) {
      await insert;
      return [];
    }
    return (await insert.returning(this.meta.primaryKey)) as KeyObject[];
  }

  /** Applies the same changes to every key. Returns how many rows changed. */
  async updateMany(keys: PrimaryKey[], data: unknown): Promise<number> {
    const changes = this.sanitizePayload(data, 'update');
    if (Object.keys(changes).length === 0) throw new InvalidPayloadError('Payload has no fields to update');
    await this.assertReferencesInTenant([changes]);
    const qb = this.knex(`${this.schema.raw.schema}.${this.table} as t0`);
    this.scopeTenant(qb, 't0');
    this.whereKeys(qb, 't0', keys.map((key) => this.parseKey(key)));
    return qb.update(changes);
  }

  async deleteMany(keys: PrimaryKey[]): Promise<number> {
    const qb = this.knex(`${this.schema.raw.schema}.${this.table} as t0`);
    this.scopeTenant(qb, 't0');
    this.whereKeys(qb, 't0', keys.map((key) => this.parseKey(key)));
    return qb.delete();
  }

  // ---- Keys ----------------------------------------------------------------

  /** Accepts `5`, `"5"`, `"3,7"` for a composite key, or `{ project_id: 3, employee_id: 7 }`. */
  parseKey(key: PrimaryKey): KeyObject {
    const pk = this.requirePrimaryKey();
    if (typeof key === 'object' && key !== null) {
      const missing = pk.filter((column) => key[column] === undefined);
      if (missing.length) throw new InvalidPayloadError(`Primary key is missing "${missing.join('", "')}"`);
      return Object.fromEntries(pk.map((column) => [column, key[column] as string | number]));
    }
    if (typeof key !== 'string' && typeof key !== 'number') throw new InvalidPayloadError('Invalid primary key');
    const parts = pk.length === 1 ? [key] : String(key).split(',');
    if (parts.length !== pk.length || parts.some((part) => part === '')) {
      throw new InvalidPayloadError(`Primary key must have ${pk.length} comma-separated values: ${pk.join(', ')}`);
    }
    return Object.fromEntries(pk.map((column, index) => [column, parts[index] as string | number]));
  }

  /** Primary key of a row, in the shape the API uses (a value, or an object for composite keys). */
  keyOf(row: Item): PrimaryKey {
    const pk = this.requirePrimaryKey();
    if (pk.length === 1) return row[pk[0] as string] as string | number;
    return Object.fromEntries(pk.map((column) => [column, row[column] as string | number]));
  }

  protected requirePrimaryKey(): string[] {
    if (this.meta.primaryKey.length === 0) {
      throw new InvalidQueryError(`"${this.table}" has no primary key, so items cannot be addressed by key`);
    }
    return this.meta.primaryKey;
  }

  // ---- Internals -----------------------------------------------------------

  protected resolveFields(fields: string[]): FieldTree {
    return new FieldsResolver(this.schema, this.ctx.onRelatedTable).resolve(this.table, fields);
  }

  /**
   * Loads rows for a field tree, then loads each requested relation with one
   * extra query per relation (no N+1) and attaches it to the rows.
   */
  protected async fetch(tree: FieldTree, options: FetchOptions = {}): Promise<Item[]> {
    const table = tree.table;
    const meta = this.schema.table(table);
    const filters = new FilterApplier({ ...this.ctx, knex: this.knex as Knex });

    const needed = new Set<string>([...tree.columns, ...(options.extraColumns ?? [])]);
    const helpers = new Set<string>();
    const need = (column: string) => {
      if (!needed.has(column)) helpers.add(column);
      needed.add(column);
    };
    for (const { relation } of tree.relations.values()) {
      (relation.kind === 'm2o' ? relation.columns : relation.referencedColumns).forEach(need);
    }

    const qb = this.knex
      .from(`${this.schema.raw.schema}.${table} as t0`)
      .select([...needed].map((column) => `t0.${column}`));
    filters.scopeTenant(qb, table, 't0');
    options.where?.(qb, 't0');

    const query = options.query;
    if (query?.filter) filters.apply(qb, table, 't0', query.filter);
    if (query?.search) this.applySearch(qb, 't0', query.search, table);
    const sort = query?.sort.length ? query.sort : meta.primaryKey;
    for (const entry of sort) {
      const descending = entry.startsWith('-');
      const column = descending ? entry.slice(1) : entry;
      const columnMeta = this.schema.column(table, column);
      if (!columnMeta) throw new InvalidQueryError(`Cannot sort by "${column}": it does not exist on "${table}"`);
      if (columnMeta.hidden) throw new ForbiddenError(`Cannot sort by "${column}" on "${table}"`);
      qb.orderBy(`t0.${column}`, descending ? 'desc' : 'asc');
    }
    if (query) qb.limit(query.limit).offset(query.offset);

    const rows = (await qb) as Item[];
    if (rows.length === 0) return rows;

    for (const [field, { relation, tree: subtree }] of tree.relations) {
      if (relation.kind === 'm2o') await this.attachManyToOne(rows, field, relation, subtree);
      else await this.attachOneToMany(rows, field, relation, subtree);
    }

    for (const column of helpers) {
      if (tree.relations.has(column)) continue;
      for (const row of rows) delete row[column];
    }
    return rows;
  }

  private async attachManyToOne(
    rows: Item[],
    field: string,
    relation: { columns: string[]; foreignColumns: string[] },
    subtree: FieldTree,
  ): Promise<void> {
    const keyOf = (row: Item, columns: string[]) => columns.map((column) => row[column]);
    const keys = this.uniqueKeys(rows.map((row) => keyOf(row, relation.columns)));
    const related = keys.length
      ? await this.fetch(subtree, {
          where: (qb, alias) => this.whereTuples(qb, alias, relation.foreignColumns, keys),
          extraColumns: relation.foreignColumns,
        })
      : [];
    const byKey = new Map(related.map((item) => [this.keyString(keyOf(item, relation.foreignColumns)), item]));
    for (const row of rows) row[field] = byKey.get(this.keyString(keyOf(row, relation.columns))) ?? null;
    this.stripExtra(related, relation.foreignColumns, subtree);
  }

  private async attachOneToMany(
    rows: Item[],
    field: string,
    relation: { columns: string[]; referencedColumns: string[] },
    subtree: FieldTree,
  ): Promise<void> {
    const keyOf = (row: Item, columns: string[]) => columns.map((column) => row[column]);
    const keys = this.uniqueKeys(rows.map((row) => keyOf(row, relation.referencedColumns)));
    const related = keys.length
      ? await this.fetch(subtree, {
          where: (qb, alias) => this.whereTuples(qb, alias, relation.columns, keys),
          extraColumns: relation.columns,
        })
      : [];
    const groups = new Map<string, Item[]>();
    for (const item of related) {
      const key = this.keyString(keyOf(item, relation.columns));
      const group = groups.get(key);
      if (group) group.push(item);
      else groups.set(key, [item]);
    }
    for (const row of rows) row[field] = groups.get(this.keyString(keyOf(row, relation.referencedColumns))) ?? [];
    this.stripExtra(related, relation.columns, subtree);
  }

  private stripExtra(items: Item[], columns: string[], tree: FieldTree): void {
    for (const column of columns) {
      if (tree.columns.includes(column) || tree.relations.has(column)) continue;
      for (const item of items) delete item[column];
    }
  }

  private uniqueKeys(keys: unknown[][]): unknown[][] {
    const seen = new Map<string, unknown[]>();
    for (const key of keys) {
      if (key.some((part) => part === null || part === undefined)) continue;
      seen.set(this.keyString(key), key);
    }
    return [...seen.values()];
  }

  private keyString(parts: unknown[]): string {
    return JSON.stringify(parts.map((part) => (part === null || part === undefined ? null : String(part))));
  }

  protected whereKeys(qb: Knex.QueryBuilder, alias: string, keys: KeyObject[]): void {
    const pk = this.requirePrimaryKey();
    this.whereTuples(qb, alias, pk, keys.map((key) => pk.map((column) => key[column])));
  }

  private whereTuples(qb: Knex.QueryBuilder, alias: string, columns: string[], tuples: unknown[][]): void {
    if (tuples.length === 0) {
      qb.whereRaw('false');
    } else if (columns.length === 1) {
      qb.whereIn(`${alias}.${columns[0]}`, tuples.map((tuple) => tuple[0]) as Knex.Value[]);
    } else {
      qb.whereIn(
        columns.map((column) => `${alias}.${column}`),
        tuples as Knex.Value[][],
      );
    }
  }

  protected scopeTenant(qb: Knex.QueryBuilder, alias: string): void {
    const column = this.schema.tenantColumn(this.table);
    if (column) qb.where(`${alias}.${column}`, this.tenantId);
  }

  /** Case-insensitive match on text columns, exact match on numbers and UUIDs. */
  protected applySearch(qb: Knex.QueryBuilder, alias: string, search: string, table = this.table): void {
    const columns = Object.values(this.schema.table(table).columns).filter((column) => !column.hidden && !column.isArray);
    const pattern = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    qb.where((group) => {
      group.whereRaw('false');
      for (const column of columns) {
        const ref = `${alias}.${column.name}`;
        if (SEARCHABLE_TEXT.has(column.dataType)) {
          group.orWhereRaw(`?? ILIKE ? ESCAPE '\\'`, [ref, pattern]);
        } else if (column.dataType === 'uuid' && UUID.test(search)) {
          group.orWhere(ref, search);
        } else if (SEARCHABLE_INT.has(column.dataType) && /^-?\d{1,9}$/.test(search)) {
          group.orWhere(ref, Number(search));
        }
      }
    });
  }

  /**
   * Foreign keys only check that the referenced row exists, not that it
   * belongs to the same tenant. Reject references into another tenant.
   */
  protected async assertReferencesInTenant(rows: Item[]): Promise<void> {
    if (this.tenantId === null) return;
    for (const [field, relation] of Object.entries(this.meta.manyToOne)) {
      if (!this.schema.hasTable(relation.foreignTable)) continue;
      const foreignTenantColumn = this.schema.tenantColumn(relation.foreignTable);
      if (!foreignTenantColumn) continue;
      const tuples = this.uniqueKeys(rows.map((row) => relation.columns.map((column) => row[column])));
      if (tuples.length === 0) continue;
      const qb = this.knex
        .from(`${this.schema.raw.schema}.${relation.foreignTable} as r`)
        .select(relation.foreignColumns.map((column) => `r.${column}`))
        .where(`r.${foreignTenantColumn}`, this.tenantId);
      this.whereTuples(qb, 'r', relation.foreignColumns, tuples);
      const found = await qb;
      if (found.length < tuples.length) {
        throw new ApiError(`Field "${field}" references an item that does not exist`, 400, 'INVALID_FOREIGN_KEY', { field });
      }
    }
  }

  /** Checks a payload against the table: known, writable columns only. */
  protected sanitizePayload(data: unknown, mode: 'create' | 'update'): Item {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new InvalidPayloadError('Each item must be an object');
    }
    const tenantColumn = this.schema.tenantColumn(this.table);
    const row: Item = {};
    for (const [field, value] of Object.entries(data)) {
      const column = this.schema.column(this.table, field);
      if (!column) {
        if (this.schema.relation(this.table, field)) {
          throw new InvalidPayloadError(`Nested writes are not supported yet ("${field}")`, { field });
        }
        throw new InvalidPayloadError(`Field "${field}" does not exist on "${this.table}"`, { field });
      }
      if (column.readOnly) throw new InvalidPayloadError(`Field "${field}" is read-only`, { field });
      if (field === tenantColumn) throw new InvalidPayloadError(`Field "${field}" is set by the server`, { field });
      if (mode === 'update' && this.meta.primaryKey.includes(field)) {
        throw new InvalidPayloadError(`Primary key "${field}" cannot be changed`, { field });
      }
      const isJson = column.dataType === 'json' || column.dataType === 'jsonb';
      if (value !== null && typeof value === 'object' && !isJson && !column.isArray) {
        throw new InvalidPayloadError(`Field "${field}" must be a single value`, { field });
      }
      // node-postgres would send a JS array as a Postgres array literal; json columns need a JSON string.
      row[field] = isJson && value !== null ? JSON.stringify(value) : value;
    }
    return row;
  }
}
