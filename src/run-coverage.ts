/**
 * Joins a Newman JSON report with the coverage report of the collection that was run, and says which
 * documented operations and responses the run exercised and whether their checks passed.
 *
 * The join key is the item id the generator writes on every request it makes for an operation
 * (`op:<operationId>`, `op:<operationId>#negative-<n>` for a negative variant, `#example-<name>` for a
 * named request example). Newman copies it into
 * the report, so no URL has to be matched. Requests without such an id (setup and teardown steps, the
 * OAuth2 token request, job polls, anything added by hand) are reported as extra.
 */
import { CoverageReport, CoverageSkipReason } from './types';

const OPERATION_PREFIX = 'op:';
const VARIANT_SUFFIX = /#(?:negative-\d+|example-.+)$/;

/** The item id of the request the generator writes for an operation. */
export function operationItemId(operationId: string): string {
  return `${OPERATION_PREFIX}${operationId}`;
}

/** The item id of the n-th negative variant (from 1) of an operation. */
export function negativeItemId(operationId: string, index: number): string {
  return `${operationItemId(operationId)}#negative-${index}`;
}

/** The item id of the request sent with one named example of the request body. */
export function exampleItemId(operationId: string, exampleName: string): string {
  return `${operationItemId(operationId)}#example-${encodeURIComponent(exampleName)}`;
}

/** The operation a generated item id stands for, or undefined for any other request. */
export function operationIdOfItem(itemId: unknown): string | undefined {
  if (typeof itemId !== 'string' || !itemId.startsWith(OPERATION_PREFIX)) return undefined;
  return itemId.slice(OPERATION_PREFIX.length).replace(VARIANT_SUFFIX, '');
}

/**
 * The documented response a status code falls under: the code itself when the document lists it,
 * else its range (`4XX`) when the document lists that, else undefined.
 */
export function documentedStatus(documented: string[], code: number | string): string | undefined {
  const exact = String(code).toUpperCase();
  if (documented.includes(exact)) return exact;
  const range = `${exact[0]}XX`;
  return documented.includes(range) ? range : undefined;
}

export type OperationRunResult = 'passed' | 'failed' | 'not run' | 'left out';
export type ResponseRunResult = 'passed' | 'failed' | 'planned only' | 'no test';

export interface RunFailure {
  /** The request's name in the collection. */
  request: string;
  /** The failed check, or where a script failed. */
  check: string;
  message: string;
}

export interface RunCoverageOperation {
  operationId: string;
  method: string;
  path: string;
  /**
   * passed: every request sent for it passed its checks; failed: at least one did not; not run: it is in
   * the collection but no request for it was sent; left out: it is not in the collection.
   */
  result: OperationRunResult;
  reason?: CoverageSkipReason;
  /** Requests sent for it, iterations counted. */
  executions: number;
  failedExecutions: number;
  /**
   * Each documented response. passed: received at least once by a request whose checks all passed;
   * failed: received, but only by requests that failed a check; planned only: a request expects it but
   * the run never received it; no test: no request expects it and the run never received it.
   */
  responses: Array<{ status: string; result: ResponseRunResult }>;
  /** Status codes received that the document does not list for the operation. */
  undocumented: string[];
  failures: RunFailure[];
}

export interface RunCoverageExtra {
  name: string;
  method: string;
  executions: number;
  failedExecutions: number;
  /** Status codes received. */
  statuses: string[];
}

export interface RunCoverageReport {
  run: { executions: number; failedExecutions: number };
  operations: { total: number; passed: number; failed: number; notRun: number; leftOut: number };
  /** Documented responses of the operations that are in the collection. */
  responses: { total: number; passed: number; failed: number; plannedOnly: number; noTest: number };
  byOperation: RunCoverageOperation[];
  /** Requests of the run that stand for no documented operation. */
  extra: RunCoverageExtra[];
}

interface NewmanError { name?: string; message?: string; test?: string }
interface NewmanExecution {
  cursor?: { ref?: string };
  item?: { id?: string; name?: string };
  request?: { method?: string };
  response?: { code?: number };
  requestError?: NewmanError | string;
  assertions?: Array<{ assertion?: string; skipped?: boolean; error?: NewmanError }>;
}
interface NewmanFailure { cursor?: { ref?: string }; source?: { id?: string; name?: string }; error?: NewmanError; at?: string }

const messageOf = (error: NewmanError | string | undefined): string =>
  (typeof error === 'string' ? error : error?.message || error?.name || 'failed').replace(/\s+/g, ' ').trim();

