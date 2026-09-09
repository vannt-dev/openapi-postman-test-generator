const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveWindowsCommand } = require('../dist/providers/command');

if (process.platform !== 'win32') {
  console.log('Windows command resolution test skipped (not running on win32)');
  process.exit(0);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-wincmd-'));
const originalPath = process.env.Path || process.env.PATH || '';
process.env.Path = `${tempDir}${path.delimiter}${originalPath}`;

try {
  // An explicit .cmd wrapper with no PowerShell sibling cannot be launched without a shell.
  const cmdPath = path.join(tempDir, 'mytool.cmd');
  fs.writeFileSync(cmdPath, '');
  assert.throws(
    () => resolveWindowsCommand(cmdPath, ['a']),
    /Cannot safely launch Windows command wrapper without a shell/,
  );

  // A PowerShell sibling next to the .cmd makes it launchable via powershell.exe -File.
  const ps1Path = path.join(tempDir, 'mytool.ps1');
  fs.writeFileSync(ps1Path, '');
  const wrapped = resolveWindowsCommand(cmdPath, ['a']);
  assert.equal(wrapped.command, 'powershell.exe');
  assert.deepEqual(wrapped.args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1Path, 'a']);

  // Newman npm shims resolve directly to their JavaScript entrypoint, allowing
  // reliable timeouts without leaving a child process behind.
  const newmanShim = path.join(tempDir, 'newman.ps1');
  const newmanScript = path.join(tempDir, 'node_modules', 'newman', 'bin', 'newman.js');
  fs.mkdirSync(path.dirname(newmanScript), { recursive: true });
  fs.writeFileSync(newmanShim, '');
  fs.writeFileSync(newmanScript, '');
  const newman = resolveWindowsCommand('newman', ['run', 'collection.json']);
  assert.equal(newman.command, process.execPath);
  assert.deepEqual(newman.args, [newmanScript, 'run', 'collection.json']);

  // A bare command name is resolved from PATH and, once it's a plain .exe, launched directly.
  const exePath = path.join(tempDir, 'mytool2.exe');
  fs.writeFileSync(exePath, '');
  const direct = resolveWindowsCommand('mytool2', ['x']);
  assert.equal(direct.command, exePath);
  assert.deepEqual(direct.args, ['x']);

  // An explicit absolute path bypasses PATH search entirely.
  const explicit = resolveWindowsCommand('C:\\tools\\thing.exe', ['y']);
  assert.equal(explicit.command, 'C:\\tools\\thing.exe');
  assert.deepEqual(explicit.args, ['y']);

  console.log('Windows command resolution tests passed');
} finally {
  process.env.Path = originalPath;
  fs.rmSync(tempDir, { recursive: true, force: true });
}
