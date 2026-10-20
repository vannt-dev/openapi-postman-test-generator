import { exampleFor } from './generator/example';
import { toJsonSchema } from './generator/json-schema';
import { classifySecurityScheme } from './generator/security';
import { documentedStatus, negativeItemId, operationItemId } from './run-coverage';
import {
  AsyncOperation, CoverageOperation, CoverageReport, CoverageSkipReason,
  Header, MediaType, NegativeScenario, OpenApiSpec, Operation, Parameter, PathItem, PostmanAuth,
  PostmanBody, PostmanCollection, PostmanEnvironment, PostmanEvent, PostmanFormEntry,
  PostmanHeader, PostmanItem, PostmanQueryParam, PostmanUrl, PostmanVariable,
  Reference, RequestBody, Response, Schema, SecurityScheme, VariableMapping, WorkflowRequest,
} from './types';

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'] as const;
// Postman script helper that resolves the small JSONPath subset used by mappings and extractions.
const GET_PATH_LINES = [
  'const getPath = (value, jsonPath) => {',
  '  const tokens = [];',
  '  jsonPath.replace(/^\\$\\.?/, "").replace(/\\[([0-9]+)|[\\x27"]([^\\x27"]+)[\\x27"]\\]|([^.\\[\\]]+)/g, (_, index, quoted, plain) => { tokens.push(index !== undefined ? Number(index) : quoted || plain); return ""; });',
  '  return tokens.reduce((current, key) => current == null ? undefined : current[key], value);',
  '};',
];
// Environment values take precedence over collection variables at run time, so a value captured
// from a response must also replace a same-named environment variable (such as a generated
// placeholder) or later requests would keep using the placeholder.
const SET_VARIABLE_LINES = [
  'const setVariable = (key, value) => {',
  '  if (pm.environment.has(key)) pm.environment.set(key, value);',
  '  pm.collectionVariables.set(key, value);',
  '};',
];
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
  setup?: WorkflowRequest[];
  teardown?: WorkflowRequest[];
  asyncOperations?: AsyncOperation[];
  includeTags?: string[];
  excludeTags?: string[];
  oauthClientCredentials?: boolean;
  /** Check the response headers the document declares. Defaults to true. */
  responseHeaderAssertions?: boolean;
}

/** How a generated script checks one declared response header. */
interface HeaderCheck {
  required: boolean;
  /** JSON Schema of the value, or null when only presence can be checked. */
  schema: Record<string, unknown> | null;
  /** The list separator when it is not a comma (Swagger 2.0 collectionFormat). */
  delimiter?: string;
}

/** Status code ("200", "2XX", "default") to header name to check. */
type HeaderChecks = Record<string, Record<string, HeaderCheck>>;

const COLLECTION_DELIMITERS: Record<string, string> = { ssv: ' ', tsv: '\t', pipes: '|' };

/**
 * A header schema without `format`: HTTP dates (`Last-Modified`, `Expires`) are not the RFC 3339
 * date-times a `date-time` format asks for, and specs label them that way often enough.
 */
function withoutFormat(schema: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...schema };
  delete rest.format;
  if (rest.items && typeof rest.items === 'object') rest.items = withoutFormat(rest.items as Record<string, unknown>);
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(rest[keyword])) rest[keyword] = (rest[keyword] as Array<Record<string, unknown>>).map(withoutFormat);
  }
  return rest;
}

