import type { Knex } from 'knex';
import { ForbiddenError, InvalidQueryError } from '../errors.js';
import type { ResolvedRelation, SchemaOverview } from '../SchemaOverview.js';
import type { Filter, FilterOperator } from '../types.js';

export interface FilterContext {
  knex: Knex;
  schema: SchemaOverview;
  tenantId: string | null;
  /** Called for every related table a filter reaches, e.g. to check read permission. */
  onRelatedTable?: (table: string) => void;
}

const OPERATORS = new Set<string>([
  '_eq', '_neq', '_lt', '_lte', '_gt', '_gte', '_in', '_nin', '_null', '_nnull',
  '_contains', '_ncontains', '_icontains', '_starts_with', '_istarts_with',
  '_ends_with', '_iends_with', '_between', '_nbetween', '_empty', '_nempty',
]);

/**
 * Applies a Directus-style filter to a Knex query. Relational filters become
 * `EXISTS` subqueries, so they never duplicate rows:
 * - many-to-one: `{ company_id: { name: { _eq: 'Acme' } } }`
 * - one-to-many: `{ employee: { _some: { salary: { _gt: 1000 } } } }` (or `_none`; a bare filter means `_some`)
 */
export class FilterApplier {
  private aliasCounter = 0;

  constructor(private readonly ctx: FilterContext) {}

  /** Adds `filter` to `qb`, where the table is available as `alias`. */
  apply(qb: Knex.QueryBuilder, table: string, alias: string, filter: Filter): void {
    this.applyGroup(qb, table, alias, filter);
  }

  /** Restricts `alias` to the current tenant when the table is tenant-scoped. */
  scopeTenant(qb: Knex.QueryBuilder, table: string, alias: string): void {
    const column = this.ctx.schema.tenantColumn(table);
    if (!column) return;
    if (this.ctx.tenantId === null) throw new ForbiddenError(`"${table}" requires a tenant`);
    qb.where(`${alias}.${column}`, this.ctx.tenantId);
  }

  private applyGroup(qb: Knex.QueryBuilder, table: string, alias: string, filter: unknown): void {
    if (!this.isPlainObject(filter)) throw new InvalidQueryError('Filter must be an object');
    for (const [key, value] of Object.entries(filter)) {
      if (key === '_and' || key === '_or') {
        if (!Array.isArray(value) || value.length === 0) throw new InvalidQueryError(`"${key}" must be a non-empty array`);
        qb.where((group) => {
          for (const item of value) {
            const add = (inner: Knex.QueryBuilder) => this.applyGroup(inner, table, alias, item);
            if (key === '_and') group.where(add);
            else group.orWhere(add);
          }
        });
        continue;
      }

      const column = this.ctx.schema.column(table, key);
      const relation = this.ctx.schema.relation(table, key);
      // A many-to-one field shares its name with its foreign key column:
      // operators filter the column, anything else filters the related item.
      if (column && (!relation || this.isOperatorObject(value))) {
        if (column.hidden) throw new ForbiddenError(`Field "${key}" on "${table}" cannot be filtered`);
        this.applyOperators(qb, `${alias}.${key}`, column.isArray, value);
      } else if (relation) {
        this.applyRelation(qb, table, alias, relation, value);
      } else {
        throw new InvalidQueryError(`Field "${key}" does not exist on "${table}"`);
      }
    }
  }

  private applyRelation(qb: Knex.QueryBuilder, table: string, alias: string, relation: ResolvedRelation, value: unknown): void {
    if (!this.isPlainObject(value)) throw new InvalidQueryError(`Filter on relation "${relation.field}" must be an object`);
    const { knex, schema } = this.ctx;
    const related = relation.kind === 'm2o' ? relation.foreignTable : relation.table;
    this.ctx.onRelatedTable?.(related);
    const relatedAlias = `f${++this.aliasCounter}`;

    let nested: unknown = value;
    let negate = false;
    if (relation.kind === 'o2m') {
      const keys = Object.keys(value);
      if (keys.length === 1 && (keys[0] === '_some' || keys[0] === '_none')) {
        negate = keys[0] === '_none';
        nested = value[keys[0]];
      }
    }

    const subquery = (sub: Knex.QueryBuilder) => {
      sub.select(knex.raw('1')).from(`${schema.raw.schema}.${related} as ${relatedAlias}`);
      const [ownColumns, otherColumns] =
        relation.kind === 'm2o' ? [relation.columns, relation.foreignColumns] : [relation.referencedColumns, relation.columns];
      ownColumns.forEach((own, index) => sub.where(`${relatedAlias}.${otherColumns[index]}`, knex.ref(`${alias}.${own}`)));
      this.scopeTenant(sub, related, relatedAlias);
      this.applyGroup(sub, related, relatedAlias, nested);
    };

    if (negate) qb.whereNotExists(subquery);
    else qb.whereExists(subquery);
  }

