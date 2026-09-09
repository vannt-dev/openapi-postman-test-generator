const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCollection } = require('../dist/runner');

if (process.platform !== 'win32') {
  console.log('Windows runner test skipped (not running on win32)');
  process.exit(0);
}

async function main() {
  // Regression test: execFile() cannot launch a .cmd/.bat file directly on Windows
  // without shell: true, so runCollection() must resolve a real newman shim (the .ps1
  // wrapper npm generates) instead of shelling out to "newman.cmd" blindly.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-runner-win-'));
  const originalPath = process.env.Path || process.env.PATH || '';
  process.env.Path = `${tempDir}${path.delimiter}${originalPath}`;

  const fakeNewman = [
    '$jsonIndex = [Array]::IndexOf($args, "--reporter-json-export")',
    '$junitIndex = [Array]::IndexOf($args, "--reporter-junit-export")',
    '$dataIndex = [Array]::IndexOf($args, "--iteration-data")',
    'if ($dataIndex -lt 0) { exit 4 }',
    '$jsonPath = $args[$jsonIndex + 1]',
    '$junitPath = $args[$junitIndex + 1]',
    '$report = \'{"run":{"stats":{"requests":{"total":1,"failed":0},"assertions":{"total":2,"failed":0}},"failures":[]}}\'',
    '[System.IO.File]::WriteAllText($jsonPath, $report)',
    '[System.IO.File]::WriteAllText($junitPath, \'<?xml version="1.0"?><testsuite tests="2" failures="0"/>\')',
    'exit 0',
  ].join('\r\n');
  fs.writeFileSync(path.join(tempDir, 'newman.ps1'), fakeNewman, 'utf8');

  const collectionPath = path.join(tempDir, 'collection.json');
  fs.writeFileSync(collectionPath, JSON.stringify({ info: { name: 'fake' } }), 'utf8');
  const reportDir = path.join(tempDir, 'reports');
  const dataPath = path.join(tempDir, 'data.json');
  fs.writeFileSync(dataPath, '[]', 'utf8');

  try {
    const result = await runCollection({ collection: collectionPath, reportDir, iterationData: dataPath });
    assert.equal(result.requests, 1);
    assert.equal(result.assertions, 2);
    assert.equal(result.failures, 0);
    assert.ok(fs.existsSync(path.join(reportDir, 'report.html')));

    // A failed invocation must not be mistaken for success because a report from a
    // previous run happens to exist.
    fs.writeFileSync(path.join(tempDir, 'newman.ps1'), 'exit 3\r\n', 'utf8');
    await assert.rejects(() => runCollection({ collection: collectionPath, reportDir }));
    assert.equal(fs.existsSync(path.join(reportDir, 'newman.json')), false);
    console.log('Windows runner integration test passed');
  } finally {
    process.env.Path = originalPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