// The part of a test script that checks the declared headers of the status code received.
// Presence is asserted for required headers only; a value is checked when the header is sent.
const HEADER_CHECK_LINES = [
  '  const headerStatus = String(pm.response.code);',
  '  const declaredHeaders = responseHeaders[headerStatus] || responseHeaders[headerStatus.charAt(0) + "XX"] || responseHeaders.default || {};',
  '  // Header values are text: read them as the declared type before the schema is applied.',
  '  const readHeader = (raw, schema, delimiter) => {',
  '    const types = [].concat(schema.type || []);',
  '    if (types.indexOf("array") >= 0) return raw.split(delimiter || ",").map(item => readHeader(item.trim(), schema.items || {}));',
  '    if ((types.indexOf("integer") >= 0 || types.indexOf("number") >= 0) && raw.trim() !== "" && !isNaN(Number(raw))) return Number(raw);',
  '    if (types.indexOf("boolean") >= 0 && (raw === "true" || raw === "false")) return raw === "true";',
  '    return raw;',
  '  };',
  '  Object.keys(declaredHeaders).forEach(name => {',
  '    const header = declaredHeaders[name];',
  '    const raw = pm.response.headers.get(name);',
  '    if (header.required) {',
  '      pm.test("Response has the " + name + " header", function () {',
  '        pm.expect(raw, name + " header").to.be.a("string");',
  '      });',
  '    }',
  '    if (raw !== undefined && raw !== null && header.schema) {',
  '      pm.test("Response header " + name + " matches its schema", function () {',
  '        pm.expect(readHeader(String(raw), header.schema, header.delimiter)).to.have.jsonSchema(header.schema);',
  '      });',
  '    }',
  '  });',
];

/** The tag an operation without tags is filed under, as a folder and for the tag filter. */
const DEFAULT_TAG = 'Default';

interface OperationEntry { route: string; method: string; pathItem: PathItem; operation: Operation; index: number }

export class OpenApiPostmanGenerator {
  private readonly baseUrl: string;
  private readonly responseTimeMs: number;
  private readonly variables = new Map<string, PostmanVariable>();
  private readonly warnings: string[] = [];
  /** One entry per operation of the document, filled by generate(). */
  private coverage: Array<CoverageOperation & { index: number }> | undefined;
  private readonly coverageByOperation = new Map<Operation, CoverageOperation>();
  private readonly tokenRequests: WorkflowRequest[] = [];
  private readonly tokenSchemes: string[] = [];
  private readonly resolveSchema = (schema: Schema): Schema => this.resolve<Schema>(schema);

  constructor(private readonly spec: OpenApiSpec, private readonly options: GeneratorOptions = {}) {
    this.baseUrl = options.baseUrl || this.detectBaseUrl();
    this.responseTimeMs = options.responseTimeMs || 2000;
    this.addVariable('baseUrl', this.baseUrl, 'API base URL');
    for (const [key, value] of Object.entries(options.variables || {})) this.addVariable(key, value, 'Configured variable');
    if (options.oauthClientCredentials) this.planTokenRequests();
  }

  /**
   * One request per security scheme with an OAuth2 client credentials flow: it asks the token endpoint for a
   * token with the client id and secret of the environment and keeps it where the other requests read it.
   */
  private planTokenRequests(): void {
    for (const [name, scheme] of Object.entries(this.securitySchemes())) {
      if (scheme.type !== 'oauth2') continue;
      const flow = (scheme.flows as { clientCredentials?: { tokenUrl?: string; scopes?: Record<string, string> } } | undefined)?.clientCredentials
        || (scheme.flow === 'application' ? { tokenUrl: scheme.tokenUrl, scopes: scheme.scopes } : undefined);
      if (!flow?.tokenUrl) continue;
      const scopes = Object.keys(flow.scopes || {});
      this.addVariable(`${name}_tokenUrl`, flow.tokenUrl, 'OAuth2 token endpoint');
      this.tokenSchemes.push(name);
      this.tokenRequests.push({
        name: `Get access token (${name})`,
        method: 'POST',
        url: `{{${name}_tokenUrl}}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id={{${name}_clientId}}&client_secret={{${name}_clientSecret}}`
          + (scopes.length ? `&scope=${encodeURIComponent(scopes.join(' '))}` : ''),
        extract: { [`${name}_token`]: '$.access_token' },
      });
    }
    if (!this.tokenRequests.length) this.warnings.push('No OAuth2 client credentials flow was found: the access token is still a value to supply');
  }

