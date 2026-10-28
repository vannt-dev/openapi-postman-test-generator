export interface OpenApiSpec {
  swagger?: string;
  openapi?: string;
  info: { title: string; version: string; description?: string };
  host?: string;
  basePath?: string;
  schemes?: string[];
  servers?: Array<{ url: string; description?: string; variables?: Record<string, { default: string }> }>;
  consumes?: string[];
  produces?: string[];
  paths: Record<string, PathItem>;
  definitions?: Record<string, Schema>;
  securityDefinitions?: Record<string, SecurityScheme>;
  components?: {
    schemas?: Record<string, Schema>;
    securitySchemes?: Record<string, SecurityScheme>;
    parameters?: Record<string, Parameter>;
    requestBodies?: Record<string, RequestBody>;
  };
  security?: SecurityRequirement[];
}

export type SecurityRequirement = Record<string, string[]>;
export interface Reference { $ref: string }

export interface PathItem {
  parameters?: Array<Parameter | Reference>;
  get?: Operation; post?: Operation; put?: Operation; delete?: Operation;
  patch?: Operation; head?: Operation; options?: Operation;
}

export interface Operation {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  consumes?: string[];
  produces?: string[];
  parameters?: Array<Parameter | Reference>;
  requestBody?: RequestBody | Reference;
  responses: Record<string, Response | Reference>;
  security?: SecurityRequirement[];
}

export interface Parameter {
  name: string;
  in: 'query' | 'header' | 'path' | 'formData' | 'body' | 'cookie';
  description?: string;
  required?: boolean;
  schema?: Schema;
  content?: Record<string, MediaType>;
  type?: string;
  format?: string;
  items?: Schema;
  default?: unknown;
  enum?: unknown[];
  example?: unknown;
  examples?: Record<string, { value?: unknown }>;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
  collectionFormat?: string;
}

export interface RequestBody { description?: string; required?: boolean; content: Record<string, MediaType> }
export interface MediaType { schema?: Schema; example?: unknown; examples?: Record<string, { value?: unknown }> }

export interface Schema {
  type?: string | string[];
  format?: string;
  title?: string;
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  default?: unknown;
  example?: unknown;
  nullable?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
  const?: unknown;
  multipleOf?: number;
  exclusiveMinimum?: boolean | number;
  exclusiveMaximum?: boolean | number;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  additionalProperties?: boolean | Schema;
  $ref?: string;
}

export interface Response {
  description: string;
  schema?: Schema;
  content?: Record<string, MediaType>;
  examples?: Record<string, unknown>;
  /** Response headers: a schema (OpenAPI 3) or the type on the header itself (Swagger 2.0). */
  headers?: Record<string, Header | Reference>;
}

/** A response header as OpenAPI 3 (`schema`, `content`) or Swagger 2.0 (`type`, `items`, ...) describes it. */
export interface Header extends Omit<Schema, 'required'> {
  required?: boolean;
  schema?: Schema;
  content?: Record<string, MediaType>;
  collectionFormat?: string;
}

export interface SecurityScheme {
  type: string;
  name?: string;
  in?: string;
  scheme?: string;
  bearerFormat?: string;
  flow?: string;
  flows?: unknown;
  /** Swagger 2.0 keeps the token endpoint and the scopes on the scheme itself. */
  tokenUrl?: string;
  scopes?: Record<string, string>;
}

export interface PostmanVariable { key: string; value: string; type?: string; description?: string }
export interface PostmanAuth { type: string; [key: string]: unknown }
export interface PostmanEvent { listen: 'test' | 'prerequest'; script: { type: 'text/javascript'; exec: string[] } }
export interface PostmanHeader { key: string; value: string; description?: string; disabled?: boolean }
export interface PostmanQueryParam { key: string; value: string; description?: string; disabled?: boolean }
export interface PostmanUrl { raw: string; host: string[]; path?: string[]; query?: PostmanQueryParam[] }
export interface PostmanFormEntry { key: string; value: string; type: 'text' | 'file'; disabled?: boolean }
export type PostmanBody =
  | { mode: 'raw'; raw: string; options: { raw: { language: 'json' | 'text' } } }
  | { mode: 'formdata'; formdata: PostmanFormEntry[] }
  | { mode: 'urlencoded'; urlencoded: PostmanFormEntry[] };
export interface PostmanRequest {
  method: string;
  header: PostmanHeader[];
  body?: PostmanBody;
  url: PostmanUrl;
  description?: string;
  auth?: PostmanAuth;
}
export interface PostmanItem {
  /** Generated requests carry `op:<operationId>`, the key `coverage --run` joins a Newman report on. */
  id?: string;
  name: string;
  request?: PostmanRequest;
  event?: PostmanEvent[];
  item?: PostmanItem[];
}
export interface PostmanCollection {
  info: { name: string; description?: string; schema: string };
  item: PostmanItem[];
  variable: PostmanVariable[];
  auth?: PostmanAuth;
}

