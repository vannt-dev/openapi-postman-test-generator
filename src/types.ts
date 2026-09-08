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
}

export interface RequestBody { description?: string; required?: boolean; content: Record<string, MediaType> }
export interface MediaType { schema?: Schema; example?: unknown; examples?: Record<string, { value?: unknown }> }

export interface Schema {
  type?: string;
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
export interface PostmanItem { name: string; request?: Record<string, unknown>; event?: PostmanEvent[]; item?: PostmanItem[] }
export interface PostmanCollection {
  info: { name: string; description?: string; schema: string };
  item: PostmanItem[];
  variable: PostmanVariable[];
  auth?: PostmanAuth;
}
export interface PostmanEnvironment {
  name: string;
  values: Array<{ key: string; value: string; enabled: boolean; type: 'default' | 'secret' }>;
  _postman_variable_scope: 'environment';
  _postman_exported_using: string;
}
