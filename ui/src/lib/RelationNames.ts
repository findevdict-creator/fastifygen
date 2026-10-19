import type { TableModel } from '../api/types.js';

/**
 * Field names of one-to-many relations, as the generated API names them
 * (mirrors RuntimeSchemaBuilder): the referencing table's name, or
 * `{table}_by_{columns}` when that table references this one more than once
 * or the name is already taken.
 */
export class RelationNames {
  static oneToMany(table: TableModel): Map<string, string> {
    const taken = new Set([
      ...table.columns.map((column) => column.name),
      ...table.manyToOne.map((fk) => (fk.columns.length === 1 ? (fk.columns[0] as string) : fk.constraintName)),
    ]);
    const perTable = new Map<string, number>();
    for (const relation of table.oneToMany) perTable.set(relation.table, (perTable.get(relation.table) ?? 0) + 1);

    const names = new Map<string, string>();
    for (const relation of table.oneToMany) {
      let field = relation.table;
      if ((perTable.get(relation.table) ?? 0) > 1 || taken.has(field)) field = `${relation.table}_by_${relation.columns.join('_')}`;
      taken.add(field);
      names.set(relation.constraintName, field);
    }
    return names;
  }
}
