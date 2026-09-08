const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swagger-postman-'));
const collectionPath = path.join(outputDir, 'collection.json');
const environmentPath = path.join(outputDir, 'environment.json');
execFileSync(process.execPath, [
  path.resolve('dist/index.js'), '--spec', path.resolve('fixtures/petstore.openapi.yaml'),
  '--out', collectionPath, '--env', environmentPath,
], { stdio: 'inherit' });

const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
const environment = JSON.parse(fs.readFileSync(environmentPath, 'utf8'));
const requests = collection.item.flatMap(folder => folder.item || []);
assert.equal(requests.length, 3);
assert.equal(environment.values.find(v => v.key === 'baseUrl').value, 'https://api.example.com/v1');
assert.ok(environment.values.some(v => v.key === 'bearerAuth_token'));
assert.ok(requests.some(item => item.request.url.raw.includes('{{id}}')));
assert.ok(requests.every(item => item.event[0].script.exec.some(line => line.includes('Status code'))));
console.log('Smoke test passed');

const swagger2CollectionPath = path.join(outputDir, 'swagger2.collection.json');
const swagger2EnvironmentPath = path.join(outputDir, 'swagger2.environment.json');
execFileSync(process.execPath, [
  path.resolve('dist/index.js'), '--spec', path.resolve('fixtures/petstore.swagger2.yaml'),
  '--out', swagger2CollectionPath, '--env', swagger2EnvironmentPath,
], { stdio: 'inherit' });
const swagger2Collection = JSON.parse(fs.readFileSync(swagger2CollectionPath, 'utf8'));
const swagger2Environment = JSON.parse(fs.readFileSync(swagger2EnvironmentPath, 'utf8'));
assert.equal(swagger2Collection.item[0].item.length, 1);
assert.equal(swagger2Environment.values.find(v => v.key === 'baseUrl').value, 'http://localhost:3000/api');
assert.ok(swagger2Environment.values.some(v => v.key === 'apiKey'));
console.log('Swagger 2 smoke test passed');
