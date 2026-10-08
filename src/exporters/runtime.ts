/* eslint-disable @typescript-eslint/no-explicit-any --
   This function is not called from the generator: its source text is written into the Bruno and
   k6 output, where it runs without types. Inside it everything is plain ES2015 JavaScript, with
   no reference to anything outside its own body. */

/** What a target (Bruno, k6) has to supply for the generated test scripts to run on it. */
export interface PmHost {
  /** Registers a named test; `run` throws when it fails. */
  test(name: string, run: () => void): void;
  /** Absent while a pre-request script runs. */
  response?: {
    code: number;
    responseTime: number;
    header(name: string): string | undefined;
    text(): string;
  };
  request: { name: string; url: string };
  variables: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    unset(key: string): void;
    /** Whether the key exists in the environment, as opposed to having been set by a script. */
    inEnvironment(key: string): boolean;
  };
  setNextRequest(name: string | null): void;
  skipRequest(): void;
}

/**
 * The part of Postman's scripting API that the generated tests use, built on a {@link PmHost}.
 *
 * The collection's scripts are written for Postman's sandbox (`pm.test`, `pm.expect`,
 * `pm.response`, variables, `setNextRequest`). Rather than translate each script into another
 * tool's idiom, the other outputs run the same script against this object, so a check means the
 * same thing wherever it runs.
 */
