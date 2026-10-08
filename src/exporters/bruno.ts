import { PostmanCollection, PostmanEnvironment } from '../types';
import { FlatRequest, flattenCollection } from './flatten';
import { PM_RUNTIME_SOURCE } from './runtime';

export interface BrunoFile {
  /** Relative to the collection folder, with forward slashes. */
  path: string;
  content: string;
}

// Connects the runtime to Bruno's own objects. Written into each script next to the runtime.
const BRUNO_HOST_SOURCE = `function postmanHost(requestName, requestUrl) {
  var hasResponse = typeof res !== 'undefined' && res;
  return {
    // Outside a tests block there is no test(): the check runs at once and a failure stops the request.
    test: function (name, run) { if (typeof test === 'function') test(name, run); else run(); },
    response: !hasResponse ? undefined : {
      code: res.getStatus(),
      responseTime: res.getResponseTime(),
      header: function (name) {
        var headers = res.getHeaders() || {};
        var wanted = name.toLowerCase();
        var found = Object.keys(headers).filter(function (key) { return key.toLowerCase() === wanted; })[0];
        return found === undefined ? undefined : String(headers[found]);
      },
      text: function () {
        var body = res.getBody();
        if (body === undefined || body === null) return '';
        return typeof body === 'string' ? body : JSON.stringify(body);
      },
    },
    request: { name: requestName, url: requestUrl },
    variables: {
      get: function (key) {
        var value = bru.getVar(key);
        return value === undefined || value === null ? bru.getEnvVar(key) : value;
      },
      set: function (key, value) {
        // A captured value has to replace a placeholder of the same name in the environment too.
        if (bru.getEnvVar(key) !== undefined) bru.setEnvVar(key, value);
        bru.setVar(key, value);
      },
      unset: function (key) { bru.setVar(key, null); },
      inEnvironment: function (key) { return bru.getEnvVar(key) !== undefined; },
    },
    setNextRequest: function (name) { bru.setNextRequest(name); },
    skipRequest: function () { if (bru.runner && bru.runner.skipRequest) bru.runner.skipRequest(); },
  };
}`;

/** Name of the folder that holds requests which sit beside folders at the top of a collection. */
const LOOSE_FOLDER = 'Requests';

function slug(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || 'request';
}

/** Percent-encodes the literal text of a query key or value and leaves `{{variables}}` alone. */
function encodeQueryPart(text: string): string {
  return text.split(/({{[^{}]+}})/).map((part, index) => (index % 2 === 1 ? part : encodeURIComponent(part))).join('');
}

/** A `name { key: value }` block; a key that starts with `~` is a disabled entry. */
function dictionary(name: string, entries: Array<[string, string]>): string {
  if (!entries.length) return '';
  // A value ends at the end of its line in the bru format.
  const line = ([key, value]: [string, string]): string => `  ${key}: ${String(value).replace(/\r?\n/g, ' ')}`;
  return `${name} {\n${entries.map(line).join('\n')}\n}\n`;
}

function textBlock(name: string, lines: string[]): string {
  return `${name} {\n${lines.map(line => (line ? `  ${line}` : '')).join('\n')}\n}\n`;
}

function scriptBlock(name: string, lines: string[], request: FlatRequest, rawUrl: string): string {
  if (!lines.length) return '';
  return textBlock(name, [
    `const postmanRuntime = createPmRuntime(postmanHost(${JSON.stringify(request.name)}, ${JSON.stringify(rawUrl)}));`,
    '// A timer in Postman holds the run until it fires; here it is awaited at the end of the script.',
    'const timers = [];',
    'const startTimer = (callback, milliseconds) => timers.push(bru.sleep(milliseconds).then(() => typeof callback === "function" && callback()));',
    '',
    '// The script of the Postman collection, unchanged.',
    'await (async function (pm, postman, require, setTimeout) {',
    ...lines.map(line => `  ${line}`.trimEnd()),
    '})(postmanRuntime.pm, postmanRuntime.postman, postmanRuntime.require, startTimer);',
    'await Promise.all(timers);',
    '',
    '// ---- Postman compatibility: what the script above calls on `pm` ----',
    ...BRUNO_HOST_SOURCE.split('\n'),
    ...PM_RUNTIME_SOURCE.split('\n'),
  ]);
}

