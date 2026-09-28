const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { OpenApiPostmanGenerator } = require('../dist/generator');
const { runCollection } = require('../dist/runner');

async function main() {
  const calls = [];
  let statusChecks = 0;
  let omitLocation = false;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      calls.push(`${request.method} ${request.url}`);
      const send = (code, payload, headers = {}) => {
        response.writeHead(code, { 'Content-Type': 'application/json', ...headers });
        response.end(payload === undefined ? '' : JSON.stringify(payload));
      };
      if (request.method === 'POST' && request.url === '/v1/admin/seed') return send(201, { id: 'tenant-1' });
      if (request.method === 'POST' && request.url === '/v1/verify') {
        return JSON.parse(body || '{}').code === '123456' ? send(200, { ok: true }) : send(401, { ok: false });
      }
      if (request.method === 'POST' && request.url === '/v1/exports') return send(202, { accepted: true }, omitLocation ? {} : { Location: 'exports/job-1' });
      if (request.method === 'GET' && request.url === '/v1/exports/job-1') {
        statusChecks++;
        return send(200, statusChecks < 3 ? { status: 'pending' } : { status: 'done', fileId: 'export-1' });
      }
      if (request.method === 'GET' && request.url === '/v1/files/export-1') return send(200, { ready: true });
      if (request.method === 'DELETE' && request.url === '/v1/admin/tenants/tenant-1') return send(204);
      send(404, { error: 'Not found' });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-workflow-e2e-'));
  try {
    const spec = {
      openapi: '3.0.3', info: { title: 'Workflow API', version: '1.0.0' },
      servers: [{ url: `http://127.0.0.1:${port}/v1` }],
      paths: {
        '/exports': { post: { operationId: 'createExport', responses: { 202: { description: 'Accepted' } } } },
        '/files/{fileId}': { get: { operationId: 'getFile', parameters: [{ name: 'fileId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'File' } } } },
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
      // Same names as extracted values: the generated environment must not override them.
      variables: { tenantId: 'placeholder-tenant' },
    });
    const collection = generator.generate();
    const environment = generator.generateEnvironment();
    assert.ok(environment.values.some(value => value.key === 'fileId'));
    assert.ok(environment.values.some(value => value.key === 'tenantId'));
    const collectionPath = path.join(temp, 'collection.json');
    const environmentPath = path.join(temp, 'environment.json');
    fs.writeFileSync(collectionPath, JSON.stringify(collection));
    fs.writeFileSync(environmentPath, JSON.stringify(environment));

    const reportDir = path.join(temp, 'reports');
    const result = await runCollection({ collection: collectionPath, environment: environmentPath, reportDir, envVars: { otp: '123456' } });
    assert.equal(result.failures, 0, fs.readFileSync(path.join(reportDir, 'report.html'), 'utf8'));
    assert.deepEqual(calls, [
      'POST /v1/admin/seed',
      'POST /v1/verify',
      'POST /v1/exports',
      'GET /v1/exports/job-1',
      'GET /v1/exports/job-1',
      'GET /v1/exports/job-1',
      'GET /v1/files/export-1',
      'DELETE /v1/admin/tenants/tenant-1',
    ]);

    // A job that never finishes fails after maxAttempts instead of looping forever.
    calls.length = 0;
    statusChecks = -100;
    const failed = await runCollection({ collection: collectionPath, environment: environmentPath, reportDir, envVars: { otp: '123456' } });
    assert.equal(failed.failures, 2); // the poll, then getFile without an extracted fileId
    assert.equal(calls.filter(call => call === 'GET /v1/exports/job-1').length, 5);
    assert.equal(calls.at(-1), 'DELETE /v1/admin/tenants/tenant-1');

    // A wrong OTP fails the setup request.
    statusChecks = 0;
    const wrongOtp = await runCollection({ collection: collectionPath, environment: environmentPath, reportDir, envVars: { otp: '000000' } });
    assert.ok(wrongOtp.failures >= 1);

    // A 202 without Location fails once and skips polling instead of retrying an unresolved URL.
    calls.length = 0;
    omitLocation = true;
    const noLocation = await runCollection({ collection: collectionPath, environment: environmentPath, reportDir, envVars: { otp: '123456' } });
    assert.ok(noLocation.failures >= 1);
    assert.ok(!calls.some(call => call.startsWith('GET /v1/exports')), calls.join(', '));
    assert.equal(calls.at(-1), 'DELETE /v1/admin/tenants/tenant-1');
    console.log('Workflow Newman end-to-end test passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
