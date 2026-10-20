const assert = require('node:assert/strict');
const { OpenApiPostmanGenerator } = require('../dist/generator');
const { createPmRuntime } = require('../dist/exporters/runtime');

// Runs a generated test script against the `pm` stand-in that the Bruno and k6 outputs carry, so the
// checks below hold for those outputs too; test/e2e.js runs the same kind of script in Newman.
function runScript(exec, { code = 200, headers = {}, body = '' } = {}) {
  const results = [];
  const host = {
    test(name, run) {
      try { run(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, error: error.message }); }
    },
    response: {
      code, responseTime: 5, text: () => body,
      header(name) {
        const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
        return key === undefined ? undefined : headers[key];
      },
    },
    request: { name: 'request', url: 'http://localhost/request' },
    variables: { get() {}, set() {}, unset() {}, inEnvironment: () => false },
    setNextRequest() {},
    skipRequest() {},
  };
  const runtime = createPmRuntime(host);
  new Function('pm', 'postman', 'require', exec.join('\n'))(runtime.pm, runtime.postman, runtime.require);
  return results;
}
const headerTests = results => results.filter(result => /header/i.test(result.name) && !/Content-Type is JSON/.test(result.name));
const failed = results => headerTests(results).filter(result => !result.passed).map(result => result.name);
const items = collection => collection.item.flatMap(folder => folder.item || [folder]);
const scriptOf = (collection, name) => items(collection).find(item => item.name === name).event.find(event => event.listen === 'test').script.exec;

const json = { 'application/json': { schema: { type: 'object' } } };
const spec = {
  openapi: '3.0.3', info: { title: 'Headers API', version: '1' },
  servers: [{ url: 'http://localhost:3000' }],
  components: { headers: { RequestId: { required: true, schema: { type: 'string', pattern: '^[a-f0-9-]+$' } } } },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets', summary: 'List pets',
        responses: {
          200: {
            description: 'Pets', content: json,
            headers: {
              'X-Total-Count': { required: true, schema: { type: 'integer', minimum: 0 } },
              'X-Rate-Limit-Remaining': { schema: { type: 'integer' } },
              'X-Mode': { schema: { type: 'string', enum: ['fast', 'slow'] } },
              'X-Tags': { schema: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } },
              'X-Cached': { schema: { type: 'boolean' } },
              'X-Request-Id': { $ref: '#/components/headers/RequestId' },
              // HTTP dates are not RFC 3339 date-times; the format must not fail them.
              'Last-Modified': { schema: { type: 'string', format: 'date-time' } },
              // OpenAPI says a Content-Type entry here is ignored.
              'Content-Type': { required: true, schema: { type: 'string', enum: ['text/csv'] } },
              // An object-valued header is only checked for presence.
              'X-Meta': { required: true, schema: { type: 'object', properties: { a: { type: 'integer' } } } },
            },
          },
        },
      },
      post: {
        operationId: 'createPet', summary: 'Create pet',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } },
        responses: {
          201: { description: 'Created', content: json, headers: { Location: { required: true, schema: { type: 'string' } } } },
          400: { description: 'Invalid', headers: { 'X-Error-Code': { required: true, schema: { type: 'string', enum: ['E_VALIDATION'] } } } },
        },
      },
    },
    '/pets/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      delete: { operationId: 'deletePet', summary: 'Delete pet', responses: { 204: { description: 'Gone', headers: { 'X-Audit-Id': { required: true, schema: { type: 'string' } } } } } },
    },
    '/health': { get: { operationId: 'health', summary: 'Health', responses: { '2XX': { description: 'Up', headers: { 'X-Version': { required: true, schema: { type: 'string', pattern: '^\\d+\\.\\d+$' } } } } } } },
    '/plain': { get: { operationId: 'plain', summary: 'Plain', responses: { 200: { description: 'No headers', content: json } } } },
  },
};
const good = {
  'Content-Type': 'application/json', 'x-total-count': '12', 'X-Rate-Limit-Remaining': '99', 'X-Mode': 'fast', 'X-Tags': 'a, b',
  'X-Cached': 'true', 'X-Request-Id': 'ab12-cd34', 'Last-Modified': 'Tue, 20 Oct 2026 10:00:00 GMT', 'X-Meta': 'a=1',
};

// Every declared header that is sent with a valid value passes, whatever its case on the wire.
{
  const collection = new OpenApiPostmanGenerator(spec).generate();
  const results = runScript(scriptOf(collection, 'List pets'), { headers: good, body: '{}' });
  assert.deepEqual(failed(results), []);
  const names = headerTests(results).map(result => result.name);
  for (const header of ['X-Total-Count', 'X-Rate-Limit-Remaining', 'X-Mode', 'X-Tags', 'X-Cached', 'X-Request-Id', 'Last-Modified', 'X-Meta']) {
    assert.ok(names.some(name => name.includes(header)), `a test names ${header}: ${names.join(' | ')}`);
  }
  // presence for the required ones, a value check for every one with a usable schema
  assert.ok(names.includes('Response has the X-Total-Count header'));
  assert.ok(names.includes('Response header X-Total-Count matches its schema'));
  assert.ok(names.includes('Response has the X-Request-Id header'));
  assert.ok(!names.includes('Response has the X-Mode header'), 'an optional header has no presence test');
  assert.ok(names.includes('Response has the X-Meta header'));
  assert.ok(!names.includes('Response header X-Meta matches its schema'), 'an object-valued header is not parsed');
  assert.ok(!names.some(name => name.includes('Content-Type') && name !== 'Response Content-Type is JSON'), 'Content-Type is ignored');
}

