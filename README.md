# OpenAPI Postman Test Generator

[![CI](https://github.com/vannt-dev/openapi-postman-test-generator/actions/workflows/ci.yml/badge.svg)](https://github.com/vannt-dev/openapi-postman-test-generator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933.svg)](https://nodejs.org/)
[![npm](https://img.shields.io/npm/v/openapi-postman-test-generator.svg)](https://www.npmjs.com/package/openapi-postman-test-generator)

**[View the project landing page →](https://vannt-dev.github.io/openapi-postman-test-generator/)**

Generate runnable Postman collections, environments, workflow-aware test scripts, negative cases, and Newman reports from Swagger 2.0 or OpenAPI 3.x specifications.

The core generator is deterministic. An optional AI planner uses structured model output to infer operation order and identifier mappings, while the deterministic generator remains responsible for producing the collection.

## Features

- Swagger 2.0 and OpenAPI 3.x files or URLs
- JSON, form-urlencoded, multipart uploads, text, and binary responses
- Path, query, header, cookie, array, and deep-object parameters
- Bearer, Basic, OAuth token placeholders, API keys, and combined security requirements
- Status-specific JSON Schema assertions and media-type-aware response handling
- CRUD-oriented ordering with configurable operation order
- Identifier extraction and target substitution between dependent requests
- Optional missing-field, invalid-enum, boundary, and unauthorized cases
- Named environment profiles and JSON/CSV iteration data
- Safe mode that excludes `DELETE` operations
- Newman execution with CLI, JSON, JUnit, and standalone HTML reports
- Per-request HTML reporting with status, duration, and assertion counts
- Provider-neutral AI planner with schema-validated output and fallback providers
- Built-in OpenAI SDK, Codex CLI, Claude Code, and Antigravity CLI adapters
- Safe custom-command adapter and a public provider registry for future integrations

## Requirements

- Node.js 20 or newer
- A Swagger 2.0 or OpenAPI 3.x document
- Newman available on `PATH` when running generated collections (`npm install --global newman`)
- An authenticated provider CLI when using Codex, Claude, or Antigravity
- `OPENAI_API_KEY` only when the OpenAI SDK provider is selected

## Install and build

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

## Development

```bash
npm run lint
npm test
npm run check
npm pack --dry-run
```

The test suite includes Swagger 2.0 and OpenAPI 3.x smoke tests, regression tests, provider contract and fallback tests, a real local HTTP/Newman end-to-end run, and Windows runner tests. Newman remains an external runtime tool so its legacy transitive dependencies are not shipped to library consumers.

## Safety and limitations

OpenAPI describes an HTTP contract, not every business prerequisite. Seed data, OTP flows, payment providers, asynchronous jobs, and environment-specific cleanup can still require configuration. Use `--safe` first against unfamiliar APIs, review generated requests, and never store secrets in committed environment files. Enabling AI sends the summarized API contract to the selected provider; do not enable it for specifications that your provider is not authorized to process.

## License

[MIT](LICENSE)
