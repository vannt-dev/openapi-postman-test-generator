const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OpenApiPostmanGenerator } = require('../dist/generator');
const { loadProjectConfig } = require('../dist/config');
const { runCollection } = require('../dist/runner');

const spec = {
  openapi: '3.0.3', info: { title: 'Workflow API', version: '1' },
  servers: [{ url: 'http://localhost:3000/v1' }],
  paths: {
    '/exports': { post: { operationId: 'createExport', tags: ['Exports'], responses: { 202: { description: 'Accepted' } } } },
    '/items': { get: { operationId: 'listItems', tags: ['Items'], responses: { 200: { description: 'OK' } } } },
    '/items/{id}': { delete: { operationId: 'deleteItem', tags: ['Items'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 204: { description: 'Deleted' } } } },
  },
};
const script = (item, listen = 'test') => item.event.find(event => event.listen === listen).script.exec.join('\n');
const setup = [{ name: 'Seed tenant', method: 'POST', url: '/admin/seed', headers: { 'X-Admin-Key': '{{adminKey}}' }, body: { tenant: 'test' }, expectStatus: [201], extract: { tenantId: '$.id' } }];
const teardown = [{ name: 'Reset tenant', method: 'DELETE', url: 'http://reset.test/tenants/{{tenantId}}' }];

// Setup and teardown wrap tag folders and survive safe mode.
{
  const collection = new OpenApiPostmanGenerator(spec, { setup, teardown, safeMode: true }).generate();
  const names = collection.item.map(item => item.name);
  assert.equal(names[0], 'Setup');
  assert.equal(names.at(-1), 'Teardown');
  assert.ok(!JSON.stringify(collection).includes('deleteItem'));
  const [seed] = collection.item[0].item;
  assert.equal(seed.name, 'Seed tenant');
  assert.equal(seed.request.method, 'POST');
  assert.equal(seed.request.url.raw, '{{baseUrl}}/admin/seed');
  assert.deepEqual(seed.request.header.find(header => header.key === 'X-Admin-Key'), { key: 'X-Admin-Key', value: '{{adminKey}}' });
  assert.equal(seed.request.body.raw, JSON.stringify({ tenant: 'test' }, null, 2));
  assert.match(script(seed), /oneOf\(\[201\]\)/);
  assert.match(script(seed), /"variable":"tenantId"/);
  assert.match(script(seed), /pm\.collectionVariables\.set/);
  const [reset] = collection.item.at(-1).item;
  assert.equal(reset.request.method, 'DELETE');
  assert.equal(reset.request.url.raw, 'http://reset.test/tenants/{{tenantId}}');
  assert.match(script(reset), /within\(200, 299\)/);
  assert.equal(reset.request.body, undefined);
}

// With an operation order the body stays flat between the Setup and Teardown folders.
{
  const collection = new OpenApiPostmanGenerator(spec, { setup, teardown, operationOrder: ['listItems', 'createExport'] }).generate();
  assert.deepEqual(collection.item.map(item => item.name).slice(0, 3), ['Setup', 'listItems', 'createExport']);
  assert.equal(collection.item.at(-1).name, 'Teardown');
}

// A text body is sent raw.
{
  const collection = new OpenApiPostmanGenerator(spec, { setup: [{ name: 'Text', method: 'PUT', url: '/raw', body: 'hello' }] }).generate();
  const [text] = collection.item[0].item;
  assert.equal(text.request.body.raw, 'hello');
  assert.equal(text.request.body.options.raw.language, 'text');
}

// An async operation gets a poll item right after it; Location is captured without statusUrl.
{
  const generator = new OpenApiPostmanGenerator(spec, {
    includeNegative: true,
    operationOrder: ['createExport', 'listItems'],
    asyncOperations: [
      { operationId: 'createExport', statusJsonPath: '$.status', successValues: ['done'], failureValues: ['failed'], maxAttempts: 5, intervalMs: 10, extract: { fileUrl: '$.url' } },
      { operationId: 'missingOperation', statusJsonPath: '$.status', successValues: ['done'] },
    ],
  });
  const collection = generator.generate();
  const names = collection.item.map(item => item.name);
  assert.equal(names[1], 'Poll: createExport');
  const poll = collection.item[1];
  assert.equal(poll.request.method, 'GET');
  assert.equal(poll.request.url.raw, '{{createExport_statusUrl}}');
  assert.match(script(collection.item[0]), /headers\.get\("Location"\)/);
  assert.match(script(collection.item[0]), /createExport_statusUrl/);
  const test = script(poll);
  assert.match(test, /\["done"\]/);
  assert.match(test, /\["failed"\]/);
  assert.match(test, /attempts < 5/);
  assert.match(test, /setNextRequest/);
  assert.match(test, /"variable":"fileUrl"/);
  assert.match(script(poll, 'prerequest'), /setTimeout\(function \(\) \{\}, 10\)/);
  assert.ok(generator.getWarnings().includes('Async operation was not found: missingOperation'));
}

