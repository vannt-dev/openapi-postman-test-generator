const assert = require('node:assert/strict');
const { OpenApiPostmanGenerator } = require('../dist/generator');

const spec = {
  openapi: '3.0.3',
  info: { title: 'Advanced API', version: '1.0.0' },
  servers: [{ url: 'http://localhost:3000' }],
  security: [{ bearerAuth: [] }],
  paths: {
    '/files': {
      post: {
        operationId: 'uploadFile',
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, label: { type: 'string' } } } } } },
        responses: { '201': { description: 'Uploaded', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } },
      },
    },
    '/files/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', example: 'file-1' } }],
      get: {
        operationId: 'downloadFile',
        parameters: [{ name: 'session', in: 'cookie', required: true, schema: { type: 'string', example: 'abc' } }],
        responses: { '200': { description: 'File', content: { 'text/plain': { schema: { type: 'string' } } } } },
      },
      delete: { operationId: 'deleteFile', responses: { '204': { description: 'Deleted' } } },
    },
    '/profiles': {
      post: {
        operationId: 'createProfile',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['age', 'role'], properties: { age: { type: 'integer', minimum: 18 }, role: { type: 'string', enum: ['admin', 'user'] } } } } } },
        responses: { '201': { description: 'Created', content: { 'application/json': { schema: { type: 'object' } } } }, '400': { description: 'Invalid input' }, '401': { description: 'Unauthorized' } },
      },
    },
  },
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
};

const generator = new OpenApiPostmanGenerator(spec, { safeMode: true, includeNegative: true });
const collection = generator.generate();
const requests = collection.item.flatMap(folder => folder.item || []);
assert.ok(!requests.some(request => request.name.includes('deleteFile')));
assert.ok(generator.getWarnings().some(warning => warning.includes('deleteFile')));
const upload = requests.find(request => request.name === 'uploadFile');
assert.equal(upload.request.body.mode, 'formdata');
assert.equal(upload.request.body.formdata.find(field => field.key === 'file').type, 'file');
const download = requests.find(request => request.name === 'downloadFile');
assert.ok(download.request.header.some(header => header.key === 'Cookie'));
assert.ok(download.event[0].script.exec.some(line => line.includes('declaredType.includes')));
assert.ok(requests.some(request => request.name.includes('[Negative] createProfile - missing age')));
assert.ok(requests.some(request => request.name.includes('[Negative] createProfile - invalid role')));
assert.ok(requests.some(request => request.name.includes('[Boundary] createProfile - age')));
assert.ok(requests.some(request => request.name.includes('[Negative] createProfile - unauthorized')));
console.log('Advanced generator tests passed');
