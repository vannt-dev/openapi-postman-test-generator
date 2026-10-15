# OpenAPI Postman Test Generator

[![CI](https://github.com/vannt-dev/openapi-postman-test-generator/actions/workflows/ci.yml/badge.svg)](https://github.com/vannt-dev/openapi-postman-test-generator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](https://nodejs.org/)
[![npm](https://img.shields.io/npm/v/openapi-postman-test-generator.svg)](https://www.npmjs.com/package/openapi-postman-test-generator)
[![npm downloads](https://img.shields.io/npm/d18m/openapi-postman-test-generator.svg)](https://www.npmjs.com/package/openapi-postman-test-generator)
[![Official vannt-dev build](https://vannt-dev.github.io/badges/official.svg)](https://vannt-dev.github.io/official.html)

**[View the project landing page →](https://vannt-dev.github.io/openapi-postman-test-generator/)**

Generate runnable Postman collections, environments, workflow-aware test scripts, negative cases, and Newman reports from Swagger 2.0 or OpenAPI 3.x specifications.

The core generator is deterministic. An optional AI planner uses structured model output to infer operation order and identifier mappings, while the deterministic generator remains responsible for producing the collection.

## Features

- Swagger 2.0 and OpenAPI 3.x files or URLs
- JSON, form-urlencoded, multipart uploads, text, and binary responses
- Path, query, header, cookie, array, and deep-object parameters
- Bearer, Basic, OAuth token placeholders, API keys, and combined security requirements
- Status-specific JSON Schema assertions and media-type-aware response handling
- Response assertions respect write-only fields; generated authentication variables retain configured values.
- Synthesized examples are checked against supported type, numeric, string, array, object, and composition constraints. Unsupported synthesis or conflicting constraints produce an error; provide a valid explicit example for complex patterns, formats, or uniqueness constraints. This is a bounded generator, not a complete JSON Schema validator.
- CRUD-oriented ordering with configurable operation order
- Identifier extraction and target substitution between dependent requests
- Optional missing-field, invalid-enum, boundary, and unauthorized cases
- Named environment profiles and JSON/CSV iteration data
- Safe mode that excludes `DELETE` operations
- A tag filter (`--tag`, `--exclude-tag`) to generate the tests of a part of the API
- A coverage report: which operations have a request and which documented responses a test expects
- OAuth2 client credentials: the collection can start by fetching its own access token
- A GitHub Action that generates, runs and reports in one step
- Setup and teardown requests, async job polling, and runtime variables such as OTPs
- Newman execution with CLI, JSON, JUnit, and standalone HTML reports
- Per-request HTML reporting with status, duration, and assertion counts
- Provider-neutral AI planner with schema-validated output and fallback providers
- Built-in OpenAI SDK, Codex CLI, Claude Code, and Antigravity CLI adapters
- `diff` command that lists the changes between two versions of a spec and fails on the ones that break clients
- The same tests as a [Bruno](https://www.usebruno.com/) collection folder or a [k6](https://k6.io/) script, with the same checks, variable capture and job polling
- Safe custom-command adapter and a public provider registry for future integrations

## Requirements

- Node.js 22 or newer
- A Swagger 2.0 or OpenAPI 3.x document
- Newman available on `PATH` when running generated collections (`npm install --global newman`)
- An authenticated provider CLI when using Codex, Claude, or Antigravity
- `OPENAI_API_KEY` only when the OpenAI SDK provider is selected

## Install

Install the published CLI (Node.js 22 or newer):

```bash
npm install --global openapi-postman-test-generator@0.9.0
openapi-postman --help
openapi-postman generate --spec ./openapi.yaml --out ./collection.json --env ./environment.json
```

Upgrade with the same install command. Version 0.9.0 generates for part of an API (`--tag`,
`--exclude-tag`), reports how much of the document the tests cover (`--coverage`), signs in with
OAuth2 client credentials (`--oauth-token`), and comes as a GitHub Action. Collections generated
without these options are unchanged; see [release notes](CHANGELOG.md).

For use as a library:

```bash
npm install openapi-postman-test-generator@0.9.0
```

```javascript
const { OpenApiPostmanGenerator } = require('openapi-postman-test-generator');
const spec = require('./openapi.json'); // Parsed, resolved OpenAPI document.
const generator = new OpenApiPostmanGenerator(spec);
const collection = generator.generate();
```

TypeScript declarations are included. Newman and authenticated AI providers are optional
external tools; deterministic collection generation does not need them.

## Build from source

```bash
npm install
npm run build
```

## Generate a collection

```bash
node dist/index.js generate \
  --spec ./fixtures/petstore.openapi.yaml \
  --out ./generated/api.collection.json \
  --env ./generated/api.environment.json
```

Generate additional negative tests and skip destructive operations:

```bash
node dist/index.js generate \
  --spec ./openapi.yaml \
  --negative \
  --safe \
  --config ./examples/openapi-postman.config.yaml
```

Generate the tests of a part of the API. A tag filter keeps the operations that carry one of the tags, or
leaves out the ones that do; names are compared without regard to case, a list may be comma-separated or
the flag repeated, and `Default` names the operations without tags:

```bash
node dist/index.js generate --spec ./openapi.yaml --tag Orders,Payments --exclude-tag Internal
```

`includeTags` and `excludeTags` in the configuration file hold the usual choice; a flag adds to it. Setup
and teardown requests are never filtered.

The legacy syntax remains supported:

```bash
npm run generate -- --spec ./openapi.yaml
```

## Run the generated tests

```bash
node dist/index.js run \
  --collection ./generated/api.collection.json \
  --environment ./generated/api.environment.json \
  --report-dir ./generated/reports
```

Or generate and run in one command by adding `--run`. The report directory contains `report.html`, `junit.xml`, and `newman.json`.

Use a JSON or CSV data file for data-driven runs and optionally cap total runtime:

```bash
node dist/index.js run \
  --collection ./generated/api.collection.json \
  --iteration-data ./test-data.csv \
  --run-timeout 300000 \
  --bail
```

## What the collection covers

`generate` ends with a summary of what the collection tests of the document:

```
Generated 14 requests
Coverage:     9/10 operations, 12/21 documented responses (1 operation left out: 1 in safe mode)
Uncovered:    9 documented error responses have no test; --negative generates them where it can
```

An operation is covered when the collection holds a request for it; the ones left out are counted with the
reason (disabled in the configuration, the tag filter, safe mode). A documented response is covered when a
generated request is written to expect it: the success responses always, the error responses that the
negative variants provoke (`--negative`). It is a statement about the collection, not about a run.

`--coverage <file>` writes the whole report as JSON: every operation with its tags, whether it is in the
collection, the responses the document describes and the ones a request expects. `default` is not a status
and is not counted.

```bash
node dist/index.js generate --spec ./openapi.yaml --negative --coverage ./generated/api.coverage.json
```

## OAuth2 client credentials

An API protected by OAuth2 needs an access token before its first request. By default the token is a
value you supply (`<scheme>_token` in the environment). With `--oauth-token`, or `oauthClientCredentials: true`
in the configuration, the collection fetches it itself: for every security scheme with a client credentials
flow (`flows.clientCredentials` in OpenAPI 3, `flow: application` in Swagger 2.0) a `Get access token`
request is put first in the `Setup` folder. It posts `grant_type=client_credentials` with the client id,
the client secret and the scopes of the document to the token endpoint, and keeps `access_token` where the
other requests read it.

```bash
node dist/index.js generate --spec ./openapi.yaml --oauth-token --run \
  --env-var oauth_clientId=my-client --env-var oauth_clientSecret="$CLIENT_SECRET"
```

The environment gains `<scheme>_clientId` and `<scheme>_clientSecret` (empty, to fill in or to pass with
`--env-var`) and `<scheme>_tokenUrl` (the endpoint the document names, to override for another
environment). The token request sends no API credentials. When no scheme has that flow, `generate` says so
and changes nothing. The same request is written to the Bruno folder and the k6 script.

## GitHub Action

```yaml
# .github/workflows/api-tests.yml
name: API tests
on: [pull_request]
jobs:
  api-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # start the API under test here, or point base-url at a deployed one
      - uses: vannt-dev/openapi-postman-test-generator@v0.9.0
        with:
          spec: openapi.yaml
          base-url: http://localhost:3000 # optional
          negative: true # optional
          exclude-tag: Internal # optional; tag and exclude-tag take a list
          oauth-token: true # optional
          env-vars: | # optional, one KEY=VALUE a line
            oauth_clientId=ci-client
            oauth_clientSecret=${{ secrets.API_CLIENT_SECRET }}
```

The action generates the collection, the environment and the coverage report into `generated/`
(`output-dir`), adds the coverage lines and the result of the run to the job summary, and fails the job
when an assertion fails. `run: false` only generates. Its outputs are `collection`, `environment`,
`coverage`, `report-dir` (with `report.html`, `junit.xml` and `newman.json`) and `failures`. It runs on
Linux and macOS runners.

## Bruno and k6 output

The generated tests can also be written for Bruno and for k6, next to the Postman files or from a collection generated earlier:

```bash
# While generating
node dist/index.js generate --spec ./openapi.yaml --bruno ./generated/bruno --k6 ./generated/api.k6.js

# From an existing collection
node dist/index.js convert \
  --collection ./generated/api.collection.json \
  --environment ./generated/api.environment.json \
  --bruno ./generated/bruno --k6 ./generated/api.k6.js
```

Run them with the tools themselves:

```bash
cd generated/bruno && bru run -r --env "<environment name>" --env-var bearerAuth_token=...
k6 run -e baseUrl=https://staging.example.com -e bearerAuth_token=... generated/api.k6.js
```

Requests, headers, bodies, authentication and variables are written in each tool's own form: `.bru` files in numbered folders with an environment file for Bruno, one script with a request table for k6. The test scripts are the collection's own. Each output carries a small stand-in for the part of Postman's `pm` object those scripts use, so a status check, a response-time limit, a schema assertion, an extracted identifier or a polled background job behaves the same in all three tools. In Bruno every `pm.test` is a test; in k6 it is a check, and the script's threshold fails the run when any check fails.

Things to know:

- The schema assertion uses a validator written for these outputs that covers the keywords the generator emits (types, `required`, `properties`, `additionalProperties`, `items`, `enum`, `const`, numeric and length bounds, `pattern`, `allOf`/`anyOf`/`oneOf`). Other keywords are ignored rather than failed. Postman and Newman keep using Ajv.
- The k6 script runs one virtual user once. Raise `vus` and `iterations` in its `options`, or pass `--vus` and `--duration`, to use it as a load test; the checks stay the same.
- A Bruno collection that has both folders and requests in a set order (setup, ordered operations, teardown) gets a `Requests` folder for the ordered ones, because Bruno runs subfolders before the requests beside them.
- Multipart file fields are sent as text parts in k6, and `--iteration-data` files are for Newman only.
- Secret environment values are not written out: Bruno lists them under `vars:secret`, and k6 takes them with `-e`.

Also exported as `toBrunoCollection` and `toK6Script`.

## Compare two versions of a spec

Before regenerating tests for a new version of an API, see what changed and whether existing clients survive it:

```bash
openapi-postman diff --old ./openapi.v1.yaml --new ./openapi.v2.yaml
```

```text
Breaking changes (2)
  DELETE /pets/{petId}  operation removed
  POST /pets  request body application/json: kind  new required property

Non-breaking changes (1)
  GET /pets  query parameter "cursor"  optional parameter added
```

The command exits with status 1 when it finds a breaking change, so a pipeline can stop on it; `--allow-breaking` keeps the exit status at 0, and `--format json` prints the changes as JSON (`severity`, `code`, `operation`, `location`, `message`). Either side may be a file or a URL, and a Swagger 2.0 document can be compared with the OpenAPI 3.x one that replaced it.

A change is breaking when a client written against the old version can fail against the new one:

| Where | Breaking | Not breaking |
| --- | --- | --- |
| Operations | removed | added, deprecated |
| Parameters | new required one, became required, type changed, enum value removed | new optional one, removed, became optional, enum value added |
| Request body | became required, media type removed, new required property, property became required, type changed | new optional property, property removed, media type added |
| Responses | success (2xx) response removed, media type removed, property removed, property no longer required, type changed | response added, other response removed, property added, enum value added |
| Security | an operation that needed no credentials now needs them | |

Path parameters are matched by position, so renaming `{id}` to `{petId}` is not a change. Not compared: descriptions and examples, response headers, numeric and length limits, `additionalProperties`, callbacks, links and servers. A changed `oneOf` or `anyOf` is reported as non-breaking with a note to compare it by hand, because the command does not judge it.

## Optional AI planning

The local CLI providers reuse the account session already established by their own login command. They do not require this project to store an API key.

Use Codex with its cached login:

```bash
node dist/index.js generate \
  --spec ./openapi.yaml \
  --ai \
  --ai-provider codex
```

Claude Code and Antigravity work the same way:

```bash
node dist/index.js generate --spec ./openapi.yaml --ai --ai-provider claude
node dist/index.js generate --spec ./openapi.yaml --ai --ai-provider antigravity
```

Configure automatic fallback when a CLI is unavailable, logged out, times out, or returns an invalid plan:

```bash
node dist/index.js generate \
  --spec ./openapi.yaml \
  --ai \
  --ai-provider codex \
  --ai-fallback claude,antigravity,openai
```

The OpenAI SDK provider still supports direct API access:

Set credentials and explicitly choose a model:

```bash
export OPENAI_API_KEY="your-key"
export OPENAI_MODEL="your-supported-model"

node dist/index.js generate \
  --spec ./openapi.yaml \
  --ai \
  --ai-provider openai \
  --plan-out ./generated/agent-plan.json
```

Every provider receives the same read-only planning prompt and must return the same schema-validated plan. Codex runs with a read-only sandbox and Claude runs in plan permission mode. The deterministic generator—not the AI provider—writes Postman scripts. Planned operation ordering, variable mappings, target substitutions, and negative scenarios are all validated and applied by the generator.

### Add any command-based provider

Define it in the project configuration without modifying source code:

```yaml
ai:
  provider: local-agent
  fallback: [codex]
  timeoutMs: 120000
  maxOutputBytes: 1048576
  providers:
    local-agent:
      type: command
      command: my-agent
      args: [--json-schema, "{schema}"]
      input: stdin
      output: stdout-json
```

Commands are launched directly without a shell. Supported argument placeholders are `{prompt}`, `{schema}`, `{schemaFile}`, `{outputFile}`, and `{model}`. The command must print either the plan JSON itself or a JSON envelope containing `structured_output`, `output_parsed`, `result`, or `response`; set `output: output-file` when it writes to `{outputFile}` instead. Library consumers can register an `AiProvider` implementation with `AiProviderRegistry` for SDK-based integrations.

## Configuration

See [`examples/openapi-postman.config.yaml`](examples/openapi-postman.config.yaml). Explicit CLI flags override config values.

```yaml
baseUrl: https://test-api.example.com
responseTimeMs: 2000
safeMode: true
includeNegative: true
variables:
  tenantId: test-tenant
operationOrder: [login, createUser, getUser, deleteUser]
variableMappings:
  - sourceOperationId: createUser
    responseJsonPath: $.data.id
    variable: userId
    targetOperationIds: [getUser, deleteUser]
disabledOperations: [chargeCreditCard]
includeTags: [Orders, Payments]
excludeTags: [Internal]
oauthClientCredentials: true
negativeScenarios:
  - operationId: createUser
    name: email is required
    kind: missing_required
    field: email
profiles:
  staging:
    baseUrl: https://staging-api.example.com
    environmentName: Staging API
    variables:
      tenantId: staging-tenant
ai:
  provider: codex
  fallback: [claude, antigravity]
  providers:
    codex:
      type: codex
      command: codex
```

Select a profile with `--profile staging`. Base variables are merged with profile variables, with profile values taking precedence. A login operation can bootstrap later authenticated requests by mapping its returned token to the security variable (for example, `bearerAuth_token`) and placing login first in `operationOrder`.

## Setup, teardown, async jobs, and OTP

OpenAPI does not describe seed data, background jobs, or one-time passwords, so the generator
does not guess them. Declare them in the project configuration instead:

```yaml
setup:
  - name: Seed tenant
    method: POST
    url: /admin/seed                  # a leading "/" is prefixed with {{baseUrl}}
    headers: { X-Admin-Key: "{{adminKey}}" }
    body: { name: test }              # objects are sent as JSON, strings as raw text
    expectStatus: [201]               # default: any 2xx
    extract: { tenantId: $.id }       # stored as a collection variable
teardown:
  - name: Delete tenant
    method: DELETE
    url: /admin/tenants/{{tenantId}}
asyncOperations:
  - operationId: createExport
    statusJsonPath: $.status
    successValues: [done]
    failureValues: [failed]
    intervalMs: 1000                  # default 1000
    maxAttempts: 30                   # default 30
    extract: { exportUrl: $.url }     # applied when the job succeeds
```

- `setup` requests run first, in a `Setup` folder; `teardown` requests run last, in a
  `Teardown` folder. They are explicit, so safe mode keeps them. They send no API credentials
  unless `inheritAuth: true` is set, because their URLs may point outside the API.
- Extracted values (and identifiers captured by `variableMappings`) also replace a variable of
  the same name in the environment, so placeholders in the generated environment file do not
  hide them.
- Each async operation gets a `Poll: <operationId>` request right after it. By default it polls
  the URL in the operation's 2xx `Location` response header, resolved against the request URL;
  set `statusUrl` (for example `/exports/{{exportId}}`) to poll a fixed endpoint instead. The
  poll repeats until a success or failure value appears, or fails after `maxAttempts`. It fails
  at once, without retrying, when there is no status URL.
- The poll reuses the operation's credentials, API-key headers, and cookies. Set
  `inheritAuth: false` when the status URL is a presigned storage link that rejects them.
  Newman follows redirects, so a `303 See Other` API should use `statusUrl`.
- For OTP flows, either fetch the code from a test-only endpoint with a `setup` request and
  `extract: { otp: $.code }`, or pass it when running:

  ```bash
  node dist/index.js run --collection ./generated/api.collection.json --env-var otp=123456
  ```

  `--env-var KEY=VALUE` can be repeated and also works with `generate --run`. The values are
  masked in this tool's error messages, but they are visible to other local processes and
  Newman writes the environment into `newman.json`; prefer CI secrets for real credentials and
  do not publish the report directory.

## Development

```bash
npm run lint
npm test
npm run check
npm pack --dry-run
```

The test suite includes Swagger 2.0 and OpenAPI 3.x smoke tests, regression tests, provider contract and fallback tests, a real local HTTP/Newman end-to-end run, tests that run the generated k6 script and Bruno scripts against stand-ins for those tools, and Windows runner tests. Newman remains an external runtime tool so its legacy transitive dependencies are not shipped to library consumers.

## Safety and limitations

OpenAPI describes an HTTP contract, not every business prerequisite. Seed data, OTP flows, asynchronous jobs, and environment cleanup need explicit configuration (see [Setup, teardown, async jobs, and OTP](#setup-teardown-async-jobs-and-otp)); payment providers and other third-party flows are not automated. Teardown requests do not run when `--bail` stops a run early or Newman is interrupted, so use a disposable test environment. Use `--safe` first against unfamiliar APIs, review generated requests, and never store secrets in committed environment files. Enabling AI sends the summarized API contract to the selected provider; do not enable it for specifications that your provider is not authorized to process.

## License

[MIT](LICENSE)
