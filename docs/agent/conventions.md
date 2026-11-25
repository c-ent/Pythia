# Conventions

Read this when unsure how something is done here. Only rules that the linter, formatter and compiler do not enforce. Rules every session needs are in `AGENTS.md`.

## TypeScript & Node

- Use explicit return types on exported service and DB functions.
- Never read `process.env` scattered across modules; parse and validate all environment variables once at startup in a single `config` module.
- Decide responsive layout from viewport width, not user-agent or device type.

## Data, SQL & Errors

- Validate all external input (HTTP bodies, query params, MCP tool arguments, uploaded Takeout zips, YAML frontmatter) at the boundary before passing it to services.
- Never interpolate user input into SQL strings; always use parameterized queries (`$1`, `$2`).
- Return structured JSON errors (`{ error: { code, message } }`) from Express error middleware; never leak stack traces, DB errors, or secret values to the client.
- When logging secrets-scan hits, log only `{ file, droppedCount }`—never log matched text or regex capture groups.

## Embeddings & Search

- Always attach `search_document: ` when embedding chunks and `search_query: ` when embedding user queries for `nomic-embed-text`.
- Batch embedding requests in groups of 16–32 chunks; never fire unbounded concurrent requests to Ollama.

## Tests

- Tests sit beside the file they test (`*.test.ts`).
- Logic depending on time (sync schedules, `recent_changes`, rate limits) or randomness takes `now` or a clock dependency as an argument.
- Every bug fix comes with a test that fails without the fix.
- Security guardrails (secrets blocklist, `allow_llm = false` filtering, auth 401/429) must have dedicated unit tests.

## Comments and docs

- A comment explains why the code is the way it is, not what a standard API does.
- No history in code comments: no dated notes, "used to", "was removed", or commit IDs.
- Docs state facts plainly. Remove unused code instead of commenting it out.
- Add a new rule here only after the same mistake has been corrected twice.
