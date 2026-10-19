/**
 * Types shared by the runtime core. The runtime is copied into every
 * generated API, so it must not import anything from the generator side.
 */

/** Everything the runtime needs to know about the database and settings. Plain JSON. */
export interface RuntimeSchema {
  /** Postgres schema the tables live in. */
  schema: string;
  tables: Record<string, RuntimeTable>;
  tenancy: {
    enabled: boolean;
    column: string;
    rls: boolean;
    settingName: string;
  };
  api: {
    defaultLimit: number;
    maxLimit: number;
  };
  permissions: {
    format: string;
  };
}

export interface RuntimeTable {
  name: string;
  /** Primary key columns in key order. Empty when the table has none. */
  primaryKey: string[];
  columns: Record<string, RuntimeColumn>;
  /** Many-to-one relations, keyed by the field name used in `fields` and `filter`. */
  manyToOne: Record<string, RuntimeManyToOne>;
  /** One-to-many relations, keyed by alias field name. */
  oneToMany: Record<string, RuntimeOneToMany>;
  tenantScoped: boolean;
  /** Only read operations are allowed. */
  readOnly: boolean;
}

export interface RuntimeColumn {
  name: string;
  dataType: string;
  isArray: boolean;
  nullable: boolean;
  hasDefault: boolean;
  /** Identity or generated column: never accepted in payloads. */
  readOnly: boolean;
  /** Never returned, filtered, sorted or searched on. Still writable. */
  hidden: boolean;
}

export interface RuntimeManyToOne {
  columns: string[];
  foreignTable: string;
  foreignColumns: string[];
}

export interface RuntimeOneToMany {
  /** Table that holds the foreign key. */
  table: string;
  /** Foreign key columns on `table`. */
  columns: string[];
  /** Columns on this table being referenced. */
  referencedColumns: string[];
}

/** Who is making the request. Set on `request.accountability` by the auth hook. */
export interface Accountability {
  userId: string | null;
  tenantId: string | null;
  /** Permission names, e.g. `read:company`. `*` grants everything. */
  permissions: string[];
}

export type Item = Record<string, unknown>;

/** Primary key value; an object for composite keys. */
export type PrimaryKey = string | number | Record<string, string | number>;

export type FilterOperator =
  | '_eq'
  | '_neq'
  | '_lt'
  | '_lte'
  | '_gt'
  | '_gte'
  | '_in'
  | '_nin'
  | '_null'
  | '_nnull'
  | '_contains'
  | '_ncontains'
  | '_icontains'
  | '_starts_with'
  | '_istarts_with'
  | '_ends_with'
  | '_iends_with'
  | '_between'
  | '_nbetween'
  | '_empty'
  | '_nempty';

/** Directus-style filter: `{ name: { _eq: 'Acme' }, _or: [...], company_id: { status: { _eq: 'active' } } }`. */
export type Filter = { [key: string]: unknown };

export type MetaField = 'total_count' | 'filter_count';

/** A parsed and validated request query. */
export interface Query {
  fields: string[];
  filter: Filter | null;
  /** Column names; a leading `-` means descending. */
  sort: string[];
  limit: number;
  offset: number;
  search: string | null;
  meta: MetaField[];
}

export interface ReadManyResult {
  data: Item[];
  meta?: Partial<Record<MetaField, number>>;
}
