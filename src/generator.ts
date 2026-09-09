import { exampleFor } from './generator/example';
import { toJsonSchema } from './generator/json-schema';
import { classifySecurityScheme } from './generator/security';
import {
  MediaType, NegativeScenario, OpenApiSpec, Operation, Parameter, PathItem, PostmanAuth,
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
  negativeScenarios?: NegativeScenario[];
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
    const orderedItems: PostmanItem[] = [];
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
      for (const target of mapping.targetOperationIds || []) {
        if (!knownOperations.has(target)) this.warnings.push(`Variable mapping target was not found: ${target}`);
      }
    }
    for (const scenario of this.options.negativeScenarios || []) {
      if (!knownOperations.has(scenario.operationId)) this.warnings.push(`Negative scenario operation was not found: ${scenario.operationId}`);
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
      const generated = [this.generateItem(entry.route, entry.method, entry.pathItem, entry.operation)];
      if (this.options.includeNegative) generated.push(...this.generateNegativeItems(entry));
      items.push(...generated);
      orderedItems.push(...generated);
      folders.set(tag, items);
    }
    return {
      info: {
        name: `${this.spec.info.title} - Generated API Tests`,
        description: this.spec.info.description,
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      // A configured workflow may alternate between tags. Top-level requests are
      // required here because grouping them into tag folders changes execution order.
      item: this.options.operationOrder?.length
        ? orderedItems
        : [...folders].map(([name, item]) => ({ name, item })),
      variable: [...this.variables.values()],
      auth: this.authFor(this.spec.security),
    };
  }

  generateEnvironment(name = `${this.spec.info.title} - Test`): PostmanEnvironment {
    const values: PostmanEnvironment['values'] = [
      { key: 'baseUrl', value: this.baseUrl, enabled: true, type: 'default' },
    ];
    const add = (key: string, value: string, type: 'default' | 'secret'): void => {
      const existing = values.find(item => item.key === key);
      if (existing) { existing.value = value; existing.type = type; }
      else values.push({ key, value, enabled: true, type });
    };
    for (const variable of this.variables.values()) {
      if (variable.key !== 'baseUrl') add(variable.key, variable.value, 'default');
    }
    for (const [key, scheme] of Object.entries(this.securitySchemes())) {
      const kind = classifySecurityScheme(scheme);
      if (kind === 'apiKey') add(key, '', 'secret');
      if (kind === 'basic') {
        add(`${key}_username`, '', 'secret');
        add(`${key}_password`, '', 'secret');
      }
      if (kind === 'bearer') add(`${key}_token`, '', 'secret');
    }
    return { name, values, _postman_variable_scope: 'environment', _postman_exported_using: 'swagger-to-postman-agent' };
  }

  private generateItem(route: string, method: string, pathItem: PathItem, operation: Operation): PostmanItem {
    const params = this.mergeParameters(pathItem.parameters, operation.parameters);
    const operationId = this.operationId(route, method, operation);
    const headers: PostmanHeader[] = [];
    const query: PostmanQueryParam[] = [];
    const cookies: string[] = [];
    let rawPath = route;
    for (const parameter of params) {
      const mappedVariable = this.mappedVariableFor(operationId, parameter.name);
      const example = mappedVariable ? `{{${mappedVariable}}}` : this.parameterExample(parameter);
      const value = this.serializeParameter(parameter, example);
      if (parameter.in === 'path') {
        const variableName = mappedVariable || parameter.name;
        this.addVariable(variableName, mappedVariable ? '' : value, parameter.description || `Path parameter: ${parameter.name}`);
        rawPath = rawPath.replace(`{${parameter.name}}`, `{{${variableName}}}`);
      } else if (parameter.in === 'query') {
        if (parameter.style === 'deepObject' && example && typeof example === 'object' && !Array.isArray(example)) {
          for (const [key, child] of Object.entries(example as Record<string, unknown>)) {
            query.push({ key: `${parameter.name}[${key}]`, value: String(child), description: parameter.description, disabled: !parameter.required });
          }
        } else if (Array.isArray(example) && (parameter.explode ?? (parameter.style === undefined || parameter.style === 'form'))) {
          for (const child of example) query.push({ key: parameter.name, value: String(child), description: parameter.description, disabled: !parameter.required });
        } else if (example && typeof example === 'object' && !Array.isArray(example) && (parameter.explode ?? true)) {
          for (const [key, child] of Object.entries(example as Record<string, unknown>)) {
            query.push({ key, value: String(child), description: parameter.description, disabled: !parameter.required });
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
    const body = this.generateBody(operation, params, headers, operationId);
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

  private generateBody(operation: Operation, params: Parameter[], headers: PostmanHeader[], operationId: string): PostmanBody | undefined {
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
    let example = media?.example ?? this.firstNamedExample(media) ?? exampleFor(schema!, this.resolveSchema);
    if (example && typeof example === 'object' && !Array.isArray(example)) {
      example = this.applyMappingsToBody(example as Record<string, unknown>, operationId);
    }
    contentType ||= 'application/json';
    headers.push({ key: 'Content-Type', value: contentType });
    headers.push({ key: 'Accept', value: (operation.produces || this.spec.produces || ['application/json'])[0] });
    const raw = typeof example === 'string' && !contentType.includes('json') ? example : JSON.stringify(example, null, 2);
    return { mode: 'raw', raw, options: { raw: { language: contentType.includes('json') ? 'json' : 'text' } } };
  }

  private generateTests(route: string, operation: Operation, method: string): PostmanEvent {
    const successEntries = Object.entries(operation.responses).filter(([code]) => /^2(?:\d\d|XX)$/i.test(code));
    const allowed = successEntries.filter(([code]) => /^2\d\d$/.test(code)).map(([code]) => Number(code));
    const hasWildcard = successEntries.some(([code]) => /^2XX$/i.test(code));
    const codes = allowed.length ? allowed : [200, 201, 202, 204];
    const responseDefinitions = Object.fromEntries(successEntries.map(([code, value]) => {
      const response = this.resolve<Response>(value);
      const contentType = this.responseContentType(response, operation);
      const schema = this.responseSchema(response, contentType);
      return [code, { contentType, schema: schema ? toJsonSchema(schema, this.resolveSchema) : null }];
    }));
    const lines = [
      `pm.test("Status code is successful (${hasWildcard ? '2XX' : codes.join(', ')})", function () {`,
      hasWildcard
        ? '  pm.expect(pm.response.code).to.be.within(200, 299);'
        : `  pm.expect(pm.response.code).to.be.oneOf(${JSON.stringify(codes)});`,
      '});', '',
      `pm.test("Response time is below ${this.responseTimeMs}ms", function () {`,
      `  pm.expect(pm.response.responseTime).to.be.below(${this.responseTimeMs});`,
      '});',
    ];
    lines.push('', `const responseDefinitions = ${JSON.stringify(responseDefinitions)};`,
      'const responseDefinition = responseDefinitions[String(pm.response.code)] || responseDefinitions["2XX"] || responseDefinitions["2xx"];',
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
    const operationId = this.operationId(route, method, operation);
    const mappings = (this.options.variableMappings || []).filter(mapping => mapping.sourceOperationId === operationId);
    if (method === 'POST' || mappings.length) {
      lines.push('', '// Persist common identifiers so later requests can reuse them.',
        'if (pm.response.code >= 200 && pm.response.code < 300 && pm.response.text()) {',
        '  let data; try { data = pm.response.json(); } catch (_) {}',
        '  if (data && typeof data === "object" && !Array.isArray(data)) {',
        '    Object.keys(data).filter(k => k === "id" || /Id$/.test(k)).forEach(k => pm.collectionVariables.set(k, data[k]));',
        '  }',
      );
      if (mappings.length) {
        lines.push(`  const mappings = ${JSON.stringify(mappings)};`,
          '  const getPath = (value, jsonPath) => {',
          '    const tokens = [];',
          '    jsonPath.replace(/^\\$\\.?/, "").replace(/\\[([0-9]+)|[\\x27"]([^\\x27"]+)[\\x27"]\\]|([^.\\[\\]]+)/g, (_, index, quoted, plain) => { tokens.push(index !== undefined ? Number(index) : quoted || plain); return ""; });',
          '    return tokens.reduce((current, key) => current == null ? undefined : current[key], value);',
          '  };',
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
    const name = names.find(candidate => classifySecurityScheme(this.securitySchemes()[candidate]) !== 'apiKey');
    if (!name) return undefined;
    const scheme = this.securitySchemes()[name];
    const kind = classifySecurityScheme(scheme);
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
    const namedExample = p.examples && Object.values(p.examples)[0]?.value;
    if (namedExample !== undefined) return namedExample;
    const media = p.content && p.content[this.preferredContentType(p.content)];
    if (media?.example !== undefined) return media.example;
    const mediaNamedExample = this.firstNamedExample(media);
    if (mediaNamedExample !== undefined) return mediaNamedExample;
    const schema: Schema = media?.schema || p.schema || { type: p.type, format: p.format, items: p.items, default: p.default, enum: p.enum };
    return exampleFor(schema, this.resolveSchema);
  }

  private mappedVariableFor(operationId: string, field: string): string | undefined {
    const candidates = (this.options.variableMappings || []).filter(mapping =>
      mapping.targetOperationIds?.includes(operationId),
    );
    if (!candidates.length) return undefined;
    const normalizedField = field.toLowerCase().replace(/[^a-z0-9]/g, '');
    const exact = candidates.find(mapping => {
      const variable = mapping.variable.toLowerCase().replace(/[^a-z0-9]/g, '');
      const leaf = mapping.responseJsonPath.match(/(?:\.|\[['"]?)([A-Za-z0-9_-]+)['"]?\]?$/)?.[1]
        ?.toLowerCase().replace(/[^a-z0-9]/g, '');
      return variable === normalizedField || leaf === normalizedField || variable.endsWith(normalizedField);
    });
    if (exact) return exact.variable;
    return candidates.length === 1 ? candidates[0].variable : undefined;
  }

  private applyMappingsToBody(data: Record<string, unknown>, operationId: string): Record<string, unknown> {
    const output = structuredClone(data);
    for (const key of Object.keys(output)) {
      const variable = this.mappedVariableFor(operationId, key);
      if (variable) output[key] = `{{${variable}}}`;
    }
    return output;
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
    const explicitPlan = Boolean(this.options.negativeScenarios?.length);
    const planned = (this.options.negativeScenarios || []).filter(scenario => scenario.operationId === operationId);
    if (explicitPlan && !planned.length) return output;
    const requested = (kind: NegativeScenario['kind']): NegativeScenario[] => explicitPlan
      ? planned.filter(scenario => scenario.kind === kind)
      : [{ operationId, name: kind, kind }];
    const security = entry.operation.security === undefined ? this.spec.security : entry.operation.security;
    for (const scenario of requested('unauthorized')) {
      if (!security?.length) {
        if (explicitPlan) this.warnings.push(`Could not generate unauthorized test for unsecured operation: ${operationId}`);
        continue;
      }
      const unauthorized = structuredClone(positive);
      unauthorized.name = `[Negative] ${positive.name} - ${explicitPlan ? scenario.name : 'unauthorized'}`;
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
    // records a warning if the body cannot be parsed or represented.
    const buildVariant = (name: string, warnLabel: string, mutate: (data: Record<string, unknown>) => void, event?: PostmanEvent): void => {
      if (!positive.request?.body) {
        if (explicitPlan) this.warnings.push(`Could not generate ${warnLabel} test without a supported request body for ${operationId}`);
        return;
      }
      const clone = structuredClone(positive);
      clone.name = name;
      try {
        const body = clone.request!.body!;
        if (body.mode === 'raw') {
          const data = JSON.parse(body.raw) as Record<string, unknown>;
          mutate(data);
          body.raw = JSON.stringify(data, null, 2);
        } else {
          const entries = body.mode === 'formdata' ? body.formdata : body.urlencoded;
          const data = Object.fromEntries(entries.map(item => [item.key, item.value]));
          mutate(data);
          const next = entries.filter(item => Object.prototype.hasOwnProperty.call(data, item.key));
          for (const item of next) item.value = String(data[item.key] ?? '');
          if (body.mode === 'formdata') body.formdata = next;
          else body.urlencoded = next;
        }
        if (event) clone.event = [event];
        output.push(clone);
      } catch {
        this.warnings.push(`Could not generate ${warnLabel} test for ${operationId}`);
      }
    };

    const requestSchema = this.requestSchema(entry.operation, this.mergeParameters(entry.pathItem.parameters, entry.operation.parameters));
    const resolved = requestSchema ? this.resolvedSchema(requestSchema) : undefined;
    const parameters = this.mergeParameters(entry.pathItem.parameters, entry.operation.parameters);

    for (const scenario of requested('missing_required')) {
      const requiredField = scenario.field || resolved?.required?.[0];
      if (!requiredField || !resolved?.required?.includes(requiredField)) {
        const parameter = parameters.find(item => item.required && (!scenario.field || item.name === scenario.field));
        if (parameter) {
          const variant = this.parameterNegativeVariant(positive, operationId, parameter,
            explicitPlan ? scenario.name : `missing ${parameter.name}`, undefined, true,
            this.negativeTest(`Missing required parameter '${parameter.name}' is rejected`, this.negativeCodes(entry.operation, [400, 404, 422])));
          if (variant) output.push(variant);
          continue;
        }
        if (explicitPlan) this.warnings.push(`Required field was not found for negative scenario on ${operationId}: ${scenario.field || '(unspecified)'}`);
        continue;
      }
      buildVariant(
        `[Negative] ${positive.name} - ${explicitPlan ? scenario.name : `missing ${requiredField}`}`,
        'missing-field',
        data => { delete data[requiredField]; },
        this.negativeTest(`Missing required field '${requiredField}' is rejected`, this.negativeCodes(entry.operation, [400, 422])),
      );
    }

    for (const scenario of requested('invalid_enum')) {
      const enumField = scenario.field || Object.entries(resolved?.properties || {}).find(([, schema]) => schema.enum?.length)?.[0];
      if (!enumField || !resolved?.properties?.[enumField]?.enum?.length) {
        const parameter = parameters.find(item => {
          const schema = this.parameterSchema(item);
          return (!scenario.field || item.name === scenario.field) && Boolean(schema.enum?.length);
        });
        if (parameter) {
          const variant = this.parameterNegativeVariant(positive, operationId, parameter,
            explicitPlan ? scenario.name : `invalid ${parameter.name}`, '__invalid_enum__', false,
            this.negativeTest(`Invalid enum value for '${parameter.name}' is rejected`, this.negativeCodes(entry.operation, [400, 422])));
          if (variant) output.push(variant);
          continue;
        }
        if (explicitPlan) this.warnings.push(`Enum field was not found for negative scenario on ${operationId}: ${scenario.field || '(unspecified)'}`);
        continue;
      }
      buildVariant(
        `[Negative] ${positive.name} - ${explicitPlan ? scenario.name : `invalid ${enumField}`}`,
        'invalid-enum',
        data => { data[enumField] = '__invalid_enum__'; },
        this.negativeTest(`Invalid enum value for '${enumField}' is rejected`, this.negativeCodes(entry.operation, [400, 422])),
      );
    }

    for (const scenario of requested('boundary')) {
      const boundaryField = scenario.field && resolved?.properties?.[scenario.field]
        ? [scenario.field, resolved.properties[scenario.field]] as const
        : Object.entries(resolved?.properties || {}).find(([, schema]) =>
          schema.minimum !== undefined || schema.maximum !== undefined || schema.minLength !== undefined || schema.maxLength !== undefined,
        );
      if (!boundaryField) {
        const parameter = parameters.find(item => {
          const schema = this.parameterSchema(item);
          return (!scenario.field || item.name === scenario.field) && this.hasBoundary(schema);
        });
        if (parameter) {
          const variant = this.parameterNegativeVariant(positive, operationId, parameter,
            explicitPlan ? scenario.name : `out-of-range ${parameter.name}`, this.invalidBoundaryValue(this.parameterSchema(parameter)), false,
            this.negativeTest(`Out-of-range value for '${parameter.name}' is rejected`, this.negativeCodes(entry.operation, [400, 404, 422])));
          if (variant) output.push(variant);
          continue;
        }
        if (explicitPlan) this.warnings.push(`Boundary field was not found for negative scenario on ${operationId}: ${scenario.field || '(unspecified)'}`);
        continue;
      }
      const [field, fieldSchema] = boundaryField;
      buildVariant(
        `[Negative] ${positive.name} - ${explicitPlan ? scenario.name : `out-of-range ${field}`}`,
        'boundary',
        data => { data[field] = this.invalidBoundaryValue(fieldSchema); },
        this.negativeTest(`Out-of-range value for '${field}' is rejected`, this.negativeCodes(entry.operation, [400, 422])),
      );
    }
    return output;
  }

  private invalidBoundaryValue(schema: Schema): unknown {
    const step = schema.multipleOf || 1;
    if (schema.minimum !== undefined) return schema.minimum - step;
    if (schema.maximum !== undefined) return schema.maximum + step;
    if (schema.minLength !== undefined) return 'x'.repeat(Math.max(0, schema.minLength - 1));
    if (schema.maxLength !== undefined) return 'x'.repeat(schema.maxLength + 1);
    return null;
  }

  private hasBoundary(schema: Schema): boolean {
    return schema.minimum !== undefined || schema.maximum !== undefined
      || schema.minLength !== undefined || schema.maxLength !== undefined;
  }

  private parameterSchema(parameter: Parameter): Schema {
    return this.resolvedSchema(parameter.schema || {
      type: parameter.type, format: parameter.format, items: parameter.items,
      default: parameter.default, enum: parameter.enum,
    });
  }

  private parameterNegativeVariant(
    positive: PostmanItem,
    operationId: string,
    parameter: Parameter,
    label: string,
    value: unknown,
    remove: boolean,
    event: PostmanEvent,
  ): PostmanItem | undefined {
    const clone = structuredClone(positive);
    const request = clone.request;
    if (!request) return undefined;
    clone.name = `[Negative] ${positive.name} - ${label}`;
    const replacement = String(value ?? '');
    let changed = false;
    if (parameter.in === 'query' && request.url.query) {
      const matches = (key: string): boolean => key === parameter.name || key.startsWith(`${parameter.name}[`);
      if (remove) request.url.query = request.url.query.filter(item => !matches(item.key));
      else {
        const item = request.url.query.find(query => matches(query.key));
        if (item) item.value = replacement;
      }
      changed = true;
    } else if (parameter.in === 'header') {
      if (remove) request.header = request.header.filter(item => item.key.toLowerCase() !== parameter.name.toLowerCase());
      else {
        const item = request.header.find(header => header.key.toLowerCase() === parameter.name.toLowerCase());
        if (item) item.value = replacement;
      }
      changed = true;
    } else if (parameter.in === 'cookie') {
      const cookie = request.header.find(header => header.key.toLowerCase() === 'cookie');
      if (cookie) {
        const parts = cookie.value.split(';').map(part => part.trim()).filter(part => !part.startsWith(`${parameter.name}=`));
        if (!remove) parts.push(`${parameter.name}=${replacement}`);
        cookie.value = parts.join('; ');
        changed = true;
      }
    } else if (parameter.in === 'path') {
      const variable = this.mappedVariableFor(operationId, parameter.name) || parameter.name;
      request.url.raw = request.url.raw.replace(`{{${variable}}}`, replacement);
      request.url.path = request.url.path.map(segment => segment === `{{${variable}}}` ? replacement : segment);
      changed = true;
    } else if (parameter.in === 'formData' && request.body && request.body.mode !== 'raw') {
      const entries = request.body.mode === 'formdata' ? request.body.formdata : request.body.urlencoded;
      if (remove) {
        if (request.body.mode === 'formdata') request.body.formdata = entries.filter(item => item.key !== parameter.name);
        else request.body.urlencoded = entries.filter(item => item.key !== parameter.name);
      } else {
        const item = entries.find(entry => entry.key === parameter.name);
        if (item) item.value = replacement;
      }
      changed = true;
    }
    if (!changed) return undefined;
    clone.event = [event];
    return clone;
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
    for (const name of names) {
      const scheme = this.securitySchemes()[name];
      if (classifySecurityScheme(scheme) !== 'apiKey') continue;
      const value = `{{${name}}}`;
      const key = scheme.name || name;
      if (scheme.in === 'query') {
        const existing = query.find(item => item.key === key);
        if (existing) { existing.value = value; existing.disabled = false; }
        else query.push({ key, value });
      }
      else if (scheme.in === 'cookie') {
        const cookie = headers.find(header => header.key.toLowerCase() === 'cookie');
        if (cookie) {
          const parts = cookie.value.split(';').map(part => part.trim()).filter(part => !part.startsWith(`${key}=`));
          cookie.value = [...parts, `${key}=${value}`].join('; ');
        }
        else headers.push({ key: 'Cookie', value: `${key}=${value}` });
      }
      else {
        const existing = headers.find(header => header.key.toLowerCase() === key.toLowerCase());
        if (existing) { existing.value = value; existing.disabled = false; }
        else headers.push({ key, value });
      }
    }
  }

  private preferredResponseType(operation: Operation): string {
    for (const [status, responseValue] of Object.entries(operation.responses)) {
      if (!/^2(?:\d\d|XX)$/i.test(status)) continue;
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
