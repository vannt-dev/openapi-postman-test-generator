const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { OpenApiPostmanGenerator } = require('../dist/generator');
const { operationIdOfItem } = require('../dist/run-coverage');

// A request body with three named examples: by default the first one is sent, as before; with
// requestExamples every one gets its own request, with the same checks, linked to the operation.
const spec = {
  openapi: '3.0.3',
  info: { title: 'Pets', version: '1' },
  paths: {
    '/pets': {
      post: {
        operationId: 'createPet',
        summary: 'Create a pet',
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string' } } },
              examples: {
                cat: { summary: 'A cat', value: { name: 'Tom', kind: 'cat' } },
                dog: { summary: 'A dog', value: { name: 'Rex', kind: 'dog' } },
                noValue: { externalValue: 'https://example.com/pet.json' },
                'bird #1': { value: { name: 'Tweety', kind: 'bird' } },
              },
            },
          },
        },
        responses: { 201: { description: 'Created' } },
      },
      get: { operationId: 'listPets', responses: { 200: { description: 'OK' } } },
    },
  },
};
const requests = collection => collection.item.flatMap(folder => folder.item || [folder]);
const bodyOf = item => JSON.parse(item.request.body.raw);

{
  const plain = requests(new OpenApiPostmanGenerator(spec).generate());
  assert.deepEqual(plain.map(item => item.id), ['op:createPet', 'op:listPets']);
  assert.deepEqual(bodyOf(plain[0]), { name: 'Tom', kind: 'cat' });
}

{
  const items = requests(new OpenApiPostmanGenerator(spec, { requestExamples: true }).generate());
  assert.deepEqual(items.map(item => item.id), [
    'op:createPet', 'op:createPet#example-dog', 'op:createPet#example-bird%20%231', 'op:listPets',
  ]);
  assert.deepEqual(items.map(item => item.name), ['Create a pet', 'Create a pet (example: A dog)', 'Create a pet (example: bird #1)', 'listPets']);
  assert.deepEqual(items.slice(0, 3).map(bodyOf).map(body => body.name), ['Tom', 'Rex', 'Tweety']);
  // the same checks as the first request, and run coverage counts them for the operation
  assert.deepEqual(items[1].event, items[0].event);
  assert.deepEqual(items.map(item => operationIdOfItem(item.id)), ['createPet', 'createPet', 'createPet', 'listPets']);
  assert.equal(operationIdOfItem('op:createPet#negative-2'), 'createPet');
}

// the CLI flag and the config key
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oapg-examples-'));
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec));
  const cli = path.join(__dirname, '..', 'dist', 'index.js');
  const run = (...args) => spawnSync(process.execPath, [cli, 'generate', '--spec', path.join(dir, 'spec.json'), '--out', path.join(dir, 'out.json'), '--env', path.join(dir, 'env.json'), ...args], { encoding: 'utf8' });
  const ids = () => requests(JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'))).map(item => item.id);
  let result = run('--examples');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ids().length, 4);
  fs.writeFileSync(path.join(dir, 'cfg.json'), JSON.stringify({ requestExamples: true }));
  result = run('--config', path.join(dir, 'cfg.json'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ids().length, 4);
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ids().length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('examples tests passed');
