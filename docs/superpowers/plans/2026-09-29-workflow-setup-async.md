# Plan: setup/teardown, async polling, OTP guidance

Spec: `docs/superpowers/specs/2026-09-29-workflow-setup-async-design.md`. Executed inline, TDD.

1. **Types and config.** Add `WorkflowRequest`, `AsyncOperation`; add `setup`, `teardown`,
   `asyncOperations` to `ProjectConfig` and `GeneratorOptions`; zod schemas in `config.ts`.
   Tests: valid config loads, lower-case method normalized, unknown key rejected.
2. **Setup/teardown folders.** `generate()` wraps the body with `Setup` / `Teardown` folders;
   workflow items get status + extract scripts. Extract the JSONPath helper lines into one
   function shared with `variableMappings`. Tests: placement with and without
   `operationOrder`, safe mode keeps a teardown `DELETE`, `/path` prefixed with `{{baseUrl}}`.
3. **Async polling.** Poll item after the positive request; Location capture in the
   operation's test script when `statusUrl` is absent; warning for unknown ids. Tests: item
   order, script contents, warning.
4. **`--env-var`.** Repeatable flag in `index.ts` for `run` and `generate --run`;
   `RunOptions.envVars` → Newman `--env-var`. Test via the fake-Newman runner test.
5. **End to end.** Extend `test/e2e.js` with seed, 202 job (pending ×2 → done), teardown.
6. **Docs.** README section + limitations update, example config.
7. `npm run check`, fresh review, PR.
