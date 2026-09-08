import {
  MediaType, OpenApiSpec, Operation, Parameter, PathItem, PostmanAuth,
  PostmanCollection, PostmanEnvironment, PostmanEvent, PostmanItem,
  PostmanVariable, Reference, RequestBody, Response, Schema, SecurityScheme,
} from './types';

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'] as const;
export interface GeneratorOptions { baseUrl?: string; responseTimeMs?: number }

export class OpenApiPostmanGenerator {
  private readonly baseUrl: string;
  private readonly responseTimeMs: number;
  private readonly variables = new Map<string, PostmanVariable>();

  constructor(private readonly spec: OpenApiSpec, options: GeneratorOptions = {}) {
    this.baseUrl = options.baseUrl || this.detectBaseUrl();
    this.responseTimeMs = options.responseTimeMs || 2000;
    this.addVariable('baseUrl', this.baseUrl, 'API base URL');
  }

  generate(): PostmanCollection {
    const folders = new Map<string, PostmanItem[]>();
    for (const [route, pathItem] of Object.entries(this.spec.paths)) {
      for (const method of HTTP_METHODS) {
        const operation = pathItem[method];
        if (!operation) continue;
        const tag = operation.tags?.[0] || 'Default';
        const items = folders.get(tag) || [];
        items.push(this.generateItem(route, method.toUpperCase(), pathItem, operation));
        folders.set(tag, items);
      }
    }
    return {
      info: {
        name: `${this.spec.info.title} - Generated API Tests`,
        description: this.spec.info.description,
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [...folders].map(([name, item]) => ({ name, item })),
      variable: [...this.variables.values()],
      auth: this.authFor(this.spec.security),
    };
  }

  generateEnvironment(name = `${this.spec.info.title} - Test`): PostmanEnvironment {
    const values: PostmanEnvironment['values'] = [
      { key: 'baseUrl', value: this.baseUrl, enabled: true, type: 'default' },
    ];
    for (const [key, scheme] of Object.entries(this.securitySchemes())) {
      if (scheme.type === 'apiKey') values.push({ key, value: '', enabled: true, type: 'secret' });
      if ((scheme.type === 'http' && scheme.scheme === 'basic') || scheme.type === 'basic') {
        values.push({ key: `${key}_username`, value: '', enabled: true, type: 'secret' });
        values.push({ key: `${key}_password`, value: '', enabled: true, type: 'secret' });
      }
      if ((scheme.type === 'http' && scheme.scheme === 'bearer') || scheme.type === 'oauth2') {
        values.push({ key: `${key}_token`, value: '', enabled: true, type: 'secret' });
      }
    }
    return { name, values, _postman_variable_scope: 'environment', _postman_exported_using: 'swagger-to-postman-agent' };
  }

  private generateItem(route: string, method: string, pathItem: PathItem, operation: Operation): PostmanItem {
    const params = this.mergeParameters(pathItem.parameters, operation.parameters);
    const headers: Array<Record<string, unknown>> = [];
    const query: Array<Record<string, unknown>> = [];
    let rawPath = route;
    for (const parameter of params) {
      const value = String(this.parameterExample(parameter));
      if (parameter.in === 'path') {
        this.addVariable(parameter.name, value, parameter.description || `Path parameter: ${parameter.name}`);
        rawPath = rawPath.replace(`{${parameter.name}}`, `{{${parameter.name}}}`);
      } else if (parameter.in === 'query') {
        query.push({ key: parameter.name, value, description: parameter.description, disabled: !parameter.required });
      } else if (parameter.in === 'header') {
        headers.push({ key: parameter.name, value, description: parameter.description, disabled: !parameter.required });
      }
    }
    const body = this.generateBody(operation, params, headers);
    const url: Record<string, unknown> = {
      raw: `{{baseUrl}}${rawPath}`,
      host: ['{{baseUrl}}'],
      path: rawPath.split('/').filter(Boolean),
    };
    if (query.length) url.query = query;
    const auth = operation.security?.length === 0
      ? { type: 'noauth' }
      : this.authFor(operation.security === undefined ? this.spec.security : operation.security);
    return {
      name: operation.summary || operation.operationId || `${method} ${route}`,
      request: {
        method, header: headers, body, url,
        description: operation.description || operation.summary,
        ...(auth ? { auth } : {}),
      },
      event: [this.generateTests(operation, method)],
    };
  }

  private generateBody(operation: Operation, params: Parameter[], headers: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
    const swaggerBody = params.find(p => p.in === 'body');
    const formParams = params.filter(p => p.in === 'formData');
    if (formParams.length) {
      const multipart = (operation.consumes || this.spec.consumes || []).includes('multipart/form-data');
      const entries = formParams.map(p => ({
        key: p.name, value: String(this.parameterExample(p)),
        type: p.type === 'file' ? 'file' : 'text', disabled: !p.required,
      }));
      headers.push({ key: 'Accept', value: (operation.produces || this.spec.produces || ['application/json'])[0] });
      return multipart ? { mode: 'formdata', formdata: entries } : { mode: 'urlencoded', urlencoded: entries };
    }
    let requestBody: RequestBody | undefined;
    if (operation.requestBody) requestBody = this.resolve<RequestBody>(operation.requestBody);
    let contentType = (operation.consumes || this.spec.consumes || [])[0];
    let media: MediaType | undefined;
    if (requestBody) {
      contentType = this.preferredContentType(requestBody.content);
      media = requestBody.content[contentType];
    }
    const schema = media?.schema || swaggerBody?.schema;
    if (!schema && media?.example === undefined) return undefined;
    const example = media?.example ?? this.firstNamedExample(media) ?? this.exampleFor(schema!);
    contentType ||= 'application/json';
    headers.push({ key: 'Content-Type', value: contentType });
    headers.push({ key: 'Accept', value: (operation.produces || this.spec.produces || ['application/json'])[0] });
    const raw = typeof example === 'string' && !contentType.includes('json') ? example : JSON.stringify(example, null, 2);
    return { mode: 'raw', raw, options: { raw: { language: contentType.includes('json') ? 'json' : 'text' } } };
  }

  private generateTests(operation: Operation, method: string): PostmanEvent {
    const successEntries = Object.entries(operation.responses).filter(([code]) => /^2\d\d$/.test(code));
    const allowed = successEntries.map(([code]) => Number(code));
    const codes = allowed.length ? allowed : [200, 201, 202, 204];
    const successResponse = successEntries.map(([, value]) => this.resolve<Response>(value)).find(Boolean);
    const responseSchema = this.responseSchema(successResponse);
    const lines = [
      `pm.test("Status code is successful (${codes.join(', ')})", function () {`,
      `  pm.expect(pm.response.code).to.be.oneOf(${JSON.stringify(codes)});`,
      '});', '',
      `pm.test("Response time is below ${this.responseTimeMs}ms", function () {`,
      `  pm.expect(pm.response.responseTime).to.be.below(${this.responseTimeMs});`,
      '});',
    ];
    if (responseSchema) {
      const jsonSchema = this.toJsonSchema(responseSchema);
      lines.push('', 'if (pm.response.code !== 204) {',
        '  pm.test("Response matches the OpenAPI schema", function () {',
        '    const data = pm.response.json();',
        `    pm.expect(data).to.have.jsonSchema(${JSON.stringify(jsonSchema)});`,
        '  });', '}',
      );
    }
    if (method === 'POST') {
      lines.push('', '// Persist common identifiers so later requests can reuse them.',
        'if (pm.response.code >= 200 && pm.response.code < 300 && pm.response.text()) {',
        '  let data; try { data = pm.response.json(); } catch (_) {}',
        '  if (data && typeof data === "object" && !Array.isArray(data)) {',
        '    Object.keys(data).filter(k => k === "id" || /Id$/.test(k)).forEach(k => pm.collectionVariables.set(k, data[k]));',
        '  }', '}',
      );
    }
    return { listen: 'test', script: { type: 'text/javascript', exec: lines } };
  }

  private responseSchema(response?: Response): Schema | undefined {
    if (!response) return undefined;
    if (response.schema) return response.schema;
    if (!response.content) return undefined;
    const type = this.preferredContentType(response.content);
    return response.content[type]?.schema;
  }

  private authFor(requirements?: Array<Record<string, string[]>>): PostmanAuth | undefined {
    if (!requirements || requirements.length === 0) return undefined;
    const name = Object.keys(requirements[0])[0];
    if (!name) return undefined;
    const scheme = this.securitySchemes()[name];
    if (!scheme) return undefined;
    if (scheme.type === 'apiKey') return {
      type: 'apikey', apikey: [
        { key: 'key', value: scheme.name || name, type: 'string' },
        { key: 'value', value: `{{${name}}}`, type: 'string' },
        { key: 'in', value: scheme.in || 'header', type: 'string' },
      ],
    };
    if ((scheme.type === 'http' && scheme.scheme === 'basic') || scheme.type === 'basic') return {
      type: 'basic', basic: [
        { key: 'username', value: `{{${name}_username}}`, type: 'string' },
        { key: 'password', value: `{{${name}_password}}`, type: 'string' },
      ],
    };
    if ((scheme.type === 'http' && scheme.scheme === 'bearer') || scheme.type === 'oauth2') return {
      type: 'bearer', bearer: [{ key: 'token', value: `{{${name}_token}}`, type: 'string' }],
    };
    return undefined;
  }

  private mergeParameters(pathParams: Array<Parameter | Reference> = [], operationParams: Array<Parameter | Reference> = []): Parameter[] {
    const merged = new Map<string, Parameter>();
    for (const item of [...pathParams, ...operationParams]) {
      const p = this.resolve<Parameter>(item);
      merged.set(`${p.in}:${p.name}`, p);
    }
    return [...merged.values()];
  }

  private parameterExample(p: Parameter): unknown {
    if (p.example !== undefined) return p.example;
    const schema: Schema = p.schema || { type: p.type, format: p.format, items: p.items, default: p.default, enum: p.enum };
    return this.exampleFor(schema);
  }

  private exampleFor(input: Schema, depth = 0, seen = new Set<string>()): unknown {
    if (depth > 12) return null;
    let schema = input;
    if (schema.$ref) {
      if (seen.has(schema.$ref)) return null;
      seen.add(schema.$ref);
      schema = this.resolve<Schema>(schema);
    }
    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;
    if (schema.enum?.length) return schema.enum[0];
    if (schema.allOf?.length) return Object.assign({}, ...schema.allOf.map(s => this.exampleFor(s, depth + 1, new Set(seen))));
    if (schema.oneOf?.length || schema.anyOf?.length) return this.exampleFor((schema.oneOf || schema.anyOf)![0], depth + 1, seen);
    if (schema.type === 'array') return [this.exampleFor(schema.items || {}, depth + 1, seen)];
    if (schema.type === 'object' || schema.properties) {
      const out: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries(schema.properties || {})) {
        if (!prop.readOnly) out[key] = this.exampleFor(prop, depth + 1, new Set(seen));
      }
      return out;
    }
    if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? 1;
    if (schema.type === 'boolean') return true;
    if (schema.format === 'date-time') return '2026-01-01T00:00:00.000Z';
    if (schema.format === 'date') return '2026-01-01';
    if (schema.format === 'email') return 'test@example.com';
    if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000001';
    if (schema.format === 'binary') return '';
    return 'test';
  }

