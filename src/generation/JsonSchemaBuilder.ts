import type { GeneratorConfig } from '../config/types.js';
import type { ColumnModel, JsonSchema, TableModel } from '../introspection/types.js';

export interface TableSchemas {
  params: JsonSchema;
  query: JsonSchema;
  item: JsonSchema;
  listResponse: JsonSchema;
  itemResponse: JsonSchema;
  writeResponse: JsonSchema;
  createBody: JsonSchema;
  updateBody: JsonSchema;
  updateManyBody: JsonSchema;
  deleteManyBody: JsonSchema;
}

/**
 * Builds the JSON Schemas a table's routes use: Fastify validates requests
 * with them and serializes responses fast with them.
 */
export class JsonSchemaBuilder {
  constructor(private readonly config: GeneratorConfig) {}

  build(table: TableModel): TableSchemas {
    const hidden = new Set(this.config.overrides[table.name]?.hiddenColumns ?? []);
    const tenantColumn = this.config.tenancy.enabled && table.tenantScoped ? this.config.tenancy.column : null;
    const foreignKeyColumns = new Set(table.manyToOne.flatMap((relation) => relation.columns));

    // Responses: columns can become nested objects (fields=company_id.name) and
    // one-to-many aliases can appear, so relation columns stay untyped.
    const itemProperties: Record<string, JsonSchema> = {};
    for (const column of table.columns) {
      if (hidden.has(column.name)) continue;
      itemProperties[column.name] = foreignKeyColumns.has(column.name) ? {} : this.columnSchema(column);
    }
    const item: JsonSchema = { type: 'object', properties: itemProperties, additionalProperties: true };

    const writable = table.columns.filter((column) => !column.readOnly && column.name !== tenantColumn);
    const createProperties = Object.fromEntries(writable.map((column) => [column.name, this.columnSchema(column)]));
    const createItem: JsonSchema = {
      type: 'object',
      properties: createProperties,
      required: writable.filter((column) => !column.nullable && !column.hasDefault).map((column) => column.name),
      additionalProperties: false,
    };
    if ((createItem.required as string[]).length === 0) delete createItem.required;

    const updatable = writable.filter((column) => !table.primaryKey.includes(column.name));
    const updateProperties = Object.fromEntries(updatable.map((column) => [column.name, this.columnSchema(column)]));
    const updateItem: JsonSchema = { type: 'object', properties: updateProperties, minProperties: 1, additionalProperties: false };

    const keyColumns = table.columns.filter((column) => table.primaryKey.includes(column.name));
    const batchItem: JsonSchema = {
      type: 'object',
      properties: { ...updateProperties, ...Object.fromEntries(keyColumns.map((column) => [column.name, column.jsonSchema])) },
      required: table.primaryKey,
      minProperties: table.primaryKey.length + 1,
      additionalProperties: false,
    };
    const keys: JsonSchema = { type: 'array', minItems: 1, items: this.keySchema(keyColumns) };

    return {
      params: {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1 } },
        required: ['id'],
      },
      query: {
        type: 'object',
        properties: {
          fields: {},
          filter: {},
          sort: {},
          limit: { type: 'integer', minimum: -1, maximum: this.config.api.maxLimit },
          offset: { type: 'integer', minimum: 0 },
          page: { type: 'integer', minimum: 1 },
          search: { type: 'string' },
          meta: { type: 'string' },
        },
      },
      item,
      listResponse: {
        type: 'object',
        properties: {
          data: { type: 'array', items: item },
          meta: {
            type: 'object',
            properties: { total_count: { type: 'integer' }, filter_count: { type: 'integer' } },
          },
        },
        required: ['data'],
      },
      itemResponse: { type: 'object', properties: { data: item }, required: ['data'] },
      writeResponse: {
        type: 'object',
        properties: { data: { anyOf: [{ type: 'array', items: item }, item] } },
        required: ['data'],
      },
      createBody: { anyOf: [createItem, { type: 'array', minItems: 1, items: createItem }] },
      updateBody: updateItem,
      updateManyBody: {
        anyOf: [
          {
            type: 'object',
            properties: { keys, data: updateItem },
            required: ['keys', 'data'],
            additionalProperties: false,
          },
          { type: 'array', minItems: 1, items: batchItem },
        ],
      },
      deleteManyBody: {
        anyOf: [
          keys,
          { type: 'object', properties: { keys }, required: ['keys'], additionalProperties: false },
        ],
      },
    };
  }

  /** Schema for one key: a value for single-column keys, an object or "a,b" string for composite keys. */
  private keySchema(keyColumns: ColumnModel[]): JsonSchema {
    if (keyColumns.length === 1) {
      const type = (keyColumns[0] as ColumnModel).jsonSchema.type;
      return type === 'integer' ? { type: ['integer', 'string'] } : { type: 'string' };
    }
    return {
      anyOf: [
        { type: 'string' },
        {
          type: 'object',
          properties: Object.fromEntries(keyColumns.map((column) => [column.name, column.jsonSchema])),
          required: keyColumns.map((column) => column.name),
          additionalProperties: false,
        },
      ],
    };
  }

  private columnSchema(column: ColumnModel): JsonSchema {
    const schema: JsonSchema = { ...column.jsonSchema };
    if (column.comment) schema.description = column.comment;
    if (!column.nullable || schema.type === undefined) return schema;
    schema.type = [schema.type as string, 'null'];
    if (Array.isArray(schema.enum)) schema.enum = [...schema.enum, null];
    return schema;
  }
}
