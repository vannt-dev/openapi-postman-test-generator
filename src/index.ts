#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { planWithProviders } from './ai';
import { loadProjectConfig } from './config';
import { diffSpecs, formatSpecDiff } from './diff';
import { toBrunoCollection } from './exporters/bruno';
import { toK6Script } from './exporters/k6';
import { OpenApiPostmanGenerator } from './generator';
import { runCollection } from './runner';
import { AgentPlan, OpenApiSpec, PostmanCollection, PostmanEnvironment, PostmanItem, ProjectConfig } from './types';

type Flags = Record<string, string | boolean | string[]>;

const BOOLEAN_FLAGS = new Set(['negative', 'safe', 'ai', 'run', 'bail', 'help', 'allow-breaking']);
const REPEATABLE_FLAGS = new Set(['env-var']);
const GENERATE_FLAGS = new Set(['spec', 'out', 'env', 'config', 'profile', 'base-url', 'response-time', 'negative', 'safe', 'ai', 'ai-provider', 'ai-fallback', 'ai-timeout', 'ai-max-output', 'model', 'plan-out', 'run', 'report-dir', 'iteration-data', 'run-timeout', 'bail', 'env-var', 'bruno', 'k6']);
const CONVERT_FLAGS = new Set(['collection', 'environment', 'bruno', 'k6']);
const DIFF_FLAGS = new Set(['old', 'new', 'format', 'allow-breaking']);
const RUN_FLAGS = new Set(['collection', 'environment', 'report-dir', 'iteration-data', 'run-timeout', 'bail', 'env-var']);

function printUsage(exitCode = 1): never {
  console.error(`OpenAPI Postman Test Generator

Usage:
  openapi-postman generate --spec <file-or-url> [options]
  openapi-postman run --collection <file> [options]
  openapi-postman diff --old <file-or-url> --new <file-or-url> [options]
  openapi-postman convert --collection <file> [--environment <file>] --bruno <dir> | --k6 <file>

Generate options:
  --out <file>             Collection output (default: generated/api.collection.json)
  --env <file>             Environment output (default: generated/api.environment.json)
  --config <file>          YAML/JSON project configuration
  --profile <name>         Apply a named environment profile from the config
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
  --bruno <directory>      Also write the tests as a Bruno collection folder
  --k6 <file>              Also write the tests as a k6 script

Run options:
  --environment <file>     Postman environment file
  --iteration-data <file>  JSON or CSV data file for data-driven runs
  --run-timeout <ms>       Maximum total Newman runtime (default: 300000)
  --report-dir <directory> Report output directory (default: generated/reports)
  --bail                   Stop after the first failure
  --env-var <key=value>    Runtime variable such as an OTP (repeatable)

Convert options (a generated collection to another tool's format):
  --collection <file>      Postman collection written by generate
  --environment <file>     Postman environment written by generate
  --bruno <directory>      Bruno collection folder to write
  --k6 <file>              k6 script to write

Diff options:
  --format <text|json>     Output format (default: text)
  --allow-breaking         Exit 0 even when breaking changes are found`);
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
    if (!next || next.startsWith('--')) throw new Error(`--${key} requires a value`);
    else if (REPEATABLE_FLAGS.has(key)) { flags[key] = [...(flags[key] as string[] | undefined || []), next]; index++; }
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

function envVarsFlag(flags: Flags): Record<string, string> | undefined {
  const values = flags['env-var'];
  if (!Array.isArray(values)) return undefined;
  return Object.fromEntries(values.map(value => {
    const separator = value.indexOf('=');
    if (separator <= 0) throw new Error(`--env-var must be KEY=VALUE: ${value}`);
    return [value.slice(0, separator), value.slice(separator + 1)];
  }));
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
  if (flags['env-var'] !== undefined && !flags.run) throw new Error('--env-var requires --run when generating');
  envVarsFlag(flags);
  const config = loadProjectConfig(stringFlag(flags, 'config'));
  const profileName = stringFlag(flags, 'profile');
  const profile = profileName ? config.profiles?.[profileName] : undefined;
  if (profileName && !profile) throw new Error(`Unknown config profile: ${profileName}`);
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
    baseUrl: stringFlag(flags, 'base-url') || profile?.baseUrl || config.baseUrl,
    responseTimeMs: numberFlag(flags, 'response-time') || config.responseTimeMs,
    safeMode: Boolean(flags.safe) || config.safeMode,
    includeNegative: Boolean(flags.negative) || config.includeNegative || Boolean(agentPlan?.negativeScenarios.length),
    variables: { ...(config.variables || {}), ...(profile?.variables || {}) },
    operationOrder: agentPlan?.operationOrder || config.operationOrder,
    variableMappings: agentPlan?.variableMappings || config.variableMappings,
    negativeScenarios: agentPlan?.negativeScenarios || config.negativeScenarios,
  };
  const generator = new OpenApiPostmanGenerator(spec, merged);
  const collection = generator.generate();
  const environment = generator.generateEnvironment(profile?.environmentName);
  const collectionPath = path.resolve(stringFlag(flags, 'out') || 'generated/api.collection.json');
  const environmentPath = path.resolve(stringFlag(flags, 'env') || 'generated/api.environment.json');
  fs.mkdirSync(path.dirname(collectionPath), { recursive: true });
  fs.mkdirSync(path.dirname(environmentPath), { recursive: true });
  fs.writeFileSync(collectionPath, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');
  fs.writeFileSync(environmentPath, `${JSON.stringify(environment, null, 2)}\n`, 'utf8');
  console.log(`Generated ${countRequests(collection.item)} requests`);
  console.log(`Collection:   ${collectionPath}`);
  console.log(`Environment:  ${environmentPath}`);
  writeOtherFormats(flags, collection, environment);
  for (const warning of [...(agentPlan?.warnings || []), ...generator.getWarnings()]) console.warn(`Warning: ${warning}`);
  return { collection: collectionPath, environment: environmentPath };
}

/** Writes the Bruno folder and the k6 script when their flags are given. */
function writeOtherFormats(flags: Flags, collection: PostmanCollection, environment?: PostmanEnvironment): void {
  const brunoDirectory = stringFlag(flags, 'bruno');
  if (brunoDirectory) {
    const directory = path.resolve(brunoDirectory);
    const files = toBrunoCollection(collection, environment);
    for (const file of files) {
      const target = path.join(directory, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content, 'utf8');
    }
    console.log(`Bruno:        ${directory} (${files.length} files)`);
  }
  const k6File = stringFlag(flags, 'k6');
  if (k6File) {
    const target = path.resolve(k6File);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, toK6Script(collection, environment, { fileName: path.basename(target) }), 'utf8');
    console.log(`k6:           ${target}`);
  }
}

