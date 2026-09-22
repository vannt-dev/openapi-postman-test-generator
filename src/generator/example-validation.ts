import { isDeepStrictEqual } from 'node:util';
import { Schema } from '../types';

/** Check synthesized requests after composition, where individually valid parts can conflict. */
export function matchesExample(value: unknown, input: Schema, resolve: (schema: Schema) => Schema, depth = 0): boolean {
  if (depth > 24) return false;
  const schema = input.$ref ? resolve(input) : input;
  if (schema.$ref) return matchesExample(value, schema, resolve, depth + 1);
  const matches = (part: Schema, candidate = value): boolean => matchesExample(candidate, part, resolve, depth + 1);
  if (schema.const !== undefined && !isDeepStrictEqual(value, schema.const)) return false;
  if (schema.enum && !schema.enum.some(item => isDeepStrictEqual(value, item))) return false;
  if (schema.allOf && !schema.allOf.every(part => matches(part))) return false;
  if (schema.anyOf && !schema.anyOf.some(part => matches(part))) return false;
  if (schema.oneOf && schema.oneOf.filter(part => matches(part)).length !== 1) return false;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (schema.nullable && value === null) return true;
  if (types.length && !types.some(type => {
    if (type === 'null') return value === null;
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'integer') return Number.isInteger(value);
    return typeof value === type;
  })) return false;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false;
    if (schema.minimum !== undefined && (value < schema.minimum || schema.exclusiveMinimum === true && value === schema.minimum)) return false;
    if (schema.maximum !== undefined && (value > schema.maximum || schema.exclusiveMaximum === true && value === schema.maximum)) return false;
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return false;
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return false;
    if (schema.multipleOf !== undefined) {
      const quotient = value / schema.multipleOf;
      if (!(schema.multipleOf > 0) || !Number.isFinite(quotient) || Math.abs(quotient - Math.round(quotient)) > 1e-9) return false;
    }
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
    if (schema.uniqueItems && value.some((item, index) => value.slice(0, index).some(other => isDeepStrictEqual(item, other)))) return false;
    if (schema.items && !value.every(item => matches(schema.items!, item))) return false;
  } else if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    if (keys.length < (schema.minProperties ?? 0) || keys.length > (schema.maxProperties ?? Infinity)) return false;
    const properties = schema.properties || {};
    for (const name of schema.required || []) {
      const property = properties[name];
      if (property && (property.$ref ? resolve(property) : property).readOnly) continue;
      if (!Object.prototype.hasOwnProperty.call(object, name)) return false;
    }
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        if (!matches(properties[key], object[key])) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && !matches(schema.additionalProperties, object[key])) return false;
    }
  }
  return true;
}
