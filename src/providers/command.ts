import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AiProvider, PlanningInput, PlanningOptions, ProviderCapabilities } from '../ai-contract';
import { AiProviderConfig } from '../types';

export interface CommandRequest {
  command: string;
  args: string[];
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CommandResult { stdout: string; stderr: string }
export type CommandExecutor = (request: CommandRequest) => Promise<CommandResult>;

export function resolveWindowsCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command, args };
  const extension = path.extname(command).toLowerCase();
  let resolved = command;
  if (!extension && !command.includes('/') && !command.includes('\\')) {
    const directories = (process.env.Path || process.env.PATH || '').split(path.delimiter);
    for (const suffix of ['.exe', '.com', '.ps1', '.cmd', '.bat']) {
      const match = directories.map((directory) => path.join(directory, `${command}${suffix}`)).find(fs.existsSync);
      if (match) { resolved = match; break; }
    }
  }
  const shimDirectory = path.dirname(resolved);
  const shimName = path.basename(resolved, path.extname(resolved)).toLowerCase();
  if (shimName === 'newman') {
    const newmanScript = path.join(shimDirectory, 'node_modules', 'newman', 'bin', 'newman.js');
    if (fs.existsSync(newmanScript)) return { command: process.execPath, args: [newmanScript, ...args] };
  }
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const nativeCandidates = shimName === 'codex' ? [
    path.join(shimDirectory, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', `codex-win32-${architecture}`, 'vendor', `${architecture === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`, 'bin', 'codex.exe'),
  ] : shimName === 'claude' ? [
    path.join(shimDirectory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
  ] : [];
  const nativeExecutable = nativeCandidates.find(fs.existsSync);
  if (nativeExecutable) return { command: nativeExecutable, args };
  const resolvedExtension = path.extname(resolved).toLowerCase();
  if (resolvedExtension === '.cmd' || resolvedExtension === '.bat') {
    const powerShellSibling = resolved.replace(/\.(cmd|bat)$/i, '.ps1');
    if (fs.existsSync(powerShellSibling)) resolved = powerShellSibling;
    else throw new Error(`Cannot safely launch Windows command wrapper without a shell: ${resolved}. Configure an .exe or .ps1 command.`);
  }
  if (path.extname(resolved).toLowerCase() === '.ps1') {
    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args],
    };
  }
  return { command: resolved, args };
}

export const defaultCommandExecutor: CommandExecutor = (request) => new Promise((resolve, reject) => {
  let executable: { command: string; args: string[] };
  try { executable = resolveWindowsCommand(request.command, request.args); }
  catch (error) { reject(error); return; }
  const child = spawn(executable.command, executable.args, {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let settled = false;

  const finish = (error?: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
  };
  const collect = (target: Buffer[]) => (chunk: Buffer): void => {
    outputBytes += chunk.length;
    if (outputBytes > request.maxOutputBytes) {
      child.kill();
      finish(new Error(`AI command exceeded the ${request.maxOutputBytes}-byte output limit.`));
      return;
    }
    target.push(chunk);
  };
  child.stdout.on('data', collect(stdout));
  child.stderr.on('data', collect(stderr));
  child.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') finish(new Error(`AI command not found: ${request.command}`));
    else finish(error);
  });
  child.on('close', (code) => {
    if (code === 0) finish();
    else finish(new Error(`AI command exited with code ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`));
  });
  const timer = setTimeout(() => {
    child.kill();
    finish(new Error(`AI command timed out after ${request.timeoutMs} ms.`));
  }, request.timeoutMs);
  child.stdin.end(request.stdin);
});

export function parseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('AI command returned no output.');
  return JSON.parse(trimmed) as unknown;
}

export function unwrapStructuredOutput(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (record.structured_output !== undefined) return record.structured_output;
  if (record.output_parsed !== undefined) return record.output_parsed;
  for (const key of ['result', 'response']) {
    const nested = record[key];
    if (typeof nested === 'string') {
      try { return parseJson(nested); } catch { continue; }
    }
    if (nested && typeof nested === 'object') return nested;
  }
  return value;
}

export class CustomCommandProvider implements AiProvider {
  readonly capabilities: ProviderCapabilities = { usesApiKey: false, usesLocalLogin: true, structuredOutput: true };

  constructor(
    readonly name: string,
    private readonly config: AiProviderConfig,
    private readonly executor: CommandExecutor = defaultCommandExecutor,
  ) {}

  async generate(input: PlanningInput, options: PlanningOptions): Promise<unknown> {
    if (!this.config.command) throw new Error(`Provider "${this.name}" requires a command.`);
    const schema = JSON.stringify(input.schema);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-postman-command-'));
    const schemaPath = path.join(directory, 'schema.json');
    const outputPath = path.join(directory, 'result.json');
    try {
      fs.writeFileSync(schemaPath, schema, 'utf8');
      const replacements: Record<string, string> = {
        '{prompt}': input.prompt,
        '{schema}': schema,
        '{schemaFile}': schemaPath,
        '{outputFile}': outputPath,
        '{model}': options.model || '',
      };
      const args = (this.config.args || []).map((arg) =>
        Object.entries(replacements).reduce((value, [token, replacement]) => value.split(token).join(replacement), arg),
      );
      if (this.config.input === 'argument' && !args.some((arg) => arg.includes(input.prompt))) args.push(input.prompt);
      const result = await this.executor({
        command: this.config.command,
        args,
        stdin: this.config.input === 'argument' ? undefined : input.prompt,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
      });
      const raw = this.config.output === 'output-file' ? fs.readFileSync(outputPath, 'utf8') : result.stdout;
      return unwrapStructuredOutput(parseJson(raw));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}
