import { exampleFor } from './generator/example';
import { toJsonSchema } from './generator/json-schema';
import { classifySecurityScheme } from './generator/security';
import {
  MediaType, OpenApiSpec, Operation, Parameter, PathItem, PostmanAuth,
  PostmanBody, PostmanCollection, PostmanEnvironment, PostmanEvent, PostmanFormEntry,
  PostmanHeader, PostmanItem, PostmanQueryParam, PostmanUrl, PostmanVariable,
  Reference, RequestBody, Response, Schema, SecurityScheme, VariableMapping,
} from './types';

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'] as const;
export interface GeneratorOptions {
  baseUrl?: string;
  responseTimeMs?: number;
  safeMode?: boolean;
  includeNegative?: boolean;
  variables?: Record<string, string>;
  operationOrder?: string[];
  variableMappings?: VariableMapping[];
  disabledOperations?: string[];
}

interface OperationEntry { route: string; method: string; pathItem: PathItem; operation: Operation; index: number }

export class OpenApiPostmanGenerator {
  private readonly baseUrl: string;
  private readonly responseTimeMs: number;
  private readonly variables = new Map<string, PostmanVariable>();
  private readonly warnings: string[] = [];
  private readonly resolveSchema = (schema: Schema): Schema => this.resolve<Schema>(schema);

  constructor(private readonly spec: OpenApiSpec, private readonly options: GeneratorOptions = {}) {
    this.baseUrl = options.baseUrl || this.detectBaseUrl();
    this.responseTimeMs = options.responseTimeMs || 2000;
    this.addVariable('baseUrl', this.baseUrl, 'API base URL');
    for (const [key, value] of Object.entries(options.variables || {})) this.addVariable(key, value, 'Configured variable');
  }

  getWarnings(): string[] { return [...this.warnings]; }

  generate(): PostmanCollection {
    const folders = new Map<string, PostmanItem[]>();
    const entries: OperationEntry[] = [];
    let index = 0;
    for (const [route, pathItem] of Object.entries(this.spec.paths)) {
      for (const method of HTTP_METHODS) {
        const operation = pathItem[method];
        if (!operation) continue;
        entries.push({ route, method: method.toUpperCase(), pathItem, operation, index: index++ });
      }
    }
    const knownOperations = new Set(entries.map(entry => this.operationId(entry.route, entry.method, entry.operation)));
    for (const configuredId of this.options.operationOrder || []) {
      if (!knownOperations.has(configuredId)) this.warnings.push(`Configured operation was not found: ${configuredId}`);
    }
    for (const mapping of this.options.variableMappings || []) {
      if (!knownOperations.has(mapping.sourceOperationId)) this.warnings.push(`Variable mapping source was not found: ${mapping.sourceOperationId}`);
    }
    for (const entry of this.sortEntries(entries)) {
      const id = this.operationId(entry.route, entry.method, entry.operation);
      if (this.options.disabledOperations?.includes(id)) continue;
      if (this.options.safeMode && entry.method === 'DELETE') {
        this.warnings.push(`Skipped destructive operation in safe mode: ${id}`);
        continue;
      }
      const tag = entry.operation.tags?.[0] || 'Default';
      const items = folders.get(tag) || [];
      items.push(this.generateItem(entry.route, entry.method, entry.pathItem, entry.operation));
      if (this.options.includeNegative) items.push(...this.generateNegativeItems(entry));
      folders.set(tag, items);
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
      const kind = classifySecurityScheme(scheme);
      if (kind === 'apiKey') values.push({ key, value: '', enabled: true, type: 'secret' });
      if (kind === 'basic') {
        values.push({ key: `${key}_username`, value: '', enabled: true, type: 'secret' });
        values.push({ key: `${key}_password`, value: '', enabled: true, type: 'secret' });
      }
      if (kind === 'bearer') values.push({ key: `${key}_token`, value: '', enabled: true, type: 'secret' });
    }
    return { name, values, _postman_variable_scope: 'environment', _postman_exported_using: 'swagger-to-postman-agent' };
  }

