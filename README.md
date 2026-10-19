# fastifygen

Generate a class-based Fastify REST API (controller / service / repository) from a PostgreSQL schema, with Directus-style endpoints, per-table permissions and multitenancy.

## Roadmap

1. **Config and schema reading**: `config.json` format, its JSON Schema, and Postgres introspection into a JSON model. ✅
2. **Shared core**: class-based Knex repository, service and controller keyed by table name; Directus query parser (`fields`, `filter`, `sort`, `limit`, `offset`, `page`, `search`) with relational fields; tenant scoping via `tenant_id` and `SET LOCAL` for row-level security. ✅
3. **Per-table generation**: a Fastify plugin per table using full `fastify.route()` declarations, JSON schemas, permissions in route `config`, auth and permission hooks, extension classes and RLS policy SQL. ✅
4. **CLI and test run**: `init`, `introspect` and `generate`, walked through end to end on a fresh database. ✅

## Getting started

You need Node 20.12+ and a Postgres database with your tables in it.

**1. Install and create a config.**

```bash
npm install --save-dev github:findevdict-creator/fastifygen   # builds itself on install
npx fastifygen init                 # writes config.json with every setting at its default
echo 'DATABASE_URL=postgres://user:pass@localhost:5432/app' > .env
```

**2. Generate the API.**

```bash
npx fastifygen generate -o ./api
# Generated 7 table module(s) in ./api: 69 created, 0 updated, 0 unchanged, 0 kept.
# Next: cd api && npm install && cp .env.example .env && npm run dev
```

**3. Run it.**

```bash
cd api && npm install
cp .env.example .env                # set DATABASE_URL and JWT_SECRET
psql "$DATABASE_URL" -f sql/rls.sql # row-level security, once per regeneration
npm run dev
curl localhost:3000/server/health   # {"status":"ok"}
```

Run the API as an ordinary database role, since superusers skip row-level security. The generated README has the `CREATE ROLE` and `GRANT` statements.

**4. Call it.**

```bash
TOKEN=$(npm run --silent token -- --tenant <tenant id> --permissions "*")
curl -H "Authorization: Bearer $TOKEN" "localhost:3000/items/company?fields=name,employee.first_name"
```

`npm run token` signs a development JWT with your `JWT_SECRET`. In production your identity provider issues the tokens; see `src/auth/AuthHook.ts`.

