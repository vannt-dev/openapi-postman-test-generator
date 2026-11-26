import { dump } from 'js-yaml';
import { PostmanAuth, PostmanBody, PostmanCollection, PostmanEnvironment, PostmanEvent, PostmanItem, PostmanUrl } from '../types';

/**
 * Postman Collection format v3.0.0: the YAML collection Postman v12 keeps in Git and the
 * Postman CLI runs (Newman runs only v2.1). The item shapes follow the published schema at
 * https://schema.postman.com/collection/json/v3.0.0/draft-07/collection.json; the split into
 * files follows https://learning.postman.com/docs/use/use-collections/collections-schemas/.
 */

export interface PostmanV3KeyValue { key: string; value: string; description?: string; disabled?: boolean }
export interface PostmanV3Auth { type: string; credentials?: Array<{ key: string; value: unknown }> }
export type PostmanV3Body =
  | { type: 'json' | 'text'; content: string }
  | { type: 'urlencoded'; content: PostmanV3KeyValue[] }
  | { type: 'formdata'; content: Array<{ type: 'text'; key: string; value: string; disabled?: boolean } | { type: 'file'; key: string; src: string; disabled?: boolean }> };
export interface PostmanV3Script { type: 'beforeRequest' | 'afterResponse'; code: string; language: 'text/javascript' }
export interface PostmanV3Request {
  $kind: 'http-request';
  id?: string;
  name: string;
  description?: string;
  /** Without the query string: the query is in `queryParams`. */
  url: string;
  method: string;
  headers?: PostmanV3KeyValue[];
  queryParams?: PostmanV3KeyValue[];
  body?: PostmanV3Body;
  auth?: PostmanV3Auth;
  scripts?: PostmanV3Script[];
}
export interface PostmanV3Folder { $kind: 'collection'; name: string; items: PostmanV3Item[] }
export type PostmanV3Item = PostmanV3Folder | PostmanV3Request;
export interface PostmanV3Collection {
  $kind: 'collection';
  name: string;
  description?: string;
  variables?: Array<{ key: string; value: string; description?: string }>;
  auth?: PostmanV3Auth;
  items: PostmanV3Item[];
}

export interface PostmanV3File {
  /** Relative to the collection folder, with forward slashes. */
  path: string;
  content: string;
}

function auth(source: PostmanAuth | undefined): PostmanV3Auth | undefined {
  if (!source) return undefined;
  if (source.type === 'noauth') return { type: 'noauth' };
  const entries = source[source.type] as Array<{ key: string; value: unknown }> | undefined;
  return { type: source.type, credentials: (entries || []).map(entry => ({ key: entry.key, value: entry.value === undefined ? '' : entry.value })) };
}

function keyValues(entries: Array<{ key: string; value: string; description?: string; disabled?: boolean }> | undefined): PostmanV3KeyValue[] | undefined {
  if (!entries?.length) return undefined;
  return entries.map(entry => ({
    key: entry.key,
    value: entry.value,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.disabled ? { disabled: true } : {}),
  }));
}

function body(source: PostmanBody | undefined): PostmanV3Body | undefined {
  if (!source) return undefined;
  if (source.mode === 'raw') return { type: source.options.raw.language === 'json' ? 'json' : 'text', content: source.raw };
  if (source.mode === 'urlencoded') return { type: 'urlencoded', content: keyValues(source.urlencoded) || [] };
  return {
    type: 'formdata',
    content: source.formdata.map(entry => {
      const disabled = entry.disabled ? { disabled: true } : {};
      return entry.type === 'file'
        ? { type: 'file' as const, key: entry.key, src: entry.value, ...disabled }
        : { type: 'text' as const, key: entry.key, value: entry.value, ...disabled };
    }),
  };
}

function scripts(events: PostmanEvent[] | undefined): PostmanV3Script[] | undefined {
  if (!events?.length) return undefined;
  return events.map(event => ({
    type: event.listen === 'prerequest' ? 'beforeRequest' : 'afterResponse',
    code: event.script.exec.join('\n'),
    language: 'text/javascript',
  }));
}

/** The query is sent from `queryParams`, so the URL keeps only what comes before it. */
function splitUrl(url: PostmanUrl): { location: string; query?: PostmanV3KeyValue[] } {
  const withoutFragment = url.raw.split('#')[0];
  const queryIndex = withoutFragment.indexOf('?');
  if (queryIndex < 0) return { location: withoutFragment, query: keyValues(url.query) };
  // The query list is what Postman sends; the raw text counts only when there is no list.
  const query = url.query ? keyValues(url.query) : keyValues(withoutFragment.slice(queryIndex + 1).split('&').filter(Boolean).map(pair => {
    const separator = pair.indexOf('=');
    return separator < 0 ? { key: pair, value: '' } : { key: pair.slice(0, separator), value: pair.slice(separator + 1) };
  }));
  return { location: withoutFragment.slice(0, queryIndex), query };
}

