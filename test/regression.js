const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OpenApiPostmanGenerator } = require('../dist/generator');
const { loadProjectConfig } = require('../dist/config');
const { toJsonSchema } = require('../dist/generator/json-schema');
const { exampleFor } = require('../dist/generator/example');

const operation = (operationId, tag, extra = {}) => ({
  operationId, tags: [tag], responses: { 200: { description: 'OK' } }, ...extra,
});
const flatten = items => items.flatMap(item => item.request ? [item] : flatten(item.item || []));

// A workflow that alternates tags must retain its configured execution order.
{
  const spec = {
    openapi: '3.0.3', info: { title: 'Ordering', version: '1' },
    paths: {
      '/a1': { get: operation('a1', 'A') },
      '/b1': { get: operation('b1', 'B') },
      '/a2': { get: operation('a2', 'A') },
    },
  };
  const collection = new OpenApiPostmanGenerator(spec, { operationOrder: ['a1', 'b1', 'a2'] }).generate();
  assert.deepEqual(collection.item.map(item => item.name), ['a1', 'b1', 'a2']);
}

// Mappings apply to target parameters/bodies and can be extracted from non-POST sources.
{
  const spec = {
    openapi: '3.0.3', info: { title: 'Mappings', version: '1' },
    paths: {
      '/session': { get: operation('readSession', 'Flow') },
      '/users/{id}': {
        put: operation('updateUser', 'Flow', {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } } } },
        }),
      },
    },
  };
  const variableMappings = [{ sourceOperationId: 'readSession', responseJsonPath: '$.users[0].id', variable: 'userId', targetOperationIds: ['updateUser'] }];
  const requests = flatten(new OpenApiPostmanGenerator(spec, { variableMappings }).generate().item);
  const source = requests.find(item => item.name === 'readSession');
  const target = requests.find(item => item.name === 'updateUser');
  assert.equal(target.request.url.raw, '{{baseUrl}}/users/{{userId}}');
  assert.equal(JSON.parse(target.request.body.raw).id, '{{userId}}');
  assert.ok(source.event[0].script.exec.some(line => line.includes('const tokens')));
}

// Planned AI scenarios are honored instead of expanding every generic negative case.
{
  const spec = {
    openapi: '3.0.3', info: { title: 'Negative plan', version: '1' },
    paths: { '/profiles': { post: operation('createProfile', 'Profiles', {
      requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['age', 'role'], properties: { age: { type: 'integer', minimum: 18 }, role: { type: 'string', enum: ['admin'] } } } } } },
      responses: { 201: { description: 'Created' }, 400: { description: 'Bad request' } },
    }) } },
  };
  const negativeScenarios = [{ operationId: 'createProfile', name: 'age below minimum', kind: 'boundary', field: 'age' }];
  const requests = flatten(new OpenApiPostmanGenerator(spec, { includeNegative: true, negativeScenarios }).generate().item);
  assert.deepEqual(requests.map(item => item.name), ['createProfile', '[Negative] createProfile - age below minimum']);
  assert.equal(JSON.parse(requests[1].request.body.raw).age, 17);
}

// Wildcard success responses, API-key cookies, named examples, and schema keywords.
{
  const spec = {
    openapi: '3.1.0', info: { title: 'Contracts', version: '1' }, security: [{ cookieKey: [] }],
    components: { securitySchemes: { cookieKey: { type: 'apiKey', in: 'cookie', name: 'session' } } },
    paths: { '/items': { get: operation('listItems', 'Items', {
      parameters: [
        { name: 'mode', in: 'query', examples: { default: { value: 'full' } }, schema: { type: 'string' } },
        { name: 'tag', in: 'query', required: true, schema: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } },
      ],
      responses: { '2XX': { description: 'Any success', content: { 'application/json': { schema: { type: 'object' } } } } },
    }) } },
  };
  const request = flatten(new OpenApiPostmanGenerator(spec).generate().item)[0];
  assert.ok(request.request.header.some(header => header.key === 'Cookie' && header.value === 'session={{cookieKey}}'));
  assert.equal(request.request.auth, undefined);
  assert.equal(request.request.url.query.find(query => query.key === 'mode').value, 'full');
  assert.equal(request.request.url.query.filter(query => query.key === 'tag').length, 1);
  assert.ok(request.event[0].script.exec.some(line => line.includes('within(200, 299)')));

  const schema = toJsonSchema({ type: 'object', minProperties: 1, additionalProperties: { $ref: '#/components/schemas/Value' } },
    value => value.$ref ? { type: 'string', minLength: 2 } : value);
  assert.deepEqual(schema.additionalProperties, { type: 'string', minLength: 2 });
  assert.equal(schema.minProperties, 1);
}

// Planned negatives also support request parameters, not only JSON body fields.
{
  const spec = {
    openapi: '3.0.3', info: { title: 'Parameter negatives', version: '1' },
    paths: { '/search': { get: operation('search', 'Search', {
      parameters: [{ name: 'limit', in: 'query', required: true, schema: { type: 'integer', minimum: 1 } }],
      responses: { 200: { description: 'OK' }, 400: { description: 'Bad request' } },
    }) } },
  };
  const negativeScenarios = [
    { operationId: 'search', name: 'limit omitted', kind: 'missing_required', field: 'limit' },
    { operationId: 'search', name: 'limit too small', kind: 'boundary', field: 'limit' },
  ];
  const requests = flatten(new OpenApiPostmanGenerator(spec, { includeNegative: true, negativeScenarios }).generate().item);
  assert.equal(requests[1].request.url.query.some(query => query.key === 'limit'), false);
  assert.equal(requests[2].request.url.query.find(query => query.key === 'limit').value, '0');
}