When the database changes, run `generate` again. Routes, schemas and types follow the new columns, and your own code is left alone (see [What `generate` writes](#what-generate-writes)).

### Commands

| Command | What it does |
| --- | --- |
| `fastifygen init [-c config.json] [--database-url <url>] [--force]` | Writes a starter config. Refuses to overwrite without `--force`. |
| `fastifygen introspect [-c config.json] [-o model.json]` | Prints what it read from the database as JSON. |
| `fastifygen generate [-c config.json] [-o ./api]` | Writes the Fastify project. `-o` overrides `output.dir`. |
| `fastifygen ui [-c config.json] [-p 4321] [--no-open]` | Opens the web UI (below). |

All commands load `.env` from the current folder first (`--env-file` to change it). A missing config or an unreachable database is reported in one line.

`introspect` prints the database model as JSON: tables, columns (with TypeScript and JSON Schema types), primary keys, unique constraints, foreign keys in both directions, enums, and whether each table is tenant-scoped.

## Web UI

```bash
npx fastifygen ui        # opens http://127.0.0.1:4321
```

The same steps as the CLI, in a browser:

1. **Settings**: a form for every config.json setting, built from its JSON Schema, with a **Test connection** button. Saving writes config.json with `${VAR}` references left as they are.
2. **Schema**: every table with its columns, relations and tenant scoping. Switch a table to skipped or read-only, rename its route, or hide columns, and see its routes and permissions update as you go.
3. **Generate**: a preview of every file and whether it will be created, rewritten or left alone, with each file's content, then **Generate**.

It only listens on 127.0.0.1 and only answers requests for localhost that carry its own header, since it can read your database credentials and write files. Without a config.json it starts from the defaults and creates the file on first save.

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

## What `generate` writes

```
my-api/
  package.json, tsconfig.json, .env.example, README.md
  sql/rls.sql                      row-level security policies (when tenancy.rls)
  src/
    server.ts, app.ts, db.ts       Application class, Fastify setup, Knex connection
    auth/AuthHook.ts               jwt | header | none, from auth.mode
    core/                          the runtime core below, copied in
    schema.ts                      tables, columns and relations the API serves
    permissions.ts                 every permission, per table and action
    modules/index.ts               registers each table under api.prefix
  scripts/token.ts                 development JWT helper (auth.mode jwt)
    modules/company/
      CompanyRoutes.ts             full fastify.route() declarations
      company.schemas.ts           request and response JSON Schemas
      company.types.ts             a TypeScript interface for the row
      CompanyController.ts         extends ItemsController
      CompanyService.ts            extends ItemsService
      CompanyRepository.ts         extends ItemsRepository
```

Each route declares its permission in `config` and runs `authenticate` (preValidation) and `checkPermission` (preHandler):

```ts
fastify.route({
  method: 'GET',
  url: '/:id',
  schema: { params: schemas.params, querystring: schemas.query, response: { 200: schemas.itemResponse } },
  config: { permission: 'read:company', action: 'read', table: 'company' },
  preValidation: [this.auth.authenticate],
  preHandler: [this.guard.checkPermission],
  handler: this.controller.readOne,
});
```

**Regenerating is safe.** Files marked "Generated" (routes, schemas, types, `core/`, `schema.ts`, `permissions.ts`, `modules/index.ts`, `sql/rls.sql`) are rewritten on every run. Files marked "Created" (controllers, services, repositories, `app.ts`, `server.ts`, `db.ts`, `AuthHook.ts`, `package.json`) are written once and then left alone, so your changes survive. Read-only tables get only GET routes; tables without a primary key get no by-id routes; actions left out of `permissions.actions` get no routes.

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

Writes answer 204 when the caller may write but not read the table. `GET /server/ping` and `GET /server/health` need no token. Unknown routes and ids that can't exist (`/items/company/abc`) answer 404 in the same error format.

### Query parameters

- `fields=*,company_id.name,employee.first_name` selects columns and nested relations (up to 5 levels). Many-to-one relations use the foreign key column name; one-to-many relations use the referencing table's name (or `{table}_by_{column}` when ambiguous). A bare one-to-many name returns the related primary keys.
- `filter` as JSON or brackets: `filter[status][_eq]=active`, `filter[company_id][name][_eq]=Acme`, `filter[employee][_some][salary][_gt]=1000`, `filter[project][_none]`. Operators: `_eq _neq _lt _lte _gt _gte _in _nin _null _nnull _contains _ncontains _icontains _starts_with _istarts_with _ends_with _iends_with _between _nbetween _empty _nempty`, plus `_and` / `_or`.
- `sort=-created_at,name`, `limit` (`-1` = `maxLimit`), `offset` or `page`, `search` (text columns, plus exact numbers and UUIDs), `meta=total_count,filter_count` or `meta=*`.

The bracket form needs `qs` as Fastify's querystring parser: `Fastify({ routerOptions: { querystringParser: (q) => qs.parse(q, { depth: 10 }) } })`.

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

const { config, outputDir } = await new ConfigLoader().load('config.json');
const model = await new Generator(config).introspect();   // the JSON model
const result = await new Generator(config).generate(outputDir); // files written, warnings
```

`ConfigTemplate.build()` returns the starter config and `configSchema` its JSON Schema, for building a settings form.

## Development

The UI lives in `ui/` (React, Vite, TypeScript) and builds into `dist/ui-app` with `npm run build`. Its server is `src/ui-server/UiServer.ts`, a JSON API over the same classes the CLI uses. To work on the frontend with hot reload, run `npx tsx src/cli.ts ui --no-open` in one terminal and `npm run dev:ui` in another; Vite proxies `/api` to it.

```bash
docker compose up -d   # local Postgres 16
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/fastifygen_test
npm test
```

The introspection tests load `examples/sample-schema.sql`, which **drops and recreates the `public` schema**, so point `TEST_DATABASE_URL` at a throwaway database. Without it, those tests are skipped.

After changing `src/config/config.schema.ts`, run `npm run schema:write` to refresh `schema/config.schema.json`.