  private applyOperators(qb: Knex.QueryBuilder, ref: string, isArray: boolean, value: unknown): void {
    if (!this.isPlainObject(value)) {
      this.applyOperator(qb, ref, isArray, '_eq', value);
      return;
    }
    for (const [operator, operand] of Object.entries(value)) {
      if (!OPERATORS.has(operator)) throw new InvalidQueryError(`Unknown filter operator "${operator}"`);
      this.applyOperator(qb, ref, isArray, operator as FilterOperator, operand);
    }
  }

  private applyOperator(qb: Knex.QueryBuilder, ref: string, isArray: boolean, operator: FilterOperator, value: unknown): void {
    const { knex } = this.ctx;
    switch (operator) {
      case '_eq':
        if (value === null || value === 'null') qb.whereNull(ref);
        else qb.where(ref, '=', this.scalar(value, operator));
        return;
      case '_neq':
        if (value === null || value === 'null') qb.whereNotNull(ref);
        else qb.where((group) => group.where(ref, '<>', this.scalar(value, operator)).orWhereNull(ref));
        return;
      case '_lt':
        qb.where(ref, '<', this.scalar(value, operator));
        return;
      case '_lte':
        qb.where(ref, '<=', this.scalar(value, operator));
        return;
      case '_gt':
        qb.where(ref, '>', this.scalar(value, operator));
        return;
      case '_gte':
        qb.where(ref, '>=', this.scalar(value, operator));
        return;
      case '_in':
        qb.whereIn(ref, this.list(value, operator));
        return;
      case '_nin':
        qb.where((group) => group.whereNotIn(ref, this.list(value, operator)).orWhereNull(ref));
        return;
      case '_null':
        if (this.bool(value, operator)) qb.whereNull(ref);
        else qb.whereNotNull(ref);
        return;
      case '_nnull':
        if (this.bool(value, operator)) qb.whereNotNull(ref);
        else qb.whereNull(ref);
        return;
      case '_contains':
      case '_ncontains':
        if (isArray) {
          const clause = knex.raw('? = ANY(??)', [this.scalar(value, operator), ref]);
          if (operator === '_contains') qb.where(clause);
          else qb.whereNot(clause);
          return;
        }
        this.like(qb, ref, `%${this.escapeLike(value, operator)}%`, 'LIKE', operator === '_ncontains');
        return;
      case '_icontains':
        this.like(qb, ref, `%${this.escapeLike(value, operator)}%`, 'ILIKE', false);
        return;
      case '_starts_with':
        this.like(qb, ref, `${this.escapeLike(value, operator)}%`, 'LIKE', false);
        return;
      case '_istarts_with':
        this.like(qb, ref, `${this.escapeLike(value, operator)}%`, 'ILIKE', false);
        return;
      case '_ends_with':
        this.like(qb, ref, `%${this.escapeLike(value, operator)}`, 'LIKE', false);
        return;
      case '_iends_with':
        this.like(qb, ref, `%${this.escapeLike(value, operator)}`, 'ILIKE', false);
        return;
      case '_between':
      case '_nbetween': {
        const range = this.list(value, operator);
        if (range.length !== 2) throw new InvalidQueryError(`"${operator}" needs exactly two values`);
        const [from, to] = range as [string | number, string | number];
        if (operator === '_between') qb.whereBetween(ref, [from, to]);
        else qb.whereNotBetween(ref, [from, to]);
        return;
      }
      case '_empty':
      case '_nempty': {
        const emptyCheck = isArray ? knex.raw('cardinality(??) = 0', [ref]) : knex.raw("??::text = ''", [ref]);
        const empty = this.bool(value, operator) === (operator === '_empty');
        if (empty) qb.where((group) => group.whereNull(ref).orWhere(emptyCheck));
        else qb.whereNotNull(ref).whereNot(emptyCheck);
        return;
      }
    }
  }

  private like(qb: Knex.QueryBuilder, ref: string, pattern: string, op: 'LIKE' | 'ILIKE', negate: boolean): void {
    const clause = this.ctx.knex.raw(`??::text ${op} ? ESCAPE '\\'`, [ref, pattern]);
    if (negate) qb.where((group) => group.whereNot(clause).orWhereNull(ref));
    else qb.where(clause);
  }

  private escapeLike(value: unknown, operator: string): string {
    return String(this.scalar(value, operator)).replace(/[\\%_]/g, (char) => `\\${char}`);
  }

  private scalar(value: unknown, operator: string): string | number | boolean {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    throw new InvalidQueryError(`"${operator}" needs a single value`);
  }

  private list(value: unknown, operator: string): Array<string | number | boolean> {
    const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [value];
    if (items.length === 0) throw new InvalidQueryError(`"${operator}" needs at least one value`);
    return items.map((item) => this.scalar(item, operator));
  }

  private bool(value: unknown, operator: string): boolean {
    if (value === true || value === 'true' || value === 1 || value === '1') return true;
    if (value === false || value === 'false' || value === 0 || value === '0') return false;
    throw new InvalidQueryError(`"${operator}" needs true or false`);
  }

  private isOperatorObject(value: unknown): boolean {
    if (!this.isPlainObject(value)) return true;
    const keys = Object.keys(value);
    return keys.length > 0 && keys.every((key) => OPERATORS.has(key));
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}
