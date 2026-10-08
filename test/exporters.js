const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OpenApiPostmanGenerator } = require('../dist/generator');
const { toBrunoCollection } = require('../dist/exporters/bruno');
const { flattenCollection } = require('../dist/exporters/flatten');
const { toK6Script } = require('../dist/exporters/k6');
const { createPmRuntime } = require('../dist/exporters/runtime');

// The API of the workflow end-to-end test, answered in memory: seed data, a one-time password,
// a background job that is polled, a file fetched with the id the job returned, and a cleanup.
function createApi({ jobNeverFinishes = false } = {}) {
  const calls = [];
  let statusChecks = jobNeverFinishes ? -100 : 0;
  const json = (status, payload, headers = {}) => ({
    status, body: payload === undefined ? '' : JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json', ...headers }, timings: { duration: 12 },
  });
  const handle = (method, url, body, params) => {
    const route = url.replace('http://api.test', '');
    calls.push({ line: `${method} ${route}`, authorization: params.headers.Authorization, body });
    if (method === 'POST' && route === '/v1/admin/seed') return json(201, { id: 'tenant-1' });
    if (method === 'POST' && route === '/v1/verify') return JSON.parse(body).code === '123456' ? json(200, { ok: true }) : json(401, { ok: false });
    if (method === 'POST' && route === '/v1/exports') return json(202, { accepted: true }, { Location: 'exports/job-1' });
    if (method === 'GET' && route === '/v1/exports/job-1') {
      statusChecks++;
      return json(200, statusChecks < 3 ? { status: 'pending' } : { status: 'done', fileId: 'export-1' });
    }
    if (method === 'GET' && route.startsWith('/v1/files/export-1')) return json(200, { ready: true, size: 3 });
    if (method === 'DELETE' && route === '/v1/admin/tenants/tenant-1') return json(204);
    return json(404, { error: 'Not found' });
  };
  return { calls, handle };
}

function workflowCollection() {
  const spec = {
    openapi: '3.0.3', info: { title: 'Workflow API', version: '1.0.0' },
    servers: [{ url: 'http://api.test/v1' }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearerAuth: [] }],
    paths: {
      '/exports': { post: { operationId: 'createExport', responses: { 202: { description: 'Accepted' } } } },
      '/files/{fileId}': { get: {
        operationId: 'getFile',
        parameters: [
          { name: 'fileId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'label', in: 'query', required: true, schema: { type: 'string', example: 'a b&c' } },
        ],
        responses: { 200: { description: 'File', content: { 'application/json': { schema: {
          type: 'object', required: ['ready'], properties: { ready: { type: 'boolean' }, size: { type: 'integer', minimum: 1 } },
        } } } } },
      } },
    },
  };
  const generator = new OpenApiPostmanGenerator(spec, {
    operationOrder: ['createExport', 'getFile'],
    setup: [
      { name: 'Seed tenant', method: 'POST', url: '/admin/seed', body: { name: 'test' }, expectStatus: [201], extract: { tenantId: '$.id' } },
      { name: 'Verify OTP', method: 'POST', url: '/verify', body: { code: '{{otp}}' }, expectStatus: [200] },
    ],
    teardown: [{ name: 'Delete tenant', method: 'DELETE', url: '/admin/tenants/{{tenantId}}', expectStatus: [204] }],
    asyncOperations: [{ operationId: 'createExport', statusJsonPath: '$.status', successValues: ['done'], failureValues: ['failed'], intervalMs: 50, maxAttempts: 5, extract: { fileId: '$.fileId' } }],
    variables: { tenantId: 'placeholder-tenant', otp: '' },
  });
  return { collection: generator.generate(), environment: generator.generateEnvironment('Local') };
}

