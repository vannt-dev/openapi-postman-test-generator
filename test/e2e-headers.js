const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { OpenApiPostmanGenerator } = require('../dist/generator');
const { runCollection } = require('../dist/runner');

// The response header checks run in Newman (Postman's sandbox and its Ajv), against a local server.
async function main() {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/pets') {
      response.setHeader('X-Total-Count', '3');
      response.setHeader('x-request-id', 'ab12-cd34');
      response.setHeader('X-Tags', 'a, b');
      response.setHeader('Last-Modified', 'Tue, 20 Oct 2026 10:00:00 GMT');
      response.writeHead(200);
      response.end('[]');
      return;
    }
    if (request.url === '/broken') {
      // X-Total-Count is not a number and the required X-Request-Id is missing.
      response.setHeader('X-Total-Count', 'many');
      response.writeHead(200);
      response.end('[]');
      return;
    }
    response.writeHead(404);
    response.end('{}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-headers-e2e-'));
  try {
    const headers = {
      'X-Total-Count': { required: true, schema: { type: 'integer', format: 'int32', minimum: 0 } },
      'X-Request-Id': { required: true, schema: { type: 'string', pattern: '^[a-f0-9-]+$' } },
      'X-Tags': { schema: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } },
      'Last-Modified': { schema: { type: 'string', format: 'date-time' } },
      'X-Rate-Limit': { schema: { type: 'integer' } },
    };
    const list = { description: 'Pets', headers, content: { 'application/json': { schema: { type: 'array' } } } };
    const spec = {
      openapi: '3.0.3', info: { title: 'Header API', version: '1' },
      servers: [{ url: `http://127.0.0.1:${port}` }],
      paths: {
        '/pets': { get: { operationId: 'listPets', responses: { 200: list } } },
        '/broken': { get: { operationId: 'broken', responses: { 200: list } } },
      },
    };
    const collectionPath = path.join(temp, 'collection.json');
    const reportDir = path.join(temp, 'reports');
    fs.writeFileSync(collectionPath, JSON.stringify(new OpenApiPostmanGenerator(spec).generate()));
    const result = await runCollection({ collection: collectionPath, reportDir });
    const report = JSON.parse(fs.readFileSync(path.join(reportDir, 'newman.json'), 'utf8'));
    const failures = report.run.failures.map(failure => `${failure.source.name}: ${failure.error.test}`);
    assert.deepEqual(failures.sort(), [
      'broken: Response has the X-Request-Id header',
      'broken: Response header X-Total-Count matches its schema',
    ]);
    assert.equal(result.failures, 2);
    const passed = report.run.executions.find(execution => execution.item.name === 'listPets').assertions;
    for (const name of ['Response has the X-Total-Count header', 'Response header X-Total-Count matches its schema',
      'Response header X-Request-Id matches its schema', 'Response header X-Tags matches its schema', 'Response header Last-Modified matches its schema']) {
      assert.ok(passed.some(assertion => assertion.assertion === name && !assertion.error), name);
    }
    console.log('Response header end-to-end test passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