/** Builds the run coverage from a coverage report (`generate --coverage`) and a Newman JSON report. */
export function runCoverage(coverage: CoverageReport, newmanReport: unknown): RunCoverageReport {
  if (!coverage || !Array.isArray(coverage.byOperation)) throw new TypeError('Not a coverage report: byOperation is missing');
  const run = (newmanReport as { run?: { executions?: unknown; failures?: unknown } } | null)?.run;
  if (!run || !Array.isArray(run.executions)) throw new TypeError('Not a Newman JSON report: run.executions is missing');
  const executions = run.executions as NewmanExecution[];
  // Script errors that are not assertions (a TypeError in a test script, a failed pre-request script)
  // are only in run.failures; they belong to the execution with the same cursor.
  const scriptFailures = new Map<string, NewmanFailure[]>();
  for (const failure of (Array.isArray(run.failures) ? run.failures : []) as NewmanFailure[]) {
    const ref = failure.cursor?.ref;
    if (!ref || failure.error?.name === 'AssertionError') continue;
    scriptFailures.set(ref, [...(scriptFailures.get(ref) || []), failure]);
  }

  interface Seen { executions: number; failed: number; received: Map<string, boolean>; failures: RunFailure[] }
  const seen = new Map<string, Seen>();
  const extra = new Map<string, RunCoverageExtra>();
  const known = new Set(coverage.byOperation.map(entry => entry.operationId));
  let failedExecutions = 0;
  let counted = 0;
  for (const execution of executions) {
    const request = execution.item?.name || '(unnamed request)';
    const failures: RunFailure[] = [];
    for (const assertion of execution.assertions || []) {
      if (assertion.error && !assertion.skipped) failures.push({ request, check: assertion.assertion || assertion.error.test || 'assertion', message: messageOf(assertion.error) });
    }
    for (const failure of scriptFailures.get(execution.cursor?.ref || '') || []) {
      failures.push({ request, check: failure.at || failure.error?.name || 'script', message: messageOf(failure.error) });
    }
    if (execution.requestError) failures.push({ request, check: 'request', message: messageOf(execution.requestError) });
    const code = execution.response?.code;
    // A request a script skipped was never sent: it exercises nothing.
    if (code === undefined && !failures.length) continue;
    counted++;
    const failed = failures.length > 0;
    if (failed) failedExecutions++;
    const status = code === undefined ? undefined : String(code);
    const operationId = operationIdOfItem(execution.item?.id);
    if (operationId === undefined || !known.has(operationId)) {
      const method = (execution.request?.method || '').toUpperCase();
      const key = `${method} ${request}`;
      const entry = extra.get(key) || { name: request, method, executions: 0, failedExecutions: 0, statuses: [] };
      entry.executions++;
      if (failed) entry.failedExecutions++;
      if (status && !entry.statuses.includes(status)) entry.statuses.push(status);
      extra.set(key, entry);
      continue;
    }
    const entry = seen.get(operationId) || { executions: 0, failed: 0, received: new Map<string, boolean>(), failures: [] };
    entry.executions++;
    if (failed) entry.failed++;
    // a status code counts as passed once any request that received it passed every check
    if (status) entry.received.set(status, (entry.received.get(status) || false) || !failed);
    entry.failures.push(...failures);
    seen.set(operationId, entry);
  }

  const byOperation: RunCoverageOperation[] = coverage.byOperation.map(operation => {
    const entry = seen.get(operation.operationId);
    const received = new Map<string, boolean>();
    const undocumented: string[] = [];
    for (const [code, passed] of entry?.received || []) {
      const status = documentedStatus(operation.documented, code);
      if (!status) { undocumented.push(code); continue; }
      received.set(status, (received.get(status) || false) || passed);
    }
    const responses = operation.documented.map(status => ({
      status,
      result: (received.has(status) ? (received.get(status) ? 'passed' : 'failed')
        : operation.covered.includes(status) ? 'planned only' : 'no test') as ResponseRunResult,
    }));
    const result: OperationRunResult = !operation.included && !entry ? 'left out'
      : !entry ? 'not run' : entry.failed ? 'failed' : 'passed';
    return {
      operationId: operation.operationId, method: operation.method, path: operation.path, result,
      ...(result === 'left out' && operation.reason ? { reason: operation.reason } : {}),
      executions: entry?.executions || 0, failedExecutions: entry?.failed || 0,
      responses, undocumented: undocumented.sort(), failures: entry?.failures || [],
    };
  });
  const count = (result: OperationRunResult) => byOperation.filter(entry => entry.result === result).length;
  const inCollection = byOperation.filter(entry => entry.result !== 'left out');
  const responses = inCollection.flatMap(entry => entry.responses);
  const countResponses = (result: ResponseRunResult) => responses.filter(entry => entry.result === result).length;
  return {
    run: { executions: counted, failedExecutions },
    operations: { total: byOperation.length, passed: count('passed'), failed: count('failed'), notRun: count('not run'), leftOut: count('left out') },
    responses: { total: responses.length, passed: countResponses('passed'), failed: countResponses('failed'), plannedOnly: countResponses('planned only'), noTest: countResponses('no test') },
    byOperation,
    extra: [...extra.values()],
  };
}

