import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveWindowsCommand } from './providers/command';

export interface RunOptions {
  collection: string;
  environment?: string;
  iterationData?: string;
  timeoutMs?: number;
  reportDir: string;
  bail?: boolean;
  executable?: string;
  executableArgsPrefix?: string[];
}

export interface RunResult { failures: number; assertions: number; requests: number }

interface NewmanStat { total?: number; failed?: number; pending?: number }
interface NewmanJsonReport {
  run?: {
    stats?: Record<string, NewmanStat>;
    failures?: Array<{ source?: { name?: string }; error?: { message?: string } | string }>;
    executions?: Array<{
      item?: { name?: string };
      request?: { method?: string };
      response?: { code?: number; responseTime?: number };
      assertions?: Array<{ assertion?: string; error?: unknown }>;
    }>;
  };
}

export function runCollection(options: RunOptions): Promise<RunResult> {
  const collectionPath = path.resolve(options.collection);
  if (!fs.existsSync(collectionPath)) throw new Error(`Collection file not found: ${collectionPath}`);
  if (options.environment && !fs.existsSync(path.resolve(options.environment))) throw new Error(`Environment file not found: ${path.resolve(options.environment)}`);
  if (options.iterationData && !fs.existsSync(path.resolve(options.iterationData))) throw new Error(`Iteration data file not found: ${path.resolve(options.iterationData)}`);
  const reportDir = path.resolve(options.reportDir);
  fs.mkdirSync(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, 'newman.json');
  const junitPath = path.join(reportDir, 'junit.xml');
  for (const stale of [jsonPath, junitPath, path.join(reportDir, 'report.html')]) {
    if (fs.existsSync(stale)) fs.rmSync(stale, { force: true });
  }
  const rawArgs = [
    ...(options.executableArgsPrefix || []),
    'run', collectionPath,
    '--reporters', 'cli,json,junit',
    '--reporter-json-export', jsonPath,
    '--reporter-junit-export', junitPath,
  ];
  if (options.environment) rawArgs.push('--environment', path.resolve(options.environment));
  if (options.iterationData) rawArgs.push('--iteration-data', path.resolve(options.iterationData));
  if (options.bail) rawArgs.push('--bail');
  // execFile() cannot launch a .cmd/.bat file directly on Windows without `shell: true`;
  // resolve it the same safe way the AI CLI providers do instead of shelling out.
  const { command: executable, args } = resolveWindowsCommand(options.executable || 'newman', rawArgs);
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, {
      windowsHide: true,
      timeout: options.timeoutMs || 300_000,
      maxBuffer: 16 * 1024 * 1024,
    }, error => {
      if (!fs.existsSync(jsonPath)) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
          return reject(new Error('Newman is not installed or is not available on PATH. Install it with: npm install --global newman'));
        }
        return reject(error || new Error('Newman did not produce a JSON report'));
      }
      try {
        const result = processNewmanReport(jsonPath, reportDir);
        if (error && result.failures === 0) return reject(error);
        resolve(result);
      } catch (reportError) { reject(reportError); }
    });
    // npm PowerShell shims inspect stdin and wait forever when the pipe remains
    // open, even though Newman itself does not consume input.
    child.stdin?.end();
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
  });
}

export function processNewmanReport(jsonPath: string, reportDir: string): RunResult {
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as NewmanJsonReport;
  const failures = report.run?.failures || [];
  const stats = report.run?.stats || {};
  const executions = report.run?.executions || [];
  if (!report.run) throw new Error(`Invalid Newman JSON report: ${jsonPath}`);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'report.html'), renderHtmlReport(stats, failures, executions), 'utf8');
  return {
    failures: failures.length,
    assertions: stats.assertions?.total || 0,
    requests: stats.requests?.total || 0,
  };
}

function renderHtmlReport(
  stats: Record<string, NewmanStat>,
  failures: NonNullable<NewmanJsonReport['run']>['failures'] = [],
  executions: NonNullable<NonNullable<NewmanJsonReport['run']>['executions']> = [],
): string {
  const rows = Object.entries(stats).map(([name, stat]) =>
    `<tr><td>${escapeHtml(name)}</td><td>${stat.total || 0}</td><td>${stat.failed || 0}</td><td>${stat.pending || 0}</td></tr>`,
  ).join('');
  const failureRows = failures.map(failure => {
    const message = typeof failure.error === 'string' ? failure.error : failure.error?.message || 'Unknown error';
    return `<li><strong>${escapeHtml(failure.source?.name || 'Unknown')}</strong>: ${escapeHtml(message)}</li>`;
  }).join('') || '<li>None</li>';
  const executionRows = executions.map(execution => {
    const assertions = execution.assertions || [];
    const failed = assertions.filter(assertion => assertion.error).length;
    return `<tr><td>${escapeHtml(execution.item?.name || 'Unknown')}</td><td>${escapeHtml(execution.request?.method || '')}</td><td>${execution.response?.code ?? ''}</td><td>${execution.response?.responseTime ?? ''}</td><td class="${failed ? 'fail' : 'ok'}">${failed}/${assertions.length}</td></tr>`;
  }).join('') || '<tr><td colspan="5">No execution details available</td></tr>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>API test report</title><style>body{font:16px system-ui;max-width:960px;margin:40px auto;padding:0 20px;color:#182230}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:9px;text-align:left}th{background:#f6f8fa}.ok{color:#08783e}.fail{color:#b42318}</style></head><body><h1>API test report</h1><p class="${failures.length ? 'fail' : 'ok'}">${failures.length ? `${failures.length} failure(s)` : 'All checks passed'}</p><h2>Statistics</h2><table><thead><tr><th>Metric</th><th>Total</th><th>Failed</th><th>Pending</th></tr></thead><tbody>${rows}</tbody></table><h2>Requests</h2><table><thead><tr><th>Name</th><th>Method</th><th>Status</th><th>Time (ms)</th><th>Failed assertions</th></tr></thead><tbody>${executionRows}</tbody></table><h2>Failures</h2><ul>${failureRows}</ul></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}
