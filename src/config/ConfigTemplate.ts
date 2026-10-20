import type { GeneratorConfig } from './types.js';

export interface ConfigTemplateOptions {
  /** Value for `database.url`. Defaults to `${DATABASE_URL}` so the secret stays in the environment. */
  databaseUrl?: string;
  /** Value for `$schema`, for editor autocompletion. */
  schemaPath?: string;
}

/** The starter `config.json` written by `fastifygen init`: every setting, at its default. */
export class ConfigTemplate {
  static readonly DEFAULT_SCHEMA_PATH = './node_modules/fastifygen/schema/config.schema.json';

  static build(options: ConfigTemplateOptions = {}): { $schema: string } & GeneratorConfig {
    return {
      $schema: options.schemaPath ?? ConfigTemplate.DEFAULT_SCHEMA_PATH,
      database: { url: options.databaseUrl ?? '${DATABASE_URL}', schema: 'public' },
      output: { dir: './generated', mode: 'development' },
      tables: { include: ['*'], exclude: ['knex_migrations', 'knex_migrations_lock'] },
      api: { prefix: '/items', defaultLimit: 100, maxLimit: 1000 },
      tenancy: { enabled: true, column: 'tenant_id', rls: true, settingName: 'app.tenant_id' },
      auth: { mode: 'jwt', tenantClaim: 'tenant_id', permissionsClaim: 'permissions' },
      permissions: { format: '{action}:{table}', actions: ['create', 'read', 'update', 'delete'] },
      overrides: {},
    };
  }

  static render(options: ConfigTemplateOptions = {}): string {
    return `${JSON.stringify(ConfigTemplate.build(options), null, 2)}\n`;
  }
}
