import { InvalidQueryError } from './errors.js';
import type { RuntimeColumn, RuntimeManyToOne, RuntimeOneToMany, RuntimeSchema, RuntimeTable } from './types.js';

export type ResolvedRelation =
  | ({ kind: 'm2o'; field: string } & RuntimeManyToOne)
  | ({ kind: 'o2m'; field: string } & RuntimeOneToMany);

export type PermissionAction = 'create' | 'read' | 'update' | 'delete';

/** Lookup helpers over a {@link RuntimeSchema}. */
export class SchemaOverview {
  constructor(readonly raw: RuntimeSchema) {}

  get tenancy() {
    return this.raw.tenancy;
  }

  get api() {
    return this.raw.api;
  }

  hasTable(name: string): boolean {
    return Object.hasOwn(this.raw.tables, name);
  }

  table(name: string): RuntimeTable {
    const table = this.raw.tables[name];
    if (!table || !Object.hasOwn(this.raw.tables, name)) throw new InvalidQueryError(`Collection "${name}" does not exist`);
    return table;
  }

  column(table: string, name: string): RuntimeColumn | undefined {
    const columns = this.table(table).columns;
    return Object.hasOwn(columns, name) ? columns[name] : undefined;
  }

  /** Column names a client may see, in table order. */
  visibleColumns(table: string): string[] {
    return Object.values(this.table(table).columns)
      .filter((column) => !column.hidden)
      .map((column) => column.name);
  }

  relation(table: string, field: string): ResolvedRelation | undefined {
    const { manyToOne, oneToMany } = this.table(table);
    if (Object.hasOwn(manyToOne, field)) {
      const relation = manyToOne[field] as RuntimeManyToOne;
      return this.hasTable(relation.foreignTable) ? { kind: 'm2o', field, ...relation } : undefined;
    }
    if (Object.hasOwn(oneToMany, field)) return { kind: 'o2m', field, ...(oneToMany[field] as RuntimeOneToMany) };
    return undefined;
  }

  relationFields(table: string): string[] {
    const { manyToOne, oneToMany } = this.table(table);
    return [...Object.keys(manyToOne), ...Object.keys(oneToMany)].filter((field) => this.relation(table, field));
  }

  /** Tenant column to scope by, or null when the table is not tenant-scoped. */
  tenantColumn(table: string): string | null {
    return this.tenancy.enabled && this.table(table).tenantScoped ? this.tenancy.column : null;
  }

  permissionName(action: PermissionAction | '*', table: string): string {
    return this.raw.permissions.format.replaceAll('{action}', action).replaceAll('{table}', table);
  }
}