// Invalid config fails with an actionable path instead of a later TypeError.
{
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-config-'));
  const file = path.join(directory, 'invalid.yaml');
  try {
    fs.writeFileSync(file, 'responseTimeMs: fast\n');
    assert.throws(() => loadProjectConfig(file), /responseTimeMs/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Synthesized positive inputs respect bounds instead of producing negative test data.
{
  const resolve = schema => schema;
  for (const schema of [
    { type: 'integer', maximum: 0 }, { type: 'integer', maximum: -0.5 },
    { type: 'integer', minimum: 1.5, maximum: 3 },
    { type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 0.1 },
    { type: 'number', exclusiveMaximum: 0 },
    { type: 'number', minimum: 0.3, maximum: 0.5, multipleOf: 0.1 },
  ]) {
    const value = exampleFor(schema, resolve);
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum);
    if (schema.exclusiveMinimum === true) assert.ok(value > schema.minimum);
    if (typeof schema.exclusiveMaximum === 'number') assert.ok(value < schema.exclusiveMaximum);
    if (schema.type === 'integer') assert.ok(Number.isInteger(value));
  }
  assert.equal(exampleFor({ type: 'string', minLength: 10 }, resolve).length, 10);
  assert.equal(exampleFor({ type: 'string', maxLength: 2 }, resolve).length, 2);
  assert.equal(exampleFor({ type: 'string', maxLength: 0 }, resolve), '');
  assert.equal(exampleFor({ type: 'array', minItems: 3, items: { type: 'integer' } }, resolve).length, 3);
  assert.deepEqual(exampleFor({ type: 'array', maxItems: 0 }, resolve), []);
  assert.deepEqual(exampleFor({ type: 'array', minItems: 2, uniqueItems: true, items: { enum: ['a', 'b'] } }, resolve), ['a', 'b']);
  for (const schema of [
    { type: 'integer', minimum: 2, maximum: 1 }, { type: 'string', minLength: 5, maxLength: 2 },
    { type: 'array', minItems: 3, maxItems: 2 }, { type: 'string', pattern: '^\\d+$' },
  ]) assert.throws(() => exampleFor(schema, resolve), /explicit example/);
}

// Response-only requirements survive references, nesting, and allOf composition.
{
  const password = { type: 'string', writeOnly: true };
  const shared = { type: 'object', required: ['id', 'password'], properties: {
    id: { type: 'integer', readOnly: true }, password: { $ref: '#/Password' },
  } };
  const resolve = schema => schema.$ref === '#/Password' ? password : schema;
  const response = toJsonSchema(shared, resolve);
  assert.deepEqual(response.required, ['id']);
  assert.equal(response.properties.password, undefined);
  const request = toJsonSchema(shared, resolve, 0, 'request');
  assert.deepEqual(request.required, ['password']);
  const composed = toJsonSchema({ allOf: [{ properties: { password } }, { required: ['password'] }] }, resolve);
  assert.deepEqual(composed.allOf[1].required, []);
  const nested = toJsonSchema({ type: 'array', items: shared }, resolve);
  assert.deepEqual(nested.items.required, ['id']);
}

// Secret typing must not erase operator-supplied authentication values.
{
  const spec = { openapi: '3.0.3', info: { title: 'Auth values', version: '1' }, paths: {},
    components: { securitySchemes: {
      key: { type: 'apiKey', in: 'header', name: 'X-Key' },
      basic: { type: 'http', scheme: 'basic' }, bearer: { type: 'http', scheme: 'bearer' },
      absent: { type: 'apiKey', in: 'query', name: 'missing' },
    } } };
  const variables = { key: 'synthetic-key', basic_username: 'test', basic_password: 'synthetic-password', bearer_token: 'synthetic-token' };
  const generator = new OpenApiPostmanGenerator(spec, { variables });
  generator.generate();
  const values = generator.generateEnvironment().values;
  for (const [key, value] of Object.entries(variables)) {
    assert.deepEqual(values.find(item => item.key === key), { key, value, enabled: true, type: 'secret' });
  }
  assert.equal(values.find(item => item.key === 'absent').value, '');
}

// Composition and explicit defaults must not silently produce invalid positive requests.
{
  const resolve = schema => schema.$ref === '#/Id' ? { type: 'integer', readOnly: true } : schema;
  assert.deepEqual(exampleFor({ type: 'object', required: ['id'], properties: { id: { $ref: '#/Id' } } }, resolve), {});
  assert.equal(exampleFor({ allOf: [{ type: 'integer', minimum: 2 }, { maximum: 4 }] }, resolve), 2);
  for (const schema of [
    { type: 'integer', maximum: 0, default: 1 },
    { type: 'array', minItems: 2, uniqueItems: true, items: { enum: ['a', 'a'] } },
    { allOf: [{ type: 'integer', minimum: 2 }, { maximum: 1 }] },
    { allOf: [{ type: 'object', properties: { x: { type: 'integer', minimum: 2 } } }, { properties: { x: { type: 'integer', maximum: 1 } } }] },
    { oneOf: [{ type: 'integer' }, { type: 'number' }] },
    { type: 'object', required: ['missing'], additionalProperties: false },
    { type: 'object', minProperties: 2, properties: { x: { type: 'boolean' } } },
    { type: 'string', format: 'custom-format' },
  ]) assert.throws(() => exampleFor(schema, resolve), /explicit example/);
}

console.log('Regression tests passed');