  getWarnings(): string[] { return [...this.warnings]; }

  /**
   * What of the document the collection built by generate() tests: which operations have a request, and
   * which of their documented responses a generated request expects. It is a statement about the
   * collection, not about a run: a response counts when a request is written to expect it.
   */
  getCoverage(): CoverageReport {
    if (!this.coverage) throw new Error('Call generate() first: the coverage is that of the collection it builds');
    const byOperation: CoverageOperation[] = [...this.coverage].sort((left, right) => left.index - right.index).map(entry => ({
      operationId: entry.operationId, method: entry.method, path: entry.path, tags: entry.tags, included: entry.included,
      ...(entry.reason ? { reason: entry.reason } : {}),
      documented: entry.documented, covered: entry.covered,
    }));
    const included = byOperation.filter(entry => entry.included);
    const at = (entry: CoverageOperation) => ({ operationId: entry.operationId, method: entry.method, path: entry.path });
    return {
      operations: {
        total: byOperation.length,
        covered: included.length,
        skipped: byOperation.filter(entry => !entry.included).map(entry => ({ ...at(entry), reason: entry.reason! })),
      },
      responses: {
        total: included.reduce((sum, entry) => sum + entry.documented.length, 0),
        covered: included.reduce((sum, entry) => sum + entry.covered.length, 0),
        uncovered: included.flatMap(entry => entry.documented
          .filter(status => !entry.covered.includes(status))
          .map(status => ({ ...at(entry), status }))),
      },
      byOperation,
    };
  }

  /** Notes that a generated request expects these status codes of an operation. */
  private cover(operation: Operation, codes: Array<number | string>): void {
    const entry = this.coverageByOperation.get(operation);
    if (!entry) return;
    for (const code of codes) {
      const status = documentedStatus(entry.documented, code);
      if (status && !entry.covered.includes(status)) entry.covered.push(status);
    }
    entry.covered.sort();
  }

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
    for (const asyncOperation of this.options.asyncOperations || []) {
      if (!knownOperations.has(asyncOperation.operationId)) this.warnings.push(`Async operation was not found: ${asyncOperation.operationId}`);
    }
    const tagsOf = (operation: Operation): string[] => (operation.tags?.length ? operation.tags : [DEFAULT_TAG]).map(tag => tag.toLowerCase());
    const includeTags = (this.options.includeTags || []).map(tag => tag.toLowerCase());
    const excludeTags = (this.options.excludeTags || []).map(tag => tag.toLowerCase());
    const knownTags = new Set(entries.flatMap(entry => tagsOf(entry.operation)));
    for (const tag of [...(this.options.includeTags || []), ...(this.options.excludeTags || [])]) {
      if (!knownTags.has(tag.toLowerCase())) this.warnings.push(`Tag was not found: ${tag}`);
    }
    this.coverage = [];
    this.coverageByOperation.clear();
    for (const entry of this.sortEntries(entries)) {
      const id = this.operationId(entry.route, entry.method, entry.operation);
      const tags = tagsOf(entry.operation);
      const covered: CoverageOperation & { index: number } = {
        operationId: id, method: entry.method, path: entry.route, tags: entry.operation.tags || [], included: true,
        documented: Object.keys(entry.operation.responses).filter(code => code.toLowerCase() !== 'default').map(code => code.toUpperCase()).sort(),
        covered: [], index: entry.index,
      };
      this.coverage.push(covered);
      const leftOut = (reason: CoverageSkipReason): void => { covered.included = false; covered.reason = reason; };
      if (this.options.disabledOperations?.includes(id)) { leftOut('disabled'); continue; }
      if ((includeTags.length && !tags.some(tag => includeTags.includes(tag))) || tags.some(tag => excludeTags.includes(tag))) {
        leftOut('tag filter');
        continue;
      }
      if (this.options.safeMode && entry.method === 'DELETE') {
        this.warnings.push(`Skipped destructive operation in safe mode: ${id}`);
        leftOut('safe mode');
        continue;
      }
      this.coverageByOperation.set(entry.operation, covered);
      const tag = entry.operation.tags?.[0] || DEFAULT_TAG;
      const items = folders.get(tag) || [];
      // The ids link the requests of a Newman report back to the operation (coverage --run).
      const generated: PostmanItem[] = [{ id: operationItemId(id), ...this.generateItem(entry.route, entry.method, entry.pathItem, entry.operation) }];
      const asyncOperation = this.asyncOperationFor(id);
      if (asyncOperation) generated.push(this.pollItem(asyncOperation, generated[0]));
      if (this.options.includeNegative) {
        generated.push(...this.generateNegativeItems(entry).map((item, position) => ({ id: negativeItemId(id, position + 1), ...item })));
      }
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
      item: [
        // the token first: a configured setup request may already need it
        ...this.workflowFolder('Setup', [...this.tokenRequests, ...(this.options.setup || [])]),
        ...(this.options.operationOrder?.length
          ? orderedItems
          : [...folders].map(([name, item]) => ({ name, item }))),
        ...this.workflowFolder('Teardown', this.options.teardown),
      ],
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
      if (existing) {
        if (type !== 'secret') existing.value = value;
        existing.type = type;
      }
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
      if (this.tokenSchemes.includes(key)) {
        add(`${key}_clientId`, '', 'secret');
        add(`${key}_clientSecret`, '', 'secret');
      }
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
      headers.push({ key: 'Accept', value: this.preferredResponseType(operation) });
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
    headers.push({ key: 'Accept', value: this.preferredResponseType(operation) });
    const raw = typeof example === 'string' && !contentType.includes('json') ? example : JSON.stringify(example, null, 2);
    return { mode: 'raw', raw, options: { raw: { language: contentType.includes('json') ? 'json' : 'text' } } };
  }

