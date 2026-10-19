# fastifygen

Generate a class-based Fastify REST API (controller / service / repository) from a PostgreSQL schema, with Directus-style endpoints, per-table permissions and multitenancy.

> Status: step 2 of 4. Config, schema introspection and the shared runtime core are in place; per-table code generation comes next.

## Roadmap

1. **Config and schema reading** — `config.json` format, its JSON Schema, and Postgres introspection into a JSON model. ✅
2. **Shared core** — class-based Knex repository, service and controller keyed by table name; Directus query parser (`fields`, `filter`, `sort`, `limit`, `offset`, `page`, `search`) with relational fields; tenant scoping via `tenant_id` and `SET LOCAL` for row-level security. ✅
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

## Runtime core

`src/runtime/` is the shared, table-agnostic core every generated API runs on (also importable as `fastifygen/runtime`). It depends only on Knex and Fastify.

| Class | Job |
| --- | --- |
| `ItemsController` | HTTP layer. Handlers (`readMany`, `readOne`, `create`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`) plug straight into `fastify.route({ handler })`. Responses are `{ data, meta? }`. |
| `ItemsService` | Permissions, read-only tables, transactions and the RLS setting. Subclass per table and override `prepareCreate` / `prepareUpdate` for custom logic. |
| `ItemsRepository` | Knex queries for one table: tenant scoping, fields, filters, search, sort, pagination, nested relations, writes. |
| `QueryParser`, `FieldsResolver`, `FilterApplier` | Directus query parameters. |
| `PermissionChecker` | `{action}:{table}` checks, with `*`, `read:*` and `*:company` wildcards. |
| `ErrorMapper` | Directus error format (`{ errors: [{ message, extensions: { code } }] }`), including Postgres constraint errors. |

### Endpoints (Directus-style)

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /items/company` | | `{ data: [...], meta? }` |
| `GET /items/company/:id` | | `{ data: {...} }` (composite keys: `/items/project_members/3,7`) |
| `POST /items/company` | one item or an array | the created item(s) |
| `PATCH /items/company/:id` | changes | the updated item |
| `PATCH /items/company` | `{ keys, data }` or an array of items with their keys | the updated items |
| `DELETE /items/company/:id` | | 204 |
| `DELETE /items/company` | an array of keys or `{ keys }` | 204 |

Writes answer 204 when the caller may write but not read the table.

### Query parameters

- `fields=*,company_id.name,employee.first_name` selects columns and nested relations (up to 5 levels). Many-to-one relations use the foreign key column name; one-to-many relations use the referencing table's name (or `{table}_by_{column}` when ambiguous). A bare one-to-many name returns the related primary keys.
- `filter` as JSON or brackets: `filter[status][_eq]=active`, `filter[company_id][name][_eq]=Acme`, `filter[employee][_some][salary][_gt]=1000`, `filter[project][_none]`. Operators: `_eq _neq _lt _lte _gt _gte _in _nin _null _nnull _contains _ncontains _icontains _starts_with _istarts_with _ends_with _iends_with _between _nbetween _empty _nempty`, plus `_and` / `_or`.
- `sort=-created_at,name`, `limit` (`-1` = `maxLimit`), `offset` or `page`, `search` (text columns, plus exact numbers and UUIDs), `meta=total_count,filter_count` or `meta=*`.

The bracket form needs `qs` as Fastify's querystring parser: `Fastify({ querystringParser: (q) => qs.parse(q, { depth: 10 }) })`.

### Tenancy and permissions

- Tables with the tenant column are scoped on every read, write and relational subquery; inserts get the tenant id from the request, and payloads may not set it.
- Foreign keys pointing into another tenant's rows are rejected (`INVALID_FOREIGN_KEY`), since Postgres foreign keys alone don't check tenants.
- Every query reaching a related table through `fields` or `filter` needs `read` permission on that table.
- Hidden columns (`overrides.<table>.hiddenColumns`) are never returned, filtered, sorted or searched, but stay writable.
- With `tenancy.rls`, each request runs in a transaction that calls `set_config('app.tenant_id', <tenant>, true)`. Policies should read it with `nullif(current_setting('app.tenant_id', true), '')::uuid`, because the setting reads as `''`, not `NULL`, on a connection that used it before.

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
