const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const SwaggerParser = require('@apidevtools/swagger-parser');
const { OpenApiPostmanGenerator } = require('../dist/generator');
const { runCollection } = require('../dist/runner');
const { runCoverage } = require('../dist/run-coverage');

const fixtures = path.join(__dirname, '..', 'fixtures', 'run-coverage');

/**
 * Generates the tests of fixtures/run-coverage/openapi.yaml, runs them in Newman against a local server
 * and joins the report with the coverage: the shape of a real Newman report is what the join relies on.
 * `node test/e2e-run-coverage.js --record` also writes the trimmed report and the coverage that
 * test/run-coverage.js reads.
 */
async function main() {
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const reply = (status, value) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(value === undefined ? '' : JSON.stringify(value));
      };
      if (request.method === 'GET' && request.url === '/health') return reply(200, { up: true });
      if (request.method === 'GET' && request.url === '/pets') return reply(200, []);
      if (request.method === 'POST' && request.url === '/pets') {
        let pet = {};
        try { pet = JSON.parse(body); } catch { /* an empty body is invalid too */ }
        return typeof pet.name === 'string' ? reply(201, { id: 1 }) : reply(400, { error: 'name is required' });
      }
      if (request.method === 'GET' && request.url === '/pets/1') return reply(200, { id: 1, name: 'Miso' });
      // the document promises 200 here
      if (request.method === 'GET' && request.url === '/stats') return reply(500, { error: 'down' });
      return reply(404, { error: 'not found' });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-run-coverage-'));
  try {
    const spec = await SwaggerParser.validate(path.join(fixtures, 'openapi.yaml'));
    const generator = new OpenApiPostmanGenerator(spec, {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      safeMode: true,
      includeNegative: true,
      setup: [{ name: 'Health check', method: 'GET', url: '/health' }],
    });
    const collectionPath = path.join(temp, 'collection.json');
    fs.writeFileSync(collectionPath, JSON.stringify(generator.generate()));
    const coverage = generator.getCoverage();
    const reportDir = path.join(temp, 'reports');
    const result = await runCollection({ collection: collectionPath, reportDir });
    assert.ok(result.failures > 0, 'the /stats request fails');
    const newman = JSON.parse(fs.readFileSync(path.join(reportDir, 'newman.json'), 'utf8'));

    const report = runCoverage(coverage, newman);
    const results = Object.fromEntries(report.byOperation.map(entry => [entry.operationId, entry.result]));
    assert.deepEqual(results, { createPet: 'passed', listPets: 'passed', getStats: 'failed', getPet: 'passed', deletePet: 'left out' });
    const stats = report.byOperation.find(entry => entry.operationId === 'getStats');
    assert.deepEqual(stats.responses, [{ status: '200', result: 'planned only' }]);
    assert.deepEqual(stats.undocumented, ['500']);
    assert.ok(stats.failures.some(failure => /Status code is successful/.test(failure.check)));
    const create = report.byOperation.find(entry => entry.operationId === 'createPet');
    assert.deepEqual(create.responses, [{ status: '201', result: 'passed' }, { status: '400', result: 'passed' }]);
    assert.deepEqual(report.extra.map(entry => entry.name), ['Health check']);
    assert.equal(report.run.executions, result.requests);

    if (process.argv.includes('--record')) {
      // Only the fields the join reads, so the fixture stays small and readable.
      const trimmed = {
        run: {
          executions: newman.run.executions.map(execution => ({
            cursor: { ref: execution.cursor.ref },
            item: { id: execution.item.id.startsWith('op:') ? execution.item.id : 'random-id-from-newman', name: execution.item.name },
            request: { method: execution.request.method },
            ...(execution.response ? { response: { code: execution.response.code } } : {}),
            assertions: (execution.assertions || []).map(assertion => ({
              assertion: assertion.assertion,
              ...(assertion.error ? { error: { name: assertion.error.name, message: assertion.error.message } } : {}),
            })),
          })),
          failures: newman.run.failures.map(failure => ({
            cursor: { ref: failure.cursor.ref },
            source: { id: failure.source.id, name: failure.source.name },
            error: { name: failure.error.name, message: failure.error.message },
            at: failure.at,
          })),
        },
      };
      fs.writeFileSync(path.join(fixtures, 'newman.json'), `${JSON.stringify(trimmed, null, 2)}\n`);
      fs.writeFileSync(path.join(fixtures, 'api.coverage.json'), `${JSON.stringify(coverage, null, 2)}\n`);
      console.log(`Recorded ${fixtures}`);
    }
    console.log('Run coverage end-to-end test passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
