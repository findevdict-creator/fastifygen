import type { JsonSchema } from './types.js';

export interface TypeMapping {
  tsType: string;
  jsonSchema: JsonSchema;
}

export interface TypeMapperInput {
  dataType: string;
  isArray: boolean;
  enumValues: string[] | null;
  maxLength: number | null;
}

/**
 * Maps Postgres types to the TypeScript type node-postgres returns and the
 * JSON Schema used for request validation and response serialization.
 */
export class TypeMapper {
  private static readonly SCALARS: Record<string, TypeMapping> = {
    int2: { tsType: 'number', jsonSchema: { type: 'integer', minimum: -32768, maximum: 32767 } },
    int4: { tsType: 'number', jsonSchema: { type: 'integer', minimum: -2147483648, maximum: 2147483647 } },
    // node-postgres returns int8 and numeric as strings to avoid losing precision.
    int8: { tsType: 'string', jsonSchema: { type: 'string', pattern: '^-?\\d+$' } },
    numeric: { tsType: 'string', jsonSchema: { type: 'string', pattern: '^-?\\d+(\\.\\d+)?$' } },
    money: { tsType: 'string', jsonSchema: { type: 'string' } },
    float4: { tsType: 'number', jsonSchema: { type: 'number' } },
    float8: { tsType: 'number', jsonSchema: { type: 'number' } },
    bool: { tsType: 'boolean', jsonSchema: { type: 'boolean' } },
    text: { tsType: 'string', jsonSchema: { type: 'string' } },
    varchar: { tsType: 'string', jsonSchema: { type: 'string' } },
    bpchar: { tsType: 'string', jsonSchema: { type: 'string' } },
    citext: { tsType: 'string', jsonSchema: { type: 'string' } },
    name: { tsType: 'string', jsonSchema: { type: 'string' } },
    uuid: { tsType: 'string', jsonSchema: { type: 'string', format: 'uuid' } },
    date: { tsType: 'Date', jsonSchema: { type: 'string', format: 'date' } },
    timestamp: { tsType: 'Date', jsonSchema: { type: 'string', format: 'date-time' } },
    timestamptz: { tsType: 'Date', jsonSchema: { type: 'string', format: 'date-time' } },
    time: { tsType: 'string', jsonSchema: { type: 'string' } },
    timetz: { tsType: 'string', jsonSchema: { type: 'string' } },
    interval: { tsType: 'string', jsonSchema: { type: 'string' } },
    json: { tsType: 'unknown', jsonSchema: {} },
    jsonb: { tsType: 'unknown', jsonSchema: {} },
    bytea: { tsType: 'Buffer', jsonSchema: { type: 'string', contentEncoding: 'base64' } },
    inet: { tsType: 'string', jsonSchema: { type: 'string' } },
    cidr: { tsType: 'string', jsonSchema: { type: 'string' } },
    macaddr: { tsType: 'string', jsonSchema: { type: 'string' } },
  };

  private static readonly FALLBACK: TypeMapping = { tsType: 'unknown', jsonSchema: {} };

  map(input: TypeMapperInput): TypeMapping {
    const element = this.mapElement(input);
    if (!input.isArray) return element;
    return {
      tsType: `${element.tsType.includes('|') ? `(${element.tsType})` : element.tsType}[]`,
      jsonSchema: { type: 'array', items: element.jsonSchema },
    };
  }

  private mapElement({ dataType, enumValues, maxLength }: TypeMapperInput): TypeMapping {
    if (enumValues) {
      return {
        tsType: enumValues.map((value) => JSON.stringify(value)).join(' | ') || 'string',
        jsonSchema: { type: 'string', enum: [...enumValues] },
      };
    }
    const scalar = TypeMapper.SCALARS[dataType] ?? TypeMapper.FALLBACK;
    const jsonSchema = { ...scalar.jsonSchema };
    if (maxLength !== null && jsonSchema.type === 'string') jsonSchema.maxLength = maxLength;
    return { tsType: scalar.tsType, jsonSchema };
  }
}
