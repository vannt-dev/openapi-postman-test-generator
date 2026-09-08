import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveWindowsCommand } from './providers/command';

export interface RunOptions {
  collection: string;
  environment?: string;
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
  };
}

export function runCollection(options: RunOptions): Promise<RunResult> {
  const reportDir = path.resolve(options.reportDir);
  fs.mkdirSync(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, 'newman.json');
  const junitPath = path.join(reportDir, 'junit.xml');
  const rawArgs = [
    ...(options.executableArgsPrefix || []),
    'run', path.resolve(options.collection),
    '--reporters', 'cli,json,junit',
    '--reporter-json-export', jsonPath,
    '--reporter-junit-export', junitPath,
  ];
  if (options.environment) rawArgs.push('--environment', path.resolve(options.environment));
  if (options.bail) rawArgs.push('--bail');
  // execFile() cannot launch a .cmd/.bat file directly on Windows without `shell: true`;
  // resolve it the same safe way the AI CLI providers do instead of shelling out.
  const { command: executable, args } = resolveWindowsCommand(options.executable || 'newman', rawArgs);
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, { windowsHide: true }, error => {
      if (!fs.existsSync(jsonPath)) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
          return reject(new Error('Newman is not installed or is not available on PATH. Install it with: npm install --global newman'));
        }
        return reject(error || new Error('Newman did not produce a JSON report'));
      }
      try {
        resolve(processNewmanReport(jsonPath, reportDir));
      } catch (reportError) { reject(reportError); }
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
  });
}

export function processNewmanReport(jsonPath: string, reportDir: string): RunResult {
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as NewmanJsonReport;
  const failures = report.run?.failures || [];
  const stats = report.run?.stats || {};
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'report.html'), renderHtmlReport(stats, failures), 'utf8');
  return {
    failures: failures.length,
    assertions: stats.assertions?.total || 0,
    requests: stats.requests?.total || 0,
  };
}

function renderHtmlReport(stats: Record<string, NewmanStat>, failures: NonNullable<NewmanJsonReport['run']>['failures'] = []): string {
  const rows = Object.entries(stats).map(([name, stat]) =>
    `<tr><td>${escapeHtml(name)}</td><td>${stat.total || 0}</td><td>${stat.failed || 0}</td><td>${stat.pending || 0}</td></tr>`,
  ).join('');
  const failureRows = failures.map(failure => {
    const message = typeof failure.error === 'string' ? failure.error : failure.error?.message || 'Unknown error';
    return `<li><strong>${escapeHtml(failure.source?.name || 'Unknown')}</strong>: ${escapeHtml(message)}</li>`;
  }).join('') || '<li>None</li>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>API test report</title><style>body{font:16px system-ui;max-width:960px;margin:40px auto;padding:0 20px;color:#182230}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:9px;text-align:left}th{background:#f6f8fa}.ok{color:#08783e}.fail{color:#b42318}</style></head><body><h1>API test report</h1><p class="${failures.length ? 'fail' : 'ok'}">${failures.length ? `${failures.length} failure(s)` : 'All checks passed'}</p><h2>Statistics</h2><table><thead><tr><th>Metric</th><th>Total</th><th>Failed</th><th>Pending</th></tr></thead><tbody>${rows}</tbody></table><h2>Failures</h2><ul>${failureRows}</ul></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}
