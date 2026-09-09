import { Schema } from '../types';

export function exampleFor(input: Schema, resolve: (schema: Schema) => Schema, depth = 0, seen = new Set<string>()): unknown {
  if (depth > 12) return null;
  let schema = input;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return null;
    seen.add(schema.$ref);
    schema = resolve(schema);
  }
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.allOf?.length) return Object.assign({}, ...schema.allOf.map(s => exampleFor(s, resolve, depth + 1, new Set(seen))));
  if (schema.oneOf?.length || schema.anyOf?.length) return exampleFor((schema.oneOf || schema.anyOf)![0], resolve, depth + 1, seen);
  const type = Array.isArray(schema.type) ? schema.type.find(value => value !== 'null') : schema.type;
  if (type === 'array') return [exampleFor(schema.items || {}, resolve, depth + 1, seen)];
  if (type === 'object' || schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(schema.properties || {})) {
      if (!prop.readOnly) out[key] = exampleFor(prop, resolve, depth + 1, new Set(seen));
    }
    return out;
  }
  if (type === 'integer' || type === 'number') return schema.minimum ?? 1;
  if (type === 'boolean') return true;
  if (schema.format === 'date-time') return '2026-01-01T00:00:00.000Z';
  if (schema.format === 'date') return '2026-01-01';
  if (schema.format === 'email') return 'test@example.com';
  if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000001';
  if (schema.format === 'binary') return '';
  return 'test';
}
