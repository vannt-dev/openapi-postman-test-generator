const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { OpenApiPostmanGenerator } = require('../dist/generator');
const { runCollection } = require('../dist/runner');

async function main() {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/items') {
      request.resume();
      response.writeHead(201);
      response.end(JSON.stringify({ id: 'item-1' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/items/item-1') {
      response.writeHead(200);
      response.end(JSON.stringify({ id: 'item-1', name: 'Test item' }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: 'Not found' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not determine test server port');
  console.log(`E2E server listening on 127.0.0.1:${address.port}`);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-real-e2e-'));
  try {
    const responseSchema = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
    const spec = {
      openapi: '3.0.3', info: { title: 'Runner API', version: '1.0.0' },
      servers: [{ url: `http://127.0.0.1:${address.port}` }],
      paths: {
        '/items': { post: { operationId: 'createItem', tags: ['Items'], responses: { 201: { description: 'Created', content: { 'application/json': { schema: responseSchema } } } } } },
        '/items/{id}': { get: { operationId: 'getItem', tags: ['Items'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Item', content: { 'application/json': { schema: responseSchema } } } } } },
      },
    };
    const generator = new OpenApiPostmanGenerator(spec, {
      operationOrder: ['createItem', 'getItem'],
      variableMappings: [{ sourceOperationId: 'createItem', responseJsonPath: '$.id', variable: 'itemId', targetOperationIds: ['getItem'] }],
    });
    const collection = generator.generate();
    assert.equal(collection.item[0].request.method, 'POST');
    assert.equal(collection.item[1].request.url.raw, '{{baseUrl}}/items/{{itemId}}');
    const collectionPath = path.join(temp, 'collection.json');
    const reportDir = path.join(temp, 'reports');
    fs.writeFileSync(collectionPath, JSON.stringify(collection));

    const result = await runCollection({ collection: collectionPath, reportDir });
    assert.equal(result.failures, 0);
    assert.equal(result.requests, 2);
    assert.ok(result.assertions >= 8);
    const html = fs.readFileSync(path.join(reportDir, 'report.html'), 'utf8');
    assert.match(html, /createItem/);
    assert.match(html, /getItem/);
    assert.ok(fs.existsSync(path.join(reportDir, 'junit.xml')));
    console.log('Real Newman end-to-end test passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
