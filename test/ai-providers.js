const assert = require('node:assert/strict');
const fs = require('node:fs');
const { AiProviderRegistry, buildPlanningPrompt, planWithProviders, validateAgentPlan } = require('../dist/ai');
const { ClaudeProvider, AntigravityProvider, CodexProvider } = require('../dist/providers/cli');
const { CustomCommandProvider } = require('../dist/providers/command');

const spec = {
  openapi: '3.0.3',
  info: { title: 'Provider Test API', version: '1.0.0' },
  paths: { '/users': { get: { operationId: 'listUsers', responses: { 200: { description: 'OK' } } } } },
};
const plan = { operationOrder: ['listUsers'], variableMappings: [], negativeScenarios: [], warnings: [] };
const options = { timeoutMs: 1000, maxOutputBytes: 10000 };

assert.deepEqual(validateAgentPlan(plan), plan);
assert.throws(() => validateAgentPlan({ operationOrder: 'invalid' }));
assert.ok(buildPlanningPrompt(spec).includes('listUsers'));

const noIdSpec = { ...spec, paths: { '/health': { get: { responses: { 200: { description: 'OK' } } } } } };
assert.ok(buildPlanningPrompt(noIdSpec).includes('get /health'));

(async () => {
  const registry = new AiProviderRegistry()
    .register({ name: 'broken', capabilities: { usesApiKey: false, usesLocalLogin: false, structuredOutput: true }, generate: async () => { throw new Error('offline'); } })
    .register({ name: 'working', capabilities: { usesApiKey: false, usesLocalLogin: false, structuredOutput: true }, generate: async () => plan });
  const fallback = await planWithProviders(spec, { provider: 'broken', fallback: ['working'] }, registry);
  assert.equal(fallback.provider, 'working');
  assert.equal(fallback.failedProviders[0].provider, 'broken');

  let request;
  const executor = async value => { request = value; return { stdout: JSON.stringify({ structured_output: plan }), stderr: '' }; };
  assert.deepEqual(await new ClaudeProvider({}, executor).generate({ spec, prompt: 'PROMPT', schema: {} }, options), plan);
  assert.ok(request.args.includes('--permission-mode'));
  assert.ok(request.args.includes('plan'));
  assert.equal(request.command, 'claude');

  assert.deepEqual(await new AntigravityProvider({}, executor).generate({ spec, prompt: 'PROMPT', schema: {} }, options), plan);
  assert.equal(request.command, 'agy');
  assert.ok(request.args.includes('--json-schema'));

  const codexExecutor = async value => {
    request = value;
    fs.writeFileSync(value.args[value.args.indexOf('--output-last-message') + 1], JSON.stringify(plan));
    return { stdout: '', stderr: '' };
  };
  assert.deepEqual(await new CodexProvider({}, codexExecutor).generate({ spec, prompt: 'PROMPT', schema: {} }, options), plan);
  assert.equal(request.stdin, 'PROMPT');
  assert.ok(request.args.includes('read-only'));

  const custom = new CustomCommandProvider('local-agent', { command: 'agent', args: ['--schema', '{schema}'] }, executor);
  assert.deepEqual(await custom.generate({ spec, prompt: 'PROMPT', schema: { type: 'object' } }, options), plan);
  assert.equal(request.command, 'agent');
  assert.equal(request.stdin, 'PROMPT');

  console.log('AI provider tests passed');
})().catch(error => { console.error(error); process.exit(1); });