const label = (entry: { method: string; path: string; operationId: string }): string =>
  entry.operationId === `${entry.method.toLowerCase()} ${entry.path}` ? `${entry.method} ${entry.path}` : `${entry.method} ${entry.path} (${entry.operationId})`;

/** The run coverage as the lines the CLI prints. */
export function formatRunCoverage(report: RunCoverageReport): string {
  const { operations, responses } = report;
  const lines = [
    `Run:          ${report.run.executions} request${report.run.executions === 1 ? '' : 's'}, ${report.run.failedExecutions} with a failed check`,
    `Operations:   ${operations.passed}/${operations.total} passed, ${operations.failed} failed, ${operations.notRun} not run, ${operations.leftOut} left out`,
    `Responses:    ${responses.passed}/${responses.total} documented responses passed, ${responses.failed} failed, ${responses.plannedOnly} planned only, ${responses.noTest} with no test`,
  ];
  for (const entry of report.byOperation.filter(item => item.result === 'failed')) {
    const first = entry.failures[0];
    lines.push(`Failed:       ${label(entry)}${first ? `: ${first.check}: ${first.message}` : ''}${entry.failures.length > 1 ? ` (+${entry.failures.length - 1} more)` : ''}`);
  }
  for (const entry of report.byOperation.filter(item => item.result === 'not run')) lines.push(`Not run:      ${label(entry)}`);
  for (const entry of report.byOperation) {
    const planned = entry.responses.filter(response => response.result === 'planned only').map(response => response.status);
    if (planned.length) lines.push(`Planned only: ${label(entry)} ${planned.join(', ')}`);
    if (entry.undocumented.length) lines.push(`Undocumented: ${label(entry)} returned ${entry.undocumented.join(', ')}`);
  }
  if (report.extra.length) {
    lines.push(`Extra:        ${report.extra.length} request${report.extra.length === 1 ? '' : 's'} outside the document: ${report.extra.map(entry => entry.name).join(', ')}`);
  }
  if (report.run.executions && report.run.executions === report.extra.reduce((sum, entry) => sum + entry.executions, 0)) {
    lines.push('Note:         no request of the run is linked to an operation; generate the collection again with this version');
  }
  return lines.join('\n');
}

const cell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const code = (value: string): string => `\`${value.replace(/`/g, "'")}\``;

/** The run coverage as Markdown, for a GitHub job summary. */
export function formatRunCoverageMarkdown(report: RunCoverageReport): string {
  const { operations, responses } = report;
  const lines = [
    '### Coverage of the run',
    '',
    `${report.run.executions} request${report.run.executions === 1 ? '' : 's'} sent, ${report.run.failedExecutions} with a failed check.`,
    '',
    `- **Operations:** ${operations.passed} of ${operations.total} passed, ${operations.failed} failed, ${operations.notRun} not run, ${operations.leftOut} left out`,
    `- **Documented responses:** ${responses.passed} of ${responses.total} passed, ${responses.failed} failed, ${responses.plannedOnly} planned only, ${responses.noTest} with no test`,
  ];
  const failed = report.byOperation.filter(entry => entry.result === 'failed');
  if (failed.length) {
    lines.push('', '#### Failed', '', '| Operation | Received | Failed checks |', '| --- | --- | --- |');
    for (const entry of failed) {
      const received = [...entry.responses.filter(response => response.result === 'passed' || response.result === 'failed').map(response => response.status), ...entry.undocumented];
      const checks = entry.failures.slice(0, 5).map(failure => cell(`${failure.request}: ${failure.check}: ${failure.message}`));
      if (entry.failures.length > 5) checks.push(`and ${entry.failures.length - 5} more`);
      lines.push(`| ${code(label(entry))} | ${received.join(', ') || 'no response'} | ${checks.join('<br>')} |`);
    }
  }
  const list = (title: string, items: string[]): void => {
    if (items.length) lines.push('', `#### ${title}`, '', ...items.map(item => `- ${item}`));
  };
  list('Not run', report.byOperation.filter(entry => entry.result === 'not run').map(entry => code(label(entry))));
  list('Planned but not received', report.byOperation.flatMap(entry => {
    const planned = entry.responses.filter(response => response.result === 'planned only').map(response => response.status);
    return planned.length ? [`${code(label(entry))}: ${planned.join(', ')}`] : [];
  }));
  list('Status codes the document does not list', report.byOperation
    .filter(entry => entry.undocumented.length)
    .map(entry => `${code(label(entry))}: ${entry.undocumented.join(', ')}`));
  list('Requests outside the document', report.extra.map(entry =>
    `${code(`${entry.method} ${entry.name}`)}: ${entry.executions} sent${entry.statuses.length ? `, received ${entry.statuses.join(', ')}` : ''}${entry.failedExecutions ? `, ${entry.failedExecutions} failed` : ''}`));
  return `${lines.join('\n')}\n`;
}
