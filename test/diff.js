const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { diffSpecs, formatSpecDiff } = require('../dist/diff');

const cli = path.join(__dirname, '..', 'dist', 'index.js');
const fixture = name => path.join(__dirname, '..', 'fixtures', name);
const clone = value => JSON.parse(JSON.stringify(value));
const codes = (diff, severity) => diff.changes.filter(change => change.severity === severity).map(change => change.code);
const find = (diff, code) => diff.changes.find(change => change.code === code);

const pet = {
  type: 'object',
  required: ['id', 'name'],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    status: { type: 'string', enum: ['available', 'adopted'] },
    owner: { type: 'object', properties: { email: { type: 'string' } } },
  },
};
const base = {
  openapi: '3.0.3',
  info: { title: 'Pets', version: '1' },
  paths: {
    '/pets': {
      get: {
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['name', 'age'] } },
        ],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: pet } } } } },
      },
      post: {
        requestBody: {
          content: {
            'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, age: { type: 'integer' } } } },
            'application/xml': { schema: { type: 'object' } },
          },
        },
        responses: { 201: { description: 'created', content: { 'application/json': { schema: pet } } }, 400: { description: 'bad' } },
      },
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
      get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: pet } } } } },
      delete: { responses: { 204: { description: 'gone' } } },
    },
  },
};

// The same document has no differences, and neither does a renamed path parameter.
{
  assert.deepEqual(diffSpecs(base, clone(base)), { changes: [], breaking: 0, nonBreaking: 0 });
  const renamed = clone(base);
  renamed.paths['/pets/{id}'] = renamed.paths['/pets/{petId}'];
  delete renamed.paths['/pets/{petId}'];
  renamed.paths['/pets/{id}'].parameters[0].name = 'id';
  assert.deepEqual(diffSpecs(base, renamed).changes, []);
  assert.equal(formatSpecDiff(diffSpecs(base, base)), 'No differences that affect a client were found.');
}

// Operations: a removed one breaks clients, an added or deprecated one does not.
{
  const next = clone(base);
  delete next.paths['/pets/{petId}'].delete;
  next.paths['/pets/{petId}'].get.deprecated = true;
  next.paths['/owners'] = { get: { responses: { 200: { description: 'ok' } } } };
  const diff = diffSpecs(base, next);
  assert.deepEqual(codes(diff, 'breaking'), ['operation-removed']);
  assert.deepEqual(codes(diff, 'non-breaking').sort(), ['operation-added', 'operation-deprecated']);
  assert.equal(find(diff, 'operation-removed').operation, 'DELETE /pets/{petId}');
  assert.equal(diff.changes[0].severity, 'breaking', 'breaking changes are listed first');
}

// Parameters: what a request must now carry is breaking; what it may now carry is not.
{
  const next = clone(base);
  const get = next.paths['/pets'].get;
  get.parameters[0].required = true;
  get.parameters[0].schema.type = 'string';
  get.parameters[1].schema.enum = ['name', 'created'];
  get.parameters.push({ name: 'X-Tenant', in: 'header', required: true, schema: { type: 'string' } });
  get.parameters.push({ name: 'cursor', in: 'query', schema: { type: 'string' } });
  const diff = diffSpecs(base, next);
  assert.deepEqual(codes(diff, 'breaking').sort(), ['enum-value-removed', 'parameter-became-required', 'required-parameter-added', 'type-changed']);
  assert.deepEqual(codes(diff, 'non-breaking').sort(), ['enum-value-added', 'parameter-added']);
  assert.equal(find(diff, 'type-changed').location, 'query parameter "limit"');
  assert.equal(find(diff, 'type-changed').message, 'type changed from integer to string');

  const removed = clone(base);
  removed.paths['/pets'].get.parameters.pop();
  assert.deepEqual(diffSpecs(base, removed).changes.map(change => [change.severity, change.code]), [['non-breaking', 'parameter-removed']]);
}

// Request bodies are judged as what the client sends.
{
  const next = clone(base);
  const body = next.paths['/pets'].post.requestBody;
  body.required = true;
  delete body.content['application/xml'];
  body.content['multipart/form-data'] = { schema: { type: 'object' } };
  const schema = body.content['application/json'].schema;
  schema.required = ['name', 'age', 'kind'];
  schema.properties.kind = { type: 'string' };
  schema.properties.nickname = { type: 'string' };
  schema.properties.age = { type: 'number' };
  const diff = diffSpecs(base, next);
  assert.deepEqual(codes(diff, 'breaking').sort(), ['property-became-required', 'request-body-became-required', 'request-media-type-removed', 'required-property-added']);
  assert.deepEqual(codes(diff, 'non-breaking').sort(), ['property-added', 'request-media-type-added', 'type-changed']);
  assert.equal(find(diff, 'required-property-added').location, 'request body application/json: kind');
  assert.equal(find(diff, 'type-changed').message, 'type changed from integer to number');
}

// Responses are judged as what the client reads: the same change cuts the other way.
{
  const next = clone(base);
  const post = next.paths['/pets'].post;
  delete post.responses[201];
  post.responses[200] = { description: 'ok' };
  delete post.responses[400];
  const item = next.paths['/pets'].get.responses[200].content['application/json'].schema.items;
  item.required = ['id'];
  delete item.properties.owner.properties.email;
  item.properties.status.enum = ['available', 'adopted', 'lost'];
  item.properties.tags = { type: 'array', items: { type: 'string' } };
  item.properties.id = { type: 'string' };
  const diff = diffSpecs(base, next);
  assert.deepEqual(codes(diff, 'breaking').sort(), ['property-became-optional', 'property-removed', 'response-removed', 'type-changed']);
  assert.deepEqual(codes(diff, 'non-breaking').sort(), ['enum-value-added', 'property-added', 'response-added', 'response-removed']);
  assert.equal(find(diff, 'property-removed').location, 'response 200 application/json: [].owner.email');
  assert.equal(find(diff, 'response-removed').message, 'success response removed');
}

