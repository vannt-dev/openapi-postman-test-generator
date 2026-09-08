#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { planWithProviders } from './ai';
import { loadProjectConfig } from './config';
import { OpenApiPostmanGenerator } from './generator';
import { runCollection } from './runner';
import { AgentPlan, OpenApiSpec, PostmanItem, ProjectConfig } from './types';

type Flags = Record<string, string | boolean>;

const BOOLEAN_FLAGS = new Set(['negative', 'safe', 'ai', 'run', 'bail', 'help']);
const GENERATE_FLAGS = new Set(['spec', 'out', 'env', 'config', 'base-url', 'response-time', 'negative', 'safe', 'ai', 'ai-provider', 'ai-fallback', 'ai-timeout', 'ai-max-output', 'model', 'plan-out', 'run', 'report-dir']);
const RUN_FLAGS = new Set(['collection', 'environment', 'report-dir', 'bail']);

function printUsage(exitCode = 1): never {
  console.error(`OpenAPI Postman Test Generator

Usage:
  openapi-postman generate --spec <file-or-url> [options]
  openapi-postman run --collection <file> [options]

Generate options:
  --out <file>             Collection output (default: generated/api.collection.json)
  --env <file>             Environment output (default: generated/api.environment.json)
  --config <file>          YAML/JSON project configuration
  --base-url <url>         Override the server URL
  --response-time <ms>     Response-time assertion threshold
  --negative               Generate negative test variants
  --safe                   Skip DELETE operations
  --ai                     Use an AI provider to plan workflows and variable mappings
  --ai-provider <name>     Provider: openai, codex, claude, antigravity, or configured command
  --ai-fallback <names>    Comma-separated fallback providers
  --ai-timeout <ms>        Timeout for each provider (default: 120000)
  --ai-max-output <bytes>  Maximum provider output (default: 1048576)
  --model <model>          Optional provider-specific model override
  --plan-out <file>        Save the structured AI plan
  --run                    Run the generated collection immediately

Run options:
  --environment <file>     Postman environment file
  --report-dir <directory> Report output directory (default: generated/reports)
  --bail                   Stop after the first failure`);
  process.exit(exitCode);
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) { flags[key] = true; continue; }
    const next = args[index + 1];
    if (!next || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; index++; }
  }
  return flags;
}

function validateFlags(flags: Flags, allowed: Set<string>): void {
  const unknown = Object.keys(flags).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`Unknown option(s): ${unknown.map(key => `--${key}`).join(', ')}`);
}

function stringFlag(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

function numberFlag(flags: Flags, key: string): number | undefined {
  const raw = stringFlag(flags, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${key} must be a positive number`);
  return value;
}

async function generate(flags: Flags): Promise<{ collection: string; environment: string }> {
  validateFlags(flags, GENERATE_FLAGS);
  const specLocation = stringFlag(flags, 'spec');
  if (!specLocation) throw new Error('--spec is required');
  const config = loadProjectConfig(stringFlag(flags, 'config'));
  const spec = await SwaggerParser.validate(specLocation) as unknown as OpenApiSpec;
  let agentPlan: AgentPlan | undefined;
  if (flags.ai) {
    const aiConfig = config.ai || {};
    const provider = stringFlag(flags, 'ai-provider') || aiConfig.provider || 'openai';
    const fallback = stringFlag(flags, 'ai-fallback')?.split(',').map(value => value.trim()).filter(Boolean) || aiConfig.fallback;
    const result = await planWithProviders(spec, {
      provider,
      fallback,
      model: stringFlag(flags, 'model') || aiConfig.model || process.env.AI_MODEL || process.env.OPENAI_MODEL,
      timeoutMs: numberFlag(flags, 'ai-timeout') || aiConfig.timeoutMs,
      maxOutputBytes: numberFlag(flags, 'ai-max-output') || aiConfig.maxOutputBytes,
      providers: aiConfig.providers,
    });
    agentPlan = result.plan;
    const planPath = path.resolve(stringFlag(flags, 'plan-out') || 'generated/agent-plan.json');
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, `${JSON.stringify(agentPlan, null, 2)}\n`, 'utf8');
    console.log(`AI provider:  ${result.provider}`);
    console.log(`AI plan:      ${planPath}`);
    for (const failure of result.failedProviders) console.warn(`Warning: AI provider ${failure.provider} failed: ${failure.error}`);
  }
  const merged: ProjectConfig = {
    ...config,
    baseUrl: stringFlag(flags, 'base-url') || config.baseUrl,
    responseTimeMs: numberFlag(flags, 'response-time') || config.responseTimeMs,
    safeMode: Boolean(flags.safe) || config.safeMode,
    includeNegative: Boolean(flags.negative) || config.includeNegative || Boolean(agentPlan?.negativeScenarios.length),
    operationOrder: agentPlan?.operationOrder || config.operationOrder,
    variableMappings: agentPlan?.variableMappings || config.variableMappings,
  };
  const generator = new OpenApiPostmanGenerator(spec, merged);
  const collection = generator.generate();
  const environment = generator.generateEnvironment();
  const collectionPath = path.resolve(stringFlag(flags, 'out') || 'generated/api.collection.json');
  const environmentPath = path.resolve(stringFlag(flags, 'env') || 'generated/api.environment.json');
  fs.mkdirSync(path.dirname(collectionPath), { recursive: true });
  fs.mkdirSync(path.dirname(environmentPath), { recursive: true });
  fs.writeFileSync(collectionPath, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');
  fs.writeFileSync(environmentPath, `${JSON.stringify(environment, null, 2)}\n`, 'utf8');
  console.log(`Generated ${countRequests(collection.item)} requests`);
  console.log(`Collection:   ${collectionPath}`);
  console.log(`Environment:  ${environmentPath}`);
  for (const warning of [...(agentPlan?.warnings || []), ...generator.getWarnings()]) console.warn(`Warning: ${warning}`);
  return { collection: collectionPath, environment: environmentPath };
}

async function run(flags: Flags): Promise<void> {
  validateFlags(flags, RUN_FLAGS);
  const collection = stringFlag(flags, 'collection');
  if (!collection) throw new Error('--collection is required');
  const result = await runCollection({
    collection,
    environment: stringFlag(flags, 'environment'),
    reportDir: stringFlag(flags, 'report-dir') || 'generated/reports',
    bail: Boolean(flags.bail),
  });
  console.log(`Completed ${result.requests} requests and ${result.assertions} assertions with ${result.failures} failure(s)`);
  if (result.failures) process.exitCode = 1;
}

function countRequests(items: PostmanItem[]): number {
  return items.reduce((total, item) => total + (item.request ? 1 : 0) + (item.item ? countRequests(item.item) : 0), 0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length) return printUsage();
  if (args.includes('--help') || args.includes('-h')) return printUsage(0);
  const explicitCommand = ['generate', 'run'].includes(args[0]);
  const command = explicitCommand ? args.shift()! : 'generate';
  // Preserve compatibility with the original positional syntax.
  if (!explicitCommand && args[0] && !args[0].startsWith('--')) {
    const spec = args.shift()!;
    const out = args[0] && !args[0].startsWith('--') ? args.shift()! : undefined;
    args.unshift('--spec', spec);
    if (out) args.push('--out', out);
  }
  const flags = parseFlags(args);
  if (command === 'run') return run(flags);
  const generated = await generate(flags);
  if (flags.run) await run({ collection: generated.collection, environment: generated.environment, 'report-dir': stringFlag(flags, 'report-dir') || 'generated/reports' });
}

main().catch(error => { console.error(`Error: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
