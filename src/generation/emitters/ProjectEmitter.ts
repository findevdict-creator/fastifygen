import type { GeneratorConfig } from '../../config/types.js';
import type { DatabaseModel, TableModel } from '../../introspection/types.js';
import type { RuntimeSchema } from '../../runtime/types.js';
import { Naming } from '../Naming.js';
import { GENERATED_HEADER, SCAFFOLD_HEADER } from './headers.js';
import type { ModuleFile } from './ModuleEmitter.js';

export interface ProjectInput {
  name: string;
  model: DatabaseModel;
  runtimeSchema: RuntimeSchema;
  /** Permission names per table, e.g. `{ company: { read: 'read:company' } }`. */
  permissions: Record<string, Record<string, string>>;
}

/** Emits the project-level files: app, server, database, auth, schema, permissions and module wiring. */
export class ProjectEmitter {
  constructor(private readonly config: GeneratorConfig) {}

  emit(input: ProjectInput): ModuleFile[] {
    return [
      { path: 'package.json', content: this.packageJson(input.name), kind: 'scaffold' },
      { path: 'tsconfig.json', content: this.tsconfig(), kind: 'scaffold' },
      { path: '.gitignore', content: 'node_modules/\ndist/\n.env\n', kind: 'scaffold' },
      { path: '.env.example', content: this.envExample(), kind: 'scaffold' },
      { path: 'README.md', content: this.readme(input), kind: 'scaffold' },
      { path: 'src/server.ts', content: this.server(), kind: 'scaffold' },
      { path: 'src/app.ts', content: this.app(), kind: 'scaffold' },
      { path: 'src/db.ts', content: this.db(), kind: 'scaffold' },
      { path: 'src/auth/AuthHook.ts', content: this.authHook(), kind: 'scaffold' },
      { path: 'src/schema.ts', content: this.schema(input.runtimeSchema), kind: 'generated' },
      { path: 'src/permissions.ts', content: this.permissionsFile(input.permissions), kind: 'generated' },
      { path: 'src/modules/index.ts', content: this.modulesIndex(input.model.tables), kind: 'generated' },
    ];
  }

