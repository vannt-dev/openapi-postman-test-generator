import fs from 'fs';
import os from 'os';
import path from 'path';
import { AiProvider, PlanningInput, PlanningOptions, ProviderCapabilities } from '../ai-contract';
import { AiProviderConfig } from '../types';
import { CommandExecutor, defaultCommandExecutor, parseJson, unwrapStructuredOutput } from './command';

abstract class CliProvider implements AiProvider {
  readonly capabilities: ProviderCapabilities = { usesApiKey: false, usesLocalLogin: true, structuredOutput: true };
  abstract readonly name: string;
  constructor(protected readonly config: AiProviderConfig = {}, protected readonly executor: CommandExecutor = defaultCommandExecutor) {}
  abstract generate(input: PlanningInput, options: PlanningOptions): Promise<unknown>;
  protected settings(options: PlanningOptions): { timeoutMs: number; maxOutputBytes: number; model?: string } {
    return {
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      model: options.model || this.config.model,
    };
  }
}

export class CodexProvider extends CliProvider {
  readonly name = 'codex';
  async generate(input: PlanningInput, options: PlanningOptions): Promise<unknown> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-codex-'));
    const schemaPath = path.join(directory, 'schema.json');
    const outputPath = path.join(directory, 'result.json');
    try {
      fs.writeFileSync(schemaPath, JSON.stringify(input.schema), 'utf8');
      const settings = this.settings(options);
      const args = ['exec', '--sandbox', 'read-only', '--output-schema', schemaPath, '--output-last-message', outputPath];
      if (settings.model) args.push('--model', settings.model);
      args.push('-');
      const result = await this.executor({
        command: this.config.command || 'codex', args, stdin: input.prompt,
        timeoutMs: settings.timeoutMs, maxOutputBytes: settings.maxOutputBytes,
      });
      const raw = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : result.stdout;
      return unwrapStructuredOutput(parseJson(raw));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

export class ClaudeProvider extends CliProvider {
  readonly name = 'claude';
  async generate(input: PlanningInput, options: PlanningOptions): Promise<unknown> {
    const settings = this.settings(options);
    const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(input.schema), '--permission-mode', 'plan', '--no-session-persistence'];
    if (settings.model) args.push('--model', settings.model);
    args.push(input.prompt);
    const result = await this.executor({ command: this.config.command || 'claude', args, timeoutMs: settings.timeoutMs, maxOutputBytes: settings.maxOutputBytes });
    return unwrapStructuredOutput(parseJson(result.stdout));
  }
}

export class AntigravityProvider extends CliProvider {
  readonly name = 'antigravity';
  async generate(input: PlanningInput, options: PlanningOptions): Promise<unknown> {
    const settings = this.settings(options);
    const args = ['-p', input.prompt, '--output-format', 'json', '--json-schema', JSON.stringify(input.schema)];
    if (settings.model) args.push('--model', settings.model);
    const result = await this.executor({ command: this.config.command || 'agy', args, timeoutMs: settings.timeoutMs, maxOutputBytes: settings.maxOutputBytes });
    return unwrapStructuredOutput(parseJson(result.stdout));
  }
}
