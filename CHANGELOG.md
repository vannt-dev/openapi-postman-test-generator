# Changelog

## Unreleased

- Preserved configured/AI workflow order across tags and applied response mappings to target path, query, header, and top-level body fields.
- Added array/bracket JSONPath extraction and support for mapping sources using any HTTP method.
- Applied AI-planned negative scenarios and changed boundary negatives to genuinely out-of-range values.
- Added strict Zod validation for project configuration, named environment profiles, iteration data, runner timeouts, and `generate --run --bail` support.
- Added OpenAPI `2XX` responses, named parameter examples, repeated query parameters, API-key cookies, combined security handling, and more JSON Schema keywords.
- Prevented stale Newman reports from masking failed invocations, closed stdin for Windows npm PowerShell shims, and added request-level HTML reporting.
- Replaced the synthetic runner check with a real local HTTP/Newman end-to-end test and expanded regression coverage.
- Updated the OpenAI SDK and Node.js type definitions without adding Newman's vulnerable legacy dependency tree to the published package.

## 0.3.1 - 2026-09-08

- Fixed `openapi-postman run` crashing with `EINVAL` on Windows: `execFile()` cannot spawn a `.cmd` file directly without `shell: true`, so newman is now launched through the same safe Windows shim resolution used by the AI CLI providers.
- Added Windows-specific test coverage (`resolveWindowsCommand`, an end-to-end `runCollection()` run) and added `windows-latest` to the CI matrix so this class of bug is caught automatically going forward.
- Replaced untyped `Record<string, unknown>` casts on generated Postman requests with proper `PostmanRequest`/`PostmanHeader`/`PostmanBody` types.
- Deduplicated negative-test-variant generation and security-scheme classification in `OpenApiPostmanGenerator`, and extracted pure helpers (`exampleFor`, `toJsonSchema`, `classifySecurityScheme`) into `src/generator/`.
- Deduplicated the CLI AI provider executor/unwrap logic shared by the Claude and Antigravity providers.

## 0.3.0 - 2026-09-08

- Replaced the OpenAI-only planner integration with a provider-neutral contract and registry.
- Added Codex, Claude Code, Antigravity, OpenAI SDK, and safe custom-command adapters.
- Added provider fallback, timeouts, output limits, shared schema validation, and read-only planning prompts.
- Added provider tests and configuration examples for account-based CLI authentication.

## 0.2.0 - 2026-09-08

- Added status-specific and media-type-aware response validation.
- Added multipart, cookie, parameter serialization, negative tests, boundary tests, and safe mode.
- Added operation ordering, variable mappings, YAML configuration, and an optional structured AI planner.
- Added a Newman runner with JSON, JUnit, and HTML reports.
- Added end-to-end tests, CI, package metadata, and English documentation.
