import type { Knex } from 'knex';
import type { GeneratorConfig } from '../config/types.js';
import { TypeMapper } from './TypeMapper.js';
import type {
  ColumnModel,
  DatabaseModel,
  EnumModel,
  ManyToOneRelation,
  ReferentialAction,
  TableModel,
  UniqueConstraintModel,
} from './types.js';

interface TableRow {
  table_name: string;
  comment: string | null;
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  full_type: string;
  atttypmod: number;
  nullable: boolean;
  default_value: string | null;
  attidentity: string;
  attgenerated: string;
  comment: string | null;
  is_array: boolean;
  element_oid: string;
  element_name: string;
}

interface EnumRow {
  oid: string;
  name: string;
  labels: string[];
}

interface ConstraintRow {
  constraint_name: string;
  constraint_type: 'p' | 'u' | 'f';
  table_name: string;
  columns: string[];
  foreign_schema: string | null;
  foreign_table: string | null;
  foreign_columns: string[] | null;
  on_delete: string;
  on_update: string;
}

export type IntrospectionConfig = Pick<GeneratorConfig, 'database' | 'tables' | 'tenancy' | 'overrides'>;

/** Reads tables, columns, keys and relations of one Postgres schema into a {@link DatabaseModel}. */
export class SchemaIntrospector {
  private static readonly REFERENTIAL_ACTIONS: Record<string, ReferentialAction> = {
    a: 'NO ACTION',
    r: 'RESTRICT',
    c: 'CASCADE',
    n: 'SET NULL',
    d: 'SET DEFAULT',
  };

  constructor(
    private readonly knex: Knex,
    private readonly config: IntrospectionConfig,
    private readonly typeMapper: TypeMapper = new TypeMapper(),
  ) {}

  async introspect(): Promise<DatabaseModel> {
    const schema = this.config.database.schema;
    const [tableRows, columnRows, enumRows, constraintRows] = await Promise.all([
      this.fetchTables(schema),
      this.fetchColumns(schema),
      this.fetchEnums(),
      this.fetchConstraints(schema),
    ]);

    const included = tableRows.filter((row) => this.isIncluded(row.table_name));
    const includedNames = new Set(included.map((row) => row.table_name));
    const enumsByOid = new Map(enumRows.map((row) => [row.oid, row]));
    const usedEnums = new Map<string, EnumModel>();
    const warnings: string[] = [];

    const tables: TableModel[] = included.map((row) => {
      const constraints = constraintRows.filter((c) => c.table_name === row.table_name);
      const primaryKey = constraints.find((c) => c.constraint_type === 'p')?.columns ?? [];
      if (primaryKey.length === 0) {
        warnings.push(`Table "${row.table_name}" has no primary key, so its by-id endpoints (/:id) cannot be generated.`);
      }

      const columns = columnRows
        .filter((c) => c.table_name === row.table_name)
        .map((c) => {
          const enumRow = enumsByOid.get(c.element_oid);
          if (enumRow) usedEnums.set(enumRow.name, { name: enumRow.name, values: enumRow.labels });
          return this.toColumn(c, primaryKey, enumRow?.labels ?? null);
        });

      return {
        name: row.table_name,
        comment: row.comment,
        columns,
        primaryKey,
        uniqueConstraints: constraints
          .filter((c) => c.constraint_type === 'u')
          .map((c): UniqueConstraintModel => ({ name: c.constraint_name, columns: c.columns })),
        manyToOne: constraints.filter((c) => c.constraint_type === 'f').map((c) => this.toManyToOne(c, schema)),
        oneToMany: [],
        tenantScoped: this.config.tenancy.enabled && columns.some((c) => c.name === this.config.tenancy.column),
      };
    });

    // Reverse side of every foreign key between included tables.
    const tablesByName = new Map(tables.map((table) => [table.name, table]));
    for (const table of tables) {
      for (const relation of table.manyToOne) {
        if (relation.foreignSchema !== schema || !includedNames.has(relation.foreignTable)) continue;
        tablesByName.get(relation.foreignTable)?.oneToMany.push({
          constraintName: relation.constraintName,
          table: table.name,
          columns: relation.columns,
          referencedColumns: relation.foreignColumns,
        });
      }
    }

    return {
      schema,
      tables,
      enums: [...usedEnums.values()].sort((a, b) => a.name.localeCompare(b.name)),
      warnings,
    };
  }

  private isIncluded(table: string): boolean {
    if (this.config.overrides[table]?.skip) return false;
    const matches = (patterns: string[]) => patterns.some((pattern) => this.globToRegExp(pattern).test(table));
    return matches(this.config.tables.include) && !matches(this.config.tables.exclude);
  }

