const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Ajv = require('ajv');
const { load } = require('js-yaml');
const { OpenApiPostmanGenerator } = require('../dist/generator');
const { postmanV3FileName, toPostmanV3Collection, toPostmanV3Environment, toPostmanV3Files } = require('../dist/exporters/postman-v3');

// The published Postman Collection v3.0.0 schema, copied on 26/11/2026 from
// https://schema.postman.com/collection/json/v3.0.0/draft-07/collection.json
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/postman-v3/collection.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const validateCollection = ajv.compile(schema);
const validateRequest = ajv.compile({ $ref: 'v3-collection#/definitions/v3-http-request' });
const assertValid = (validate, value, label) => assert.ok(validate(value), `${label}: ${ajv.errorsText(validate.errors)}`);

// Every request shape the generator writes: tag folders, bearer, basic and API-key credentials,
// JSON, form and multipart bodies, optional query parameters, negative variants, an OAuth token
// request, Setup and Teardown folders, and a polled background job.
const spec = {
  openapi: '3.0.3',
  info: { title: 'Shop API', version: '1', description: 'Orders and files' },
  servers: [{ url: 'https://shop.example/v1' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
      basicAuth: { type: 'http', scheme: 'basic' },
      key: { type: 'apiKey', in: 'header', name: 'X-Key' },
      oauth: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://auth.example/token', scopes: {} } } },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/orders': {
      post: {
        operationId: 'createOrder', summary: 'Create order', tags: ['Orders'],
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', required: ['item'], properties: { item: { type: 'string', example: 'pen' }, size: { type: 'string', enum: ['s', 'm'] } },
        } } } },
        responses: { 202: { description: 'Accepted', headers: { Location: { schema: { type: 'string' } } } } },
      },
      get: {
        operationId: 'listOrders', summary: 'List orders', tags: ['Orders'], security: [{ basicAuth: [] }],
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 50, example: 10 } }],
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } } },
      },
    },
    '/orders/{id}/notes': {
      post: {
        operationId: 'addNote', summary: 'Add note: a/b?', tags: ['Orders'], security: [{ key: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { text: { type: 'string', example: 'hi' } } } } } },
        responses: { 201: { description: 'Created' } },
      },
    },
    '/files': {
      post: {
        operationId: 'upload', summary: 'Upload', tags: ['files'], security: [{ oauth: [] }],
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, label: { type: 'string' } } } } } },
        responses: { 201: { description: 'Created' } },
      },
      get: { operationId: 'listFiles', summary: 'Upload', tags: ['Files'], security: [], responses: { 200: { description: 'OK' } } },
    },
  },
};
const generator = new OpenApiPostmanGenerator(spec, {
  includeNegative: true,
  oauthClientCredentials: true,
  setup: [{ name: 'Seed', method: 'POST', url: '/admin/seed?mode=fast#top', body: { name: 'test' }, expectStatus: [201], extract: { tenantId: '$.id' } }],
  teardown: [{ name: 'Clean up', method: 'DELETE', url: '/admin/tenants/{{tenantId}}', body: 'raw text' }],
  asyncOperations: [{ operationId: 'createOrder', statusJsonPath: '$.status', successValues: ['done'] }],
});
const collection = generator.generate();
const document = toPostmanV3Collection(collection);

function testDocument() {
  assertValid(validateCollection, document, 'collection');
  assert.equal(document.$kind, 'collection');
  assert.equal(document.name, collection.info.name);
  assert.equal(document.description, 'Orders and files');
  assert.deepEqual(document.auth, { type: 'bearer', credentials: [{ key: 'token', value: '{{bearerAuth_token}}' }] });
  assert.deepEqual(document.items.map(item => item.name), ['Setup', 'Orders', 'files', 'Files', 'Teardown']);
  const requests = [];
  const walk = items => items.forEach(item => (item.$kind === 'collection' ? walk(item.items) : requests.push(item)));
  walk(document.items);
  const byId = Object.fromEntries(requests.filter(request => request.id).map(request => [request.id, request]));

  const create = byId['op:createOrder'];
  assert.equal(create.url, '{{baseUrl}}/orders');
  assert.equal(create.method, 'POST');
  assert.deepEqual(create.body, { type: 'json', content: JSON.stringify({ item: 'pen', size: 's' }, null, 2) });
  assert.deepEqual(create.scripts.map(script => script.type), ['afterResponse']);
  assert.equal(create.scripts[0].code, collection.item[1].item[0].event[0].script.exec.join('\n'));
  const poll = requests.find(request => request.name === 'Poll: createOrder');
  assert.deepEqual(poll.scripts.map(script => script.type), ['beforeRequest', 'afterResponse']);

  // The query is sent from queryParams, so the URL must not repeat it; an optional one is off.
  const list = byId['op:listOrders'];
  assert.equal(list.url, '{{baseUrl}}/orders');
  assert.deepEqual(list.queryParams, [{ key: 'limit', value: '10', disabled: true }]);
  assert.deepEqual(list.auth, { type: 'basic', credentials: [{ key: 'username', value: '{{basicAuth_username}}' }, { key: 'password', value: '{{basicAuth_password}}' }] });
  const seed = requests.find(request => request.name === 'Seed');
  assert.equal(seed.url, '{{baseUrl}}/admin/seed');
  assert.deepEqual(seed.queryParams, [{ key: 'mode', value: 'fast' }]);
  assert.deepEqual(seed.auth, { type: 'noauth' });
  assert.deepEqual(requests.find(request => request.name === 'Clean up').body, { type: 'text', content: 'raw text' });

  const note = byId['op:addNote'];
  assert.equal(note.body.type, 'urlencoded');
  assert.deepEqual(note.body.content.map(entry => entry.key), ['text']);
  assert.ok(note.headers.some(header => header.key === 'X-Key' && header.value === '{{key}}'));
  const upload = byId['op:upload'];
  assert.equal(upload.body.type, 'formdata');
  assert.deepEqual(upload.body.content.map(entry => entry.type), ['file', 'text']);
  assert.deepEqual(byId['op:listFiles'].auth, { type: 'noauth' });
  assert.ok(requests.some(request => request.id?.startsWith('op:createOrder#negative')));
  for (const request of requests) assertValid(validateRequest, request, request.name);
}