function item(source: PostmanItem): PostmanV3Item {
  if (!source.request) return { $kind: 'collection', name: source.name, items: (source.item || []).map(item) };
  const request = source.request;
  const { location, query } = splitUrl(request.url);
  const result: PostmanV3Request = {
    $kind: 'http-request',
    ...(source.id ? { id: source.id } : {}),
    name: source.name,
    ...(request.description ? { description: request.description } : {}),
    url: location,
    method: request.method,
  };
  const headers = keyValues(request.header);
  if (headers) result.headers = headers;
  if (query) result.queryParams = query;
  const requestBody = body(request.body);
  if (requestBody) result.body = requestBody;
  const requestAuth = auth(request.auth);
  if (requestAuth) result.auth = requestAuth;
  const requestScripts = scripts(source.event);
  if (requestScripts) result.scripts = requestScripts;
  return result;
}

/** The collection as one v3 document, the shape the published schema describes. */
export function toPostmanV3Collection(collection: PostmanCollection): PostmanV3Collection {
  const result: Omit<PostmanV3Collection, 'items'> = { $kind: 'collection', name: collection.info.name };
  if (collection.info.description) result.description = collection.info.description;
  if (collection.variable?.length) {
    result.variables = collection.variable.map(variable => ({
      key: variable.key,
      value: String(variable.value ?? ''),
      ...(variable.description ? { description: variable.description } : {}),
    }));
  }
  const collectionAuth = auth(collection.auth);
  if (collectionAuth) result.auth = collectionAuth;
  return { ...result, items: collection.item.map(item) };
}

const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** A file or folder name that is valid on every system; Postman replaces the same characters. */
export function postmanV3FileName(name: string): string {
  let safe = name
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-')
    // a leading dot would hide the file or clash with `.resources`, a trailing one is dropped by Windows
    .slice(0, 100)
    .replace(/^[.\s]+|[.\s]+$/g, match => '-'.repeat(match.length));
  if (!safe) safe = 'Untitled';
  if (WINDOWS_DEVICE_NAMES.test(safe)) safe = `${safe}-`;
  return safe;
}

/** Names for the entries of one folder: case-insensitively unique, as the format requires. */
function uniqueNames(items: PostmanV3Item[]): string[] {
  const taken = new Set<string>();
  return items.map(entry => {
    const base = postmanV3FileName(entry.name);
    let candidate = base;
    for (let suffix = 1; taken.has(candidate.toLowerCase()); suffix++) candidate = `${base}-${suffix}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

function yaml(value: object): string {
  return dump(value, { lineWidth: -1, noRefs: true });
}

/**
 * The collection as the files of a v3 collection folder: `.resources/definition.yaml` for the
 * collection and each folder, one `<name>.request.yaml` per request. `order` keeps the run order
 * (Postman sorts the entries of a folder by it, not by file name).
 */
export function toPostmanV3Files(collection: PostmanCollection): PostmanV3File[] {
  const document = toPostmanV3Collection(collection);
  const files: PostmanV3File[] = [];
  const { items, ...definition } = document;
  files.push({ path: '.resources/definition.yaml', content: yaml(definition) });
  const walk = (entries: PostmanV3Item[], directory: string): void => {
    const names = uniqueNames(entries);
    entries.forEach((entry, index) => {
      const order = (index + 1) * 1000;
      if (entry.$kind === 'collection') {
        const folder = `${directory}${names[index]}/`;
        files.push({ path: `${folder}.resources/definition.yaml`, content: yaml({ $kind: entry.$kind, name: entry.name, order }) });
        walk(entry.items, folder);
      } else {
        files.push({ path: `${directory}${names[index]}.request.yaml`, content: yaml({ ...entry, order }) });
      }
    });
  };
  walk(items, '');
  return files;
}

/**
 * The environment for a v3 run. In a v3 run the Postman CLI leaves a value marked `secret` as
 * `{{name}}`, even when --env-var gives it, so secrets become plain values here, to be given
 * with --env-var or written into the file before a run.
 */
export function toPostmanV3Environment(environment: PostmanEnvironment): PostmanEnvironment {
  return { ...environment, values: environment.values.map(value => ({ ...value, type: 'default' })) };
}