// Runs a generated k6 script under Node: its imports are replaced by stand-ins and the default
// export is called once, as k6 does for one iteration of one virtual user.
function runK6Script(script, api, env) {
  const checks = [];
  const sleeps = [];
  const source = script
    .replace(/^import .*$/gm, '')
    .replace(/^export const options/m, 'const options')
    .replace(/^export default function \(\) \{/m, 'const main = function () {');
  const run = new Function('http', 'encoding', 'check', 'sleep', '__ENV', 'console', `${source}\nmain();\nreturn options;`);
  const options = run(
    { request: api.handle },
    { b64encode: text => Buffer.from(text).toString('base64') },
    (_value, sets) => { for (const [name, passes] of Object.entries(sets)) checks.push({ name, passed: passes() }); return true; },
    seconds => sleeps.push(seconds),
    env,
    { error() {} },
  );
  return { checks, sleeps, options };
}

function testRuntime() {
  const variables = { baseUrl: 'http://api.test', token: 'placeholder' };
  const environment = new Set(['token']);
  const host = {
    test(name, run) { run(); },
    response: { code: 201, responseTime: 40, header: name => (name.toLowerCase() === 'content-type' ? 'application/json' : undefined), text: () => '{"id":7,"tags":["a"]}' },
    request: { name: 'Create', url: '{{baseUrl}}/items?x={{missing}}' },
    variables: {
      get: key => variables[key], set: (key, value) => { variables[key] = value; }, unset: key => { delete variables[key]; },
      inEnvironment: key => environment.has(key),
    },
    setNextRequest() {}, skipRequest() {},
  };
  const { pm, require: load } = createPmRuntime(host);

  // The assertion forms the generated scripts are written in.
  pm.expect(pm.response.code).to.be.within(200, 299);
  pm.expect(pm.response.code).to.be.oneOf([200, 201]);
  pm.expect(pm.response.responseTime).to.be.below(2000);
  pm.expect(pm.response.headers.get('Content-Type') || '').to.include('json');
  pm.expect(pm.response.text()).to.not.equal('');
  assert.ok(pm.expect('exports/job-1', 'Location header').to.be.a('string').that.is.not.empty);
  assert.throws(() => pm.expect(404).to.be.oneOf([200]), /expected 404 to be one of \[200\]/);
  assert.throws(() => pm.expect(2500).to.be.below(2000), /expected 2500 to be below 2000/);
  assert.throws(() => pm.expect('').to.not.equal(''), /not to equal ""/);
  assert.throws(() => pm.expect(undefined, 'Location header').to.be.a('string').that.is.not.empty, /Location header: expected undefined to be string/);
  assert.throws(() => pm.expect('', 'Location header').to.be.a('string').that.is.not.empty, /not to be empty/);
  assert.throws(() => pm.expect.fail('Job reached failure status failed'), /Job reached failure status failed/);
  assert.deepEqual(pm.response.json(), { id: 7, tags: ['a'] });

  // JSON Schema, as the generator writes it.
  const schema = {
    type: 'object', required: ['id'], additionalProperties: false,
    properties: {
      id: { type: 'integer', minimum: 1 },
      tags: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 2 },
      state: { type: ['string', 'null'], enum: ['open', null] },
      ratio: { type: 'number', exclusiveMinimum: 0 },
      owner: { allOf: [{ type: 'object', required: ['name'] }, { type: 'object', properties: { name: { type: 'string', pattern: '^[A-Z]' } } }] },
      kind: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    },
  };
  const matches = value => pm.expect(value).to.have.jsonSchema(schema);
  matches({ id: 7, tags: ['a'], state: null, ratio: 0.5, owner: { name: 'Ann' }, kind: 3 });
  assert.throws(() => matches({ tags: [] }), /\$ should have the property id/);
  assert.throws(() => matches({ id: 1.5 }), /\$\.id should be integer but is number/);
  assert.throws(() => matches({ id: 0 }), /\$\.id should be >= 1/);
  assert.throws(() => matches({ id: 1, tags: ['a', ''] }), /\$\.tags\[1\] should have at least 1 characters/);
  assert.throws(() => matches({ id: 1, tags: ['a', 'b', 'c'] }), /at most 2 items/);
  assert.throws(() => matches({ id: 1, state: 'closed' }), /\$\.state should be one of/);
  assert.throws(() => matches({ id: 1, ratio: 0 }), /\$\.ratio should be > 0/);
  assert.throws(() => matches({ id: 1, owner: {} }), /\$\.owner should have the property name/);
  assert.throws(() => matches({ id: 1, owner: { name: 'ann' } }), /should match \^\[A-Z\]/);
  assert.throws(() => matches({ id: 1, kind: true }), /matches 0 of the oneOf schemas/);
  assert.throws(() => matches({ id: 1, extra: true }), /\$\.extra is not a known property/);
  assert.throws(() => matches([]), /\$ should be object but is array/);

  // One variable scope behind Postman's two; a known variable is substituted, an unknown one is left.
  assert.equal(pm.environment.has('token'), true);
  assert.equal(pm.environment.has('baseUrl'), false);
  pm.collectionVariables.set('itemId', 7);
  assert.equal(pm.collectionVariables.get('itemId'), 7);
  assert.equal(pm.variables.replaceIn(pm.request.url.toString()), 'http://api.test/items?x={{missing}}');
  pm.collectionVariables.unset('itemId');
  assert.equal(pm.collectionVariables.get('itemId'), undefined);

  // `require("url").resolve`, for a Location header of any shape.
  const { resolve } = load('url');
  assert.equal(resolve('http://h.test/v1/exports?x=1', 'exports/job-1'), 'http://h.test/v1/exports/job-1');
  assert.equal(resolve('http://h.test/v1/exports', '/jobs/1'), 'http://h.test/jobs/1');
  assert.equal(resolve('https://h.test/v1/exports', '//cdn.test/j/1'), 'https://cdn.test/j/1');
  assert.equal(resolve('http://h.test/v1/exports', 'https://other.test/j'), 'https://other.test/j');
  assert.equal(resolve('http://h.test/v1/a/b', '../c'), 'http://h.test/v1/c');
  assert.throws(() => load('fs'), /not available outside Postman/);
}

