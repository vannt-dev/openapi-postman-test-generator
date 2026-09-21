import { Schema } from '../types';
import { matchesExample } from './example-validation';

export function exampleFor(input: Schema, resolve: (schema: Schema) => Schema, depth = 0, seen = new Set<string>()): unknown {
  const value = synthesize(input, resolve, depth, seen);
  if (depth === 0 && !matchesExample(value, input, resolve)) {
    throw new Error('Cannot synthesize an example satisfying the request schema; provide an explicit example.');
  }
  return value;
}

function synthesize(input: Schema, resolve: (schema: Schema) => Schema, depth: number, seen: Set<string>): unknown {
  if (depth > 12) return null;
  let schema = input;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return null;
    seen.add(schema.$ref);
    schema = resolve(schema);
  }
  if (schema.example !== undefined) return schema.example;
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.allOf?.length) {
    const values = schema.allOf.map(s => exampleFor(s, resolve, depth + 1, new Set(seen)));
    return values.every(value => value !== null && typeof value === 'object' && !Array.isArray(value))
      ? Object.assign({}, ...values) : values[0];
  }
  if (schema.oneOf?.length || schema.anyOf?.length) return exampleFor((schema.oneOf || schema.anyOf)![0], resolve, depth + 1, seen);
  const type = Array.isArray(schema.type) ? schema.type.find(value => value !== 'null') : schema.type;
  if (type === 'array') {
    const count = schema.minItems ?? Math.min(1, schema.maxItems ?? 1);
    if (!Number.isInteger(count) || count < 0 || count > (schema.maxItems ?? Infinity) || count > 1000) {
      throw new Error('Cannot synthesize an array within its item bounds; provide an explicit example.');
    }
    const itemSchema = schema.items?.$ref ? resolve(schema.items) : schema.items || {};
    const items = Array.from({ length: count }, (_, index) => schema.uniqueItems && itemSchema.enum
      ? itemSchema.enum[index] : exampleFor(itemSchema, resolve, depth + 1, new Set(seen)));
    if (schema.uniqueItems && (items.some(item => item === undefined) || new Set(items.map(item => JSON.stringify(item))).size !== count)) {
      throw new Error('Cannot synthesize unique array items; provide an explicit example.');
    }
    return items;
  }
  if (type === 'object' || schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(schema.properties || {})) {
      const property = prop.$ref ? resolve(prop) : prop;
      if (!property.readOnly) out[key] = exampleFor(prop, resolve, depth + 1, new Set(seen));
    }
    return out;
  }
  if (type === 'integer' || type === 'number') return numericExample(schema, type === 'integer');
  if (type === 'boolean') return true;
  if (type === 'null') return null;
  const formats: Record<string, string> = {
    'date-time': '2026-01-01T00:00:00.000Z', date: '2026-01-01', email: 'test@example.com',
    uuid: '00000000-0000-4000-8000-000000000001', binary: '',
  };
  const formatted = schema.format ? formats[schema.format] : undefined;
  if (schema.format && formatted === undefined) throw new Error(`Cannot synthesize format ${schema.format}; provide an explicit example.`);
  const min = schema.minLength ?? 0;
  const max = schema.maxLength ?? 65536;
  if (min < 0 || min > max || min > 65536 || max < 0) throw new Error('Cannot synthesize a string within its length bounds; provide an explicit example.');
  const value = formatted ?? 'test'.slice(0, max).padEnd(min, 'x');
  if (value.length < min || value.length > max || (schema.pattern && !new RegExp(schema.pattern).test(value))) {
    throw new Error('Cannot synthesize a string matching its format, pattern and length; provide an explicit example.');
  }
  return value;
}

function numericExample(schema: Schema, integer: boolean): number {
  const lower = Math.max(schema.minimum ?? -Infinity, typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : -Infinity);
  const upper = Math.min(schema.maximum ?? Infinity, typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum : Infinity);
  const lowerExclusive = schema.exclusiveMinimum === true || typeof schema.exclusiveMinimum === 'number' && lower === schema.exclusiveMinimum;
  const upperExclusive = schema.exclusiveMaximum === true || typeof schema.exclusiveMaximum === 'number' && upper === schema.exclusiveMaximum;
  const step = schema.multipleOf ?? (integer ? 1 : undefined);
  if (step !== undefined && (!Number.isFinite(step) || step <= 0)) throw new Error('multipleOf must be a positive finite number.');
  let value = Number.isFinite(lower) ? lower : Math.min(1, upper);
  if (step !== undefined) {
    value = Number((Math.ceil(value / step) * step).toPrecision(15));
    if (lowerExclusive && value <= lower) value = Number((value + step).toPrecision(15));
    if (!Number.isFinite(lower) && (value > upper || upperExclusive && value === upper)) {
      value = Number(((Math.floor(upper / step) - (upperExclusive && upper / step === Math.floor(upper / step) ? 1 : 0)) * step).toPrecision(15));
    }
  } else if (lowerExclusive && value <= lower || upperExclusive && value >= upper) {
    value = Number.isFinite(lower) && Number.isFinite(upper) ? lower + (upper - lower) / 2
      : Number.isFinite(lower) ? lower + Math.max(1, Math.abs(lower) * Number.EPSILON)
        : upper - Math.max(1, Math.abs(upper) * Number.EPSILON);
  }
  if (!Number.isFinite(value) || value < lower || value > upper || lowerExclusive && value <= lower
    || upperExclusive && value >= upper || integer && !Number.isInteger(value)) {
    throw new Error('Cannot synthesize a number within its bounds; provide an explicit example.');
  }
  return value;
}
