/**
 * Shape of `config.json`, after defaults have been applied.
 * Keep in sync with `config.schema.ts`.
 */
export interface GeneratorConfig {
  database: DatabaseConfig;
  output: OutputConfig;
  tables: TablesConfig;
  api: ApiConfig;
  tenancy: TenancyConfig;
  auth: AuthConfig;
  permissions: PermissionsConfig;
  overrides: Record<string, TableOverride>;
}

export interface DatabaseConfig {
  /** Connection string, e.g. `${DATABASE_URL}`. Takes precedence over the discrete fields. */
  url?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
  /** Postgres schema to introspect. */
  schema: string;
}

export interface OutputConfig {
  /** Folder the generated API is written to, relative to config.json. */
  dir: string;
}

export interface TablesConfig {
  /** Glob patterns (`*` wildcard) of tables to include. */
  include: string[];
  /** Glob patterns of tables to leave out. Wins over `include`. */
  exclude: string[];
}

export interface ApiConfig {
  /** Route prefix for item endpoints, Directus-style. */
  prefix: string;
  defaultLimit: number;
  maxLimit: number;
}

export interface TenancyConfig {
  enabled: boolean;
  /** Tables that have this column are tenant-scoped. */
  column: string;
  /** Generate Postgres row-level security policies for tenant-scoped tables. */
  rls: boolean;
  /** Session setting the RLS policy reads, set per request with `SET LOCAL`. */
  settingName: string;
}

export type AuthMode = 'jwt' | 'header' | 'none';

export interface AuthConfig {
  mode: AuthMode;
  /** JWT claim (or header name in `header` mode) that carries the tenant id. */
  tenantClaim: string;
  /** JWT claim that carries the user's permission list. */
  permissionsClaim: string;
}

export type PermissionAction = 'create' | 'read' | 'update' | 'delete';

export interface PermissionsConfig {
  /** Permission name template. `{action}` and `{table}` are replaced. */
  format: string;
  actions: PermissionAction[];
}

export interface TableOverride {
  /** Skip this table entirely. */
  skip?: boolean;
  /** Only generate read endpoints. */
  readOnly?: boolean;
  /** Columns never returned by the API, e.g. password hashes. */
  hiddenColumns?: string[];
  /** URL segment to use instead of the table name. */
  routeName?: string;
}