  private globToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
  }

  private toColumn(row: ColumnRow, primaryKey: string[], enumValues: string[] | null): ColumnModel {
    const typmod = row.atttypmod > 0 ? row.atttypmod - 4 : null;
    const isText = row.element_name === 'varchar' || row.element_name === 'bpchar';
    const isNumeric = row.element_name === 'numeric';
    const maxLength = isText ? typmod : null;
    const { tsType, jsonSchema } = this.typeMapper.map({
      dataType: row.element_name,
      isArray: row.is_array,
      enumValues,
      maxLength,
    });

    return {
      name: row.column_name,
      dataType: row.element_name,
      fullType: row.full_type,
      isArray: row.is_array,
      nullable: row.nullable,
      defaultValue: row.default_value,
      hasDefault: row.default_value !== null || row.attidentity !== '' || row.attgenerated !== '',
      readOnly: row.attidentity === 'a' || row.attgenerated !== '',
      isPrimaryKey: primaryKey.includes(row.column_name),
      maxLength,
      numericPrecision: isNumeric && typmod !== null ? (typmod >> 16) & 0xffff : null,
      numericScale: isNumeric && typmod !== null ? typmod & 0xffff : null,
      enumValues,
      comment: row.comment,
      tsType,
      jsonSchema,
    };
  }

  private toManyToOne(row: ConstraintRow, schema: string): ManyToOneRelation {
    return {
      constraintName: row.constraint_name,
      columns: row.columns,
      foreignSchema: row.foreign_schema ?? schema,
      foreignTable: row.foreign_table ?? '',
      foreignColumns: row.foreign_columns ?? [],
      onDelete: SchemaIntrospector.REFERENTIAL_ACTIONS[row.on_delete] ?? 'NO ACTION',
      onUpdate: SchemaIntrospector.REFERENTIAL_ACTIONS[row.on_update] ?? 'NO ACTION',
    };
  }

  private async fetchTables(schema: string): Promise<TableRow[]> {
    const result = await this.knex.raw<{ rows: TableRow[] }>(
      `SELECT c.relname AS table_name, obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ? AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        ORDER BY c.relname`,
      [schema],
    );
    return result.rows;
  }

  private async fetchColumns(schema: string): Promise<ColumnRow[]> {
    // Domains are resolved to their base type; arrays report their element type.
    const result = await this.knex.raw<{ rows: ColumnRow[] }>(
      `WITH cols AS (
         SELECT c.relname AS table_name,
                a.attname AS column_name,
                a.attnum,
                format_type(a.atttypid, a.atttypmod) AS full_type,
                CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.oid END AS type_oid,
                CASE WHEN t.typtype = 'd' THEN t.typtypmod ELSE a.atttypmod END AS atttypmod,
                NOT a.attnotnull AS nullable,
                pg_get_expr(d.adbin, d.adrelid) AS default_value,
                a.attidentity::text AS attidentity,
                a.attgenerated::text AS attgenerated,
                col_description(c.oid, a.attnum) AS comment
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_type t ON t.oid = a.atttypid
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE n.nspname = ?
            AND c.relkind IN ('r', 'p')
            AND NOT c.relispartition
            AND a.attnum > 0
            AND NOT a.attisdropped
       )
       SELECT cols.table_name, cols.column_name, cols.full_type, cols.atttypmod, cols.nullable,
              cols.default_value, cols.attidentity, cols.attgenerated, cols.comment,
              (et.typcategory = 'A') AS is_array,
              (CASE WHEN et.typcategory = 'A' THEN el.oid ELSE et.oid END)::text AS element_oid,
              CASE WHEN et.typcategory = 'A' THEN el.typname ELSE et.typname END AS element_name
         FROM cols
         JOIN pg_type et ON et.oid = cols.type_oid
         LEFT JOIN pg_type el ON el.oid = et.typelem
        ORDER BY cols.table_name, cols.attnum`,
      [schema],
    );
    return result.rows;
  }

  private async fetchEnums(): Promise<EnumRow[]> {
    const result = await this.knex.raw<{ rows: EnumRow[] }>(
      `SELECT t.oid::text AS oid, t.typname AS name,
              array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS labels
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
        GROUP BY t.oid, t.typname`,
    );
    return result.rows;
  }

  private async fetchConstraints(schema: string): Promise<ConstraintRow[]> {
    const result = await this.knex.raw<{ rows: ConstraintRow[] }>(
      `SELECT con.conname AS constraint_name,
              con.contype::text AS constraint_type,
              c.relname AS table_name,
              array(SELECT a.attname
                      FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                     ORDER BY k.ord)::text[] AS columns,
              fn.nspname AS foreign_schema,
              fc.relname AS foreign_table,
              CASE WHEN con.contype = 'f' THEN
                array(SELECT a.attname
                        FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
                       ORDER BY k.ord)::text[]
              END AS foreign_columns,
              con.confdeltype::text AS on_delete,
              con.confupdtype::text AS on_update
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_class fc ON fc.oid = con.confrelid
         LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
        WHERE n.nspname = ? AND con.contype IN ('p', 'u', 'f')
        ORDER BY c.relname, con.conname`,
      [schema],
    );
    return result.rows;
  }
}
