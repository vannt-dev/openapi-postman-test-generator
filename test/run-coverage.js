const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { OpenApiPostmanGenerator } = require('../dist/generator');
const { runCoverage, formatRunCoverage, formatRunCoverageMarkdown } = require('../dist/run-coverage');

// fixtures/run-coverage holds a tiny spec with the coverage report and the (trimmed) Newman report of
// one recorded run; test/e2e-run-coverage.js --record writes them again.
const fixtures = path.join(__dirname, '..', 'fixtures', 'run-coverage');
const read = name => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
const coverage = read('api.coverage.json');
const newman = read('newman.json');
const clone = value => JSON.parse(JSON.stringify(value));
const operation = (report, id) => report.byOperation.find(entry => entry.operationId === id);
const cli = path.join(__dirname, '..', 'dist', 'index.js');

// The recorded run: every operation is passed, failed or left out; responses are passed or planned only.
{
  const report = runCoverage(coverage, newman);
  assert.deepEqual(report.run, { executions: 7, failedExecutions: 1 });
  assert.deepEqual(report.operations, { total: 5, passed: 3, failed: 1, notRun: 0, leftOut: 1 });
  assert.deepEqual(report.responses, { total: 6, passed: 5, failed: 0, plannedOnly: 1, noTest: 0 });
  assert.deepEqual(report.byOperation.map(entry => [entry.operationId, entry.result]), [
    ['listPets', 'passed'], ['createPet', 'passed'], ['getPet', 'passed'], ['deletePet', 'left out'], ['getStats', 'failed'],
  ]);
  // the negative variant of createPet is what exercised its 400
  assert.deepEqual(operation(report, 'createPet').responses, [{ status: '201', result: 'passed' }, { status: '400', result: 'passed' }]);
  assert.equal(operation(report, 'createPet').executions, 2);
  assert.equal(operation(report, 'deletePet').reason, 'safe mode');
  const stats = operation(report, 'getStats');
  assert.deepEqual(stats.responses, [{ status: '200', result: 'planned only' }]);
  assert.deepEqual(stats.undocumented, ['500']);
  assert.deepEqual(stats.failures, [{ request: 'getStats', check: 'Status code is successful (200)', message: 'expected 500 to be one of [ 200 ]' }]);
  // the setup request is not in the document
  assert.deepEqual(report.extra, [{ name: 'Health check', method: 'GET', executions: 1, failedExecutions: 0, statuses: ['200'] }]);

  const text = formatRunCoverage(report);
  assert.match(text, /^Run: {10}7 requests, 1 with a failed check$/m);
  assert.match(text, /^Operations: {3}3\/5 passed, 1 failed, 0 not run, 1 left out$/m);
  assert.match(text, /^Responses: {4}5\/6 documented responses passed, 0 failed, 1 planned only, 0 with no test$/m);
  assert.match(text, /^Failed: {7}GET \/stats \(getStats\): Status code is successful \(200\): expected 500/m);
  assert.match(text, /^Planned only: GET \/stats \(getStats\) 200$/m);
  assert.match(text, /^Undocumented: GET \/stats \(getStats\) returned 500$/m);
  assert.match(text, /^Extra: {8}1 request outside the document: Health check$/m);

  const markdown = formatRunCoverageMarkdown(report);
  assert.match(markdown, /^### Coverage of the run$/m);
  assert.match(markdown, /^- \*\*Operations:\*\* 3 of 5 passed, 1 failed, 0 not run, 1 left out$/m);
  assert.match(markdown, /^\| `GET \/stats \(getStats\)` \| 500 \| getStats: Status code is successful \(200\): expected 500 to be one of \[ 200 \] \|$/m);
  assert.match(markdown, /^#### Planned but not received\n\n- `GET \/stats \(getStats\)`: 200$/m);
  assert.match(markdown, /^- `GET Health check`: 1 sent, received 200$/m);
}

// A status received only by requests that failed a check is failed; an operation with no request sent is not run.
{
  const run = clone(newman);
  const getPet = run.run.executions.find(execution => execution.item.id === 'op:getPet');
  getPet.assertions[0].error = { name: 'AssertionError', message: 'expected 200 to be one of [ 201 ]' };
  run.run.executions = run.run.executions.filter(execution => execution.item.id !== 'op:listPets');
  const report = runCoverage(coverage, run);
  assert.equal(operation(report, 'getPet').result, 'failed');
  assert.deepEqual(operation(report, 'getPet').responses, [{ status: '200', result: 'failed' }, { status: '404', result: 'passed' }]);
  assert.equal(operation(report, 'listPets').result, 'not run');
  assert.deepEqual(operation(report, 'listPets').responses, [{ status: '200', result: 'planned only' }]);
  assert.deepEqual(report.operations, { total: 5, passed: 1, failed: 2, notRun: 1, leftOut: 1 });
  assert.match(formatRunCoverage(report), /^Not run: {6}GET \/pets \(listPets\)$/m);
  assert.match(formatRunCoverageMarkdown(report), /^#### Not run\n\n- `GET \/pets \(listPets\)`$/m);
  // one passing request is enough for a status code to count as passed
  const twice = clone(newman);
  const failing = clone(twice.run.executions.find(execution => execution.item.id === 'op:listPets'));
  failing.cursor.ref = 'second-iteration';
  failing.assertions[2].error = { name: 'AssertionError', message: 'expected json' };
  twice.run.executions.push(failing);
  const both = runCoverage(coverage, twice);
  assert.equal(operation(both, 'listPets').result, 'failed');
  assert.equal(operation(both, 'listPets').executions, 2);
  assert.deepEqual(operation(both, 'listPets').responses, [{ status: '200', result: 'passed' }]);
}

// A connection error and a broken script fail a request; a request a script skipped exercises nothing.
{
  const run = clone(newman);
  const listPets = run.run.executions.find(execution => execution.item.id === 'op:listPets');
  delete listPets.response;
  listPets.assertions = [];
  listPets.requestError = { name: 'Error', message: 'connect ECONNREFUSED 127.0.0.1:3000' };
  const getPet = run.run.executions.find(execution => execution.item.id === 'op:getPet');
  run.run.failures.push({ cursor: { ref: getPet.cursor.ref }, source: { id: 'op:getPet', name: 'getPet' }, error: { name: 'TypeError', message: 'data is undefined' }, at: 'test-script' });
  const health = run.run.executions.find(execution => execution.item.name === 'Health check');
  delete health.response;
  health.assertions = [];
  const report = runCoverage(coverage, run);
  assert.equal(operation(report, 'listPets').result, 'failed');
  assert.deepEqual(operation(report, 'listPets').responses, [{ status: '200', result: 'planned only' }]);
  assert.deepEqual(operation(report, 'listPets').failures, [{ request: 'listPets', check: 'request', message: 'connect ECONNREFUSED 127.0.0.1:3000' }]);
  assert.equal(operation(report, 'getPet').result, 'failed');
  assert.deepEqual(operation(report, 'getPet').failures, [{ request: 'getPet', check: 'test-script', message: 'data is undefined' }]);
  assert.deepEqual(report.extra, []);
  assert.equal(report.run.executions, 6);
}

// A documented range (2XX) takes every code of the range; `default` is not a status code.
{
  const spec = {
    openapi: '3.0.3', info: { title: 'Ranges', version: '1' }, servers: [{ url: 'http://localhost' }],
    paths: { '/jobs': { post: { operationId: 'startJob', responses: { '2XX': { description: 'Started' }, default: { description: 'Error' } } } } },
  };
  const generator = new OpenApiPostmanGenerator(spec);
  const collection = generator.generate();
  assert.equal(collection.item[0].item[0].id, 'op:startJob');
  const execution = (code, ref) => ({ cursor: { ref }, item: { id: 'op:startJob', name: 'startJob' }, request: { method: 'POST' }, response: { code }, assertions: [{ assertion: 'ok' }] });
  const report = runCoverage(generator.getCoverage(), { run: { executions: [execution(202, 'a'), execution(503, 'b')], failures: [] } });
  assert.deepEqual(operation(report, 'startJob').responses, [{ status: '2XX', result: 'passed' }]);
  assert.deepEqual(operation(report, 'startJob').undocumented, ['503']);
}

// The generator writes the join key: one id per operation, one per negative variant; other requests have none.
{
  const spec = {
    openapi: '3.0.3', info: { title: 'Ids', version: '1' }, servers: [{ url: 'http://localhost' }],
    paths: { '/pets/{id}': { get: {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
      responses: { 200: { description: 'ok' }, 400: { description: 'bad' } },
    } } },
  };
  const collection = new OpenApiPostmanGenerator(spec, {
    includeNegative: true,
    setup: [{ name: 'Seed', method: 'POST', url: '/seed' }],
    asyncOperations: [{ operationId: 'get /pets/{id}', statusJsonPath: '$.state', successValues: ['done'] }],
  }).generate();
  const ids = collection.item.flatMap(folder => folder.item).map(item => item.id);
  assert.deepEqual(ids, [undefined, 'op:get /pets/{id}', undefined, 'op:get /pets/{id}#negative-1', 'op:get /pets/{id}#negative-2']);
}

// A report of a collection without the ids (made by an older version) links nothing, and says why.
{
  const run = clone(newman);
  for (const execution of run.run.executions) execution.item.id = 'some-uuid';
  const report = runCoverage(coverage, run);
  assert.equal(report.extra.length, 7);
  assert.equal(report.operations.notRun, 4);
  assert.match(formatRunCoverage(report), /no request of the run is linked to an operation/);
}

// Input that is not a coverage report or not a Newman report is refused.
{
  assert.throws(() => runCoverage({}, newman), /Not a coverage report/);
  assert.throws(() => runCoverage(coverage, { collection: {} }), /Not a Newman JSON report/);
}

// The CLI: text by default, Markdown or JSON on request, the JSON file with --out.
{
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-run-coverage-cli-'));
  const run = (...args) => spawnSync(process.execPath, [cli, 'coverage', ...args], { encoding: 'utf8' });
  const inputs = ['--run', path.join(fixtures, 'newman.json'), '--coverage', path.join(fixtures, 'api.coverage.json')];
  try {
    const out = path.join(directory, 'nested', 'run-coverage.json');
    const text = run(...inputs, '--out', out);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^Operations: {3}3\/5 passed/m);
    assert.match(text.stdout, /Run coverage: .*run-coverage\.json/);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), runCoverage(coverage, newman));
    const markdown = run(...inputs, '--format', 'markdown');
    assert.equal(markdown.status, 0, markdown.stderr);
    assert.equal(markdown.stdout, formatRunCoverageMarkdown(runCoverage(coverage, newman)));
    assert.deepEqual(JSON.parse(run(...inputs, '--format', 'json').stdout), runCoverage(coverage, newman));
    // a failed run is reported, not turned into a failed command
    assert.equal(text.status, 0);
    assert.match(run('--run', path.join(fixtures, 'newman.json')).stderr, /--run <newman.json> and --coverage <file> are required/);
    assert.match(run(...inputs, '--format', 'xml').stderr, /--format must be text, markdown or json/);
    assert.match(run(...inputs, '--bail').stderr, /Unknown option\(s\): --bail/);
    assert.match(run('--run', path.join(directory, 'missing.json'), '--coverage', path.join(fixtures, 'api.coverage.json')).stderr, /Newman report file not found/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

console.log('run coverage tests passed');
