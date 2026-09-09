import { Schema } from '../types';

export function toJsonSchema(input: Schema, resolve: (schema: Schema) => Schema, depth = 0): Record<string, unknown> {
  if (depth > 12) return {};
  const schema = input.$ref ? resolve(input) : input;
  const out: Record<string, unknown> = {};
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
  if (schema.properties) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toJsonSchema(v, resolve, depth + 1)]));
  if (schema.items) out.items = toJsonSchema(schema.items, resolve, depth + 1);
  if (typeof schema.additionalProperties === 'boolean') out.additionalProperties = schema.additionalProperties;
  else if (schema.additionalProperties) out.additionalProperties = toJsonSchema(schema.additionalProperties, resolve, depth + 1);
  if (schema.allOf) out.allOf = schema.allOf.map(s => toJsonSchema(s, resolve, depth + 1));
  if (schema.oneOf) out.oneOf = schema.oneOf.map(s => toJsonSchema(s, resolve, depth + 1));
  if (schema.anyOf) out.anyOf = schema.anyOf.map(s => toJsonSchema(s, resolve, depth + 1));
  return out;
}
