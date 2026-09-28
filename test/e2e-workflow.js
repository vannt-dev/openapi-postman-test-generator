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
      if (request.method === 'POST' && request.url === '/v1/exports') return send(202, { accepted: true }, { Location: '/v1/exports/job-1' });
      if (request.method === 'GET' && request.url === '/v1/exports/job-1') {
        statusChecks++;
        return send(200, statusChecks < 3 ? { status: 'pending' } : { status: 'done', url: '/files/export-1' });
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
    const collection = new OpenApiPostmanGenerator(spec, {
      operationOrder: ['createExport', 'getFile'],
      setup: [
        { name: 'Seed tenant', method: 'POST', url: '/admin/seed', body: { name: 'test' }, expectStatus: [201], extract: { tenantId: '$.id' } },
        { name: 'Verify OTP', method: 'POST', url: '/verify', body: { code: '{{otp}}' }, expectStatus: [200] },
      ],
      teardown: [{ name: 'Delete tenant', method: 'DELETE', url: '/admin/tenants/{{tenantId}}', expectStatus: [204] }],
      asyncOperations: [{ operationId: 'createExport', statusJsonPath: '$.status', successValues: ['done'], failureValues: ['failed'], intervalMs: 50, maxAttempts: 5, extract: { fileId: '$.url' } }],
      variables: { fileId: 'unused' },
    }).generate();
    // The file path is a full path segment here, so point getFile straight at the extracted value.
    const getFile = collection.item.find(item => item.name === 'getFile');
    getFile.request.url = { raw: '{{baseUrl}}/files/export-1', host: ['{{baseUrl}}'], path: ['files', 'export-1'] };
    const collectionPath = path.join(temp, 'collection.json');
    fs.writeFileSync(collectionPath, JSON.stringify(collection));

    const reportDir = path.join(temp, 'reports');
    const result = await runCollection({ collection: collectionPath, reportDir, envVars: { otp: '123456' } });
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
    const failed = await runCollection({ collection: collectionPath, reportDir, envVars: { otp: '123456' } });
    assert.equal(failed.failures, 1);
    assert.equal(calls.filter(call => call === 'GET /v1/exports/job-1').length, 5);
    assert.equal(calls.at(-1), 'DELETE /v1/admin/tenants/tenant-1');

    // A wrong OTP fails the setup request.
    statusChecks = 0;
    const wrongOtp = await runCollection({ collection: collectionPath, reportDir, envVars: { otp: '000000' } });
    assert.ok(wrongOtp.failures >= 1);
    console.log('Workflow Newman end-to-end test passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