// An explicit statusUrl is used as-is and no Location capture is added.
{
  const collection = new OpenApiPostmanGenerator(spec, {
    asyncOperations: [{ operationId: 'createExport', statusUrl: '/exports/{{exportId}}', statusJsonPath: '$.state', successValues: ['ready'] }],
  }).generate();
  const exportsFolder = collection.item.find(item => item.name === 'Exports');
  assert.deepEqual(exportsFolder.item.map(item => item.name), ['createExport', 'Poll: createExport']);
  assert.equal(exportsFolder.item[1].request.url.raw, '{{baseUrl}}/exports/{{exportId}}');
  assert.doesNotMatch(script(exportsFolder.item[0]), /Location/);
  assert.match(script(exportsFolder.item[1]), /attempts < 30/);
}

// Review fixes: auth isolation, collision-free keys, stale state, and environment-aware variables.
{
  const securedSpec = {
    ...spec,
    security: [{ bearerAuth: [], apiKey: [] }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } } },
    paths: {
      ...spec.paths,
      '/a': { post: { operationId: 'export-users', responses: { 202: { description: 'Accepted' } } } },
      '/b': { post: { operationId: 'export.users', responses: { 202: { description: 'Accepted' } } } },
    },
  };
  const asyncOperation = id => ({ operationId: id, statusJsonPath: '$.status', successValues: ['done'] });
  const collection = new OpenApiPostmanGenerator(securedSpec, {
    setup: [...setup, { ...setup[0], name: 'Authenticated seed', inheritAuth: true }],
    asyncOperations: [asyncOperation('export-users'), asyncOperation('export.users'), { ...asyncOperation('createExport'), inheritAuth: false }],
  }).generate();
  const all = collection.item.flatMap(item => item.item || [item]);
  const byName = name => all.find(item => item.name === name);
  // Setup requests do not send the API credentials unless asked to.
  assert.deepEqual(byName('Seed tenant').request.auth, { type: 'noauth' });
  assert.equal(byName('Authenticated seed').request.auth, undefined);
  // Polls reuse the operation's credentials by default, or send none.
  const poll = byName('Poll: export-users');
  assert.deepEqual(poll.request.auth, byName('export-users').request.auth);
  assert.equal(poll.request.auth.type, 'bearer');
  assert.equal(poll.request.header.find(header => header.key === 'X-Api-Key').value, '{{apiKey}}');
  assert.deepEqual(byName('Poll: createExport').request.auth, { type: 'noauth' });
  assert.ok(!byName('Poll: createExport').request.header.some(header => header.key === 'X-Api-Key'));
  // Different operation ids never share poll state.
  const urls = ['Poll: export-users', 'Poll: export.users'].map(name => byName(name).request.url.raw);
  assert.notEqual(urls[0], urls[1]);
  assert.notEqual(script(byName('Poll: export-users')).match(/counterKey = "([^"]+)"/)[1], script(byName('Poll: export.users')).match(/counterKey = "([^"]+)"/)[1]);
  // The starting request resets stale state and only captures Location on 2xx.
  const start = script(byName('createExport'));
  assert.match(start, /collectionVariables\.unset\("__poll_createExport_attempts"\)/);
  assert.match(start, /collectionVariables\.unset\("createExport_statusUrl"\)/);
  assert.match(start, /pm\.response\.code >= 200 && pm\.response\.code < 300/);
  assert.match(start, /require\("url"\)\.resolve/);
  // An unresolved status URL fails fast instead of retrying.
  assert.match(script(poll, 'prerequest'), /skipRequest/);
  // Extracted values also update an environment variable of the same name.
  assert.match(script(byName('Seed tenant')), /pm\.environment\.has\(key\)/);
}

// Workflow URLs keep templated schemes intact and drop fragments.
{
  const collection = new OpenApiPostmanGenerator(spec, { setup: [{ name: 'Templated', method: 'GET', url: '{{scheme}}://{{host}}/seed?x=1#top' }] }).generate();
  const { url } = collection.item[0].item[0].request;
  assert.deepEqual(url.host, ['{{scheme}}://{{host}}']);
  assert.deepEqual(url.path, ['seed']);
  assert.deepEqual(url.query, [{ key: 'x', value: '1' }]);
}

