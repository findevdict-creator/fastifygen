import type { GeneratorConfig } from '../config/types.js';
import type { DatabaseModel, TableModel } from '../introspection/types.js';
import type { RuntimeManyToOne, RuntimeOneToMany, RuntimeSchema, RuntimeTable } from '../runtime/types.js';

/**
 * Turns the introspected {@link DatabaseModel} plus `config.json` into the
 * {@link RuntimeSchema} the generated API loads at startup.
 *
 * Relation field names, Directus-style:
 * - many-to-one: the foreign key column (`company_id`), or the constraint name for composite keys;
 * - one-to-many: the referencing table (`employee`), or `{table}_by_{columns}` when that
 *   name is taken or the same table references this one more than once.
 */
export class RuntimeSchemaBuilder {
  constructor(private readonly config: GeneratorConfig) {}

  build(model: DatabaseModel): RuntimeSchema {
    const tableNames = new Set(model.tables.map((table) => table.name));
    return {
      schema: model.schema,
      tables: Object.fromEntries(model.tables.map((table) => [table.name, this.buildTable(table, model.schema, tableNames)])),
      tenancy: { ...this.config.tenancy },
      api: { defaultLimit: this.config.api.defaultLimit, maxLimit: this.config.api.maxLimit },
      permissions: { format: this.config.permissions.format },
    };
  }

  private buildTable(table: TableModel, schema: string, tableNames: Set<string>): RuntimeTable {
    const override = this.config.overrides[table.name] ?? {};
    const hidden = new Set(override.hiddenColumns ?? []);

    const columns = Object.fromEntries(
      table.columns.map((column) => [
        column.name,
        {
          name: column.name,
          dataType: column.dataType,
          isArray: column.isArray,
          nullable: column.nullable,
          hasDefault: column.hasDefault,
          readOnly: column.readOnly,
          hidden: hidden.has(column.name),
        },
      ]),
    );

    const manyToOne: Record<string, RuntimeManyToOne> = {};
    for (const relation of table.manyToOne) {
      if (relation.foreignSchema !== schema || !tableNames.has(relation.foreignTable)) continue;
      const field = relation.columns.length === 1 ? (relation.columns[0] as string) : relation.constraintName;
      manyToOne[field] = {
        columns: relation.columns,
        foreignTable: relation.foreignTable,
        foreignColumns: relation.foreignColumns,
      };
    }

    const oneToMany: Record<string, RuntimeOneToMany> = {};
    const referencesPerTable = new Map<string, number>();
    for (const relation of table.oneToMany) {
      referencesPerTable.set(relation.table, (referencesPerTable.get(relation.table) ?? 0) + 1);
    }
    for (const relation of table.oneToMany) {
      let field = relation.table;
      const taken = (name: string) => name in columns || name in manyToOne || name in oneToMany;
      if ((referencesPerTable.get(relation.table) ?? 0) > 1 || taken(field)) {
        field = `${relation.table}_by_${relation.columns.join('_')}`;
      }
      oneToMany[field] = {
        table: relation.table,
        columns: relation.columns,
        referencedColumns: relation.referencedColumns,
      };
    }

    return {
      name: table.name,
      primaryKey: table.primaryKey,
      columns,
      manyToOne,
      oneToMany,
      tenantScoped: table.tenantScoped,
      readOnly: override.readOnly ?? false,
    };
  }
}
