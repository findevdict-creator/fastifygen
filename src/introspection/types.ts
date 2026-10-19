/**
 * The database as the generator sees it. Plain JSON, so it can be written to
 * disk, diffed, or shown in a frontend.
 */
export interface DatabaseModel {
  schema: string;
  tables: TableModel[];
  enums: EnumModel[];
  /** Things the generator can work around but the user should know about. */
  warnings: string[];
}

export interface TableModel {
  name: string;
  comment: string | null;
  columns: ColumnModel[];
  /** Primary key column names, in key order. Empty if the table has none. */
  primaryKey: string[];
  uniqueConstraints: UniqueConstraintModel[];
  /** Foreign keys declared on this table (this table holds the reference). */
  manyToOne: ManyToOneRelation[];
  /** Foreign keys on other tables that point at this table. */
  oneToMany: OneToManyRelation[];
  /** True when tenancy is enabled and the table has the tenant column. */
  tenantScoped: boolean;
}

export interface ColumnModel {
  name: string;
  /** Postgres type name, e.g. `int4`, `varchar`, `timestamptz`, or the enum's name. */
  dataType: string;
  /** Full type as Postgres prints it, e.g. `character varying(255)`. */
  fullType: string;
  isArray: boolean;
  nullable: boolean;
  /** Default expression as written in the database, e.g. `now()`. */
  defaultValue: string | null;
  /** Postgres fills it in: identity, serial, generated, or a default. */
  hasDefault: boolean;
  /** Identity or generated column; clients can never write it. */
  readOnly: boolean;
  isPrimaryKey: boolean;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  /** Enum labels when the column (or its array element) is an enum. */
  enumValues: string[] | null;
  comment: string | null;
  /** TypeScript type of the value as returned by node-postgres. */
  tsType: string;
  /** JSON Schema for a non-null value of this column. */
  jsonSchema: JsonSchema;
}

export interface UniqueConstraintModel {
  name: string;
  columns: string[];
}

export type ReferentialAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';

export interface ManyToOneRelation {
  constraintName: string;
  columns: string[];
  foreignSchema: string;
  foreignTable: string;
  foreignColumns: string[];
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
}

export interface OneToManyRelation {
  constraintName: string;
  /** Table that holds the foreign key. */
  table: string;
  /** Columns on `table` that hold the reference. */
  columns: string[];
  /** Columns on this table being referenced. */
  referencedColumns: string[];
}

export interface EnumModel {
  name: string;
  values: string[];
}

export type JsonSchema = Record<string, unknown>;
