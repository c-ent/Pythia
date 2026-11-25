---
name: add-sql-migration
description: Use when adding or modifying PostgreSQL tables, columns, or indexes in Pythia.
---

# Add a SQL migration

1. Confirm with the owner before changing the database schema or stored data format (see Boundaries in `AGENTS.md`).
2. Create a sequentially numbered SQL file in `server/migrations/` (e.g. `002_add_example.sql`) using idempotent DDL where practical (`IF NOT EXISTS`).
3. Run the migration runner twice against the local Docker Postgres instance to verify it applies cleanly and is idempotent.
4. Update `docs/agent/spec.md` and `docs/agent/architecture.md` if table contracts changed.
5. Run `npm run build`, `npm run typecheck`, and `npm test`, then update `docs/agent/progress.md`.
