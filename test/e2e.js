const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OpenApiPostmanGenerator } = require('../dist/generator');
const { processNewmanReport } = require('../dist/runner');

async function main() {
  const spec = {
    openapi: '3.0.3', info: { title: 'Runner API', version: '1.0.0' }, servers: [{ url: 'http://127.0.0.1:3000' }],
    paths: {
      '/items/{id}': { get: { operationId: 'getItem', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', default: 'item-1' } }], responses: { '200': { description: 'Item', content: { 'application/json': { schema: { type: 'object' } } } } } } },
      '/items': { post: { operationId: 'createItem', responses: { '201': { description: 'Created', content: { 'application/json': { schema: { type: 'object' } } } } } } },
    },
  };
  const generator = new OpenApiPostmanGenerator(spec);
  const collection = generator.generate();
  assert.equal(collection.item[0].item[0].request.method, 'POST');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-runner-'));
  const collectionPath = path.join(temp, 'collection.json');
  const reportDir = path.join(temp, 'reports');
  fs.writeFileSync(collectionPath, JSON.stringify(collection));
  fs.mkdirSync(reportDir, { recursive: true });
  const newmanJson = path.join(reportDir, 'newman.json');
  fs.writeFileSync(newmanJson, JSON.stringify({ run: { stats: { requests: { total: 2, failed: 0 }, assertions: { total: 8, failed: 0 } }, failures: [] } }));
  fs.writeFileSync(path.join(reportDir, 'junit.xml'), '<?xml version="1.0"?><testsuite tests="8" failures="0"/>');
  const result = processNewmanReport(newmanJson, reportDir);
  assert.equal(result.failures, 0);
  assert.equal(result.requests, 2);
  assert.equal(result.assertions, 8);
  assert.ok(fs.existsSync(path.join(reportDir, 'report.html')));
  assert.ok(fs.existsSync(path.join(reportDir, 'junit.xml')));
  console.log('Runner integration test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