  private generateItem(route: string, method: string, pathItem: PathItem, operation: Operation): PostmanItem {
    const params = this.mergeParameters(pathItem.parameters, operation.parameters);
    const headers: PostmanHeader[] = [];
    const query: PostmanQueryParam[] = [];
    const cookies: string[] = [];
    let rawPath = route;
    for (const parameter of params) {
      const example = this.parameterExample(parameter);
      const value = this.serializeParameter(parameter, example);
      if (parameter.in === 'path') {
        this.addVariable(parameter.name, value, parameter.description || `Path parameter: ${parameter.name}`);
        rawPath = rawPath.replace(`{${parameter.name}}`, `{{${parameter.name}}}`);
      } else if (parameter.in === 'query') {
        if (parameter.style === 'deepObject' && example && typeof example === 'object' && !Array.isArray(example)) {
          for (const [key, child] of Object.entries(example as Record<string, unknown>)) {
            query.push({ key: `${parameter.name}[${key}]`, value: String(child), description: parameter.description, disabled: !parameter.required });
          }
        } else {
          query.push({ key: parameter.name, value, description: parameter.description, disabled: !parameter.required });
        }
      } else if (parameter.in === 'header') {
        headers.push({ key: parameter.name, value, description: parameter.description, disabled: !parameter.required });
      } else if (parameter.in === 'cookie') {
        cookies.push(`${parameter.name}=${value}`);
      }
    }
    if (cookies.length) headers.push({ key: 'Cookie', value: cookies.join('; ') });
    const body = this.generateBody(operation, params, headers);
    if (!headers.some(header => header.key.toLowerCase() === 'accept')) {
      headers.push({ key: 'Accept', value: this.preferredResponseType(operation) });
    }
    const url: PostmanUrl = {
      raw: `{{baseUrl}}${rawPath}`,
      host: ['{{baseUrl}}'],
      path: rawPath.split('/').filter(Boolean),
    };
    if (query.length) url.query = query;
    const auth = operation.security?.length === 0
      ? { type: 'noauth' }
      : this.authFor(operation.security === undefined ? this.spec.security : operation.security);
    this.applyAdditionalSecurity(operation.security === undefined ? this.spec.security : operation.security, headers, query);
    return {
      name: operation.summary || operation.operationId || `${method} ${route}`,
      request: {
        method, header: headers, body, url,
        description: operation.description || operation.summary,
        ...(auth ? { auth } : {}),
      },
      event: [this.generateTests(route, operation, method)],
    };
  }

