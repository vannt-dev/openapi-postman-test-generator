const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { OpenApiPostmanGenerator } = require('../dist/generator');
const { loadProjectConfig } = require('../dist/config');

const cli = path.resolve(__dirname, '..', 'dist', 'index.js');
const ok = { description: 'OK' };
const spec = {
  openapi: '3.0.3', info: { title: 'Shop API', version: '1' },
  servers: [{ url: 'http://localhost:3000' }],
  security: [{ oauth: [] }],
  components: { securitySchemes: { oauth: { type: 'oauth2', flows: { clientCredentials: {
    tokenUrl: 'https://auth.example.com/oauth/token', scopes: { 'orders:read': 'Read orders', 'orders:write': 'Write orders' },
  } } } } },
  paths: {
    '/orders': {
      get: { operationId: 'listOrders', tags: ['Orders'], responses: { 200: ok, 401: { description: 'Unauthorized' } } },
      post: {
        operationId: 'createOrder', tags: ['Orders', 'Write'],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } },
        responses: { 201: { description: 'Created' }, 400: { description: 'Bad request' }, 401: { description: 'Unauthorized' }, default: { description: 'Error' } },
      },
    },
    '/orders/{id}': { delete: {
      operationId: 'deleteOrder', tags: ['Orders', 'Admin'],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 204: { description: 'Deleted' }, 404: { description: 'Not found' } },
    } },
    '/health': { get: { operationId: 'health', security: [], responses: { '2XX': ok } } },
    '/internal/metrics': { get: { operationId: 'metrics', tags: ['Internal'], responses: { 200: ok } } },
  },
};
const has = (collection, operationId) => JSON.stringify(collection).includes(operationId);
const operationsIn = collection => ['listOrders', 'createOrder', 'deleteOrder', 'health', 'metrics'].filter(id => has(collection, id));

// ---------------------------------------------------------------- tags

// --tag keeps the operations that carry one of the tags; names are compared without regard to case.
{
  const generator = new OpenApiPostmanGenerator(spec, { includeTags: ['orders'] });
  assert.deepEqual(operationsIn(generator.generate()), ['listOrders', 'createOrder', 'deleteOrder']);
  assert.deepEqual(generator.getWarnings(), []);
}
// An operation is in when any of its tags is asked for, and out when any of its tags is excluded.
{
  assert.deepEqual(operationsIn(new OpenApiPostmanGenerator(spec, { includeTags: ['Write', 'Internal'] }).generate()), ['createOrder', 'metrics']);
  assert.deepEqual(operationsIn(new OpenApiPostmanGenerator(spec, { excludeTags: ['admin', 'INTERNAL'] }).generate()), ['listOrders', 'createOrder', 'health']);
  assert.deepEqual(operationsIn(new OpenApiPostmanGenerator(spec, { includeTags: ['Orders'], excludeTags: ['Admin'] }).generate()), ['listOrders', 'createOrder']);
}
// An operation without tags is in the Default folder, and "Default" is the tag that names it.
{
  assert.deepEqual(operationsIn(new OpenApiPostmanGenerator(spec, { includeTags: ['Default'] }).generate()), ['health']);
  assert.deepEqual(operationsIn(new OpenApiPostmanGenerator(spec, { excludeTags: ['default'] }).generate()), ['listOrders', 'createOrder', 'deleteOrder', 'metrics']);
}
// A tag no operation carries is a typing mistake more often than a wish for an empty collection.
{
  const generator = new OpenApiPostmanGenerator(spec, { includeTags: ['Ordres'], excludeTags: ['Nope'] });
  assert.deepEqual(operationsIn(generator.generate()), []);
  assert.deepEqual(generator.getWarnings(), ['Tag was not found: Ordres', 'Tag was not found: Nope']);
}
// Setup and teardown are not operations of the API: a tag filter leaves them in.
{
  const collection = new OpenApiPostmanGenerator(spec, { includeTags: ['Internal'], setup: [{ name: 'Seed', method: 'POST', url: '/seed' }] }).generate();
  assert.equal(collection.item[0].name, 'Setup');
  assert.deepEqual(operationsIn(collection), ['metrics']);
}

// ---------------------------------------------------------------- coverage