function testK6() {
  const { collection, environment } = workflowCollection();
  const script = toK6Script(collection, environment, { fileName: 'workflow.k6.js' });
  assert.match(script, /^import http from 'k6\/http';$/m);
  assert.match(script, /k6 run workflow\.k6\.js/);
  // Syntax of the file as k6 will read it, as an ES module.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-k6-'));
  try {
    const file = path.join(temp, 'workflow.k6.mjs');
    fs.writeFileSync(file, script);
    execFileSync(process.execPath, ['--check', file]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const api = createApi();
  const { checks, sleeps, options } = runK6Script(script, api, { otp: '123456', bearerAuth_token: 'secret-token', PATH: 'ignored' });
  assert.deepEqual(api.calls.map(call => call.line), [
    'POST /v1/admin/seed',
    'POST /v1/verify',
    'POST /v1/exports',
    'GET /v1/exports/job-1',
    'GET /v1/exports/job-1',
    'GET /v1/exports/job-1',
    // The id the job returned, and a query value encoded for the URL.
    'GET /v1/files/export-1?label=a%20b%26c',
    // The id captured at setup replaced the environment's placeholder.
    'DELETE /v1/admin/tenants/tenant-1',
  ]);
  assert.equal(api.calls[1].body.replace(/\s/g, ''), '{"code":"123456"}');
  // Requests from the config send no credentials unless asked to; the API's own requests and the poll do.
  assert.deepEqual(api.calls.map(call => call.authorization), [undefined, undefined, 'Bearer secret-token', 'Bearer secret-token', 'Bearer secret-token', 'Bearer secret-token', 'Bearer secret-token', undefined]);
  assert.deepEqual(checks.filter(check => !check.passed), []);
  assert.deepEqual(checks.map(check => check.name), [
    'Seed tenant - Status code is 201',
    'Seed tenant - Extracted tenantId from $.id',
    'Verify OTP - Status code is 200',
    'createExport - Status code is successful (202)',
    'createExport - Response time is below 2000ms',
    'createExport - Response Content-Type is JSON',
    'createExport - Response has a Location header for the async job',
    'Poll: createExport - Async job completed',
    'Poll: createExport - Extracted fileId from $.fileId',
    'getFile - Status code is successful (200)',
    'getFile - Response time is below 2000ms',
    'getFile - Response Content-Type is JSON',
    'getFile - Response matches the schema for its status code',
    'Delete tenant - Status code is 204',
  ]);
  // The first status check is immediate; each retry waits the configured interval.
  assert.deepEqual(sleeps, [0.05, 0.05]);
  assert.deepEqual(options.thresholds, { checks: ['rate==1.0'] });

  // A job that never finishes stops after maxAttempts, fails, and the run still cleans up.
  const stuck = createApi({ jobNeverFinishes: true });
  const stuckRun = runK6Script(script, stuck, { otp: '123456', bearerAuth_token: 'secret-token' });
  assert.equal(stuck.calls.filter(call => call.line === 'GET /v1/exports/job-1').length, 5);
  assert.deepEqual(stuckRun.checks.filter(check => !check.passed).map(check => check.name), [
    'Poll: createExport - Async job completed',
    'getFile - Status code is successful (200)',
  ]);
  assert.equal(stuck.calls.at(-1).line, 'DELETE /v1/admin/tenants/tenant-1');

  // A wrong one-time password fails the setup request's check.
  const wrong = runK6Script(script, createApi(), { otp: '000000', bearerAuth_token: 'secret-token' });
  assert.deepEqual(wrong.checks.filter(check => !check.passed).map(check => check.name), ['Verify OTP - Status code is 200']);
}

// Runs one script block of a .bru file under Node with stand-ins for Bruno's objects.
async function runBrunoBlock(file, blockName, { status, body, headers = {}, env = {}, vars = {} }) {
  const start = file.indexOf(`\n${blockName} {\n`);
  assert.ok(start >= 0, `${blockName} block not found`);
  const end = file.indexOf('\n}\n', start);
  const code = file.slice(start + blockName.length + 4, end).replace(/^ {2}/gm, '');
  const tests = [];
  const state = { env: { ...env }, vars: { ...vars }, next: undefined, skipped: false, slept: [] };
  const bru = {
    getVar: key => state.vars[key], setVar: (key, value) => { state.vars[key] = value; },
    getEnvVar: key => state.env[key], setEnvVar: (key, value) => { state.env[key] = value; },
    setNextRequest: name => { state.next = name; },
    runner: { skipRequest: () => { state.skipped = true; } },
    sleep: async milliseconds => { state.slept.push(milliseconds); },
  };
  const res = status === undefined ? undefined : {
    getStatus: () => status, getResponseTime: () => 15, getHeaders: () => headers, getBody: () => body,
  };
  const test = (name, run) => { try { run(); tests.push({ name, passed: true }); } catch (error) { tests.push({ name, passed: false, message: error.message }); } };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  await new AsyncFunction('bru', 'res', 'test', code)(bru, res, test);
  return { tests, state };
}

async function testBruno() {
  const { collection, environment } = workflowCollection();
  const files = toBrunoCollection(collection, environment);
  const byPath = Object.fromEntries(files.map(file => [file.path, file.content]));
  // Folders are numbered so the run order survives on disk; the loose requests of an ordered
  // collection get a folder of their own between setup and teardown.
  assert.deepEqual(Object.keys(byPath).sort(), [
    '01-Setup/01-Seed-tenant.bru',
    '01-Setup/02-Verify-OTP.bru',
    '01-Setup/folder.bru',
    '02-Requests/01-createExport.bru',
    '02-Requests/02-Poll-createExport.bru',
    '02-Requests/03-getFile.bru',
    '02-Requests/folder.bru',
    '03-Teardown/01-Delete-tenant.bru',
    '03-Teardown/folder.bru',
    'bruno.json',
    'environments/Local.bru',
  ]);
  assert.deepEqual(JSON.parse(byPath['bruno.json']), { version: '1', name: collection.info.name, type: 'collection', ignore: ['node_modules', '.git'] });
  assert.equal(byPath['02-Requests/folder.bru'], 'meta {\n  name: Requests\n  seq: 2\n}\n');
  assert.equal(byPath['environments/Local.bru'], [
    'vars {', '  baseUrl: http://api.test/v1', '  tenantId: placeholder-tenant', '  otp: ', '  fileId: test', '}',
    'vars:secret [', '  bearerAuth_token', ']', '',
  ].join('\n'));

  const seed = byPath['01-Setup/01-Seed-tenant.bru'];
  assert.ok(seed.startsWith('meta {\n  name: Seed tenant\n  type: http\n  seq: 1\n}\n\npost {\n  url: {{baseUrl}}/admin/seed\n  body: json\n  auth: none\n}\n'));
  assert.ok(seed.includes('body:json {\n  {\n    "name": "test"\n  }\n}\n'));
  const getFile = byPath['02-Requests/03-getFile.bru'];
  assert.ok(getFile.includes('get {\n  url: {{baseUrl}}/files/{{fileId}}?label=a%20b%26c\n  body: none\n  auth: bearer\n}\n'));
  assert.ok(getFile.includes('params:query {\n  label: a b&c\n}\n'));
  assert.ok(getFile.includes('auth:bearer {\n  token: {{bearerAuth_token}}\n}\n'));
  assert.ok(getFile.includes('headers {\n  Accept: application/json\n}\n'));

  // The Postman script runs unchanged on Bruno's objects: status, time, header, schema.
  const passing = await runBrunoBlock(getFile, 'tests', { status: 200, body: { ready: true, size: 3 }, headers: { 'content-type': 'application/json' } });
  assert.deepEqual(passing.tests.map(entry => [entry.name, entry.passed]), [
    ['Status code is successful (200)', true],
    ['Response time is below 2000ms', true],
    ['Response Content-Type is JSON', true],
    ['Response matches the schema for its status code', true],
  ]);
  const failing = await runBrunoBlock(getFile, 'tests', { status: 200, body: { ready: 'yes' }, headers: { 'content-type': 'application/json' } });
  assert.match(failing.tests.at(-1).message, /\$\.ready should be boolean but is string/);

  // A captured value becomes a runtime variable and also replaces the environment's placeholder.
  const captured = await runBrunoBlock(seed, 'tests', { status: 201, body: { id: 'tenant-1' }, env: { tenantId: 'placeholder-tenant' } });
  assert.deepEqual(captured.state.vars, { tenantId: 'tenant-1' });
  assert.deepEqual(captured.state.env, { tenantId: 'tenant-1' });

  // Polling: a pending job names itself as the next request; before a retry the script waits.
  const poll = byPath['02-Requests/02-Poll-createExport.bru'];
  const pending = await runBrunoBlock(poll, 'tests', { status: 200, body: { status: 'pending' } });
  assert.equal(pending.state.next, 'Poll: createExport');
  const counter = Object.keys(pending.state.vars)[0];
  assert.equal(pending.state.vars[counter], 1);
  const statusUrl = { createExport_statusUrl: 'http://api.test/v1/exports/job-1' };
  const first = await runBrunoBlock(poll, 'script:pre-request', { vars: statusUrl });
  assert.deepEqual([first.state.slept, first.state.skipped], [[], false]);
  const retry = await runBrunoBlock(poll, 'script:pre-request', { vars: { ...statusUrl, ...pending.state.vars } });
  assert.deepEqual([retry.state.slept, retry.state.skipped], [[50], false]);
  // No status URL, because the job's request failed: the poll is reported once and not sent.
  const unresolved = await runBrunoBlock(poll, 'script:pre-request', {});
  assert.equal(unresolved.state.skipped, true);
  assert.deepEqual(unresolved.tests.map(entry => [entry.name, entry.passed]), [['Async job status URL is resolved', false]]);
  const done = await runBrunoBlock(poll, 'tests', { status: 200, body: { status: 'done', fileId: 'export-1' }, vars: pending.state.vars });
  assert.equal(done.state.next, undefined);
  assert.equal(done.state.vars.fileId, 'export-1');
  assert.deepEqual(done.tests.map(entry => entry.passed), [true, true]);

  // A collection of tag folders only keeps them as they are, numbered in the order they run in.
  const tagged = new OpenApiPostmanGenerator({
    openapi: '3.0.3', info: { title: 'Tagged', version: '1' }, servers: [{ url: 'http://api.test' }],
    paths: {
      '/b': { get: { tags: ['Zebra'], operationId: 'b', responses: { 200: { description: 'ok' } } } },
      '/a': { post: { tags: ['Apple'], operationId: 'a', requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', required: ['q'], properties: { q: { type: 'string', example: 'x y' } } } } } }, responses: { 200: { description: 'ok' } } } },
    },
  });
  const taggedFiles = toBrunoCollection(tagged.generate());
  assert.deepEqual(taggedFiles.map(file => file.path), [
    'bruno.json', '01-Apple/folder.bru', '01-Apple/01-a.bru', '02-Zebra/folder.bru', '02-Zebra/01-b.bru', 'environments/default.bru',
  ]);
  assert.ok(taggedFiles[2].content.includes('body: formUrlEncoded'));
  assert.ok(taggedFiles[2].content.includes('body:form-urlencoded {\n  q: x y\n}\n'));
}

function testFlattenAndCli() {
  const { collection, environment } = workflowCollection();
  const flat = flattenCollection(collection);
  assert.deepEqual(flat.map(request => `${request.folder.join('/') || '.'} ${request.method} ${request.url}`), [
    'Setup POST {{baseUrl}}/admin/seed',
    'Setup POST {{baseUrl}}/verify',
    '. POST {{baseUrl}}/exports',
    '. GET {{createExport_statusUrl}}',
    '. GET {{baseUrl}}/files/{{fileId}}',
    'Teardown DELETE {{baseUrl}}/admin/tenants/{{tenantId}}',
  ]);
  assert.deepEqual(flat[4].query, [['label', 'a b&c']]);
  assert.deepEqual(flat[0].auth, null);
  assert.deepEqual(flat[2].auth, { type: 'bearer', token: '{{bearerAuth_token}}' });

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-convert-'));
  try {
    const collectionPath = path.join(temp, 'collection.json');
    const environmentPath = path.join(temp, 'environment.json');
    fs.writeFileSync(collectionPath, JSON.stringify(collection));
    fs.writeFileSync(environmentPath, JSON.stringify(environment));
    const cli = path.join(__dirname, '..', 'dist', 'index.js');
    const output = execFileSync(process.execPath, [cli, 'convert', '--collection', collectionPath, '--environment', environmentPath, '--bruno', path.join(temp, 'bruno'), '--k6', path.join(temp, 'load', 'api.k6.js')], { encoding: 'utf8' });
    assert.match(output, /Bruno: .*\(11 files\)/);
    assert.ok(fs.existsSync(path.join(temp, 'bruno', '02-Requests', '03-getFile.bru')));
    assert.equal(fs.readFileSync(path.join(temp, 'load', 'api.k6.js'), 'utf8'), toK6Script(collection, environment, { fileName: 'api.k6.js' }));
    const fails = args => {
      try { execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: 'pipe' }); } catch (error) { return error.stderr; }
      return '';
    };
    assert.match(fails(['convert', '--collection', collectionPath]), /Give --bruno <directory>, --k6 <file>, or both/);
    assert.match(fails(['convert', '--collection', path.join(temp, 'missing.json'), '--k6', 'x.js']), /Collection file not found/);
    assert.match(fails(['convert', '--collection', environmentPath, '--k6', 'x.js']), /Not a Postman collection/);
    // generate writes them too, next to the Postman files.
    execFileSync(process.execPath, [cli, 'generate', '--spec', path.join(__dirname, '..', 'fixtures', 'petstore.openapi.yaml'), '--out', path.join(temp, 'p.json'), '--env', path.join(temp, 'pe.json'), '--bruno', path.join(temp, 'pet-bruno'), '--k6', path.join(temp, 'pet.k6.js')], { encoding: 'utf8' });
    assert.ok(fs.existsSync(path.join(temp, 'pet-bruno', 'bruno.json')));
    assert.ok(fs.existsSync(path.join(temp, 'pet.k6.js')));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function main() {
  testRuntime();
  testK6();
  await testBruno();
  testFlattenAndCli();
  console.log('Bruno and k6 exporter tests passed');
}

main().catch(error => { console.error(error); process.exit(1); });