// Security: an operation that starts asking for credentials breaks anonymous clients.
{
  const next = clone(base);
  next.security = [{ bearerAuth: [] }];
  next.paths['/pets'].get.security = [];
  next.paths['/pets'].post.security = [{ bearerAuth: [] }, {}];
  const diff = diffSpecs(base, next);
  assert.deepEqual(diff.changes.map(change => `${change.code} ${change.operation}`).sort(), [
    'security-added DELETE /pets/{petId}',
    'security-added GET /pets/{petId}',
  ]);
}

// allOf is read as one schema, and a schema that contains itself does not loop.
{
  const node = { type: 'object', properties: { name: { type: 'string' } } };
  node.properties.children = { type: 'array', items: node };
  const tree = name => ({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: { '/tree': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: name } } } } } } } });
  const other = { type: 'object', properties: { name: { type: 'string' } } };
  other.properties.children = { type: 'array', items: other };
  assert.deepEqual(diffSpecs(tree(node), tree(other)).changes, []);

  const composed = { allOf: [{ type: 'object', required: ['id'], properties: { id: { type: 'integer' } } }, { type: 'object', properties: { name: { type: 'string' } } }] };
  const flat = { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, name: { type: 'string' } } };
  assert.deepEqual(diffSpecs(tree(composed), tree(flat)).changes, []);
}

// A Swagger 2.0 document compares with OpenAPI 3: body and form parameters are request bodies.
{
  const swagger = {
    swagger: '2.0', info: { title: 'Pets', version: '1' }, consumes: ['application/json'], produces: ['application/json'],
    paths: {
      '/pets': {
        post: {
          parameters: [{ name: 'body', in: 'body', required: true, schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } }],
          responses: { 201: { description: 'created', schema: { type: 'object', properties: { id: { type: 'integer' } } } } },
        },
      },
      '/upload': {
        post: {
          consumes: ['multipart/form-data'],
          parameters: [{ name: 'file', in: 'formData', type: 'file', required: true }, { name: 'note', in: 'formData', type: 'string' }],
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  };
  const openapi = {
    openapi: '3.0.3', info: { title: 'Pets', version: '2' },
    paths: {
      '/pets': {
        post: {
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'kind'], properties: { name: { type: 'string' }, kind: { type: 'string' } } } } } },
          responses: { 201: { description: 'created', content: { 'application/json': { schema: { type: 'object', properties: {} } } } } },
        },
      },
      '/upload': {
        post: {
          requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, note: { type: 'string' } } } } } },
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  };
  const diff = diffSpecs(swagger, openapi);
  assert.deepEqual(diff.changes.map(change => `${change.severity} ${change.code} ${change.location}`).sort(), [
    'breaking property-removed response 201 application/json: id',
    'breaking required-property-added request body application/json: kind',
    'breaking type-changed request body multipart/form-data: file',
  ]);
}

// The text report groups by severity; the function rejects what is not a document.
{
  const next = clone(base);
  delete next.paths['/pets/{petId}'].delete;
  next.paths['/owners'] = { get: { responses: { 200: { description: 'ok' } } } };
  assert.equal(formatSpecDiff(diffSpecs(base, next)), [
    'Breaking changes (1)',
    '  DELETE /pets/{petId}  operation removed',
    '',
    'Non-breaking changes (1)',
    '  GET /owners  operation added',
  ].join('\n'));
  assert.throws(() => diffSpecs(null, base), TypeError);
}

// The command: reads files, prints the report, and fails the run on a breaking change.
{
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-diff-'));
  try {
    const run = (...args) => spawnSync(process.execPath, [cli, 'diff', ...args], { encoding: 'utf8' });
    const same = run('--old', fixture('petstore.openapi.yaml'), '--new', fixture('petstore.openapi.yaml'));
    assert.equal(same.status, 0, same.stderr);
    assert.match(same.stdout, /No differences that affect a client were found\./);

    const changed = fs.readFileSync(fixture('petstore.openapi.yaml'), 'utf8')
      .replace("required: [name]", "required: [name, status]")
      .replace("enum: [available, adopted]", "enum: [available]");
    assert.notEqual(changed, fs.readFileSync(fixture('petstore.openapi.yaml'), 'utf8'));
    const next = path.join(directory, 'next.yaml');
    fs.writeFileSync(next, changed);

    const broken = run('--old', fixture('petstore.openapi.yaml'), '--new', next);
    assert.equal(broken.status, 1, 'breaking changes fail the command');
    assert.match(broken.stdout, /Breaking changes \(\d+\)/);
    assert.match(broken.stdout, /POST \/pets {2}request body application\/json: status {2}property became required/);
    assert.match(broken.stdout, /enum value removed: adopted/);

    const allowed = run('--old', fixture('petstore.openapi.yaml'), '--new', next, '--allow-breaking', '--format', 'json');
    assert.equal(allowed.status, 0);
    const report = JSON.parse(allowed.stdout);
    assert.ok(report.breaking > 0);
    assert.equal(report.changes.length, report.breaking + report.nonBreaking);

    assert.equal(run('--old', fixture('petstore.openapi.yaml')).status, 1);
    assert.match(run('--old', fixture('petstore.openapi.yaml')).stderr, /--old and --new are required/);
    assert.match(run('--old', 'a', '--new', 'b', '--format', 'xml').stderr, /--format must be text or json/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

console.log('diff tests passed');