// A missing required header fails; a missing optional one registers no test at all.
{
  const collection = new OpenApiPostmanGenerator(spec).generate();
  const rest = Object.fromEntries(Object.entries(good).filter(([name]) => !['x-total-count', 'X-Mode'].includes(name)));
  const results = runScript(scriptOf(collection, 'List pets'), { headers: rest, body: '{}' });
  assert.deepEqual(failed(results), ['Response has the X-Total-Count header']);
  assert.ok(!headerTests(results).some(result => result.name.includes('X-Mode')));
}

// Values are read as the declared type before the schema is applied: numbers, booleans, lists, enums, patterns.
{
  const collection = new OpenApiPostmanGenerator(spec).generate();
  const script = scriptOf(collection, 'List pets');
  const bad = { ...good, 'x-total-count': 'many', 'X-Mode': 'medium', 'X-Tags': 'a,z', 'X-Cached': 'yes', 'X-Request-Id': 'NOT HEX', 'X-Rate-Limit-Remaining': '-3' };
  assert.deepEqual(failed(runScript(script, { headers: bad, body: '{}' })), [
    'Response header X-Total-Count matches its schema',
    'Response header X-Mode matches its schema',
    'Response header X-Tags matches its schema',
    'Response header X-Cached matches its schema',
    'Response header X-Request-Id matches its schema',
  ]);
  assert.deepEqual(failed(runScript(script, { headers: { ...good, 'x-total-count': '-1' }, body: '{}' })), ['Response header X-Total-Count matches its schema']);
}

// A response without a body (204) still has its headers checked; a 2XX range applies to every success code.
{
  const collection = new OpenApiPostmanGenerator(spec).generate();
  assert.deepEqual(failed(runScript(scriptOf(collection, 'Delete pet'), { code: 204 })), ['Response has the X-Audit-Id header']);
  assert.deepEqual(failed(runScript(scriptOf(collection, 'Delete pet'), { code: 204, headers: { 'X-Audit-Id': 'a1' } })), []);
  assert.deepEqual(failed(runScript(scriptOf(collection, 'Health'), { code: 203, headers: { 'X-Version': 'v1' } })), ['Response header X-Version matches its schema']);
  assert.deepEqual(failed(runScript(scriptOf(collection, 'Health'), { code: 200, headers: { 'X-Version': '1.2' } })), []);
  // the headers of 201 are the ones checked on a 201
  assert.deepEqual(failed(runScript(scriptOf(collection, 'Create pet'), { code: 201, headers: { 'Content-Type': 'application/json' }, body: '{}' })), ['Response has the Location header']);
}

// The negative variants check the headers of the error response they provoke.
{
  const collection = new OpenApiPostmanGenerator(spec, { includeNegative: true }).generate();
  const negative = items(collection).find(item => item.name === '[Negative] Create pet - missing name');
  const exec = negative.event[0].script.exec;
  assert.deepEqual(failed(runScript(exec, { code: 400, headers: { 'X-Error-Code': 'E_OTHER' } })), ['Response header X-Error-Code matches its schema']);
  assert.deepEqual(failed(runScript(exec, { code: 400, headers: { 'X-Error-Code': 'E_VALIDATION' } })), []);
}

// An operation that declares no headers gets no header code; the checks can be switched off.
{
  const collection = new OpenApiPostmanGenerator(spec).generate();
  assert.ok(!scriptOf(collection, 'Plain').join('\n').includes('responseHeaders'));
  const off = new OpenApiPostmanGenerator(spec, { responseHeaderAssertions: false, includeNegative: true }).generate();
  assert.ok(!JSON.stringify(off).includes('responseHeaders'));
  assert.deepEqual(headerTests(runScript(scriptOf(off, 'List pets'), { headers: {}, body: '{}' })), []);
}

// Swagger 2.0: headers carry their type themselves and have no `required`, so they are only checked when sent;
// collectionFormat decides how a list is split.
{
  const swagger = {
    swagger: '2.0', info: { title: 'Swagger headers', version: '1' }, host: 'localhost', basePath: '/', produces: ['application/json'],
    paths: { '/users': { get: { summary: 'List users', responses: { 200: {
      description: 'Users', schema: { type: 'array', items: { type: 'object' } },
      headers: {
        'X-Total': { type: 'integer', minimum: 0 },
        'X-Roles': { type: 'array', collectionFormat: 'pipes', items: { type: 'string', enum: ['admin', 'user'] } },
        'X-Trace': { type: 'string', required: true },
      },
    } } } } },
  };
  const script = scriptOf(new OpenApiPostmanGenerator(swagger).generate(), 'List users');
  const headers = { 'Content-Type': 'application/json', 'X-Trace': 't' };
  assert.deepEqual(failed(runScript(script, { headers, body: '[]' })), []);
  assert.ok(!headerTests(runScript(script, { headers, body: '[]' })).some(result => result.name.includes('X-Total')), 'no presence test in Swagger 2');
  assert.deepEqual(failed(runScript(script, { headers: { ...headers, 'X-Total': '3', 'X-Roles': 'admin|user' }, body: '[]' })), []);
  assert.deepEqual(failed(runScript(script, { headers: { ...headers, 'X-Total': 'x', 'X-Roles': 'admin,user' }, body: '[]' })), [
    'Response header X-Total matches its schema',
    'Response header X-Roles matches its schema',
  ]);
  // a non-standard `required: true` is honoured
  assert.deepEqual(failed(runScript(script, { headers: { 'Content-Type': 'application/json' }, body: '[]' })), ['Response has the X-Trace header']);
}

console.log('response header assertion tests passed');