// Every operation has a request; without --negative only the documented success responses have a test.
{
  const generator = new OpenApiPostmanGenerator(spec);
  generator.generate();
  const coverage = generator.getCoverage();
  assert.deepEqual(coverage.operations, { total: 5, covered: 5, skipped: [] });
  // 200 401 | 201 400 401 | 204 404 | 2XX | 200; "default" is not a status and is not counted
  assert.equal(coverage.responses.total, 9);
  assert.equal(coverage.responses.covered, 5);
  assert.deepEqual(coverage.responses.uncovered.map(entry => `${entry.operationId} ${entry.status}`), [
    'listOrders 401', 'createOrder 400', 'createOrder 401', 'deleteOrder 404',
  ]);
  const create = coverage.byOperation.find(entry => entry.operationId === 'createOrder');
  assert.deepEqual(create, {
    operationId: 'createOrder', method: 'POST', path: '/orders', tags: ['Orders', 'Write'],
    included: true, documented: ['201', '400', '401'], covered: ['201'],
  });
}
// The negative variants expect the documented error responses, and those then count.
{
  const generator = new OpenApiPostmanGenerator(spec, { includeNegative: true });
  generator.generate();
  const coverage = generator.getCoverage();
  // 401 without credentials, 400 without the required field, 404 without the id
  assert.equal(coverage.responses.covered, 9);
  assert.deepEqual(coverage.responses.uncovered, []);
  assert.deepEqual(coverage.byOperation.find(entry => entry.operationId === 'createOrder').covered, ['201', '400', '401']);

  // a response no generated request can provoke stays uncovered, and is named
  const limited = structuredClone(spec);
  limited.paths['/orders'].get.responses[429] = { description: 'Too many requests' };
  limited.paths['/orders'].get.responses['5XX'] = { description: 'Server error' };
  const other = new OpenApiPostmanGenerator(limited, { includeNegative: true });
  other.generate();
  assert.deepEqual(other.getCoverage().responses.uncovered, [
    { operationId: 'listOrders', method: 'GET', path: '/orders', status: '429' },
    { operationId: 'listOrders', method: 'GET', path: '/orders', status: '5XX' },
  ]);
}
// What was left out is named with the reason, and its responses are not counted as coverable.
{
  const generator = new OpenApiPostmanGenerator(spec, { safeMode: true, disabledOperations: ['metrics'], excludeTags: ['Write'] });
  generator.generate();
  const coverage = generator.getCoverage();
  assert.equal(coverage.operations.total, 5);
  assert.equal(coverage.operations.covered, 2);
  assert.deepEqual(coverage.operations.skipped, [
    { operationId: 'createOrder', method: 'POST', path: '/orders', reason: 'tag filter' },
    { operationId: 'deleteOrder', method: 'DELETE', path: '/orders/{id}', reason: 'safe mode' },
    { operationId: 'metrics', method: 'GET', path: '/internal/metrics', reason: 'disabled' },
  ]);
  assert.equal(coverage.byOperation.find(entry => entry.operationId === 'metrics').included, false);
  assert.deepEqual(coverage.byOperation.find(entry => entry.operationId === 'metrics').covered, []);
  // listOrders 200 401, health 2XX
  assert.equal(coverage.responses.total, 3);
}
// Asked before generate(), there is nothing to report yet.
assert.throws(() => new OpenApiPostmanGenerator(spec).getCoverage(), /generate\(\) first/);

// ---------------------------------------------------------------- OAuth2 client credentials

const tokenRequest = collection => collection.item[0].item[0];
const script = item => item.event.find(event => event.listen === 'test').script.exec.join('\n');

// Asked for, the collection starts by fetching the token the other requests send.
{
  const generator = new OpenApiPostmanGenerator(spec, { oauthClientCredentials: true });
  const collection = generator.generate();
  assert.equal(collection.item[0].name, 'Setup');
  const request = tokenRequest(collection);
  assert.equal(request.name, 'Get access token (oauth)');
  assert.equal(request.request.method, 'POST');
  assert.equal(request.request.url.raw, '{{oauth_tokenUrl}}');
  assert.deepEqual(request.request.header, [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }]);
  assert.equal(request.request.body.raw,
    'grant_type=client_credentials&client_id={{oauth_clientId}}&client_secret={{oauth_clientSecret}}&scope=orders%3Aread%20orders%3Awrite');
  // the token endpoint is not the API: it gets no API credentials
  assert.deepEqual(request.request.auth, { type: 'noauth' });
  assert.match(script(request), /"variable":"oauth_token"/);
  assert.match(script(request), /"responseJsonPath":"\$\.access_token"/);
  assert.deepEqual(collection.auth, { type: 'bearer', bearer: [{ key: 'token', value: '{{oauth_token}}', type: 'string' }] });
  assert.deepEqual(generator.getWarnings(), []);

  const values = Object.fromEntries(generator.generateEnvironment().values.map(value => [value.key, value]));
  assert.equal(values.oauth_tokenUrl.value, 'https://auth.example.com/oauth/token');
  assert.equal(values.oauth_tokenUrl.type, 'default');
  assert.deepEqual([values.oauth_clientId.type, values.oauth_clientSecret.type, values.oauth_token.type], ['secret', 'secret', 'secret']);
  assert.equal(values.oauth_clientSecret.value, '');
}
// Not asked for, nothing changes: the token stays a value to supply.
{
  const collection = new OpenApiPostmanGenerator(spec).generate();
  assert.ok(!JSON.stringify(collection).includes('Get access token'));
  const keys = new OpenApiPostmanGenerator(spec).generateEnvironment().values.map(value => value.key);
  assert.ok(keys.includes('oauth_token') && !keys.includes('oauth_clientId'));
}
// It comes before the configured setup requests, which may already need the token.
{
  const collection = new OpenApiPostmanGenerator(spec, { oauthClientCredentials: true, setup: [{ name: 'Seed', method: 'POST', url: '/seed', inheritAuth: true }] }).generate();
  assert.deepEqual(collection.item[0].item.map(item => item.name), ['Get access token (oauth)', 'Seed']);
}
// Swagger 2.0 calls the same flow "application"; a scheme without scopes sends no scope.
{
  const swagger = {
    swagger: '2.0', info: { title: 'Old API', version: '1' }, host: 'localhost:3000', schemes: ['http'],
    security: [{ machine: [] }],
    securityDefinitions: { machine: { type: 'oauth2', flow: 'application', tokenUrl: 'https://auth.example.com/token', scopes: {} } },
    paths: { '/ping': { get: { operationId: 'ping', responses: { 200: ok } } } },
  };
  const request = tokenRequest(new OpenApiPostmanGenerator(swagger, { oauthClientCredentials: true }).generate());
  assert.equal(request.name, 'Get access token (machine)');
  assert.equal(request.request.body.raw, 'grant_type=client_credentials&client_id={{machine_clientId}}&client_secret={{machine_clientSecret}}');
}
// Asked for where no scheme has that flow: said, and nothing invented.
{
  const other = structuredClone(spec);
  other.components.securitySchemes.oauth.flows = { authorizationCode: { authorizationUrl: 'https://a/authorize', tokenUrl: 'https://a/token', scopes: {} } };
  const generator = new OpenApiPostmanGenerator(other, { oauthClientCredentials: true });
  const collection = generator.generate();
  assert.ok(!JSON.stringify(collection).includes('Get access token'));
  assert.deepEqual(generator.getWarnings(), ['No OAuth2 client credentials flow was found: the access token is still a value to supply']);
}