  private packageJson(name: string): string {
    const dependencies: Record<string, string> = {
      fastify: '^5.12.0',
      knex: '^3.3.0',
      pg: '^8.23.0',
      qs: '^6.16.0',
    };
    if (this.config.auth.mode === 'jwt') dependencies['@fastify/jwt'] = '^10.2.0';
    const pkg = {
      name: name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'api',
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        dev: 'tsx watch src/server.ts',
        build: 'tsc',
        start: 'node dist/server.js',
        typecheck: 'tsc --noEmit',
      },
      engines: { node: '>=20.12' },
      dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
      devDependencies: {
        '@types/node': '^22.0.0',
        '@types/qs': '^6.15.0',
        tsx: '^4.23.0',
        typescript: '^7.0.0',
      },
    };
    return `${JSON.stringify(pkg, null, 2)}\n`;
  }

  private tsconfig(): string {
    const tsconfig = {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noUncheckedIndexedAccess: true,
        types: ['node'],
        esModuleInterop: true,
        skipLibCheck: true,
        sourceMap: true,
        outDir: 'dist',
        rootDir: 'src',
      },
      include: ['src'],
    };
    return `${JSON.stringify(tsconfig, null, 2)}\n`;
  }

  private envExample(): string {
    const lines = ['DATABASE_URL=postgres://user:password@localhost:5432/app', 'PORT=3000', 'HOST=0.0.0.0'];
    if (this.config.auth.mode === 'jwt') lines.push('JWT_SECRET=change-me-to-a-long-random-string');
    return `${lines.join('\n')}\n`;
  }

  private server(): string {
    return `${SCAFFOLD_HEADER}
import { existsSync } from 'node:fs';
import { Application } from './app.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const app = await new Application().build();
await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '0.0.0.0' });
`;
  }

  private app(): string {
    return `${SCAFFOLD_HEADER}
import Fastify, { type FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import qs from 'qs';
import { AuthHook } from './auth/AuthHook.js';
import { ErrorMapper, RouteGuard, SchemaOverview } from './core/index.js';
import { Database } from './db.js';
import { Modules } from './modules/index.js';
import { runtimeSchema } from './schema.js';

export interface ApplicationOptions {
  /** Reuse a Knex instance (e.g. in tests). By default one is created from DATABASE_URL. */
  knex?: Knex;
  logger?: boolean;
}

/** Builds the Fastify app: query parsing, error format, auth and every table's routes. */
export class Application {
  constructor(private readonly options: ApplicationOptions = {}) {}

  async build(): Promise<FastifyInstance> {
    const app = Fastify({
      logger: this.options.logger ?? true,
      routerOptions: {
        // Directus-style bracket filters: filter[name][_eq]=Acme
        querystringParser: (query) => qs.parse(query, { depth: 10, arrayLimit: 100 }),
      },
      // Reject unknown fields instead of silently dropping them; nullable columns use union types.
      ajv: { customOptions: { removeAdditional: false, allowUnionTypes: true } },
    });

    const knex = this.options.knex ?? Database.connect();
    if (!this.options.knex) app.addHook('onClose', async () => knex.destroy());

    const schema = new SchemaOverview(runtimeSchema);
    app.setErrorHandler(ErrorMapper.handler);

    const auth = new AuthHook();
    await auth.register(app);
    await new Modules({ knex, schema, auth, guard: new RouteGuard(schema) }).register(app);
    return app;
  }
}
`;
  }

  private db(): string {
    return `${SCAFFOLD_HEADER}
import knex, { type Knex } from 'knex';
import pg from 'pg';

// Keep DATE and INTERVAL values as the strings Postgres sends, so no time zone shifts sneak in.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
pg.types.setTypeParser(pg.types.builtins.INTERVAL, (value) => value);

export class Database {
  static connect(url = process.env.DATABASE_URL): Knex {
    if (!url) throw new Error('DATABASE_URL is not set');
    return knex({ client: 'pg', connection: url, pool: { min: 0, max: 10 } });
  }
}
`;
  }

  private authHook(): string {
    const { mode, tenantClaim, permissionsClaim } = this.config.auth;
    const shared = `
function asString(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(/[\\s,]+/).filter(Boolean);
  return [];
}
`;

    if (mode === 'jwt') {
      return `${SCAFFOLD_HEADER}
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../core/index.js';

/**
 * Reads who is calling from a JWT signed with JWT_SECRET:
 * \`sub\` is the user, \`${tenantClaim}\` the tenant and \`${permissionsClaim}\` the permission list.
 * Replace this class to plug in your own identity provider.
 */
export class AuthHook {
  static readonly TENANT_CLAIM = '${tenantClaim}';
  static readonly PERMISSIONS_CLAIM = '${permissionsClaim}';

  async register(app: FastifyInstance): Promise<void> {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not set');
    await app.register(fastifyJwt, { secret });
  }

  authenticate = async (request: FastifyRequest): Promise<void> => {
    let payload: Record<string, unknown>;
    try {
      payload = await request.jwtVerify<Record<string, unknown>>();
    } catch {
      throw new UnauthorizedError('Missing or invalid token');
    }
    request.accountability = {
      userId: asString(payload.sub),
      tenantId: asString(payload[AuthHook.TENANT_CLAIM]),
      permissions: asList(payload[AuthHook.PERMISSIONS_CLAIM]),
    };
  };
}
${shared}`;
    }

    if (mode === 'header') {
      return `${SCAFFOLD_HEADER}
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Trusts the \`${tenantClaim}\` and \`${permissionsClaim}\` request headers.
 * Only use this behind a gateway that authenticates users and sets these headers itself.
 */
export class AuthHook {
  static readonly TENANT_HEADER = '${tenantClaim.toLowerCase()}';
  static readonly PERMISSIONS_HEADER = '${permissionsClaim.toLowerCase()}';

  async register(_app: FastifyInstance): Promise<void> {}

  authenticate = async (request: FastifyRequest): Promise<void> => {
    request.accountability = {
      userId: null,
      tenantId: asString(request.headers[AuthHook.TENANT_HEADER]),
      permissions: asList(request.headers[AuthHook.PERMISSIONS_HEADER]),
    };
  };
}
${shared}`;
    }

    return `${SCAFFOLD_HEADER}
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * No authentication: every request gets every permission, and the tenant comes
 * from the \`${tenantClaim}\` header. For local development only.
 */
export class AuthHook {
  static readonly TENANT_HEADER = '${tenantClaim.toLowerCase()}';

  async register(_app: FastifyInstance): Promise<void> {}

  authenticate = async (request: FastifyRequest): Promise<void> => {
    request.accountability = {
      userId: null,
      tenantId: asString(request.headers[AuthHook.TENANT_HEADER]),
      permissions: ['*'],
    };
  };
}
${shared.replace(/\nfunction asList[\s\S]*$/, '\n')}`;
  }

  private schema(runtimeSchema: RuntimeSchema): string {
    return `${GENERATED_HEADER}
import type { RuntimeSchema } from './core/index.js';

/** Tables, columns and relations the API serves, read from the database by fastifygen. */
export const runtimeSchema: RuntimeSchema = ${JSON.stringify(runtimeSchema, null, 2)};
`;
  }

  private permissionsFile(permissions: Record<string, Record<string, string>>): string {
    const all = Object.values(permissions).flatMap((byAction) => Object.values(byAction));
    return `${GENERATED_HEADER}

/** Every permission the API checks, per table and action. */
export const PERMISSIONS = ${JSON.stringify(permissions, null, 2)} as const;

/** Flat list, e.g. for seeding a roles table or building an admin UI. */
export const ALL_PERMISSIONS = ${JSON.stringify(all, null, 2)} as const;
`;
  }

  private modulesIndex(tables: TableModel[]): string {
    const imports = tables.flatMap((table) => {
      const name = Naming.pascal(table.name);
      return [
        `import { ${name}Controller } from './${table.name}/${name}Controller.js';`,
        `import { ${name}Routes } from './${table.name}/${name}Routes.js';`,
      ];
    });
    const registrations = tables.map((table) => {
      const name = Naming.pascal(table.name);
      const segment = this.config.overrides[table.name]?.routeName ?? table.name;
      return `    await app.register(new ${name}Routes(new ${name}Controller(ctx), auth, guard).register, {
      prefix: '${this.config.api.prefix}/${segment}',
    });`;
    });

    return `${GENERATED_HEADER}
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { AuthHook } from '../auth/AuthHook.js';
import type { RouteGuard, SchemaOverview } from '../core/index.js';
${imports.join('\n')}

export interface ModulesContext {
  knex: Knex;
  schema: SchemaOverview;
  auth: AuthHook;
  guard: RouteGuard;
}

/** Registers every table's routes under \`${this.config.api.prefix}/<table>\`. */
export class Modules {
  constructor(private readonly context: ModulesContext) {}

  async register(app: FastifyInstance): Promise<void> {
    const { knex, schema, auth, guard } = this.context;
    const ctx = { knex, schema };
${registrations.join('\n')}
  }
}
`;
  }

  private readme(input: ProjectInput): string {
    const tables = input.model.tables
      .map((table) => `| \`${table.name}\` | \`${this.config.api.prefix}/${this.config.overrides[table.name]?.routeName ?? table.name}\` | ${table.tenantScoped ? 'yes' : 'no'} |`)
      .join('\n');
    const auth = {
      jwt: `Send \`Authorization: Bearer <token>\`. The token is verified with \`JWT_SECRET\`; its \`sub\` is the user, \`${this.config.auth.tenantClaim}\` the tenant and \`${this.config.auth.permissionsClaim}\` the list of permissions.`,
      header: `The \`${this.config.auth.tenantClaim}\` and \`${this.config.auth.permissionsClaim}\` headers are trusted as-is. Only run this behind a gateway that sets them.`,
      none: `No authentication: every request gets every permission and the tenant comes from the \`${this.config.auth.tenantClaim}\` header. Development only.`,
    }[this.config.auth.mode];

    return `# ${input.name}

A Fastify REST API generated by [fastifygen](https://github.com/findevdict-creator/fastifygen) from a PostgreSQL schema.

## Run it

\`\`\`bash
npm install
cp .env.example .env    # then fill in DATABASE_URL${this.config.auth.mode === 'jwt' ? ' and JWT_SECRET' : ''}
npm run dev
\`\`\`
${this.config.tenancy.enabled && this.config.tenancy.rls ? `
Apply the row-level security policies once (and again after regenerating): \`psql "$DATABASE_URL" -f sql/rls.sql\`. Run the API as an ordinary database role: superusers skip the policies.
` : ''}
## Auth

${auth}

Permissions look like \`${this.config.permissions.format.replace('{action}', 'read').replace('{table}', 'company')}\`; \`*\`, \`read:*\` and \`*:company\` work as wildcards. The full list is in \`src/permissions.ts\`.

## Tables

| Table | Route | Tenant-scoped |
| --- | --- | --- |
${tables}

Every table supports Directus-style \`fields\`, \`filter\`, \`sort\`, \`limit\`, \`offset\`, \`page\`, \`search\` and \`meta\`.

## Layout

- \`src/modules/<table>/\`: \`*Routes.ts\`, \`*.schemas.ts\` and \`*.types.ts\` are regenerated on every run. \`*Controller.ts\`, \`*Service.ts\` and \`*Repository.ts\` are created once and are yours to edit.
- \`src/core/\`: the shared runtime (rewritten on every run).
- \`src/schema.ts\`, \`src/permissions.ts\`, \`src/modules/index.ts\`, \`sql/rls.sql\`: regenerated.
- \`src/app.ts\`, \`src/server.ts\`, \`src/db.ts\`, \`src/auth/AuthHook.ts\`: created once, yours to edit.
`;
  }
}
