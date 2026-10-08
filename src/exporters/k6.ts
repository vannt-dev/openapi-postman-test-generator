/* eslint-disable @typescript-eslint/no-explicit-any --
   `createK6Runner` is written into the generated script as source text and runs inside k6,
   without types; see runtime.ts for the same arrangement. */
import { PostmanCollection, PostmanEnvironment } from '../types';
import { FlatRequest, flattenCollection, variableDefaults } from './flatten';
import { PM_RUNTIME_SOURCE } from './runtime';

/**
 * Sends the collection's requests in order and runs their scripts, the way a Postman runner
 * does: variables are substituted, a script can name the request to send next (which is how a
 * background job is polled) or skip the one about to be sent, and every `pm.test` becomes a k6
 * check.
 *
 * Everything k6 provides comes in through `deps`, so the same function runs under Node in tests.
 */
export function createK6Runner(deps: any): () => void {
  return function run(): void {
    const vars: Record<string, any> = {};
    Object.keys(deps.defaults).forEach(function (key) {
      // `-e name=value` on the command line replaces a variable of that name.
      vars[key] = deps.env[key] !== undefined ? deps.env[key] : deps.defaults[key];
    });

    function interpolate(text: string): string {
      return String(text).replace(/\{\{([^{}]+)\}\}/g, function (whole: string, key: string) {
        const value = vars[key.trim()];
        return value === undefined || value === null ? whole : String(value);
      });
    }

    function findHeader(headers: Record<string, string>, name: string): string | undefined {
      const wanted = name.toLowerCase();
      const found = Object.keys(headers).filter(function (key) { return key.toLowerCase() === wanted; })[0];
      return found === undefined ? undefined : headers[found];
    }

    function encodeFields(fields: Array<[string, string]>): string {
      return fields.map(function (field) {
        return encodeURIComponent(interpolate(field[0])) + '=' + encodeURIComponent(interpolate(field[1]));
      }).join('&');
    }

    const requests = deps.requests;
    let index = 0;
    // A script that keeps naming itself as the next request would never end.
    let budget = requests.length * 200 + 200;
    while (index < requests.length && budget-- > 0) {
      const request = requests[index];
      const state = { next: index + 1, skipped: false };
      const host: any = {
        test: (function (current: any) {
          return function (name: string, check: () => void) {
            let passed = true;
            try { check(); } catch (error: any) {
              passed = false;
              deps.log('FAIL ' + current.name + ' - ' + name + ': ' + (error && error.message ? error.message : error));
            }
            const checks: Record<string, () => boolean> = {};
            checks[current.name + ' - ' + name] = function () { return passed; };
            deps.check(null, checks);
          };
        })(request),
        request: { name: request.name, url: request.url + (request.query.length ? '?' + request.query.map(function (pair: string[]) { return pair[0] + '=' + pair[1]; }).join('&') : '') },
        variables: {
          get: function (key: string) { return vars[key]; },
          set: function (key: string, value: any) { vars[key] = value; },
          unset: function (key: string) { delete vars[key]; },
          inEnvironment: function (key: string) { return deps.environmentKeys.indexOf(key) >= 0 && vars[key] !== undefined; },
        },
        setNextRequest: (function (current: any) {
          return function (name: string | null) {
            const target = name === null ? -1 : requests.map(function (item: any) { return item.name; }).indexOf(name);
            current.next = target < 0 ? requests.length : target;
          };
        })(state),
        skipRequest: (function (current: any) { return function () { current.skipped = true; }; })(state),
      };
      // Postman finishes a script's timers before it moves on; here a timer is simply a pause.
      const wait = function (callback: any, milliseconds: number) {
        deps.sleep((milliseconds || 0) / 1000);
        if (typeof callback === 'function') callback();
      };
      let runtime: any;

      if (request.prerequest) {
        runtime = deps.createPmRuntime(host);
        request.prerequest(runtime.pm, runtime.postman, runtime.require, wait);
      }
      if (!state.skipped) {
        const headers: Record<string, string> = {};
        request.headers.forEach(function (header: string[]) { headers[interpolate(header[0])] = interpolate(header[1]); });
        if (request.auth && findHeader(headers, 'Authorization') === undefined) {
          headers.Authorization = request.auth.type === 'bearer'
            ? 'Bearer ' + interpolate(request.auth.token)
            : 'Basic ' + deps.b64encode(interpolate(request.auth.username) + ':' + interpolate(request.auth.password));
        }
        let body: string | null = null;
        if (request.body && request.body.mode === 'raw') {
          body = interpolate(request.body.raw);
        } else if (request.body && request.body.mode === 'urlencoded') {
          body = encodeFields(request.body.fields);
          if (findHeader(headers, 'Content-Type') === undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
        } else if (request.body) {
          // Text parts only: a file part would need the file read at init time with open().
          const boundary = '----openapi-postman-' + index + '-' + request.body.fields.length;
          body = request.body.fields.map(function (field: string[]) {
            return '--' + boundary + '\r\nContent-Disposition: form-data; name="' + interpolate(field[0]).replace(/"/g, '%22') + '"\r\n\r\n' + interpolate(field[1]) + '\r\n';
          }).join('') + '--' + boundary + '--\r\n';
          Object.keys(headers).forEach(function (key) { if (key.toLowerCase() === 'content-type') delete headers[key]; });
          headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary;
        }
        const url = interpolate(request.url) + (request.query.length ? '?' + encodeFields(request.query) : '');
        const response = deps.http.request(request.method, url, body, { headers: headers, tags: { name: request.name } });
        host.response = (function (result: any) {
          return {
            code: result.status,
            responseTime: result.timings ? result.timings.duration : 0,
            header: function (name: string) { return findHeader(result.headers || {}, name); },
            text: function () { return result.body === undefined || result.body === null ? '' : String(result.body); },
          };
        })(response);
        if (request.test) {
          runtime = deps.createPmRuntime(host);
          request.test(runtime.pm, runtime.postman, runtime.require, wait);
        }
      }
      index = state.next;
    }
  };
}

function scriptFunction(lines: string[]): string {
  if (!lines.length) return 'null';
  return `function (pm, postman, require, setTimeout) {\n${lines.map(line => `      ${line}`.trimEnd()).join('\n')}\n    }`;
}

function requestLiteral(request: FlatRequest): string {
  const field = (name: string, value: unknown): string => `    ${name}: ${JSON.stringify(value)},`;
  return [
    '  {',
    field('name', request.name),
    field('folder', request.folder.join(' / ')),
    field('method', request.method),
    field('url', request.url),
    field('query', request.query),
    field('headers', request.headers),
    field('auth', request.auth),
    field('body', request.body),
    `    prerequest: ${scriptFunction(request.prerequest)},`,
    `    test: ${scriptFunction(request.test)},`,
    '  },',
  ].join('\n');
}

export interface K6Options {
  /** Shown in the header comment as the command to run. */
  fileName?: string;
}

/**
 * Writes the collection as a k6 script: the same requests in the same order, with the same
 * checks, variable capture and polling, run by one virtual user once. Raise `options.vus` and
 * `options.iterations` (or pass `--vus`/`--duration` to k6) to turn it into a load test.
 */
export function toK6Script(collection: PostmanCollection, environment?: PostmanEnvironment, options: K6Options = {}): string {
  const requests = flattenCollection(collection);
  const defaults = variableDefaults(collection, environment);
  const environmentKeys = (environment?.values || []).filter(entry => entry.enabled).map(entry => entry.key);
  const fileName = options.fileName || 'api.k6.js';
  return `// ${collection.info.name}
//
// Generated by openapi-postman-test-generator. Run it with:
//   k6 run ${fileName}
//   k6 run -e baseUrl=https://staging.example.com -e bearerAuth_token=... ${fileName}
//
// The requests, their order and their checks are those of the Postman collection: each request's
// test script is the same code, run against a small stand-in for Postman's \`pm\` object.
import http from 'k6/http';
import encoding from 'k6/encoding';
import { check, sleep } from 'k6';

export const options = {
  vus: 1,
  iterations: 1,
  // Any failed check fails the run, so a pipeline notices.
  thresholds: { checks: ['rate==1.0'] },
};

// Collection variables, then the environment's. \`-e name=value\` replaces one of them.
const DEFAULTS = ${JSON.stringify(defaults, null, 2)};
const ENVIRONMENT_KEYS = ${JSON.stringify(environmentKeys)};

const REQUESTS = [
${requests.map(requestLiteral).join('\n')}
];

// ---- Postman compatibility: what the scripts above call on \`pm\` -------------------------
${PM_RUNTIME_SOURCE}

// ---- Runner -------------------------------------------------------------------------------
${createK6Runner.toString()}

const run = createK6Runner({
  http, check, sleep,
  b64encode: encoding.b64encode,
  env: __ENV,
  log: message => console.error(message),
  createPmRuntime,
  requests: REQUESTS,
  defaults: DEFAULTS,
  environmentKeys: ENVIRONMENT_KEYS,
});

export default function () {
  run();
}
`;
}