// ---------------------------------------------------------------- CLI and config

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-tags-'));
try {
  const specFile = path.join(temp, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const run = (...args) => spawnSync(process.execPath, [cli, 'generate', '--spec', specFile, '--out', path.join(temp, 'c.json'), '--env', path.join(temp, 'e.json'), ...args], { encoding: 'utf8' });
  const written = () => JSON.parse(fs.readFileSync(path.join(temp, 'c.json'), 'utf8'));

  // repeated and comma-separated, on both flags
  const tagged = run('--tag', 'Orders,Internal', '--tag', 'default', '--exclude-tag', 'Admin');
  assert.equal(tagged.status, 0, tagged.stderr);
  assert.deepEqual(operationsIn(written()), ['listOrders', 'createOrder', 'health', 'metrics']);
  assert.match(tagged.stdout, /Coverage: {5}4\/5 operations, 4\/7 documented responses \(1 operation left out: 1 by the tag filter\)/);

  // the report as a file, and the hint that the error responses want --negative
  const coverageFile = path.join(temp, 'reports', 'coverage.json');
  const plain = run('--coverage', coverageFile, '--safe');
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /Coverage: {5}4\/5 operations, 4\/7 documented responses \(1 operation left out: 1 in safe mode\)/);
  assert.match(plain.stdout, /Uncovered: {4}3 documented error responses have no test; --negative generates them where it can/);
  assert.match(plain.stdout, new RegExp(`Coverage file: ${coverageFile.replace(/[\\.]/g, '\\$&')}`));
  const report = JSON.parse(fs.readFileSync(coverageFile, 'utf8'));
  assert.deepEqual(report.operations.skipped, [{ operationId: 'deleteOrder', method: 'DELETE', path: '/orders/{id}', reason: 'safe mode' }]);
  assert.equal(run('--negative').stdout.includes('--negative generates them'), false, 'no hint once --negative is on');

  // the token request from the flag, and all three from a config file
  assert.equal(run('--oauth-token').status, 0);
  assert.equal(written().item[0].item[0].name, 'Get access token (oauth)');
  const configFile = path.join(temp, 'config.yaml');
  fs.writeFileSync(configFile, 'includeTags: [Orders]\nexcludeTags: [Admin]\noauthClientCredentials: true\n');
  assert.deepEqual(loadProjectConfig(configFile), { includeTags: ['Orders'], excludeTags: ['Admin'], oauthClientCredentials: true });
  assert.equal(run('--config', configFile).status, 0);
  assert.deepEqual(operationsIn(written()), ['listOrders', 'createOrder']);
  assert.equal(written().item[0].item[0].name, 'Get access token (oauth)');
  // a flag adds to the config's tags rather than replacing them
  assert.equal(run('--config', configFile, '--tag', 'Internal').status, 0);
  assert.deepEqual(operationsIn(written()), ['listOrders', 'createOrder', 'metrics']);
  fs.writeFileSync(configFile, 'includeTags: Orders\n');
  assert.match(run('--config', configFile).stderr, /Invalid project configuration: includeTags/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('Tag filter, coverage and OAuth token tests passed');