// Existing identifier mappings also update environment variables of the same name.
{
  const collection = new OpenApiPostmanGenerator(spec, {
    variableMappings: [{ sourceOperationId: 'createExport', responseJsonPath: '$.id', variable: 'exportId' }],
  }).generate();
  const exportsFolder = collection.item.find(item => item.name === 'Exports');
  assert.match(script(exportsFolder.item[0]), /setVariable\(mapping\.variable, value\)/);
  assert.match(script(exportsFolder.item[0]), /pm\.environment\.has\(key\)/);
}

// Config validation for the new keys.
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-workflow-'));
  try {
    const file = path.join(temp, 'config.yaml');
    fs.writeFileSync(file, [
      'setup:', '  - name: Seed', '    method: post', '    url: /seed', '    extract: { id: $.id }',
      'teardown:', '  - name: Reset', '    method: DELETE', '    url: /reset',
      'asyncOperations:', '  - operationId: createExport', '    statusJsonPath: $.status', '    successValues: [done]',
    ].join('\n'));
    const config = loadProjectConfig(file);
    assert.equal(config.setup[0].method, 'POST');
    assert.equal(config.asyncOperations[0].successValues[0], 'done');
    fs.writeFileSync(file, 'setup:\n  - name: Seed\n    method: POST\n    url: /seed\n    retries: 3\n');
    assert.throws(() => loadProjectConfig(file), /setup\.0/);
    fs.writeFileSync(file, 'asyncOperations:\n  - operationId: x\n    statusJsonPath: $.s\n    successValues: []\n');
    assert.throws(() => loadProjectConfig(file), /successValues/);
    fs.writeFileSync(file, 'setup:\n  - name: Seed\n    method: FETCH\n    url: /seed\n');
    assert.throws(() => loadProjectConfig(file), /method/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// Runtime variables are passed to Newman as --env-var pairs.
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-envvar-'));
  try {
    const fake = path.join(temp, 'fake-newman.js');
    fs.writeFileSync(fake, [
      "const fs = require('fs');",
      'const args = process.argv.slice(2);',
      "fs.writeFileSync(args[args.indexOf('--reporter-json-export') + 1], JSON.stringify({ run: { stats: {}, failures: [], executions: [] } }));",
      "fs.writeFileSync(process.env.ARGS_OUT, JSON.stringify(args));",
    ].join('\n'));
    const collection = path.join(temp, 'collection.json');
    fs.writeFileSync(collection, '{}');
    process.env.ARGS_OUT = path.join(temp, 'args.json');
    await runCollection({
      collection, reportDir: path.join(temp, 'reports'),
      executable: process.execPath, executableArgsPrefix: [fake],
      envVars: { otp: '123456', token: 'a=b' },
    });
    const args = JSON.parse(fs.readFileSync(process.env.ARGS_OUT, 'utf8'));
    const pairs = args.flatMap((arg, index) => arg === '--env-var' ? [args[index + 1]] : []);
    assert.deepEqual(pairs, ['otp=123456', 'token=a=b']);

    // A failed Newman process must not echo runtime secrets in the error message.
    fs.writeFileSync(fake, 'process.exit(2);');
    await assert.rejects(
      () => runCollection({ collection, reportDir: path.join(temp, 'reports'), executable: process.execPath, executableArgsPrefix: [fake], envVars: { otp: '123456' } }),
      error => !String(error.message).includes('123456') && !String(error.cmd || '').includes('123456'),
    );

    // --env-var is validated before any generation work and only accepted with --run.
    const cli = args => require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js'), ...args], { encoding: 'utf8' });
    const spec = path.join(__dirname, '..', 'fixtures', 'petstore.openapi.yaml');
    const out = ['--out', path.join(temp, 'c.json'), '--env', path.join(temp, 'e.json')];
    assert.match(cli(['generate', '--spec', spec, ...out, '--env-var', 'otp=1']).stderr, /--env-var requires --run/);
    const malformed = cli(['generate', '--spec', spec, ...out, '--run', '--env-var', 'otp']);
    assert.match(malformed.stderr, /--env-var must be KEY=VALUE/);
    assert.ok(!fs.existsSync(path.join(temp, 'c.json')));
    console.log('Workflow tests passed');
  } finally {
    delete process.env.ARGS_OUT;
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
