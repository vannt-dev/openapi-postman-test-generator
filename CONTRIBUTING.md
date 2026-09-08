# Contributing

1. Create a branch from `main`.
2. Add or update fixtures for behavior changes.
3. Run `npm run check`.
4. Open a focused pull request that explains the OpenAPI case being addressed.

Do not commit generated collections, credentials, API keys, or production response data.

AI provider changes must preserve the provider-neutral `AgentPlan` contract. Add tests with an injected command executor or an in-memory provider; automated tests must not require a real account, network access, or API key.

New command integrations must use argument arrays with `shell: false`, enforce timeout and output limits, validate structured output, and clean up temporary files.
