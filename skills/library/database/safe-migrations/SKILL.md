---
name: safe-migrations
description: Schema changes that do not break a running system
tier: library
domains: [database, backend]
trigger: migration, migrate, schema, column, table, index, database, sql, gorm automigrate
---
- Additive first: add nullable columns or new tables; backfill; only then add constraints.
- Never rename or drop a column in the same deploy that stops using it. Expand, migrate
  code, contract later.
- Large tables: create indexes concurrently where the database supports it; avoid
  long-running locks.
- Every migration must be re-runnable or guarded, and have a clear rollback story.
- Keep migrations separate from seed data. Never embed real customer data or secrets.
