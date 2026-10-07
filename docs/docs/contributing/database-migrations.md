---
title: Database migrations
description: How Lifer changes its database schema, and the rules for writing a migration.
---

# Database migrations

Every change to Lifer's database schema is a numbered SQL file in `packages/data-pipeline/migrations`. Installs apply new ones by themselves when they start: the Docker entrypoint and the desktop app both run `packages/data-pipeline/src/migrate.ts` before the API. In development, run it with:

```bash
npm run migrate
```

It's safe to run any number of times.

## How it works

`migrate.ts`:

1. Takes a Postgres advisory lock, so two processes starting at once can't migrate at the same time.
2. Reads the `schema_migrations` table, which lists the file name of every migration already applied.
3. Sorts the `.sql` files by name and applies each one not in that list, **each in its own transaction**: the file's SQL and its row in `schema_migrations` commit together, or neither does. A failing migration rolls back and stops the run.

Because migrations are tracked by file name, renaming a file makes it run again.

## Adding a migration

1. Look up the highest number in `packages/data-pipeline/migrations`, and add one.
2. Name the file `NNN_snake_case_description.sql`, three digits, for example `122_trip_cover_photo.sql`.
3. Write plain SQL. Prefer statements that are safe on a database in any state the previous migrations could leave it in.
4. Run `npm run migrate`, then `npm run check:migrations`, which fails on a duplicate number or a badly formed name.

If two pull requests claim the same number, the one merged second renumbers its migration before merging.

The gaps at 078, 079 and 083 are historical. Don't fill them: new migrations always go after the highest number.

## Rules

- **Forward only.** There are no down migrations, and Lifer can't run on a database a newer version has migrated. To undo something, write a new migration. This is why users [back up before updating](../install/upgrading.md).
- **Never edit or rename a migration once it's in a release.** Installs that already applied it won't run it again, so a change would leave them different from new installs.
- **Keep each one small and focused.** One schema change per file is easiest to review.
- **Think about big tables.** A migration runs while the user waits for Lifer to start. Rewriting every row of a large table, or building an index on one, can take minutes on a big library. Say so in the pull request.
- **Only use extensions Lifer already needs:** `pgcrypto`, `pg_trgm` and `unaccent`. Lifer doesn't use PostGIS, and must run on plain Postgres 16 or newer, including the desktop app's embedded one.
- **The catalog is data, not schema.** Species, regions and checklists reach installs through the catalog seed and packs, not migrations. See [Data pipeline](./data-pipeline.md).
