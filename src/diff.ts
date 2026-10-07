/**
 * Compares two versions of an API description and says which differences can
 * break an existing client.
 *
 * Both documents are expected dereferenced, as `SwaggerParser.validate`
 * returns them. Swagger 2.0 and OpenAPI 3.x are read into one shape first, so
 * a 2.0 document can be compared with the 3.x one that replaced it.
 */

export type ChangeSeverity = 'breaking' | 'non-breaking';

export interface SpecChange {
  severity: ChangeSeverity;
  /** A stable identifier for the kind of change, such as `operation-removed`. */
  code: string;
  /** `GET /pets/{petId}`, or empty for a change to the document as a whole. */
  operation: string;
  /** Where in the operation: `query parameter "limit"`, `response 200 application/json: owner.name`. */
  location: string;
  message: string;
}

export interface SpecDiff {
  changes: SpecChange[];
  breaking: number;
  nonBreaking: number;
}

type Node = Record<string, unknown>;

interface NormalizedParameter {
  in: string;
  name: string;
  required: boolean;
  schema: Node;
}

interface NormalizedOperation {
  /** Method and path as written, for display. */
  label: string;
  deprecated: boolean;
  secured: boolean;
  parameters: Map<string, NormalizedParameter>;
  bodyRequired: boolean;
  /** Media type to schema. */
  requestBodies: Map<string, Node>;
  /** Status code to (media type to schema). A response without a body maps to an empty map. */
  responses: Map<string, Map<string, Node>>;
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
// Nested deeper than this, a schema is a recursive one being walked in circles.
const MAX_SCHEMA_DEPTH = 24;

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nodeOf(value: unknown): Node {
  return isNode(value) ? value : {};
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `/pets/{petId}` and `/pets/{id}` are the same path to a client. */
function pathKey(path: string): string {
  return path.replace(/\{[^}]*\}/g, '{}');
}

function parametersOf(pathItem: Node, operation: Node): { parameters: Map<string, NormalizedParameter>; body?: Node; form: Node[] } {
  const parameters = new Map<string, NormalizedParameter>();
  const form: Node[] = [];
  let body: Node | undefined;
  // Operation-level parameters replace path-level ones of the same name and location.
  for (const raw of [...listOf(pathItem.parameters), ...listOf(operation.parameters)]) {
    if (!isNode(raw) || typeof raw.name !== 'string' || typeof raw.in !== 'string') continue;
    if (raw.in === 'body') { body = raw; continue; }
    if (raw.in === 'formData') { form.push(raw); continue; }
    // Header names are case-insensitive on the wire.
    parameters.set(`${raw.in}:${raw.in === 'header' ? raw.name.toLowerCase() : raw.name}`, {
      in: raw.in,
      name: raw.name,
      required: raw.required === true || raw.in === 'path',
      // OpenAPI 3 nests the type under `schema`; Swagger 2 puts it on the parameter itself.
      schema: isNode(raw.schema) ? raw.schema : raw,
    });
  }
  return { parameters, body, form };
}

function normalizeOperation(spec: Node, path: string, method: string, pathItem: Node, operation: Node): NormalizedOperation {
  const { parameters, body, form } = parametersOf(pathItem, operation);
  const requestBodies = new Map<string, Node>();
  let bodyRequired = false;

  const requestBody = nodeOf(operation.requestBody);
  if (isNode(requestBody.content)) {
    bodyRequired = requestBody.required === true;
    for (const [mediaType, media] of Object.entries(requestBody.content)) {
      requestBodies.set(mediaType.toLowerCase(), nodeOf(nodeOf(media).schema));
    }
  }
  const consumes = listOf(operation.consumes ?? spec.consumes).filter((value): value is string => typeof value === 'string');
  if (body) {
    bodyRequired = body.required === true;
    for (const mediaType of consumes.length ? consumes : ['application/json']) {
      requestBodies.set(mediaType.toLowerCase(), nodeOf(body.schema));
    }
  }
  if (form.length) {
    // Swagger 2 form fields are the properties of an OpenAPI 3 form body.
    const properties: Node = {};
    const required: string[] = [];
    for (const field of form) {
      properties[String(field.name)] = field;
      if (field.required === true) required.push(String(field.name));
    }
    bodyRequired = required.length > 0;
    const formTypes = consumes.filter(type => /form/i.test(type));
    for (const mediaType of formTypes.length ? formTypes : ['application/x-www-form-urlencoded']) {
      requestBodies.set(mediaType.toLowerCase(), { type: 'object', properties, required });
    }
  }

  const responses = new Map<string, Map<string, Node>>();
  const produces = listOf(operation.produces ?? spec.produces).filter((value): value is string => typeof value === 'string');
  for (const [status, raw] of Object.entries(nodeOf(operation.responses))) {
    const response = nodeOf(raw);
    const bodies = new Map<string, Node>();
    if (isNode(response.content)) {
      for (const [mediaType, media] of Object.entries(response.content)) {
        bodies.set(mediaType.toLowerCase(), nodeOf(nodeOf(media).schema));
      }
    } else if (isNode(response.schema)) {
      for (const mediaType of produces.length ? produces : ['application/json']) {
        bodies.set(mediaType.toLowerCase(), response.schema);
      }
    }
    responses.set(String(status).toUpperCase(), bodies);
  }

  const security = operation.security ?? spec.security;
  return {
    label: `${method.toUpperCase()} ${path}`,
    deprecated: operation.deprecated === true,
    // An empty requirement object (`{}`) in the list means "or no credentials at all".
    secured: listOf(security).length > 0 && !listOf(security).some(item => isNode(item) && Object.keys(item).length === 0),
    parameters,
    bodyRequired,
    requestBodies,
    responses,
  };
}

function operationsOf(spec: Node): Map<string, NormalizedOperation> {
  const operations = new Map<string, NormalizedOperation>();
  for (const [path, rawItem] of Object.entries(nodeOf(spec.paths))) {
    const pathItem = nodeOf(rawItem);
    for (const method of METHODS) {
      if (!isNode(pathItem[method])) continue;
      operations.set(`${method} ${pathKey(path)}`, normalizeOperation(spec, path, method, pathItem, pathItem[method]));
    }
  }
  return operations;
}

function typeOf(schema: Node): string {
  const type = Array.isArray(schema.type) ? schema.type.filter(item => item !== 'null').join('|') : schema.type;
  if (typeof type === 'string' && type) return typeof schema.format === 'string' ? `${type} (${schema.format})` : type;
  if (isNode(schema.properties)) return 'object';
  if (schema.items !== undefined) return 'array';
  return '';
}

/** Folds `allOf` into one schema: its members describe the same value. */
function flatten(schema: Node): Node {
  if (!Array.isArray(schema.allOf)) return schema;
  const { allOf, ...rest } = schema;
  let merged: Node = {};
  for (const member of [...allOf, rest]) {
    const part = flatten(nodeOf(member));
    merged = {
      ...merged,
      ...part,
      properties: { ...nodeOf(merged.properties), ...nodeOf(part.properties) },
      required: [...listOf(merged.required), ...listOf(part.required)],
    };
  }
  return merged;
}

class Comparison {
  readonly changes: SpecChange[] = [];