  private generateTests(route: string, operation: Operation, method: string): PostmanEvent {
    const successEntries = Object.entries(operation.responses).filter(([code]) => /^2(?:\d\d|XX)$/i.test(code));
    const allowed = successEntries.filter(([code]) => /^2\d\d$/.test(code)).map(([code]) => Number(code));
    const hasWildcard = successEntries.some(([code]) => /^2XX$/i.test(code));
    const codes = allowed.length ? allowed : [200, 201, 202, 204];
    this.cover(operation, hasWildcard ? ['2XX', ...allowed] : allowed);
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
    lines.push(...this.headerCheckLines(operation, status => /^2/.test(status)));
    const operationId = this.operationId(route, method, operation);
    const mappings = (this.options.variableMappings || []).filter(mapping => mapping.sourceOperationId === operationId);
    if (method === 'POST' || mappings.length) {
      lines.push('', '// Persist common identifiers so later requests can reuse them.',
        'if (pm.response.code >= 200 && pm.response.code < 300 && pm.response.text()) {',
        '  let data; try { data = pm.response.json(); } catch (_) {}',
        ...SET_VARIABLE_LINES.map(line => `  ${line}`),
        '  if (data && typeof data === "object" && !Array.isArray(data)) {',
        '    Object.keys(data).filter(k => k === "id" || /Id$/.test(k)).forEach(k => setVariable(k, data[k]));',
        '  }',
      );
      if (mappings.length) {
        lines.push(`  const mappings = ${JSON.stringify(mappings)};`, ...GET_PATH_LINES.map(line => `  ${line}`),
          '  mappings.forEach(mapping => {',
          '    const value = getPath(data, mapping.responseJsonPath);',
          '    if (value !== undefined) setVariable(mapping.variable, value);',
          '  });',
        );
      }
      lines.push('}');
    }
    const asyncOperation = this.asyncOperationFor(operationId);
    if (asyncOperation) {
      // A block keeps these names away from the declarations above.
      lines.push('', '// Start a fresh poll for the background job started by this request.', '{',
        `  pm.collectionVariables.unset(${JSON.stringify(this.pollCounterVariable(asyncOperation))});`);
      if (!asyncOperation.statusUrl) {
        const statusVariable = JSON.stringify(this.statusUrlVariable(asyncOperation));
        lines.push(
          `  pm.collectionVariables.unset(${statusVariable});`,
          '  if (pm.response.code >= 200 && pm.response.code < 300) {',
          '    const jobLocation = pm.response.headers.get("Location");',
          '    pm.test("Response has a Location header for the async job", function () {',
          '      pm.expect(jobLocation, "Location header").to.be.a("string").that.is.not.empty;',
          '    });',
          ...SET_VARIABLE_LINES.map(line => `    ${line}`),
          '    // Resolve relative, absolute-path, and scheme-relative references against the request URL.',
          `    if (jobLocation) setVariable(${statusVariable}, require("url").resolve(pm.variables.replaceIn(pm.request.url.toString()), jobLocation));`,
          '  }',
        );
      }
      lines.push('}');
    }
    return { listen: 'test', script: { type: 'text/javascript', exec: lines } };
  }

