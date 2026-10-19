import { ForbiddenError, InvalidQueryError } from '../errors.js';
import type { ResolvedRelation, SchemaOverview } from '../SchemaOverview.js';

export interface FieldTree {
  table: string;
  /** Columns to return, in request order. */
  columns: string[];
  relations: Map<string, { relation: ResolvedRelation; tree: FieldTree }>;
}

/**
 * Turns `fields` like `*,company_id.name,employee.*` into a tree of columns
 * and nested relations, checking every name against the schema.
 */
export class FieldsResolver {
  static readonly MAX_DEPTH = 5;

  constructor(
    private readonly schema: SchemaOverview,
    /** Called for every related table the fields reach, e.g. to check read permission. */
    private readonly onRelatedTable: (table: string) => void = () => {},
  ) {}

  resolve(table: string, fields: string[]): FieldTree {
    const tree = this.emptyTree(table);
    for (const field of fields) this.addPath(tree, field.split('.'), field, 0);
    if (tree.columns.length === 0 && tree.relations.size === 0) {
      throw new InvalidQueryError('"fields" did not select anything');
    }
    return tree;
  }

  private emptyTree(table: string): FieldTree {
    return { table, columns: [], relations: new Map() };
  }

  private addPath(tree: FieldTree, path: string[], original: string, depth: number): void {
    const [segment, ...rest] = path;
    if (segment === undefined || segment === '') throw new InvalidQueryError(`Invalid field "${original}"`);

    if (segment === '*') {
      if (rest.length === 0) {
        for (const column of this.schema.visibleColumns(tree.table)) this.addColumn(tree, column);
      } else {
        for (const field of this.schema.relationFields(tree.table)) this.addRelation(tree, field, rest, original, depth);
      }
      return;
    }

    if (rest.length === 0) {
      const column = this.schema.column(tree.table, segment);
      if (column) {
        if (column.hidden) throw new ForbiddenError(`Field "${segment}" on "${tree.table}" is not readable`);
        this.addColumn(tree, segment);
        return;
      }
      // A bare one-to-many alias returns the related items' primary keys.
      if (this.schema.relation(tree.table, segment)?.kind === 'o2m') {
        this.addRelation(tree, segment, ['__pk__'], original, depth);
        return;
      }
      throw new InvalidQueryError(`Field "${segment}" does not exist on "${tree.table}"`);
    }

    this.addRelation(tree, segment, rest, original, depth);
  }

  private addColumn(tree: FieldTree, column: string): void {
    if (!tree.columns.includes(column)) tree.columns.push(column);
  }

  private addRelation(tree: FieldTree, field: string, rest: string[], original: string, depth: number): void {
    const relation = this.schema.relation(tree.table, field);
    if (!relation) throw new InvalidQueryError(`Field "${field}" on "${tree.table}" is not a relation`);
    if (depth + 1 > FieldsResolver.MAX_DEPTH) {
      throw new InvalidQueryError(`Fields can be nested at most ${FieldsResolver.MAX_DEPTH} levels deep`);
    }

    const relatedTable = relation.kind === 'm2o' ? relation.foreignTable : relation.table;
    let entry = tree.relations.get(field);
    if (!entry) {
      this.onRelatedTable(relatedTable);
      entry = { relation, tree: this.emptyTree(relatedTable) };
      tree.relations.set(field, entry);
    }

    if (rest.length === 1 && rest[0] === '__pk__') {
      for (const column of this.schema.table(relatedTable).primaryKey) this.addColumn(entry.tree, column);
      return;
    }
    this.addPath(entry.tree, rest, original, depth + 1);
  }
}
