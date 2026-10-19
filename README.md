# fastifygen

Generate a class-based Fastify REST API (controller / service / repository) from a PostgreSQL schema, with Directus-style endpoints, per-table permissions and multitenancy.

> Status: step 1 of 4. The config format and schema introspection are in place; code generation comes next.

## Roadmap

1. **Config and schema reading** — `config.json` format, its JSON Schema, and Postgres introspection into a JSON model. ✅
2. **Shared core** — class-based Knex repository, service and controller keyed by table name; Directus query parser (`fields`, `filter`, `sort`, `limit`, `offset`, `page`, `search`) with relational fields; tenant scoping via `tenant_id` and `SET LOCAL` for row-level security.
3. **Per-table generation** — a Fastify plugin per table using full `fastify.route()` declarations, JSON schemas, permissions in route `config`, auth and permission hooks, extension classes and RLS policy SQL.
4. **CLI and test run** — `fastifygen generate`, checked end to end against a sample schema.

## Quick start

```bash
npm install
npm run build
export DATABASE_URL=postgres://user:pass@localhost:5432/app   # or put it in .env
node dist/cli.js introspect -c examples/config.json -o model.json
```

`introspect` prints the database model as JSON: tables, columns (with TypeScript and JSON Schema types), primary keys, unique constraints, foreign keys in both directions, enums, and whether each table is tenant-scoped.

## config.json

Every setting lives in one file. Only `database` is required; everything else has defaults. Point `$schema` at `schema/config.schema.json` for editor autocompletion.

```json
{
  "$schema": "./node_modules/fastifygen/schema/config.schema.json",
  "database": { "url": "${DATABASE_URL}", "schema": "public" },
  "output": { "dir": "./generated" },
  "tables": { "include": ["*"], "exclude": ["knex_migrations", "knex_migrations_lock"] },
  "api": { "prefix": "/items", "defaultLimit": 100, "maxLimit": 1000 },
  "tenancy": { "enabled": true, "column": "tenant_id", "rls": true, "settingName": "app.tenant_id" },
  "auth": { "mode": "jwt", "tenantClaim": "tenant_id", "permissionsClaim": "permissions" },
  "permissions": { "format": "{action}:{table}", "actions": ["create", "read", "update", "delete"] },
  "overrides": {
    "users": { "hiddenColumns": ["password_hash"] },
    "audit_log": { "readOnly": true }
  }
}
```

| Section | What it controls |
| --- | --- |
| `database` | Connection (`url`, or `host`/`port`/`user`/`password`/`database`/`ssl`) and the Postgres `schema` to read. |
| `output.dir` | Where the generated API is written, relative to `config.json`. |
| `tables` | `include` / `exclude` glob patterns (`*` wildcard). `exclude` wins. |
| `api` | Route prefix and pagination limits. |
| `tenancy` | Tables with `column` are tenant-scoped; `rls` generates row-level security policies reading `settingName`. |
| `auth` | Where the tenant id and permission list come from (`jwt`, `header` or `none`). |
| `permissions` | Permission name template and which actions get one, e.g. `create:company`. |
| `overrides` | Per table: `skip`, `readOnly`, `hiddenColumns`, `routeName`. |

`${VAR}` and `${VAR:-fallback}` are replaced from the environment, so secrets stay out of the file. The CLI loads `.env` from the current folder if it exists (`--env-file` to change it).

## Programmatic use

The CLI is a thin wrapper; a frontend or script can drive the same classes:

```ts
import { ConfigLoader, Generator } from 'fastifygen';

const { config } = await new ConfigLoader().load('config.json');
const model = await new Generator(config).introspect();
```

## Development

```bash
docker compose up -d   # local Postgres 16
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/fastifygen_test
npm test
```

The introspection tests load `examples/sample-schema.sql`, which **drops and recreates the `public` schema**, so point `TEST_DATABASE_URL` at a throwaway database. Without it, those tests are skipped.

After changing `src/config/config.schema.ts`, run `npm run schema:write` to refresh `schema/config.schema.json`.