  private generateBody(operation: Operation, params: Parameter[], headers: PostmanHeader[]): PostmanBody | undefined {
    const swaggerBody = params.find(p => p.in === 'body');
    const formParams = params.filter(p => p.in === 'formData');
    if (formParams.length) {
      const multipart = (operation.consumes || this.spec.consumes || []).includes('multipart/form-data');
      const entries: PostmanFormEntry[] = formParams.map(p => ({
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
    if (requestBody && (contentType === 'multipart/form-data' || contentType === 'application/x-www-form-urlencoded')) {
      const resolved = schema ? this.resolvedSchema(schema) : undefined;
      const entries: PostmanFormEntry[] = Object.entries(resolved?.properties || {}).map(([key, property]) => ({
        key,
        value: property.format === 'binary' ? '' : String(exampleFor(property, this.resolveSchema)),
        type: property.format === 'binary' ? 'file' : 'text',
        disabled: resolved?.required ? !resolved.required.includes(key) : true,
      }));
      return contentType === 'multipart/form-data'
        ? { mode: 'formdata', formdata: entries }
        : { mode: 'urlencoded', urlencoded: entries };
    }
    const example = media?.example ?? this.firstNamedExample(media) ?? exampleFor(schema!, this.resolveSchema);
    contentType ||= 'application/json';
    headers.push({ key: 'Content-Type', value: contentType });
    headers.push({ key: 'Accept', value: (operation.produces || this.spec.produces || ['application/json'])[0] });
    const raw = typeof example === 'string' && !contentType.includes('json') ? example : JSON.stringify(example, null, 2);
    return { mode: 'raw', raw, options: { raw: { language: contentType.includes('json') ? 'json' : 'text' } } };
  }

  private generateTests(route: string, operation: Operation, method: string): PostmanEvent {
    const successEntries = Object.entries(operation.responses).filter(([code]) => /^2\d\d$/.test(code));
    const allowed = successEntries.map(([code]) => Number(code));
    const codes = allowed.length ? allowed : [200, 201, 202, 204];
    const responseDefinitions = Object.fromEntries(successEntries.map(([code, value]) => {
      const response = this.resolve<Response>(value);
      const contentType = this.responseContentType(response, operation);
      const schema = this.responseSchema(response, contentType);
      return [code, { contentType, schema: schema ? toJsonSchema(schema, this.resolveSchema) : null }];
    }));
    const lines = [
      `pm.test("Status code is successful (${codes.join(', ')})", function () {`,
      `  pm.expect(pm.response.code).to.be.oneOf(${JSON.stringify(codes)});`,
      '});', '',
      `pm.test("Response time is below ${this.responseTimeMs}ms", function () {`,
      `  pm.expect(pm.response.responseTime).to.be.below(${this.responseTimeMs});`,
      '});',
    ];
    lines.push('', `const responseDefinitions = ${JSON.stringify(responseDefinitions)};`,
      'const responseDefinition = responseDefinitions[String(pm.response.code)];',
      'if (responseDefinition && pm.response.code !== 204) {',
      '  const declaredType = responseDefinition.contentType || "";',
      '  if (declaredType.includes("json")) {',
      '    pm.test("Response Content-Type is JSON", function () {',
      '      pm.expect(pm.response.headers.get("Content-Type") || "").to.include("json");',
      '    });',
      '    if (responseDefinition.schema) {',
      '      pm.test("Response matches the schema for its status code", function () {',
      '        pm.expect(pm.response.json()).to.have.jsonSchema(responseDefinition.schema);',
      '      });',
      '    }',
      '  } else if (responseDefinition.schema) {',
      '    pm.test("Non-JSON response contains a body", function () {',
      '      pm.expect(pm.response.text()).to.not.equal("");',
      '    });',
      '  }',
      '}',
    );
    if (method === 'POST') {
      const operationId = this.operationId(route, method, operation);
      const mappings = (this.options.variableMappings || []).filter(mapping => mapping.sourceOperationId === operationId);
      lines.push('', '// Persist common identifiers so later requests can reuse them.',
        'if (pm.response.code >= 200 && pm.response.code < 300 && pm.response.text()) {',
        '  let data; try { data = pm.response.json(); } catch (_) {}',
        '  if (data && typeof data === "object" && !Array.isArray(data)) {',
        '    Object.keys(data).filter(k => k === "id" || /Id$/.test(k)).forEach(k => pm.collectionVariables.set(k, data[k]));',
        '  }',
      );
      if (mappings.length) {
        lines.push(`  const mappings = ${JSON.stringify(mappings)};`,
          '  const getPath = (value, jsonPath) => jsonPath.replace(/^\\$\\.?/, "").split(".").filter(Boolean).reduce((current, key) => current == null ? undefined : current[key], value);',
          '  mappings.forEach(mapping => {',
          '    const value = getPath(data, mapping.responseJsonPath);',
          '    if (value !== undefined) pm.collectionVariables.set(mapping.variable, value);',
          '  });',
        );
      }
      lines.push('}');
    }
    return { listen: 'test', script: { type: 'text/javascript', exec: lines } };
  }

  private responseSchema(response: Response | undefined, contentType?: string): Schema | undefined {
    if (!response) return undefined;
    if (response.schema) return response.schema;
    if (!response.content) return undefined;
    const type = contentType || this.preferredContentType(response.content);
    return response.content[type]?.schema;
  }

  private responseContentType(response: Response | undefined, operation: Operation): string {
    if (response?.content) return this.preferredContentType(response.content);
    return (operation.produces || this.spec.produces || ['application/json'])[0];
  }

  private authFor(requirements?: Array<Record<string, string[]>>): PostmanAuth | undefined {
    if (!requirements || requirements.length === 0) return undefined;
    const names = Object.keys(requirements[0]);
    const name = names.find(candidate => classifySecurityScheme(this.securitySchemes()[candidate]) !== 'apiKey') || names[0];
    if (!name) return undefined;
    const scheme = this.securitySchemes()[name];
    const kind = classifySecurityScheme(scheme);
    if (kind === 'apiKey') return {
      type: 'apikey', apikey: [
        { key: 'key', value: scheme.name || name, type: 'string' },
        { key: 'value', value: `{{${name}}}`, type: 'string' },
        { key: 'in', value: scheme.in || 'header', type: 'string' },
      ],
    };
    if (kind === 'basic') return {
      type: 'basic', basic: [
        { key: 'username', value: `{{${name}_username}}`, type: 'string' },
        { key: 'password', value: `{{${name}_password}}`, type: 'string' },
      ],
    };
    if (kind === 'bearer') return {
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
    return exampleFor(schema, this.resolveSchema);
  }

  private serializeParameter(parameter: Parameter, value: unknown): string {
    if (Array.isArray(value)) {
      const delimiter = parameter.style === 'spaceDelimited' || parameter.collectionFormat === 'ssv' ? ' '
        : parameter.style === 'pipeDelimited' || parameter.collectionFormat === 'pipes' ? '|'
          : parameter.collectionFormat === 'tsv' ? '\t' : ',';
      return value.map(String).join(delimiter);
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      return parameter.explode
        ? entries.map(([key, child]) => `${key}=${String(child)}`).join(',')
        : entries.flatMap(([key, child]) => [key, String(child)]).join(',');
    }
    return String(value ?? '');
  }

  private sortEntries(entries: OperationEntry[]): OperationEntry[] {
    const configured = new Map((this.options.operationOrder || []).map((id, index) => [id, index]));
    const methodPriority: Record<string, number> = { POST: 10, PUT: 20, PATCH: 25, GET: 30, HEAD: 35, OPTIONS: 40, DELETE: 90 };
    return [...entries].sort((left, right) => {
      const leftId = this.operationId(left.route, left.method, left.operation);
      const rightId = this.operationId(right.route, right.method, right.operation);
      const leftConfigured = configured.get(leftId);
      const rightConfigured = configured.get(rightId);
      if (leftConfigured !== undefined || rightConfigured !== undefined) {
        return (leftConfigured ?? Number.MAX_SAFE_INTEGER) - (rightConfigured ?? Number.MAX_SAFE_INTEGER);
      }
      return (methodPriority[left.method] || 50) - (methodPriority[right.method] || 50) || left.index - right.index;
    });
  }

  private operationId(route: string, method: string, operation: Operation): string {
    return operation.operationId || `${method.toLowerCase()} ${route}`;
  }

  private generateNegativeItems(entry: OperationEntry): PostmanItem[] {
    const output: PostmanItem[] = [];
    const positive = this.generateItem(entry.route, entry.method, entry.pathItem, entry.operation);
    const operationId = this.operationId(entry.route, entry.method, entry.operation);
    const security = entry.operation.security === undefined ? this.spec.security : entry.operation.security;
    if (security?.length) {
      const unauthorized = structuredClone(positive);
      unauthorized.name = `[Negative] ${positive.name} - unauthorized`;
      if (unauthorized.request) {
        unauthorized.request.auth = { type: 'noauth' };
        const schemes = Object.keys(security[0]).map(name => ({ name, scheme: this.securitySchemes()[name] }));
        const apiKeyNames = schemes.filter(item => classifySecurityScheme(item.scheme) === 'apiKey').map(item => item.scheme.name || item.name);
        unauthorized.request.header = unauthorized.request.header.filter(header =>
          !apiKeyNames.includes(header.key) && !(header.key === 'Cookie' && apiKeyNames.some(name => header.value.includes(`${name}=`))));
        if (unauthorized.request.url.query) {
          unauthorized.request.url.query = unauthorized.request.url.query.filter(query => !apiKeyNames.includes(query.key));
        }
      }
      unauthorized.event = [this.negativeTest('Request is rejected without credentials', this.negativeCodes(entry.operation, [401, 403]))];
      output.push(unauthorized);
    }

    // Clones `positive`, mutates its raw JSON body, and pushes the variant; silently
    // skips non-JSON bodies and records a warning if the body cannot be parsed.
    const buildVariant = (name: string, warnLabel: string, mutate: (data: Record<string, unknown>) => void, event?: PostmanEvent): void => {
      if (positive.request?.body?.mode !== 'raw') return;
      const clone = structuredClone(positive);
      clone.name = name;
      const body = clone.request!.body as Extract<PostmanBody, { mode: 'raw' }>;
      try {
        const data = JSON.parse(body.raw) as Record<string, unknown>;
        mutate(data);
        body.raw = JSON.stringify(data, null, 2);
        if (event) clone.event = [event];
        output.push(clone);
      } catch {
        this.warnings.push(`Could not generate ${warnLabel} test for ${operationId}`);
      }
    };

    const requestSchema = this.requestSchema(entry.operation, this.mergeParameters(entry.pathItem.parameters, entry.operation.parameters));
    const resolved = requestSchema ? this.resolvedSchema(requestSchema) : undefined;

    const requiredField = resolved?.required?.[0];
    if (requiredField) {
      buildVariant(
        `[Negative] ${positive.name} - missing ${requiredField}`,
        'missing-field',
        data => { delete data[requiredField]; },
        this.negativeTest(`Missing required field '${requiredField}' is rejected`, this.negativeCodes(entry.operation, [400, 422])),
      );
    }

    const enumField = Object.entries(resolved?.properties || {}).find(([, schema]) => schema.enum?.length)?.[0];
    if (enumField) {
      buildVariant(
        `[Negative] ${positive.name} - invalid ${enumField}`,
        'invalid-enum',
        data => { data[enumField] = '__invalid_enum__'; },
        this.negativeTest(`Invalid enum value for '${enumField}' is rejected`, this.negativeCodes(entry.operation, [400, 422])),
      );
    }

    const boundaryField = Object.entries(resolved?.properties || {}).find(([, schema]) =>
      schema.minimum !== undefined || schema.maximum !== undefined || schema.minLength !== undefined || schema.maxLength !== undefined,
    );
    if (boundaryField) {
      const [field, fieldSchema] = boundaryField;
      buildVariant(
        `[Boundary] ${positive.name} - ${field}`,
        'boundary',
        data => {
          data[field] = fieldSchema.minimum ?? fieldSchema.maximum
            ?? (fieldSchema.minLength !== undefined ? 'x'.repeat(fieldSchema.minLength) : 'x'.repeat(fieldSchema.maxLength || 1));
        },
      );
    }
    return output;
  }

  private negativeCodes(operation: Operation, fallback: number[]): number[] {
    const declared = Object.keys(operation.responses).filter(code => /^4\d\d$/.test(code)).map(Number);
    const preferred = declared.filter(code => fallback.includes(code));
    return preferred.length ? preferred : declared.length ? declared : fallback;
  }

  private negativeTest(name: string, codes: number[]): PostmanEvent {
    return { listen: 'test', script: { type: 'text/javascript', exec: [
      `pm.test(${JSON.stringify(name)}, function () {`,
      `  pm.expect(pm.response.code).to.be.oneOf(${JSON.stringify(codes)});`,
      '});',
    ] } };
  }

  private requestSchema(operation: Operation, params: Parameter[]): Schema | undefined {
    const swaggerBody = params.find(parameter => parameter.in === 'body');
    if (swaggerBody?.schema) return swaggerBody.schema;
    if (!operation.requestBody) return undefined;
    const requestBody = this.resolve<RequestBody>(operation.requestBody);
    const type = this.preferredContentType(requestBody.content);
    return requestBody.content[type]?.schema;
  }

  private resolvedSchema(input: Schema): Schema {
    const schema = input.$ref ? this.resolve<Schema>(input) : input;
    if (!schema.allOf?.length) return schema;
    const parts = schema.allOf.map(part => this.resolvedSchema(part));
    return {
      ...schema,
      type: 'object',
      properties: Object.assign({}, ...parts.map(part => part.properties || {}), schema.properties || {}),
      required: [...new Set(parts.flatMap(part => part.required || []).concat(schema.required || []))],
    };
  }

  private applyAdditionalSecurity(
    requirements: Array<Record<string, string[]>> | undefined,
    headers: PostmanHeader[],
    query: PostmanQueryParam[],
  ): void {
    if (!requirements?.[0]) return;
    const names = Object.keys(requirements[0]);
    if (names.length < 2) return;
    for (const name of names) {
      const scheme = this.securitySchemes()[name];
      if (classifySecurityScheme(scheme) !== 'apiKey') continue;
      const value = `{{${name}}}`;
      if (scheme.in === 'query') query.push({ key: scheme.name || name, value });
      else if (scheme.in === 'cookie') headers.push({ key: 'Cookie', value: `${scheme.name || name}=${value}` });
      else headers.push({ key: scheme.name || name, value });
    }
  }

  private preferredResponseType(operation: Operation): string {
    for (const [status, responseValue] of Object.entries(operation.responses)) {
      if (!/^2\d\d$/.test(status)) continue;
      return this.responseContentType(this.resolve<Response>(responseValue), operation);
    }
    return (operation.produces || this.spec.produces || ['application/json'])[0];
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
