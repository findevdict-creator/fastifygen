import { describe, expect, it } from 'vitest';
import { InvalidQueryError } from '../../src/runtime/errors.js';
import { QueryParser } from '../../src/runtime/query/QueryParser.js';

const parser = new QueryParser({ defaultLimit: 100, maxLimit: 1000 });

describe('QueryParser', () => {
  it('uses defaults for an empty query', () => {
    expect(parser.parse({})).toEqual({
      fields: ['*'],
      filter: null,
      sort: [],
      limit: 100,
      offset: 0,
      search: null,
      meta: [],
    });
  });

  it('splits comma lists and accepts repeated params', () => {
    const query = parser.parse({ fields: ['id,name', 'company_id.name'], sort: '-created_at, name' });
    expect(query.fields).toEqual(['id', 'name', 'company_id.name']);
    expect(query.sort).toEqual(['-created_at', 'name']);
  });

  it('accepts filter as JSON or as an object from bracket syntax', () => {
    expect(parser.parse({ filter: '{"name":{"_eq":"Acme"}}' }).filter).toEqual({ name: { _eq: 'Acme' } });
    expect(parser.parse({ filter: { name: { _eq: 'Acme' } } }).filter).toEqual({ name: { _eq: 'Acme' } });
    expect(() => parser.parse({ filter: '{nope' })).toThrow(InvalidQueryError);
    expect(() => parser.parse({ filter: '[1]' })).toThrow('"filter" must be an object');
  });

  it('turns page into an offset and caps limits', () => {
    expect(parser.parse({ limit: '25', page: '3' })).toMatchObject({ limit: 25, offset: 50 });
    expect(parser.parse({ offset: '10' }).offset).toBe(10);
    expect(parser.parse({ limit: '-1' }).limit).toBe(1000);
    expect(() => parser.parse({ limit: '1001' })).toThrow('cannot be more than 1000');
    expect(() => parser.parse({ limit: '0' })).toThrow(InvalidQueryError);
    expect(() => parser.parse({ limit: 'ten' })).toThrow('"limit" must be a whole number');
    expect(() => parser.parse({ page: '0' })).toThrow(InvalidQueryError);
    expect(() => parser.parse({ offset: '-5' })).toThrow(InvalidQueryError);
  });

  it('parses search and meta', () => {
    expect(parser.parse({ search: '  acme ' }).search).toBe('acme');
    expect(parser.parse({ search: '   ' }).search).toBeNull();
    expect(parser.parse({ meta: '*' }).meta).toEqual(['total_count', 'filter_count']);
    expect(parser.parse({ meta: 'filter_count' }).meta).toEqual(['filter_count']);
    expect(() => parser.parse({ meta: 'everything' })).toThrow(InvalidQueryError);
  });
});
