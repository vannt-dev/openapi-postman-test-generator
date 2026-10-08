import { PostmanAuth, PostmanCollection, PostmanEnvironment, PostmanEvent, PostmanItem } from '../types';

export type FlatAuth =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string };

export type FlatBody =
  | { mode: 'raw'; raw: string; language: 'json' | 'text' }
  | { mode: 'urlencoded' | 'formdata'; fields: Array<[string, string]> };

/** One request of a collection with everything it inherits already applied. */
export interface FlatRequest {
  name: string;
  /** Names of the folders it sits in, outermost first. */
  folder: string[];
  method: string;
  /** Without its query string; variables are still written as {{name}}. */
  url: string;
  query: Array<[string, string]>;
  headers: Array<[string, string]>;
  auth: FlatAuth | null;
  body: FlatBody | null;
  prerequest: string[];
  test: string[];
}

function authValue(auth: PostmanAuth, key: string): string {
  const entries = auth[auth.type] as Array<{ key: string; value: unknown }> | undefined;
  const entry = entries?.find(item => item.key === key);
  return entry?.value === undefined ? '' : String(entry.value);
}

function flatAuth(auth: PostmanAuth | undefined): FlatAuth | null {
  if (auth?.type === 'bearer') return { type: 'bearer', token: authValue(auth, 'token') };
  if (auth?.type === 'basic') return { type: 'basic', username: authValue(auth, 'username'), password: authValue(auth, 'password') };
  return null;
}

function script(events: PostmanEvent[] | undefined, listen: PostmanEvent['listen']): string[] {
  return (events || []).filter(event => event.listen === listen).flatMap(event => event.script.exec);
}

/** The requests of a collection in the order a runner sends them. */
export function flattenCollection(collection: PostmanCollection): FlatRequest[] {
  const requests: FlatRequest[] = [];
  const walk = (items: PostmanItem[], folder: string[]): void => {
    for (const item of items) {
      if (item.item) walk(item.item, [...folder, item.name]);
      const request = item.request;
      if (!request) continue;
      const [location, rawQuery] = request.url.raw.split('#')[0].split(/\?(.*)/s);
      // The query list is what Postman sends; the raw text is only its display form.
      const query: Array<[string, string]> = request.url.query
        ? request.url.query.filter(entry => !entry.disabled).map(entry => [entry.key, entry.value])
        : (rawQuery || '').split('&').filter(Boolean).map(pair => {
          const separator = pair.indexOf('=');
          return separator < 0 ? [pair, ''] : [pair.slice(0, separator), pair.slice(separator + 1)];
        });
      const body = request.body;
      requests.push({
        name: item.name,
        folder,
        method: request.method,
        url: location,
        query,
        headers: request.header.filter(header => !header.disabled).map(header => [header.key, header.value]),
        // A request's own auth wins, and "noauth" there switches the collection's off.
        auth: flatAuth(request.auth || collection.auth),
        body: !body ? null
          : body.mode === 'raw' ? { mode: 'raw', raw: body.raw, language: body.options.raw.language }
            : {
              mode: body.mode,
              fields: (body.mode === 'formdata' ? body.formdata : body.urlencoded)
                .filter(entry => !entry.disabled).map(entry => [entry.key, entry.value]),
            },
        prerequest: script(item.event, 'prerequest'),
        test: script(item.event, 'test'),
      });
    }
  };
  walk(collection.item, []);
  return requests;
}

/** Collection variables overlaid with the environment's, which is the order Postman resolves them in. */
export function variableDefaults(collection: PostmanCollection, environment?: PostmanEnvironment): Record<string, string> {
  const values: Record<string, string> = {};
  for (const variable of collection.variable || []) values[variable.key] = variable.value;
  for (const entry of environment?.values || []) if (entry.enabled) values[entry.key] = entry.value;
  return values;
}