  add(severity: ChangeSeverity, code: string, operation: string, location: string, message: string): void {
    this.changes.push({ severity, code, operation, location, message });
  }

  /**
   * Compares two schemas of a value the client sends (`request`) or receives
   * (`response`). The same difference cuts opposite ways: a property that
   * becomes required breaks a client that sends the body, and one that stops
   * being required breaks a client that reads it.
   */
  schema(direction: 'request' | 'response', operation: string, where: string, path: string, before: Node, after: Node, depth = 0): void {
    if (before === after || depth > MAX_SCHEMA_DEPTH) return;
    const oldSchema = flatten(before);
    const newSchema = flatten(after);
    const location = path ? `${where}: ${path}` : where;

    const oldType = typeOf(oldSchema);
    const newType = typeOf(newSchema);
    if (oldType && newType && oldType !== newType) {
      // A server that starts accepting any number where it took integers breaks nobody.
      const widened = direction === 'request' && oldType.startsWith('integer') && newType.startsWith('number');
      this.add(widened ? 'non-breaking' : 'breaking', 'type-changed', operation, location, `type changed from ${oldType} to ${newType}`);
      return;
    }

    for (const keyword of ['oneOf', 'anyOf']) {
      if ((oldSchema[keyword] || newSchema[keyword]) && JSON.stringify(oldSchema[keyword]) !== JSON.stringify(newSchema[keyword])) {
        this.add('non-breaking', 'composition-changed', operation, location, `"${keyword}" changed; compare the alternatives by hand`);
      }
    }

    const oldEnum = Array.isArray(oldSchema.enum) ? oldSchema.enum.map(String) : undefined;
    const newEnum = Array.isArray(newSchema.enum) ? newSchema.enum.map(String) : undefined;
    if (oldEnum && newEnum) {
      const removed = oldEnum.filter(value => !newEnum.includes(value));
      const added = newEnum.filter(value => !oldEnum.includes(value));
      if (removed.length) {
        this.add(direction === 'request' ? 'breaking' : 'non-breaking', 'enum-value-removed', operation, location, `enum value${removed.length === 1 ? '' : 's'} removed: ${removed.join(', ')}`);
      }
      if (added.length) {
        this.add('non-breaking', 'enum-value-added', operation, location, `enum value${added.length === 1 ? '' : 's'} added: ${added.join(', ')}`);
      }
    } else if (!oldEnum && newEnum && direction === 'request') {
      this.add('breaking', 'enum-added', operation, location, `now limited to: ${newEnum.join(', ')}`);
    }

    const oldProperties = nodeOf(oldSchema.properties);
    const newProperties = nodeOf(newSchema.properties);
    const oldRequired = new Set(listOf(oldSchema.required).map(String));
    const newRequired = new Set(listOf(newSchema.required).map(String));
    for (const name of new Set([...Object.keys(oldProperties), ...Object.keys(newProperties)])) {
      const propertyPath = path ? `${path}.${name}` : name;
      const propertyLocation = `${where}: ${propertyPath}`;
      if (!(name in newProperties)) {
        this.add(direction === 'response' ? 'breaking' : 'non-breaking', 'property-removed', operation, propertyLocation, 'property removed');
        continue;
      }
      if (!(name in oldProperties)) {
        const required = newRequired.has(name);
        this.add(direction === 'request' && required ? 'breaking' : 'non-breaking', required ? 'required-property-added' : 'property-added', operation, propertyLocation, required ? 'new required property' : 'property added');
        continue;
      }
      if (!oldRequired.has(name) && newRequired.has(name)) {
        this.add(direction === 'request' ? 'breaking' : 'non-breaking', 'property-became-required', operation, propertyLocation, 'property became required');
      } else if (oldRequired.has(name) && !newRequired.has(name)) {
        this.add(direction === 'response' ? 'breaking' : 'non-breaking', 'property-became-optional', operation, propertyLocation, 'property is no longer required');
      }
      this.schema(direction, operation, where, propertyPath, nodeOf(oldProperties[name]), nodeOf(newProperties[name]), depth + 1);
    }

    if (isNode(oldSchema.items) && isNode(newSchema.items)) {
      this.schema(direction, operation, where, `${path}[]`, oldSchema.items, newSchema.items, depth + 1);
    }
  }

