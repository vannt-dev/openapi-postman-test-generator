import * as fs from 'fs';
import * as path from 'path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { OpenApiPostmanGenerator } from './generator';
import { OpenApiSpec, PostmanItem } from './types';

interface CliOptions { spec: string; out: string; env: string; baseUrl?: string; responseTimeMs?: number }

function usage(): never {
  console.error('Usage: swagger-to-postman --spec <openapi.yaml> [--out collection.json] [--env environment.json]');
  console.error('Options: --base-url <url> --response-time <milliseconds>');
  console.error('Legacy:  swagger-to-postman <swagger-file> [collection-file]');
  process.exit(1);
}

function parseArgs(args: string[]): CliOptions {
  if (!args.length) return usage();
  if (!args[0].startsWith('-')) {
    const out = args[1] || 'generated/api.collection.json';
    return { spec: args[0], out, env: path.join(path.dirname(out), 'api.environment.json') };
  }
  const value = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const spec = value('--spec');
  if (!spec) return usage();
  const out = value('--out') || 'generated/api.collection.json';
  const responseTime = value('--response-time');
  return { spec, out, env: value('--env') || path.join(path.dirname(out), 'api.environment.json'), baseUrl: value('--base-url'), responseTimeMs: responseTime ? Number(responseTime) : undefined };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.spec)) throw new Error(`Spec file not found: ${options.spec}`);
  const spec = await SwaggerParser.validate(options.spec) as unknown as OpenApiSpec;
  const generator = new OpenApiPostmanGenerator(spec, { baseUrl: options.baseUrl, responseTimeMs: options.responseTimeMs });
  const collection = generator.generate();
  const environment = generator.generateEnvironment();
  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  fs.mkdirSync(path.dirname(path.resolve(options.env)), { recursive: true });
  fs.writeFileSync(options.out, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');
  fs.writeFileSync(options.env, `${JSON.stringify(environment, null, 2)}\n`, 'utf8');
  console.log(`Generated ${countRequests(collection.item)} requests`);
  console.log(`Collection:  ${path.resolve(options.out)}`);
  console.log(`Environment: ${path.resolve(options.env)}`);
}

function countRequests(items: PostmanItem[]): number { return items.reduce((n, item) => n + (item.request ? 1 : 0) + (item.item ? countRequests(item.item) : 0), 0); }
main().catch(error => { console.error(`Error: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