function readJsonFile<T>(file: string, label: string): T {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`${label} file not found: ${resolved}`);
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8')) as T;
  } catch (error) {
    // The ES2020 library has no `cause` option on the Error constructor.
    const failure: Error & { cause?: unknown } = new Error(`${label} file is not valid JSON: ${resolved} (${error instanceof Error ? error.message : String(error)})`);
    failure.cause = error;
    throw failure;
  }
}

function convert(flags: Flags): void {
  validateFlags(flags, CONVERT_FLAGS);
  const collectionFile = stringFlag(flags, 'collection');
  if (!collectionFile) throw new Error('--collection is required');
  if (!stringFlag(flags, 'bruno') && !stringFlag(flags, 'k6')) throw new Error('Give --bruno <directory>, --k6 <file>, or both');
  const collection = readJsonFile<PostmanCollection>(collectionFile, 'Collection');
  if (!Array.isArray(collection.item) || !collection.info?.name) throw new Error(`Not a Postman collection: ${path.resolve(collectionFile)}`);
  const environmentFile = stringFlag(flags, 'environment');
  const environment = environmentFile ? readJsonFile<PostmanEnvironment>(environmentFile, 'Environment') : undefined;
  writeOtherFormats(flags, collection, environment);
}

async function run(flags: Flags): Promise<void> {
  validateFlags(flags, RUN_FLAGS);
  const collection = stringFlag(flags, 'collection');
  if (!collection) throw new Error('--collection is required');
  const result = await runCollection({
    collection,
    environment: stringFlag(flags, 'environment'),
    reportDir: stringFlag(flags, 'report-dir') || 'generated/reports',
    iterationData: stringFlag(flags, 'iteration-data'),
    timeoutMs: numberFlag(flags, 'run-timeout'),
    bail: Boolean(flags.bail),
    envVars: envVarsFlag(flags),
  });
  console.log(`Completed ${result.requests} requests and ${result.assertions} assertions with ${result.failures} failure(s)`);
  if (result.failures) process.exitCode = 1;
}

async function diff(flags: Flags): Promise<void> {
  validateFlags(flags, DIFF_FLAGS);
  const oldLocation = stringFlag(flags, 'old');
  const newLocation = stringFlag(flags, 'new');
  if (!oldLocation || !newLocation) throw new Error('--old and --new are required');
  const format = stringFlag(flags, 'format') || 'text';
  if (format !== 'text' && format !== 'json') throw new Error('--format must be text or json');
  // Two parser instances: one shared instance keeps the first document's references.
  const oldSpec = await new SwaggerParser().validate(oldLocation);
  const newSpec = await new SwaggerParser().validate(newLocation);
  const result = diffSpecs(oldSpec, newSpec);
  console.log(format === 'json' ? JSON.stringify(result, null, 2) : formatSpecDiff(result));
  // A non-zero exit lets a pipeline stop a release that would break clients.
  if (result.breaking && !flags['allow-breaking']) process.exitCode = 1;
}

function countRequests(items: PostmanItem[]): number {
  return items.reduce((total, item) => total + (item.request ? 1 : 0) + (item.item ? countRequests(item.item) : 0), 0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length) return printUsage();
  if (args.includes('--help') || args.includes('-h')) return printUsage(0);
  const explicitCommand = ['generate', 'run', 'diff', 'convert'].includes(args[0]);
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
  if (command === 'diff') return diff(flags);
  if (command === 'convert') return convert(flags);
  const generated = await generate(flags);
  if (flags.run) await run({
    collection: generated.collection,
    environment: generated.environment,
    'report-dir': stringFlag(flags, 'report-dir') || 'generated/reports',
    ...(stringFlag(flags, 'iteration-data') ? { 'iteration-data': stringFlag(flags, 'iteration-data')! } : {}),
    ...(stringFlag(flags, 'run-timeout') ? { 'run-timeout': stringFlag(flags, 'run-timeout')! } : {}),
    bail: Boolean(flags.bail),
    ...(Array.isArray(flags['env-var']) ? { 'env-var': flags['env-var'] } : {}),
  });
}

main().catch(error => { console.error(`Error: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
