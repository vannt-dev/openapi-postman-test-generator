const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { OpenApiPostmanGenerator } = require('../dist/generator');
const { runCollection } = require('../dist/runner');

// A token endpoint that only answers the right client, and an API that only answers the token it gave out.
// Newman runs the generated collection against both: the token is fetched first and the next request sends it.
async function main() {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST' && request.url === '/oauth/token') {
        const form = new URLSearchParams(body);
        seen.push({ token: Object.fromEntries(form), type: request.headers['content-type'], authorization: request.headers.authorization });
        const valid = form.get('grant_type') === 'client_credentials' && form.get('client_id') === 'my-client' && form.get('client_secret') === 's3cret';
        response.writeHead(valid ? 200 : 401);
        response.end(JSON.stringify(valid ? { access_token: 'tok-123', token_type: 'Bearer', expires_in: 3600 } : { error: 'invalid_client' }));
        return;
      }
      if (request.method === 'GET' && request.url === '/orders') {
        seen.push({ orders: request.headers.authorization || null });
        const allowed = request.headers.authorization === 'Bearer tok-123';
        response.writeHead(allowed ? 200 : 401);
        response.end(JSON.stringify(allowed ? [{ id: 'order-1' }] : { error: 'unauthorized' }));
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'Not found' }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  console.log(`OAuth E2E server listening on 127.0.0.1:${port}`);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-oauth-e2e-'));
  try {
    const spec = {
      openapi: '3.0.3', info: { title: 'Orders API', version: '1.0.0' },
      servers: [{ url: `http://127.0.0.1:${port}` }],
      security: [{ oauth: [] }],
      components: { securitySchemes: { oauth: { type: 'oauth2', flows: { clientCredentials: {
        tokenUrl: `http://127.0.0.1:${port}/oauth/token`, scopes: { 'orders:read': 'Read orders' },
      } } } } },
      paths: { '/orders': { get: { operationId: 'listOrders', tags: ['Orders'], responses: {
        200: { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } } } },
        401: { description: 'Unauthorized' },
      } } } },
    };
    const generator = new OpenApiPostmanGenerator(spec, { oauthClientCredentials: true, includeNegative: true });
    const collectionPath = path.join(temp, 'collection.json');
    const environmentPath = path.join(temp, 'environment.json');
    fs.writeFileSync(collectionPath, JSON.stringify(generator.generate()));
    // the generated environment holds empty placeholders for the client and for the token
    fs.writeFileSync(environmentPath, JSON.stringify(generator.generateEnvironment()));
    const reportDir = path.join(temp, 'reports');

    const result = await runCollection({
      collection: collectionPath, environment: environmentPath, reportDir,
      envVars: { oauth_clientId: 'my-client', oauth_clientSecret: 's3cret' },
    });
    assert.equal(result.failures, 0, 'the token is fetched and accepted');
    assert.equal(result.requests, 3, 'token, listOrders, and listOrders without credentials');
    assert.deepEqual(seen[0], {
      token: { grant_type: 'client_credentials', client_id: 'my-client', client_secret: 's3cret', scope: 'orders:read' },
      type: 'application/x-www-form-urlencoded',
      authorization: undefined,
    });
    assert.deepEqual(seen.slice(1), [{ orders: 'Bearer tok-123' }, { orders: null }]);

    // the wrong secret: the token request fails, and so does the request that needed the token
    seen.length = 0;
    const refused = await runCollection({
      collection: collectionPath, environment: environmentPath, reportDir,
      envVars: { oauth_clientId: 'my-client', oauth_clientSecret: 'wrong' },
    });
    assert.ok(refused.failures >= 2, `expected the token request and listOrders to fail, got ${refused.failures}`);
    assert.equal(seen[1].orders === 'Bearer tok-123', false);
    console.log('OAuth client credentials end-to-end test passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