  private asyncOperationFor(operationId: string): AsyncOperation | undefined {
    return this.options.asyncOperations?.find(candidate => candidate.operationId === operationId);
  }

  private statusUrlVariable(asyncOperation: AsyncOperation): string {
    return `${this.variableSafe(asyncOperation.operationId)}_statusUrl`;
  }

  private pollCounterVariable(asyncOperation: AsyncOperation): string {
    return `__poll_${this.variableSafe(asyncOperation.operationId)}_attempts`;
  }

  /** Escapes every non-alphanumeric character so distinct operation ids never share a variable. */
  private variableSafe(value: string): string {
    return value.replace(/[^A-Za-z0-9]/g, character => `_${character.charCodeAt(0).toString(16)}_`);
  }

  private workflowUrl(url: string): PostmanUrl {
    const raw = url.startsWith('/') ? `{{baseUrl}}${url}` : url;
    // Fragments are never sent to the server.
    const withoutFragment = raw.split('#')[0];
    const queryIndex = withoutFragment.indexOf('?');
    const location = queryIndex < 0 ? withoutFragment : withoutFragment.slice(0, queryIndex);
    const [, host, rest] = location.match(/^((?:(?:[a-z][a-z0-9+.-]*|\{\{[^}]+\}\}):\/\/)?[^/]*)(.*)$/i)!;
    const result: PostmanUrl = { raw, host: [host] };
    // Postman appends "/" whenever a path array exists, so a URL held in one variable must have none.
    if (rest) result.path = rest.replace(/^\//, '').split('/');
    if (queryIndex >= 0) {
      result.query = withoutFragment.slice(queryIndex + 1).split('&').filter(Boolean).map(pair => {
        const separator = pair.indexOf('=');
        return separator < 0 ? { key: pair, value: '' } : { key: pair.slice(0, separator), value: pair.slice(separator + 1) };
      });
    }
    return result;
  }

  private workflowFolder(name: string, requests: WorkflowRequest[] | undefined): PostmanItem[] {
    if (!requests?.length) return [];
    return [{ name, item: requests.map(request => this.workflowItem(request)) }];
  }

