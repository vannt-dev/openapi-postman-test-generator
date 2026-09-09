const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OpenApiPostmanGenerator } = require('../dist/generator');
const { loadProjectConfig } = require('../dist/config');
const { toJsonSchema } = require('../dist/generator/json-schema');

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

console.log('Regression tests passed');
