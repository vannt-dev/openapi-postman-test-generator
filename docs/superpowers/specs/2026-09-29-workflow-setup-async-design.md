# Setup/teardown requests, async polling, and OTP guidance

Date: 2026-09-29. Status: approved for implementation (option A: one spec covering all three parts).

## Goal

The README "Safety and limitations" section says seed data, OTP flows, async jobs, and
environment cleanup need manual work. OpenAPI cannot describe these, so the generator will not
guess them. Instead, the project config gets explicit, declarative hooks that the deterministic
generator turns into Postman items and scripts.

Success: a user can seed data, wait for a 202-style job, feed an OTP, and clean up, all from the
config file and CLI flags, without editing the generated collection by hand.

## Non-goals

- Automatic OTP retrieval from email/SMS providers.
- Guaranteed cleanup after `--bail` (Newman stops the whole run; documented).
- AI planner changes. The plan schema stays the same.
- Per-profile setup/teardown lists.

## Config (ProjectConfig and GeneratorOptions)

```yaml
setup:
  - name: Seed tenant
    method: POST
    url: /admin/seed            # a leading "/" is prefixed with {{baseUrl}}
    headers: { X-Admin-Key: "{{adminKey}}" }
    body: { tenant: test }      # object/array -> JSON, string -> raw text
    expectStatus: [200, 201]    # default: any 2xx
    extract: { tenantId: $.id } # variable -> JSONPath, stored as a collection variable
teardown:
  - name: Reset tenant
    method: DELETE
    url: /admin/tenants/{{tenantId}}
asyncOperations:
  - operationId: createExport
    statusUrl: /exports/{{exportId}}   # optional; default: the operation's Location header
    statusJsonPath: $.status
    successValues: [done]
    failureValues: [failed]            # optional
    intervalMs: 1000                   # optional, default 1000
    maxAttempts: 30                    # optional, default 30
    extract: { downloadUrl: $.url }    # optional, applied on success
```

Validated with zod (strict objects). `method` accepts any case and is normalized to upper case.

## Collection layout

- `setup` becomes a top-level folder named `Setup`, placed first.
- `teardown` becomes a top-level folder named `Teardown`, placed last.
- Both are explicit, so they are kept in safe mode (safe mode only drops generated `DELETE`
  operations).
- Each workflow request gets a status assertion (`expectStatus` or 2xx) and, when `extract` is
  set, a script that stores the values with `pm.collectionVariables.set`. The JSONPath helper
  is shared with the existing `variableMappings` script.

## Async polling

- For each configured `operationId` that is generated, a `Poll: <operationId>` item is inserted
  right after the positive request (before negative variants).
- Without `statusUrl`, the operation's test script stores its `Location` header in
  `<sanitizedId>_statusUrl`. Absolute URLs are kept; `/path` is joined to the origin of
  `baseUrl`; other relative paths are joined to `baseUrl`.
- The poll item is a `GET`. Its pre-request script waits `intervalMs` (via `setTimeout`) on
  every attempt after the first. Its test script reads `statusJsonPath`:
  - success value → passing "Async job completed" test, apply `extract`, reset the counter;
  - failure value → failing test naming the status, reset the counter;
  - otherwise, while attempts < `maxAttempts` → increment the counter and re-run itself with
    `pm.execution.setNextRequest` (falls back to `postman.setNextRequest`);
  - otherwise → failing test with the last status, reset the counter.
- Unknown `operationId` → generator warning, like other config references.

## OTP

No generator logic. Two documented patterns:

1. A `setup` request to a test-only OTP endpoint with `extract: { otp: $.code }`.
2. Runtime injection: new repeatable `--env-var KEY=VALUE` flag on `run` and `generate --run`,
   passed straight to Newman's `--env-var`. Also usable for short-lived tokens in CI. The README
   warns that command-line values are visible in the process list.

## Testing

- Unit (test/regression.js): folder placement, safe-mode retention, extraction script,
  poll item placement and scripts, Location capture, unknown operation warning, config
  validation errors.
- End to end (test/e2e.js): local HTTP server with a seed endpoint, a 202 job that reports
  `pending` twice then `done`, and a teardown endpoint; Newman run passes and the server sees
  the teardown call. Runner test for `--env-var` argument passing.

## Docs

README: new "Setup, teardown, async jobs, and OTP" section; the limitations paragraph points to
it and states the `--bail` cleanup caveat. `examples/openapi-postman.config.yaml` gains the new
keys.