function requestFile(request: FlatRequest, sequence: number): string {
  const rawQuery = request.query.map(([key, value]) => `${key}=${value}`).join('&');
  // What the Postman script sees as the request's URL, variables and all.
  const rawUrl = request.url + (rawQuery ? `?${rawQuery}` : '');
  // Bruno sends the URL line as written, so a value with `&` or `=` in it has to be encoded here.
  const query = request.query.map(([key, value]) => `${encodeQueryPart(key)}=${encodeQueryPart(value)}`).join('&');
  const sentUrl = request.url + (query ? `?${query}` : '');
  const bodyType = !request.body ? 'none'
    : request.body.mode === 'raw' ? (request.body.language === 'json' ? 'json' : 'text')
      : request.body.mode === 'urlencoded' ? 'formUrlEncoded' : 'multipartForm';
  const blocks = [
    dictionary('meta', [['name', request.name], ['type', 'http'], ['seq', String(sequence)]]),
    dictionary(request.method.toLowerCase(), [['url', sentUrl], ['body', bodyType], ['auth', request.auth ? request.auth.type : 'none']]),
    dictionary('params:query', request.query),
    dictionary('headers', request.headers),
    request.auth?.type === 'bearer' ? dictionary('auth:bearer', [['token', request.auth.token]]) : '',
    request.auth?.type === 'basic' ? dictionary('auth:basic', [['username', request.auth.username], ['password', request.auth.password]]) : '',
    request.body?.mode === 'raw' ? textBlock(`body:${bodyType}`, request.body.raw.split(/\r?\n/)) : '',
    request.body?.mode === 'urlencoded' ? dictionary('body:form-urlencoded', request.body.fields) : '',
    request.body?.mode === 'formdata' ? dictionary('body:multipart-form', request.body.fields) : '',
    scriptBlock('script:pre-request', request.prerequest, request, rawUrl),
    scriptBlock('tests', request.test, request, rawUrl),
  ];
  return blocks.filter(Boolean).join('\n');
}

/**
 * Writes the collection as a Bruno collection folder: `bruno.json`, one `.bru` file per request
 * in a folder per Postman folder, and the environment. Run it with `bru run -r --env <name>`
 * from that folder, or open the folder in Bruno.
 *
 * Requests, headers, bodies, auth and variables are native Bruno. The test scripts are the
 * Postman ones, each followed by the small compatibility layer it runs on, so the checks,
 * the variable capture and the polling of background jobs behave as they do in Postman.
 */
export function toBrunoCollection(collection: PostmanCollection, environment?: PostmanEnvironment): BrunoFile[] {
  const files: BrunoFile[] = [{
    path: 'bruno.json',
    content: `${JSON.stringify({ version: '1', name: collection.info.name, type: 'collection', ignore: ['node_modules', '.git'] }, null, 2)}\n`,
  }];

  // Sequence numbers are per folder; folders themselves are numbered in the order they first appear.
  interface FolderState { sequence: number; count: number; directory: string }
  const folders = new Map<string, FolderState>();
  const folderOf = (names: string[]): { directory: string; state: FolderState } => {
    let directory = '';
    let state = folders.get('') || { sequence: 0, count: 0, directory: '' };
    folders.set('', state);
    for (const name of names) {
      const parent = state;
      const key = `${directory}/${name}`;
      let child = folders.get(key);
      if (!child) {
        parent.count += 1;
        // The number in the folder's name keeps the order on disk and in a runner that sorts by name.
        child = { sequence: parent.count, count: 0, directory: `${directory ? `${directory}/` : ''}${String(parent.count).padStart(2, '0')}-${slug(name)}` };
        folders.set(key, child);
        directory = child.directory;
        files.push({ path: `${directory}/folder.bru`, content: dictionary('meta', [['name', name], ['seq', String(child.sequence)]]) });
      }
      directory = child.directory;
      state = child;
    }
    return { directory, state };
  };

  const used = new Set<string>();
  const requests = flattenCollection(collection);
  // Bruno runs a folder's subfolders before the requests that sit beside them, so a collection
  // that mixes the two at the top (setup, then requests in a set order, then teardown) would run
  // its teardown early. The loose requests get a folder of their own, in their place in the order.
  const mixed = requests.some(request => request.folder.length > 0) && requests.some(request => request.folder.length === 0);
  for (const request of requests) {
    const { directory, state } = folderOf(mixed && request.folder.length === 0 ? [LOOSE_FOLDER] : request.folder);
    state.count += 1;
    // The number keeps the files in run order on disk and two requests of one name apart.
    let path = `${directory ? `${directory}/` : ''}${String(state.count).padStart(2, '0')}-${slug(request.name)}.bru`;
    for (let suffix = 2; used.has(path); suffix++) path = path.replace(/(-\d+)?\.bru$/, `-${suffix}.bru`);
    used.add(path);
    files.push({ path, content: requestFile(request, state.count) });
  }

  const values = new Map<string, { value: string; secret: boolean }>();
  for (const variable of collection.variable || []) values.set(variable.key, { value: variable.value, secret: false });
  for (const entry of environment?.values || []) {
    if (entry.enabled) values.set(entry.key, { value: entry.value, secret: entry.type === 'secret' });
  }
  const plain = [...values].filter(([, entry]) => !entry.secret).map(([key, entry]): [string, string] => [key, entry.value]);
  const secret = [...values].filter(([, entry]) => entry.secret).map(([key]) => key);
  files.push({
    path: `environments/${slug(environment?.name || 'default')}.bru`,
    content: dictionary('vars', plain) + (secret.length ? `vars:secret [\n${secret.map(key => `  ${key}`).join(',\n')}\n]\n` : ''),
  });
  return files;
}
