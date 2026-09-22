import { Schema } from '../types';

type Direction = 'request' | 'response';

function excludedProperties(input: Schema, resolve: (schema: Schema) => Schema, direction: Direction, depth: number): string[] {
  if (depth > 12) return [];
  const schema = input.$ref ? resolve(input) : input;
  const excluded = Object.entries(schema.properties || {}).filter(([, value]) => {
    const property = value.$ref ? resolve(value) : value;
    return direction === 'response' ? property.writeOnly : property.readOnly;
  }).map(([name]) => name);
  return excluded.concat((schema.allOf || []).flatMap(part => excludedProperties(part, resolve, direction, depth + 1)));
}

export function toJsonSchema(input: Schema, resolve: (schema: Schema) => Schema, depth = 0, direction: Direction = 'response', inheritedExcluded: string[] = []): Record<string, unknown> {
  if (depth > 12) return {};
  const schema = input.$ref ? resolve(input) : input;
  const out: Record<string, unknown> = {};
  const excluded = new Set([...inheritedExcluded, ...excludedProperties(schema, resolve, direction, depth)]);
  for (const key of [
    'type', 'format', 'title', 'description', 'enum', 'default', 'const',
    'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
    'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems',
    'minProperties', 'maxProperties', 'required',
  ] as const) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }
  if (!out.type && schema.properties) out.type = 'object';
  if (schema.nullable) {
    const types = Array.isArray(out.type) ? out.type : [String(out.type || 'object')];
    out.type = [...new Set([...types, 'null'])];
  }
  if (schema.required) out.required = schema.required.filter(name => !excluded.has(name));
  if (schema.properties) out.properties = Object.fromEntries(Object.entries(schema.properties)
    .filter(([name]) => !excluded.has(name))
    .map(([k, v]) => [k, toJsonSchema(v, resolve, depth + 1, direction)]));
  if (schema.items) out.items = toJsonSchema(schema.items, resolve, depth + 1, direction);
  if (typeof schema.additionalProperties === 'boolean') out.additionalProperties = schema.additionalProperties;
  else if (schema.additionalProperties) out.additionalProperties = toJsonSchema(schema.additionalProperties, resolve, depth + 1, direction);
  if (schema.allOf) out.allOf = schema.allOf.map(s => toJsonSchema(s, resolve, depth + 1, direction, [...excluded]));
  if (schema.oneOf) out.oneOf = schema.oneOf.map(s => toJsonSchema(s, resolve, depth + 1, direction, [...excluded]));
  if (schema.anyOf) out.anyOf = schema.anyOf.map(s => toJsonSchema(s, resolve, depth + 1, direction, [...excluded]));
  return out;
}