export function createPmRuntime(host: any): any {
  function show(value: any): string {
    try {
      const text = JSON.stringify(value);
      return text === undefined ? String(value) : text.length > 200 ? text.slice(0, 200) + '…' : text;
    } catch {
      return String(value);
    }
  }

  function typeOf(value: any): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  // JSON Schema, as far as the generator emits it: the keywords below and nothing else. A keyword
  // that is not listed is ignored, which can only make a check more lenient, never fail it.
  function schemaError(value: any, schema: any, path: string): string | null {
    if (schema === true || schema === undefined || schema === null) return null;
    if (schema === false) return path + ' is not allowed';
    let index: number;
    let error: string | null;
    if (schema.allOf) {
      for (index = 0; index < schema.allOf.length; index++) {
        error = schemaError(value, schema.allOf[index], path);
        if (error) return error;
      }
    }
    if (schema.anyOf) {
      const anyMatch = schema.anyOf.some(function (option: any) { return !schemaError(value, option, path); });
      if (!anyMatch) return path + ' matches none of the anyOf schemas';
    }
    if (schema.oneOf) {
      const matches = schema.oneOf.filter(function (option: any) { return !schemaError(value, option, path); }).length;
      if (matches !== 1) return path + ' matches ' + matches + ' of the oneOf schemas instead of exactly one';
    }
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const actual = typeOf(value);
      const typeMatches = types.some(function (type: string) {
        if (type === 'integer') return actual === 'number' && Math.floor(value) === value;
        return type === actual;
      });
      if (!typeMatches) return path + ' should be ' + types.join(' or ') + ' but is ' + actual;
    }
    if (schema.enum && !schema.enum.some(function (option: any) { return JSON.stringify(option) === JSON.stringify(value); })) {
      return path + ' should be one of ' + show(schema.enum) + ' but is ' + show(value);
    }
    if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
      return path + ' should be ' + show(schema.const) + ' but is ' + show(value);
    }
    if (typeof value === 'number') {
      if (typeof schema.minimum === 'number' && value < schema.minimum) return path + ' should be >= ' + schema.minimum;
      if (typeof schema.maximum === 'number' && value > schema.maximum) return path + ' should be <= ' + schema.maximum;
      if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return path + ' should be > ' + schema.exclusiveMinimum;
      if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return path + ' should be < ' + schema.exclusiveMaximum;
      if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
        const quotient = value / schema.multipleOf;
        if (Math.abs(quotient - Math.round(quotient)) > 1e-9) return path + ' should be a multiple of ' + schema.multipleOf;
      }
    }
    if (typeof value === 'string') {
      // Counted in characters, as the specification says, not in UTF-16 units.
      const length = Array.from(value).length;
      if (typeof schema.minLength === 'number' && length < schema.minLength) return path + ' should have at least ' + schema.minLength + ' characters';
      if (typeof schema.maxLength === 'number' && length > schema.maxLength) return path + ' should have at most ' + schema.maxLength + ' characters';
      if (typeof schema.pattern === 'string') {
        // A pattern this engine cannot compile is skipped rather than failed.
        let pattern: RegExp | null;
        try { pattern = new RegExp(schema.pattern); } catch { pattern = null; }
        if (pattern && !pattern.test(value)) return path + ' should match ' + schema.pattern;
      }
    }
    if (Array.isArray(value)) {
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) return path + ' should have at least ' + schema.minItems + ' items';
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return path + ' should have at most ' + schema.maxItems + ' items';
      if (schema.uniqueItems) {
        const seen: Record<string, boolean> = {};
        for (index = 0; index < value.length; index++) {
          const key = JSON.stringify(value[index]);
          if (seen[key]) return path + ' should not repeat an item';
          seen[key] = true;
        }
      }
      if (schema.items && !Array.isArray(schema.items)) {
        for (index = 0; index < value.length; index++) {
          error = schemaError(value[index], schema.items, path + '[' + index + ']');
          if (error) return error;
        }
      }
    }
    if (typeOf(value) === 'object') {
      const keys = Object.keys(value);
      const properties = schema.properties || {};
      if (schema.required) {
        for (index = 0; index < schema.required.length; index++) {
          if (!Object.prototype.hasOwnProperty.call(value, schema.required[index])) {
            return path + ' should have the property ' + schema.required[index];
          }
        }
      }
      if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) return path + ' should have at least ' + schema.minProperties + ' properties';
      if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) return path + ' should have at most ' + schema.maxProperties + ' properties';
      for (index = 0; index < keys.length; index++) {
        const name = keys[index];
        const child = path + '.' + name;
        if (Object.prototype.hasOwnProperty.call(properties, name)) {
          error = schemaError(value[name], properties[name], child);
        } else if (schema.additionalProperties === false) {
          error = child + ' is not a known property';
        } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          error = schemaError(value[name], schema.additionalProperties, child);
        } else {
          error = null;
        }
        if (error) return error;
      }
    }
    return null;
  }

  // The assertions the generated scripts use, in the chain style they are written in.
  function expect(value: any, message?: string): any {
    let negate = false;
    const chain: any = {};
    function check(passed: boolean, positive: string, negative: string): any {
      if (negate ? passed : !passed) {
        throw new Error((message ? message + ': ' : '') + 'expected ' + show(value) + ' ' + (negate ? negative : positive));
      }
      return chain;
    }
    ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same'].forEach(function (word) {
      Object.defineProperty(chain, word, { get: function () { return chain; } });
    });
    Object.defineProperty(chain, 'not', { get: function () { negate = !negate; return chain; } });
    Object.defineProperty(chain, 'empty', { get: function () {
      const size = value === null || value === undefined ? 0
        : typeOf(value) === 'object' ? Object.keys(value).length : value.length;
      return check(size === 0, 'to be empty', 'not to be empty');
    } });
    Object.defineProperty(chain, 'ok', { get: function () { return check(Boolean(value), 'to be truthy', 'to be falsy'); } });
    chain.equal = function (expected: any) { return check(value === expected, 'to equal ' + show(expected), 'not to equal ' + show(expected)); };
    chain.eql = function (expected: any) { return check(JSON.stringify(value) === JSON.stringify(expected), 'to deeply equal ' + show(expected), 'not to deeply equal ' + show(expected)); };
    chain.within = function (low: number, high: number) { return check(value >= low && value <= high, 'to be within ' + low + '..' + high, 'not to be within ' + low + '..' + high); };
    chain.below = function (limit: number) { return check(value < limit, 'to be below ' + limit, 'to be at least ' + limit); };
    chain.above = function (limit: number) { return check(value > limit, 'to be above ' + limit, 'to be at most ' + limit); };
    chain.least = function (limit: number) { return check(value >= limit, 'to be at least ' + limit, 'to be below ' + limit); };
    chain.most = function (limit: number) { return check(value <= limit, 'to be at most ' + limit, 'to be above ' + limit); };
    chain.oneOf = function (list: any[]) { return check(list.indexOf(value) >= 0, 'to be one of ' + show(list), 'not to be one of ' + show(list)); };
    chain.include = function (part: any) {
      const found = typeof value === 'string' || Array.isArray(value) ? value.indexOf(part) >= 0 : false;
      return check(found, 'to include ' + show(part), 'not to include ' + show(part));
    };
    chain.a = chain.an = function (type: string) { return check(typeOf(value) === type, 'to be ' + type, 'not to be ' + type); };
    chain.jsonSchema = function (schema: any) {
      const error = schemaError(value, schema, '$');
      return check(error === null, 'to match the schema: ' + error, 'not to match the schema');
    };
    return chain;
  }
  (expect as any).fail = function (text?: string) { throw new Error(text || 'expect.fail()'); };

  function replaceIn(text: any): string {
    return String(text).replace(/\{\{([^{}]+)\}\}/g, function (whole: string, key: string) {
      const value = host.variables.get(key.trim());
      return value === undefined || value === null ? whole : String(value);
    });
  }

  // Postman keeps collection and environment variables apart; the targets have one scope. A
  // script that writes to both, as the generated ones do, ends up with the one value it meant.
  function scope(environment: boolean): any {
    return {
      get: function (key: string) { return host.variables.get(key); },
      set: function (key: string, value: any) { host.variables.set(key, value); },
      unset: function (key: string) { host.variables.unset(key); },
      has: function (key: string) {
        return environment ? host.variables.inEnvironment(key) : host.variables.get(key) !== undefined;
      },
    };
  }

  const response = host.response;
  const pm = {
    test: function (name: string, run: () => void) { host.test(name, run); },
    expect: expect,
    response: response && {
      code: response.code,
      responseTime: response.responseTime,
      headers: { get: function (name: string) { return response.header(name); } },
      text: function () { return response.text(); },
      json: function () { return JSON.parse(response.text()); },
    },
    environment: scope(true),
    collectionVariables: scope(false),
    variables: { get: function (key: string) { return host.variables.get(key); }, replaceIn: replaceIn },
    request: { url: { toString: function () { return host.request.url; } } },
    execution: {
      setNextRequest: function (name: string | null) { host.setNextRequest(name); },
      skipRequest: function () { host.skipRequest(); },
    },
    info: { requestName: host.request.name },
  };

  // `require("url").resolve` is the one module call in the generated scripts.
  function resolveUrl(base: string, reference: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) return reference;
    const origin = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)/i.exec(base);
    if (!origin) return reference;
    if (reference.slice(0, 2) === '//') return origin[1] + reference;
    if (reference.charAt(0) === '/') return origin[1] + '//' + origin[2] + reference;
    if (reference.charAt(0) === '?' || reference.charAt(0) === '#') return origin[1] + '//' + origin[2] + (origin[3] || '/') + reference;
    const segments = (origin[3] || '/').split('/');
    segments.pop();
    reference.split('/').forEach(function (segment) {
      if (segment === '..') { if (segments.length > 1) segments.pop(); }
      else if (segment !== '.') segments.push(segment);
    });
    return origin[1] + '//' + origin[2] + segments.join('/');
  }

  return {
    pm: pm,
    postman: { setNextRequest: function (name: string | null) { host.setNextRequest(name); } },
    require: function (name: string) {
      if (name === 'url') return { resolve: resolveUrl };
      throw new Error('Module "' + name + '" is not available outside Postman');
    },
    replaceIn: replaceIn,
  };
}

/** The runtime as source text, ready to be written into a generated script. */
export const PM_RUNTIME_SOURCE = createPmRuntime.toString();
