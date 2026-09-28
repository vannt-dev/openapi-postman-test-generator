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
}

export interface SecurityScheme {
  type: string;
  name?: string;
  in?: string;
  scheme?: string;
  bearerFormat?: string;
  flow?: string;
  flows?: unknown;
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
export interface PostmanItem { name: string; request?: PostmanRequest; event?: PostmanEvent[]; item?: PostmanItem[] }
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
  variables?: Record<string, string>;
  operationOrder?: string[];
  variableMappings?: VariableMapping[];
  negativeScenarios?: NegativeScenario[];
  disabledOperations?: string[];
  setup?: WorkflowRequest[];
  teardown?: WorkflowRequest[];
  asyncOperations?: AsyncOperation[];
  profiles?: Record<string, {
    baseUrl?: string;
    variables?: Record<string, string>;
    environmentName?: string;
  }>;
  ai?: AiConfig;
}
export interface PostmanEnvironment {
  name: string;
  values: Array<{ key: string; value: string; enabled: boolean; type: 'default' | 'secret' }>;
  _postman_variable_scope: 'environment';
  _postman_exported_using: string;
}
