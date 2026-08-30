# Migrating to 0.3.0 (one Postgres database per instance)

0.3.0 switches the supervised backends from `-d postgres-v5-multitenant` to `-d postgres-v5`.
Instead of every instance sharing one database and being told apart by an `instance_name` column,
each instance now owns a database named after it (`lucky-owl-755` lives in `lucky_owl_755`).

**This is a data migration, not a flag flip.** The two layouts have different table shapes, so the
existing rows in the shared database are not readable by a `postgres-v5` backend. Every instance
has to be exported before the upgrade and imported after it.

## Why the change

Convex removed `postgres-v5-multitenant` as dead code in
[#55981](https://github.com/get-convex/convex-backend/pull/55981). The last release that still has
it is `precompiled-2026-08-10-c0cb7ae`; from `precompiled-2026-08-11-1f851c0` onward a backend
started in that mode exits immediately:

```
error: invalid value 'postgres-v5-multitenant' for '--db <DB>'
  [possible values: sqlite, mysql-v5, mysql-v5-multitenant, mysql-v6-multitenant, postgres-v5]
```

Staying on the old mode meant freezing the Convex backend at a May 2026 build forever. `postgres-v5`
meanwhile learned to derive its database name from `--instance-name`, which is what makes a shared
cluster workable without the multitenant mode.

## Before you start

- Budget downtime for the whole fleet. Every instance is unavailable from the export until its
  import finishes.
- Have `npx convex` available, plus each instance's URL and admin key (the orchestrator's instance
  detail view shows both).
- A backup zip does **not** contain environment variables, functions, schema, crons or auth config.
  Those come back via `convex env set` and `convex deploy`, so collect them first.

## Steps

### 1. Freeze anything that writes

Stop the applications, agents and cron jobs that talk to the instances. A client writing during the
export lands in the old database and is lost.

### 2. Capture what the backup does not cover

Per instance, with the **old** image still running:

```bash
export CONVEX_SELF_HOSTED_URL='https://<instance>.<base-domain>'
export CONVEX_SELF_HOSTED_ADMIN_KEY='<admin key>'
npx convex env list > <instance>-env-vars.txt
```

### 3. Take a fresh backup of every instance

Trigger a backup per instance (UI button, or `POST /api/instances/<name>/backup`) and wait for
`status: "complete"`. Note the backup id, that is what you restore from in step 6.

The instances are only stopped, never deleted, so their MinIO backup buckets survive the migration
untouched. Still pull the zips off the host as a second copy, because at that point they are the
only representation of the data that is not in the about-to-be-abandoned database layout:

```bash
curl -fsS -H "Authorization: Bearer $ORCHESTRATOR_ADMIN_TOKEN" \
  "http://127.0.0.1:8080/api/instances/<name>/backups/<backup-id>/download" \
  -o <instance>-premigration.zip
```

### 4. Stop every instance

`POST /api/instances/<name>/stop` for each one, or the Stop button. This matters: the orchestrator
only re-spawns instances whose stored status is `running`, so stopping them now prevents empty
backends from going live the moment the new image boots.

### 5. Upgrade the image

```bash
docker compose pull && docker compose up -d
```

The orchestrator applies SQLite migration `007_postgres_database`, which renames the stored
`postgres_schema` column and fills it with the per-instance database name.

### 6. Create each instance's database

The orchestrator only creates a database when an instance is created; starting one asserts that its
database is there and refuses to boot otherwise, so that a lost database can never masquerade as a
healthy empty instance. Migrated instances therefore need theirs made once, by hand:

```bash
docker compose exec postgres \
  psql -U convex -d postgres -c 'CREATE DATABASE lucky_owl_755'
```

The name is the instance name with dashes replaced by underscores. Repeat per instance.

Two things to watch here, because this is the one step the orchestrator cannot guard:

- **The command has to actually succeed.** If it answers `database "…" already exists`, stop.
  Something else on the cluster owns that name, and starting the instance would point a Convex
  backend at a stranger's database. `create` refuses this case with a 409; a hand-made database
  bypasses that check.
- **Use the same role the backends connect as** (`POSTGRES_CLUSTER_URL`). Since Postgres 15 a
  database created by a different role leaves the backend unable to create its tables in the
  `public` schema.

### 7. Bring each instance back, one at a time

Start the instance (`POST /api/instances/<name>/start`). The backend boots into the empty database.
The instance is now live and **empty**, so do not point clients at it yet.

Then, for that instance:

1. **Restore the data** from the backup taken in step 3, which is still in the instance's MinIO
   bucket: the Restore button, or

   ```bash
   curl -fsS -X POST -H "Authorization: Bearer $ORCHESTRATOR_ADMIN_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"backupId":"<backup-id>","confirmName":"<name>"}' \
     http://127.0.0.1:8080/api/instances/<name>/restore
   ```

   If MinIO is gone too, upload the zip from step 3 instead
   (`POST /api/instances/<name>/restore-from-upload` with the `x-confirm-name` header).

2. **Re-set the environment variables** from the file captured in step 2:
   `npx convex env set <KEY> <VALUE>` for each.
3. **Redeploy the functions**: `npx convex deploy` from the application repo, or run the CI job
   that normally deploys it.
4. **Verify** before moving on: the dashboard loads, a known document is present, an HTTP action
   answers, scheduled functions are listed.

### 8. Unfreeze, then clean up

Let the clients back in. Once every instance has been verified for long enough that you trust it,
drop the now-unused shared database on the cluster:

```sql
DROP DATABASE convex_tenants;  -- whatever POSTGRES_SHARED_DB used to be
```

`POSTGRES_SHARED_DB` itself is gone from the config; leaving a stale value in `.env` is harmless,
the orchestrator ignores it.

## If a restore goes wrong

The instance's own `pre-restore` backup (taken automatically before every restore) and the
pre-migration zip from step 3 are both still there. See
[Backups and restore](./backups.md) § Recovery playbooks.