  private workflowItem(request: WorkflowRequest): PostmanItem {
    const header: PostmanHeader[] = Object.entries(request.headers || {}).map(([key, value]) => ({ key, value }));
    let body: PostmanBody | undefined;
    if (request.body !== undefined) {
      const text = typeof request.body === 'string';
      if (!header.some(item => item.key.toLowerCase() === 'content-type')) {
        header.push({ key: 'Content-Type', value: text ? 'text/plain' : 'application/json' });
      }
      body = {
        mode: 'raw',
        raw: text ? request.body as string : JSON.stringify(request.body, null, 2),
        options: { raw: { language: text ? 'text' : 'json' } },
      };
    }
    const lines = request.expectStatus
      ? [`pm.test("Status code is ${request.expectStatus.join(', ')}", function () {`,
        `  pm.expect(pm.response.code).to.be.oneOf(${JSON.stringify(request.expectStatus)});`, '});']
      : ['pm.test("Status code is successful (2XX)", function () {',
        '  pm.expect(pm.response.code).to.be.within(200, 299);', '});'];
    if (request.extract && Object.keys(request.extract).length) lines.push('', ...this.extractLines(request.extract));
    return {
      name: request.name,
      request: {
        method: request.method, header, ...(body ? { body } : {}), url: this.workflowUrl(request.url),
        // Config URLs may point outside the API, so credentials are opt-in.
        ...(request.inheritAuth ? {} : { auth: { type: 'noauth' } }),
      },
      event: [{ listen: 'test', script: { type: 'text/javascript', exec: lines } }],
    };
  }

  private extractLines(extract: Record<string, string>): string[] {
    const mappings = Object.entries(extract).map(([variable, responseJsonPath]) => ({ variable, responseJsonPath }));
    return [
      `const extractions = ${JSON.stringify(mappings)};`,
      'let extractData; try { extractData = pm.response.json(); } catch (_) {}',
      ...GET_PATH_LINES,
      ...SET_VARIABLE_LINES,
      'extractions.forEach(mapping => {',
      '  const value = extractData === undefined ? undefined : getPath(extractData, mapping.responseJsonPath);',
      '  pm.test("Extracted " + mapping.variable + " from " + mapping.responseJsonPath, function () {',
      '    pm.expect(value, mapping.responseJsonPath).to.not.equal(undefined);',
      '  });',
      '  if (value !== undefined) setVariable(mapping.variable, value);',
      '});',
    ];
  }

