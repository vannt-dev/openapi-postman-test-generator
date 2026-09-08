# OpenAPI Postman Test Generator

Generate runnable Postman collections, environments, workflow-aware test scripts, negative cases, and Newman reports from Swagger 2.0 or OpenAPI 3.x specifications.

The core generator is deterministic. An optional AI planner uses structured model output to infer operation order and identifier mappings, while the deterministic generator remains responsible for producing the collection.

## Features

- Swagger 2.0 and OpenAPI 3.x files or URLs
- JSON, form-urlencoded, multipart uploads, text, and binary responses
- Path, query, header, cookie, array, and deep-object parameters
- Bearer, Basic, OAuth token placeholders, API keys, and combined security requirements
- Status-specific JSON Schema assertions and media-type-aware response handling
- CRUD-oriented ordering with configurable operation order
- Identifier extraction between dependent requests
- Optional missing-field, invalid-enum, boundary, and unauthorized cases
- Safe mode that excludes `DELETE` operations
- Newman execution with CLI, JSON, JUnit, and standalone HTML reports
- Optional OpenAI workflow planner with Zod Structured Outputs

## Requirements

- Node.js 20 or newer
- A Swagger 2.0 or OpenAPI 3.x document
- Newman available on `PATH` when running generated collections (`npm install --global newman`)
- `OPENAI_API_KEY` only when `--ai` is enabled

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

## Optional AI planning

Set credentials and explicitly choose a model:

```bash
export OPENAI_API_KEY="your-key"
export OPENAI_MODEL="your-supported-model"

node dist/index.js generate \
  --spec ./openapi.yaml \
  --ai \
  --plan-out ./generated/agent-plan.json
```

The AI planner only returns a schema-validated plan containing operation order, response-to-variable mappings, negative scenarios, and warnings. It does not write arbitrary Postman scripts.

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
```

## Development

```bash
npm run lint
npm test
npm run check
npm pack --dry-run
```

The test suite includes Swagger 2.0 and OpenAPI 3.x smoke tests, advanced generator cases, and runner/report integration tests. Newman remains an external runtime tool so its legacy transitive dependencies are not shipped to library consumers.

## Safety and limitations

OpenAPI describes an HTTP contract, not every business prerequisite. Seed data, OTP flows, payment providers, asynchronous jobs, and environment-specific cleanup can still require configuration. Use `--safe` first against unfamiliar APIs, review generated requests, and never store secrets in committed environment files.

## License

[MIT](LICENSE)