/** Reads a written folder back into one document, sorting each folder by `order` as Postman does. */
function readFolder(files) {
  const byPath = new Map(files.map(file => [file.path, load(file.content)]));
  const entries = directory => {
    const children = [];
    for (const [filePath, value] of byPath) {
      const rest = filePath.slice(directory.length);
      if (!filePath.startsWith(directory) || rest === '.resources/definition.yaml') continue;
      const folder = rest.match(/^([^/]+)\/\.resources\/definition\.yaml$/);
      if (folder) children.push({ ...value, items: entries(`${directory}${folder[1]}/`) });
      else if (/^[^/]+\.request\.yaml$/.test(rest)) children.push(value);
    }
    return children.sort((a, b) => a.order - b.order).map(({ order, ...item }) => {
      assert.equal(typeof order, 'number');
      return item;
    });
  };
  return { ...byPath.get('.resources/definition.yaml'), items: entries('') };
}

function testFiles() {
  const files = toPostmanV3Files(collection);
  const paths = files.map(file => file.path);
  assert.equal(new Set(paths.map(file => file.toLowerCase())).size, paths.length);
  assert.ok(paths.every(file => !/[\\:*?"<>|]/.test(file) && (file.endsWith('.request.yaml') || file.endsWith('.resources/definition.yaml'))));
  assert.ok(paths.includes('Setup/.resources/definition.yaml'));
  assert.ok(paths.includes('Orders/Add note- a-b-.request.yaml'));
  assert.ok(paths.includes('Poll- createOrder.request.yaml') || paths.some(file => file.endsWith('/Poll- createOrder.request.yaml')));
  // Two tags differing only in case, and two requests with the same summary, still get their own path.
  assert.ok(paths.includes('files/.resources/definition.yaml') && paths.includes('Files-1/.resources/definition.yaml'));
  const root = load(files[0].content);
  assert.equal(files[0].path, '.resources/definition.yaml');
  assert.equal(root.order, undefined);
  // Long script lines stay on one line instead of being folded.
  const createFile = files.find(file => file.path === 'Orders/Create order.request.yaml');
  assert.match(createFile.content, /^ {6}const responseDefinitions = .*;$/m);
  // The files hold the whole collection, in order, and nothing the schema does not describe.
  const rebuilt = readFolder(files);
  assert.deepEqual(rebuilt, document);
  assertValid(validateCollection, rebuilt, 'folder read back');
}

function testFileNames() {
  // What `postman collection migrate` (Postman CLI 1.94.0) writes for the same names.
  assert.equal(postmanV3FileName('GET /pets/{id}: a?b*c'), 'GET -pets-{id}- a-b-c');
  assert.equal(postmanV3FileName('Fold/er <x>'), 'Fold-er -x-');
  assert.equal(postmanV3FileName('inner.'), 'inner-');
  assert.equal(postmanV3FileName('[Negative] Create pet - unauthorized'), '[Negative] Create pet - unauthorized');
  // A leading dot would clash with `.resources`; Windows refuses device names; no name is empty.
  assert.equal(postmanV3FileName('.resources'), '-resources');
  assert.equal(postmanV3FileName('nul'), 'nul-');
  assert.equal(postmanV3FileName(''), 'Untitled');
  assert.equal(postmanV3FileName('x'.repeat(300)).length, 100);
  assert.equal(postmanV3FileName(`${'x'.repeat(99)} tail`), `${'x'.repeat(99)}-`);
  const duplicates = toPostmanV3Files({ info: { name: 'D', schema: '' }, variable: [], item: [
    { name: 'dup', request: { method: 'GET', header: [], url: { raw: 'https://a.example/1', host: ['https://a.example'] } } },
    { name: 'DUP', request: { method: 'GET', header: [], url: { raw: 'https://a.example/2', host: ['https://a.example'] } } },
    { name: 'dup', request: { method: 'GET', header: [], url: { raw: 'https://a.example/3', host: ['https://a.example'] } } },
  ] });
  assert.deepEqual(duplicates.map(file => file.path), ['.resources/definition.yaml', 'dup.request.yaml', 'DUP-1.request.yaml', 'dup-2.request.yaml']);
  assert.deepEqual(duplicates.slice(1).map(file => load(file.content).name), ['dup', 'DUP', 'dup']);
}

function testRawQuery() {
  // A URL with its query only in the raw text, as a hand-written v2.1 collection may have it.
  const [request] = toPostmanV3Collection({ info: { name: 'Q', schema: '' }, variable: [], item: [
    { name: 'q', request: { method: 'GET', header: [], url: { raw: '{{baseUrl}}/a?x=1&flag#frag', host: ['{{baseUrl}}'], path: ['a'] } } },
  ] }).items;
  assert.equal(request.url, '{{baseUrl}}/a');
  assert.deepEqual(request.queryParams, [{ key: 'x', value: '1' }, { key: 'flag', value: '' }]);
}

function testEnvironment() {
  const environment = generator.generateEnvironment();
  assert.ok(environment.values.some(value => value.type === 'secret'));
  const v3 = toPostmanV3Environment(environment);
  assert.ok(v3.values.every(value => value.type === 'default'));
  assert.deepEqual(v3.values.map(value => [value.key, value.value]), environment.values.map(value => [value.key, value.value]));
}

function testCli() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-v3-'));
  const cli = path.join(__dirname, '../dist/index.js');
  const specFile = path.join(temp, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const run = (...args) => spawnSync(process.execPath, [cli, 'generate', '--spec', specFile, ...args], { cwd: temp, encoding: 'utf8', timeout: 60000 });
  try {
    const out = path.join(temp, 'collection');
    const env = path.join(temp, 'environment.json');
    let result = run('--format', 'v3', '--out', out, '--env', env, '--negative');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\(Postman Collection v3, \d+ files\)/);
    assert.ok(fs.existsSync(path.join(out, '.resources', 'definition.yaml')));
    assert.ok(fs.existsSync(path.join(out, 'Orders', 'Create order.request.yaml')));
    assert.ok(JSON.parse(fs.readFileSync(env, 'utf8')).values.every(value => value.type === 'default'));

    // A second run replaces what the first wrote: a request renamed since then must not stay to run.
    fs.writeFileSync(path.join(out, 'Orders', 'Old name.request.yaml'), '$kind: http-request\nname: Old\n');
    fs.writeFileSync(path.join(out, 'notes.txt'), 'kept');
    fs.writeFileSync(path.join(out, 'Orders', 'definition.yaml'), 'not a definition');
    fs.mkdirSync(path.join(out, 'Gone', '.resources'), { recursive: true });
    fs.writeFileSync(path.join(out, 'Gone', '.resources', 'definition.yaml'), '$kind: collection\nname: Gone\n');
    result = run('--format', 'v3', '--out', out, '--env', env);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.existsSync(path.join(out, 'Orders', 'Old name.request.yaml')));
    assert.ok(!fs.existsSync(path.join(out, 'Gone')));
    assert.equal(fs.readFileSync(path.join(out, 'notes.txt'), 'utf8'), 'kept');
    assert.equal(fs.readFileSync(path.join(out, 'Orders', 'definition.yaml'), 'utf8'), 'not a definition');
    assert.ok(!fs.readdirSync(path.join(out, 'Orders')).some(file => file.includes('[Negative]')));

    // The default stays the v2.1 JSON file.
    result = run('--out', path.join(temp, 'v21.json'), '--env', env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(fs.readFileSync(path.join(temp, 'v21.json'), 'utf8')).info.schema, /v2\.1\.0/);
    assert.equal(run('--format', 'v2.1', '--out', path.join(temp, 'v21b.json'), '--env', env).status, 0);

    const other = path.join(temp, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'keep.txt'), 'x');
    result = run('--format', 'v3', '--out', other, '--env', env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a Postman v3 collection folder/);
    assert.equal(fs.readFileSync(path.join(other, 'keep.txt'), 'utf8'), 'x');
    result = run('--format', 'v3', '--out', path.join(temp, 'v21.json'), '--env', env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /writes a folder/);
    result = run('--format', 'v3', '--run');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Newman, which runs only v2\.1 collections.*postman collection run/);
    result = run('--format', 'v4');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--format must be v2\.1 or v3/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

testDocument();
testFiles();
testFileNames();
testRawQuery();
testEnvironment();
testCli();
console.log('Postman Collection v3 tests passed');