  private toJsonSchema(input: Schema, depth = 0): Record<string, unknown> {
    if (depth > 12) return {};
    const schema = input.$ref ? this.resolve<Schema>(input) : input;
    const out: Record<string, unknown> = {};
    for (const key of ['type', 'format', 'description', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'required', 'additionalProperties'] as const) {
      if (schema[key] !== undefined) out[key] = schema[key];
    }
    if (!out.type && schema.properties) out.type = 'object';
    if (schema.nullable) out.type = [String(out.type || 'object'), 'null'];
    if (schema.properties) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, this.toJsonSchema(v, depth + 1)]));
    if (schema.items) out.items = this.toJsonSchema(schema.items, depth + 1);
    if (schema.allOf) out.allOf = schema.allOf.map(s => this.toJsonSchema(s, depth + 1));
    if (schema.oneOf) out.oneOf = schema.oneOf.map(s => this.toJsonSchema(s, depth + 1));
    if (schema.anyOf) out.anyOf = schema.anyOf.map(s => this.toJsonSchema(s, depth + 1));
    return out;
  }

  private resolve<T>(value: T | Reference): T {
    if (!value || typeof value !== 'object' || !('$ref' in value)) return value as T;
    const ref = (value as Reference).$ref;
    if (!ref.startsWith('#/')) throw new Error(`Only local $ref values are supported: ${ref}`);
    let current: unknown = this.spec;
    for (const part of ref.slice(2).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      current = (current as Record<string, unknown>)?.[part];
    }
    if (!current) throw new Error(`Cannot resolve reference: ${ref}`);
    return current as T;
  }

  private securitySchemes(): Record<string, SecurityScheme> { return this.spec.components?.securitySchemes || this.spec.securityDefinitions || {}; }
  private preferredContentType(content: Record<string, MediaType>): string { return Object.keys(content).find(k => k.includes('json')) || Object.keys(content)[0]; }
  private firstNamedExample(media?: MediaType): unknown { const first = media?.examples && Object.values(media.examples)[0]; return first?.value; }
  private addVariable(key: string, value: string, description?: string): void { if (!this.variables.has(key)) this.variables.set(key, { key, value, description, type: 'string' }); }

  private detectBaseUrl(): string {
    if (this.spec.servers?.[0]) {
      return this.spec.servers[0].url.replace(/\{([^}]+)\}/g, (_match, key: string) => this.spec.servers?.[0].variables?.[key]?.default || key);
    }
    const scheme = this.spec.schemes?.[0] || 'http';
    const host = this.spec.host || 'localhost';
    const basePath = (this.spec.basePath || '').replace(/\/$/, '');
    return `${scheme}://${host}${basePath}`;
  }
}

export { OpenApiPostmanGenerator as SwaggerToPostmanGenerator };