  private pollItem(asyncOperation: AsyncOperation, operationItem: PostmanItem): PostmanItem {
    const name = `Poll: ${asyncOperation.operationId}`;
    const counter = this.pollCounterVariable(asyncOperation);
    const intervalMs = asyncOperation.intervalMs ?? 1000;
    const maxAttempts = asyncOperation.maxAttempts ?? 30;
    const url = asyncOperation.statusUrl ?? `{{${this.statusUrlVariable(asyncOperation)}}}`;
    const exec = [
      `const counterKey = ${JSON.stringify(counter)};`,
      'const attempts = Number(pm.collectionVariables.get(counterKey) || 0) + 1;',
      `const successValues = ${JSON.stringify(asyncOperation.successValues)};`,
      `const failureValues = ${JSON.stringify(asyncOperation.failureValues || [])};`,
      `const statusPath = ${JSON.stringify(asyncOperation.statusJsonPath)};`,
      'let pollData; try { pollData = pm.response.json(); } catch (_) {}',
      ...GET_PATH_LINES,
      'const rawStatus = pollData === undefined ? undefined : getPath(pollData, statusPath);',
      'const status = rawStatus === undefined || rawStatus === null ? undefined : String(rawStatus);',
      'const next = requestName => (pm.execution && pm.execution.setNextRequest)',
      '  ? pm.execution.setNextRequest(requestName) : postman.setNextRequest(requestName);',
      'if (successValues.includes(status)) {',
      '  pm.collectionVariables.unset(counterKey);',
      '  pm.test("Async job completed", function () {',
      '    pm.expect(status).to.be.oneOf(successValues);',
      '  });',
      ...(asyncOperation.extract && Object.keys(asyncOperation.extract).length
        ? this.extractLines(asyncOperation.extract).map(line => `  ${line}`) : []),
      '} else if (failureValues.includes(status)) {',
      '  pm.collectionVariables.unset(counterKey);',
      '  pm.test("Async job completed", function () {',
      '    pm.expect.fail("Job reached failure status " + status);',
      '  });',
      `} else if (attempts < ${maxAttempts}) {`,
      '  pm.collectionVariables.set(counterKey, attempts);',
      '  next(pm.info.requestName);',
      '} else {',
      '  pm.collectionVariables.unset(counterKey);',
      '  pm.test("Async job completed", function () {',
      `    pm.expect.fail("Job did not reach a success status after ${maxAttempts} attempts; last status: " + status + " (HTTP " + pm.response.code + ")");`,
      '  });',
      '}',
    ];
    // By default the status endpoint gets the operation's credentials, API-key headers, and
    // cookies; presigned storage URLs reject extra credentials, so that can be switched off.
    const inherit = asyncOperation.inheritAuth !== false;
    const header: PostmanHeader[] = [
      ...(inherit ? (operationItem.request?.header || [])
        .filter(item => !['accept', 'content-type'].includes(item.key.toLowerCase()))
        .map(item => ({ ...item })) : []),
      { key: 'Accept', value: 'application/json' },
    ];
    const auth = inherit ? operationItem.request?.auth : { type: 'noauth' };
    return {
      name,
      request: { method: 'GET', header, url: this.workflowUrl(url), ...(auth ? { auth } : {}) },
      event: [
        { listen: 'prerequest', script: { type: 'text/javascript', exec: [
          'const statusUrl = pm.variables.replaceIn(pm.request.url.toString());',
          'if (!statusUrl || /{{[^}]+}}/.test(statusUrl)) {',
          `  pm.collectionVariables.unset(${JSON.stringify(counter)});`,
          '  pm.test("Async job status URL is resolved", function () {',
          '    pm.expect.fail("No status URL to poll: " + statusUrl);',
          '  });',
          '  if (pm.execution && pm.execution.skipRequest) pm.execution.skipRequest();',
          `} else if (Number(pm.collectionVariables.get(${JSON.stringify(counter)}) || 0) > 0) {`,
          '  // Wait before every retry; the first status check runs immediately.',
          `  setTimeout(function () {}, ${intervalMs});`,
          '}',
        ] } },
        { listen: 'test', script: { type: 'text/javascript', exec } },
      ],
    };
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
      unauthorized.event = [this.negativeTest('Request is rejected without credentials', this.negativeCodes(entry.operation, [401, 403]), entry.operation)];
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
            this.negativeTest(`Missing required parameter '${parameter.name}' is rejected`, this.negativeCodes(entry.operation, [400, 404, 422]), entry.operation));
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
        this.negativeTest(`Missing required field '${requiredField}' is rejected`, this.negativeCodes(entry.operation, [400, 422]), entry.operation),
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
            this.negativeTest(`Invalid enum value for '${parameter.name}' is rejected`, this.negativeCodes(entry.operation, [400, 422]), entry.operation));
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
        this.negativeTest(`Invalid enum value for '${enumField}' is rejected`, this.negativeCodes(entry.operation, [400, 422]), entry.operation),
      );
    }

    for (const scenario of requested('boundary')) {
      const boundaryField = scenario.field && resolved?.properties?.[scenario.field]
        ? [scenario.field, resolved.properties[scenario.field]] as const
        : Object.entries(resolved?.properties || {}).find(([, schema]) => this.hasBoundary(schema));
      if (!boundaryField) {
        const parameter = parameters.find(item => {
          const schema = this.parameterSchema(item);
          return (!scenario.field || item.name === scenario.field) && this.hasBoundary(schema);
        });
        if (parameter) {
          const variant = this.parameterNegativeVariant(positive, operationId, parameter,
            explicitPlan ? scenario.name : `out-of-range ${parameter.name}`, this.invalidBoundaryValue(this.parameterSchema(parameter)), false,
            this.negativeTest(`Out-of-range value for '${parameter.name}' is rejected`, this.negativeCodes(entry.operation, [400, 404, 422]), entry.operation));
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
        this.negativeTest(`Out-of-range value for '${field}' is rejected`, this.negativeCodes(entry.operation, [400, 422]), entry.operation),
      );
    }
    return output;
  }

  /** A value that violates one declared bound, or undefined when no bound can be violated. */
  private invalidBoundaryValue(schema: Schema): unknown {
    const step = schema.multipleOf || 1;
    if (schema.minimum !== undefined) return schema.exclusiveMinimum === true ? schema.minimum : schema.minimum - step;
    if (typeof schema.exclusiveMinimum === 'number') return schema.exclusiveMinimum;
    if (schema.maximum !== undefined) return schema.exclusiveMaximum === true ? schema.maximum : schema.maximum + step;
    if (typeof schema.exclusiveMaximum === 'number') return schema.exclusiveMaximum;
    // minLength 0 is satisfied by every string, so only a positive minimum can be undercut.
    if (schema.minLength !== undefined && schema.minLength > 0) return 'x'.repeat(schema.minLength - 1);
    if (schema.maxLength !== undefined) return 'x'.repeat(schema.maxLength + 1);
    return undefined;
  }

  private hasBoundary(schema: Schema): boolean {
    return this.invalidBoundaryValue(schema) !== undefined;
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
      if (request.url.path) request.url.path = request.url.path.map(segment => segment === `{{${variable}}}` ? replacement : segment);
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
    const codes = preferred.length ? preferred : declared.length ? declared : fallback;
    this.cover(operation, codes);
    return codes;
  }

  private negativeTest(name: string, codes: number[], operation: Operation): PostmanEvent {
    return { listen: 'test', script: { type: 'text/javascript', exec: [
      `pm.test(${JSON.stringify(name)}, function () {`,
      `  pm.expect(pm.response.code).to.be.oneOf(${JSON.stringify(codes)});`,
      '});',
      ...this.headerCheckLines(operation, status => /^[45]/.test(status)),
    ] } };
  }

  /** The script lines that check the headers declared by the responses whose status passes `include`. */
  private headerCheckLines(operation: Operation, include: (status: string) => boolean): string[] {
    if (this.options.responseHeaderAssertions === false) return [];
    const checks: HeaderChecks = {};
    for (const [code, value] of Object.entries(operation.responses)) {
      const status = code.toLowerCase() === 'default' ? 'default' : code.toUpperCase();
      if (status !== 'default' && !include(status)) continue;
      const headers: Record<string, HeaderCheck> = {};
      for (const [name, header] of Object.entries(this.resolve<Response>(value)?.headers || {})) {
        // OpenAPI: a Content-Type entry among the response headers is ignored.
        if (name.toLowerCase() === 'content-type') continue;
        headers[name] = this.headerCheck(this.resolve<Header>(header));
      }
      if (Object.keys(headers).length) checks[status] = headers;
    }
    if (!Object.keys(checks).length) return [];
    return ['', '// Check the response headers the document declares for the status code received.', '{',
      `  const responseHeaders = ${JSON.stringify(checks)};`, ...HEADER_CHECK_LINES, '}'];
  }

  private headerCheck(header: Header): HeaderCheck {
    // OpenAPI 3 puts the type under `schema` (a media type is left unparsed); Swagger 2.0 on the header.
    const { required, schema: nested, content, collectionFormat, ...inline } = header;
    const source = nested || (!content && (inline.type || inline.enum) ? inline as Schema : undefined);
    let schema = source ? withoutFormat(toJsonSchema(source, this.resolveSchema)) : null;
    const types = schema ? ([] as unknown[]).concat(schema.type ?? []) : [];
    // An object-valued header has no single text form to parse: only its presence is checked.
    if (schema && (types.includes('object') || schema.properties)) schema = null;
    const delimiter = collectionFormat ? COLLECTION_DELIMITERS[collectionFormat] : undefined;
    return { required: required === true, schema, ...(delimiter ? { delimiter } : {}) };
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