  operation(before: NormalizedOperation, after: NormalizedOperation): void {
    const name = after.label;
    if (!before.deprecated && after.deprecated) {
      this.add('non-breaking', 'operation-deprecated', name, '', 'operation is now deprecated');
    }
    if (!before.secured && after.secured) {
      this.add('breaking', 'security-added', name, '', 'operation now requires credentials');
    }

    for (const [key, parameter] of before.parameters) {
      const where = `${parameter.in} parameter "${parameter.name}"`;
      const next = after.parameters.get(key);
      if (!next) {
        // A path parameter cannot vanish while the path keeps its shape; this is a rename.
        if (parameter.in !== 'path') this.add('non-breaking', 'parameter-removed', name, where, 'parameter removed; the server no longer reads it');
        continue;
      }
      if (!parameter.required && next.required) this.add('breaking', 'parameter-became-required', name, where, 'parameter became required');
      else if (parameter.required && !next.required) this.add('non-breaking', 'parameter-became-optional', name, where, 'parameter is no longer required');
      this.schema('request', name, where, '', parameter.schema, next.schema);
    }
    for (const [key, parameter] of after.parameters) {
      if (before.parameters.has(key) || parameter.in === 'path') continue;
      const where = `${parameter.in} parameter "${parameter.name}"`;
      this.add(parameter.required ? 'breaking' : 'non-breaking', parameter.required ? 'required-parameter-added' : 'parameter-added', name, where, parameter.required ? 'new required parameter' : 'optional parameter added');
    }

    if (!before.bodyRequired && after.bodyRequired) {
      this.add('breaking', 'request-body-became-required', name, 'request body', before.requestBodies.size ? 'request body became required' : 'a request body is now required');
    }
    for (const [mediaType, schema] of before.requestBodies) {
      const next = after.requestBodies.get(mediaType);
      if (!next) {
        this.add('breaking', 'request-media-type-removed', name, `request body ${mediaType}`, 'media type is no longer accepted');
        continue;
      }
      this.schema('request', name, `request body ${mediaType}`, '', schema, next);
    }
    for (const mediaType of after.requestBodies.keys()) {
      if (!before.requestBodies.has(mediaType) && before.requestBodies.size) {
        this.add('non-breaking', 'request-media-type-added', name, `request body ${mediaType}`, 'media type is now accepted');
      }
    }

    for (const [status, bodies] of before.responses) {
      const next = after.responses.get(status);
      if (!next) {
        const success = /^2/.test(status);
        this.add(success ? 'breaking' : 'non-breaking', 'response-removed', name, `response ${status}`, success ? 'success response removed' : 'response removed');
        continue;
      }
      for (const [mediaType, schema] of bodies) {
        const nextSchema = next.get(mediaType);
        if (!nextSchema) {
          this.add('breaking', 'response-media-type-removed', name, `response ${status} ${mediaType}`, 'media type is no longer returned');
          continue;
        }
        this.schema('response', name, `response ${status} ${mediaType}`, '', schema, nextSchema);
      }
    }
    for (const status of after.responses.keys()) {
      if (!before.responses.has(status)) this.add('non-breaking', 'response-added', name, `response ${status}`, 'response added');
    }
  }
}

/**
 * Lists what changed between two API descriptions, most serious first.
 *
 * "Breaking" means a client written against the old description can fail
 * against the new one: an operation or a success response is gone, a request
 * needs something it did not, a response lost something it had, a type
 * changed. Everything else that is noticed is "non-breaking".
 *
 * Not compared: descriptions and examples, headers of responses, numeric and
 * length limits, `additionalProperties`, callbacks, links and servers.
 */
export function diffSpecs(oldSpec: unknown, newSpec: unknown): SpecDiff {
  if (!isNode(oldSpec) || !isNode(newSpec)) throw new TypeError('diffSpecs expects two API description objects');
  const comparison = new Comparison();
  const before = operationsOf(oldSpec);
  const after = operationsOf(newSpec);

  for (const [key, operation] of before) {
    const next = after.get(key);
    if (!next) comparison.add('breaking', 'operation-removed', operation.label, '', 'operation removed');
    else comparison.operation(operation, next);
  }
  for (const [key, operation] of after) {
    if (!before.has(key)) comparison.add('non-breaking', 'operation-added', operation.label, '', 'operation added');
  }

  const changes = [
    ...comparison.changes.filter(change => change.severity === 'breaking'),
    ...comparison.changes.filter(change => change.severity === 'non-breaking'),
  ];
  const breaking = changes.filter(change => change.severity === 'breaking').length;
  return { changes, breaking, nonBreaking: changes.length - breaking };
}

/** The diff as the lines the CLI prints. */
export function formatSpecDiff(diff: SpecDiff): string {
  if (!diff.changes.length) return 'No differences that affect a client were found.';
  const lines: string[] = [];
  const section = (title: string, severity: ChangeSeverity) => {
    const changes = diff.changes.filter(change => change.severity === severity);
    if (!changes.length) return;
    if (lines.length) lines.push('');
    lines.push(`${title} (${changes.length})`);
    for (const change of changes) {
      const subject = [change.operation, change.location].filter(Boolean).join('  ');
      lines.push(`  ${subject ? `${subject}  ` : ''}${change.message}`);
    }
  };
  section('Breaking changes', 'breaking');
  section('Non-breaking changes', 'non-breaking');
  return lines.join('\n');
}