export interface VariableMapping {
  sourceOperationId: string;
  responseJsonPath: string;
  variable: string;
  targetOperationIds?: string[];
}

export interface NegativeScenario {
  operationId: string;
  name: string;
  kind: 'missing_required' | 'boundary' | 'invalid_enum' | 'unauthorized';
  field?: string | null;
}

export type WorkflowMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/** A request that is not described by the spec, such as seeding data or resetting an environment. */
export interface WorkflowRequest {
  name: string;
  method: WorkflowMethod;
  /** A leading "/" is prefixed with {{baseUrl}}. */
  url: string;
  headers?: Record<string, string>;
  /** Objects and arrays are sent as JSON; strings are sent as raw text. */
  body?: unknown;
  /** Accepted status codes. Defaults to any 2xx. */
  expectStatus?: number[];
  /** Collection variable name -> JSONPath in the response body. */
  extract?: Record<string, string>;
  /** Send the collection's API credentials. Defaults to false. */
  inheritAuth?: boolean;
}

/** An operation that starts a background job whose status must be polled. */
export interface AsyncOperation {
  operationId: string;
  /** Defaults to the operation's Location response header. */
  statusUrl?: string;
  statusJsonPath: string;
  successValues: string[];
  failureValues?: string[];
  intervalMs?: number;
  maxAttempts?: number;
  /** Applied when the job reaches a success value. */
  extract?: Record<string, string>;
  /** Poll with the operation's credentials and headers. Defaults to true; disable for presigned storage URLs. */
  inheritAuth?: boolean;
}

export interface AgentPlan {
  operationOrder: string[];
  variableMappings: VariableMapping[];
  negativeScenarios: NegativeScenario[];
  warnings: string[];
}

export interface AiProviderConfig {
  type?: 'openai' | 'codex' | 'claude' | 'antigravity' | 'command';
  command?: string;
  args?: string[];
  model?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  input?: 'stdin' | 'argument';
  output?: 'stdout-json' | 'stdout-text' | 'output-file';
}

export interface AiConfig {
  provider?: string;
  fallback?: string[];
  model?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  providers?: Record<string, AiProviderConfig>;
}

export interface ProjectConfig {
  baseUrl?: string;
  responseTimeMs?: number;
  safeMode?: boolean;
  includeNegative?: boolean;
  requestExamples?: boolean;
  variables?: Record<string, string>;
  operationOrder?: string[];
  variableMappings?: VariableMapping[];
  negativeScenarios?: NegativeScenario[];
  disabledOperations?: string[];
  setup?: WorkflowRequest[];
  teardown?: WorkflowRequest[];
  asyncOperations?: AsyncOperation[];
  /** Only the operations that carry one of these tags ("Default" names the untagged ones). */
  includeTags?: string[];
  /** Leave out the operations that carry one of these tags. */
  excludeTags?: string[];
  /** Start the collection by fetching an OAuth2 client credentials token for the schemes that have that flow. */
  oauthClientCredentials?: boolean;
  /** Check the response headers the document declares. Defaults to true. */
  responseHeaderAssertions?: boolean;
  profiles?: Record<string, {
    baseUrl?: string;
    variables?: Record<string, string>;
    environmentName?: string;
  }>;
  ai?: AiConfig;
}
/** Why an operation of the document has no request in the collection. */
export type CoverageSkipReason = 'disabled' | 'tag filter' | 'safe mode';

export interface CoverageOperation {
  operationId: string;
  method: string;
  path: string;
  tags: string[];
  /** Whether the collection holds a request for it. */
  included: boolean;
  reason?: CoverageSkipReason;
  /** The responses the document describes for it, "default" set aside. */
  documented: string[];
  /** The documented responses that a generated request expects. */
  covered: string[];
}

/** What of the document the generated collection tests: by design, not by what a run returned. */
export interface CoverageReport {
  operations: { total: number; covered: number; skipped: Array<{ operationId: string; method: string; path: string; reason: CoverageSkipReason }> };
  /** Documented responses of the operations that are in the collection. */
  responses: { total: number; covered: number; uncovered: Array<{ operationId: string; method: string; path: string; status: string }> };
  byOperation: CoverageOperation[];
}

export interface PostmanEnvironment {
  name: string;
  values: Array<{ key: string; value: string; enabled: boolean; type: 'default' | 'secret' }>;
  _postman_variable_scope: 'environment';
  _postman_exported_using: string;
}
