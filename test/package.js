// Exercise the distributable from a fresh consumer, outside this source checkout.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repository = path.resolve(__dirname, '..');
const npmCli = process.env.npm_execpath;
assert.ok(npmCli && fs.existsSync(npmCli), 'Run through npm run test:package');
const temporaryParent = fs.realpathSync(os.tmpdir());
const consumer = fs.mkdtempSync(path.join(temporaryParent, 'postman-package-'));
const expectedVersion = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8')).version;
const npm = (args, cwd = consumer) => execFileSync(process.execPath, [npmCli, ...args], {
  cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
});

try {
  let artifact = process.argv[2];
  if (!artifact) {
    const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', consumer], repository));
    assert.equal(packed.length, 1);
    assert.equal(packed[0].version, expectedVersion);
    const files = packed[0].files.map(file => file.path);
    for (const required of ['dist/index.js', 'dist/library.js', 'dist/library.d.ts', 'README.md', 'LICENSE']) {
      assert.ok(files.includes(required), `Missing published file: ${required}`);
    }
    assert.ok(!files.some(file => /(^|\/)(\.env(?:\.|$)|\.git\/|test\/)/.test(file)), 'Unexpected private/test files');
    artifact = path.join(consumer, packed[0].filename);
  }
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'release-consumer', private: true }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', artifact]);
  const installed = path.join(consumer, 'node_modules/openapi-postman-test-generator');
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.version, expectedVersion);
  const fixture = {
    openapi: '3.0.3', info: { title: 'Installed package smoke', version: '1.0.0' },
    servers: [{ url: 'https://example.invalid' }],
    paths: { '/health': { get: { responses: { 200: { description: 'Healthy' } } } } },
  };
  fs.writeFileSync(path.join(consumer, 'spec.json'), JSON.stringify(fixture));
  execFileSync(process.execPath, [path.join(installed, manifest.bin['openapi-postman']),
    'generate', '--spec', 'spec.json', '--out', 'collection.json', '--env', 'environment.json'],
  { cwd: consumer, stdio: 'inherit', timeout: 30000 });
  const collection = JSON.parse(fs.readFileSync(path.join(consumer, 'collection.json'), 'utf8'));
  assert.equal(collection.item[0].item[0].request.method, 'GET');
  const environment = JSON.parse(fs.readFileSync(path.join(consumer, 'environment.json'), 'utf8'));
  assert.equal(environment.values.find(value => value.key === 'baseUrl').value, 'https://example.invalid');
  fs.writeFileSync(path.join(consumer, 'consumer.js'), [
    "const assert = require('node:assert/strict');",
    "const api = require('openapi-postman-test-generator');",
    "const generator = new api.OpenApiPostmanGenerator(require('./spec.json'));",
    "assert.equal(generator.generate().item[0].item[0].request.method, 'GET');",
    "for (const name of ['loadProjectConfig', 'runCollection', 'planWithProviders']) assert.equal(typeof api[name], 'function');",
  ].join('\n'));
  execFileSync(process.execPath, ['consumer.js'], { cwd: consumer, stdio: 'inherit', timeout: 30000 });
  fs.writeFileSync(path.join(consumer, 'consumer.ts'), [
    "import { OpenApiPostmanGenerator, OpenApiSpec, PostmanCollection } from 'openapi-postman-test-generator';",
    `const spec: OpenApiSpec = ${JSON.stringify(fixture)};`,
    'const collection: PostmanCollection = new OpenApiPostmanGenerator(spec).generate();',
    'void collection;',
  ].join('\n'));
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict',
    '--skipLibCheck', '--target', 'ES2020', '--module', 'commonjs', '--moduleResolution', 'node', 'consumer.ts'],
  { cwd: consumer, stdio: 'inherit', timeout: 30000 });
  console.log(`Package consumer smoke passed for ${manifest.name}@${manifest.version}: CLI, library, declarations`);
} finally {
  const resolved = fs.realpathSync(consumer);
  assert.equal(path.dirname(resolved).toLowerCase(), temporaryParent.toLowerCase());
  assert.ok(path.basename(resolved).startsWith('postman-package-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
