import { InvalidQueryError } from '../errors.js';
import type { Filter, MetaField, Query } from '../types.js';

export interface QueryParserLimits {
  defaultLimit: number;
  maxLimit: number;
}

/**
 * Parses Directus-style query parameters (`fields`, `filter`, `sort`,
 * `limit`, `offset`, `page`, `search`, `meta`) into a {@link Query}.
 * Accepts both `filter={"name":{"_eq":"x"}}` and the bracket form
 * `filter[name][_eq]=x` once the querystring is parsed with `qs`.
 * Checking names against the table happens later, in the repository.
 */
export class QueryParser {
  private static readonly META_FIELDS: MetaField[] = ['total_count', 'filter_count'];

  constructor(private readonly limits: QueryParserLimits) {}

  parse(raw: Record<string, unknown> = {}): Query {
    const limit = this.parseLimit(raw.limit);
    const offset = this.parsePage(raw.page, limit) ?? this.parseNonNegativeInt(raw.offset, 'offset') ?? 0;
    return {
      fields: this.parseList(raw.fields, 'fields') ?? ['*'],
      filter: this.parseFilter(raw.filter),
      sort: this.parseList(raw.sort, 'sort') ?? [],
      limit,
      offset,
      search: typeof raw.search === 'string' && raw.search.trim() !== '' ? raw.search.trim() : null,
      meta: this.parseMeta(raw.meta),
    };
  }

  private parseList(value: unknown, name: string): string[] | null {
    if (value === undefined || value === '') return null;
    const parts = Array.isArray(value) ? value : [value];
    if (!parts.every((part) => typeof part === 'string')) throw new InvalidQueryError(`"${name}" must be a string`);
    const items = (parts as string[])
      .flatMap((part) => part.split(','))
      .map((part) => part.trim())
      .filter(Boolean);
    return items.length ? items : null;
  }

  private parseFilter(value: unknown): Filter | null {
    if (value === undefined || value === '') return null;
    let filter = value;
    if (typeof value === 'string') {
      try {
        filter = JSON.parse(value);
      } catch {
        throw new InvalidQueryError('"filter" must be valid JSON or use filter[field][_op]=value');
      }
    }
    if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
      throw new InvalidQueryError('"filter" must be an object');
    }
    return Object.keys(filter).length ? (filter as Filter) : null;
  }

  private parseLimit(value: unknown): number {
    if (value === undefined || value === '') return this.limits.defaultLimit;
    const limit = this.parseInt(value, 'limit');
    if (limit === -1) return this.limits.maxLimit;
    if (limit < 1) throw new InvalidQueryError('"limit" must be a positive number or -1');
    if (limit > this.limits.maxLimit) throw new InvalidQueryError(`"limit" cannot be more than ${this.limits.maxLimit}`);
    return limit;
  }

  private parsePage(value: unknown, limit: number): number | null {
    if (value === undefined || value === '') return null;
    const page = this.parseInt(value, 'page');
    if (page < 1) throw new InvalidQueryError('"page" must be 1 or more');
    return (page - 1) * limit;
  }

  private parseNonNegativeInt(value: unknown, name: string): number | null {
    if (value === undefined || value === '') return null;
    const number = this.parseInt(value, name);
    if (number < 0) throw new InvalidQueryError(`"${name}" cannot be negative`);
    return number;
  }

  private parseInt(value: unknown, name: string): number {
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(number)) throw new InvalidQueryError(`"${name}" must be a whole number`);
    return number;
  }

  private parseMeta(value: unknown): MetaField[] {
    const items = this.parseList(value, 'meta');
    if (!items) return [];
    if (items.includes('*')) return [...QueryParser.META_FIELDS];
    for (const item of items) {
      if (!QueryParser.META_FIELDS.includes(item as MetaField)) {
        throw new InvalidQueryError(`"meta" must be total_count, filter_count or *`);
      }
    }
    return [...new Set(items)] as MetaField[];
  }
}
