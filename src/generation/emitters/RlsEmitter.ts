import type { GeneratorConfig } from '../../config/types.js';
import type { DatabaseModel } from '../../introspection/types.js';
import { GENERATED_HEADER } from './headers.js';

/** Emits `sql/rls.sql`: a row-level security policy for every tenant-scoped table. */
export class RlsEmitter {
  static readonly POLICY = 'fastifygen_tenant_isolation';

  constructor(private readonly config: GeneratorConfig) {}

  emit(model: DatabaseModel): string {
    const { column, settingName } = this.config.tenancy;
    const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const statements = model.tables
      .filter((table) => table.tenantScoped)
      .map((table) => {
        const tenantColumn = table.columns.find((c) => c.name === column);
        const type = tenantColumn?.fullType ?? 'text';
        const qualified = `${ident(model.schema)}.${ident(table.name)}`;
        const condition = `${ident(column)} = nullif(current_setting('${settingName}', true), '')::${type}`;
        return `-- ${table.name}
ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ${RlsEmitter.POLICY} ON ${qualified};
CREATE POLICY ${RlsEmitter.POLICY} ON ${qualified}
  USING (${condition})
  WITH CHECK (${condition});`;
      });

    return `${GENERATED_HEADER.replace('//', '--')}
--
-- Row-level security for tenant-scoped tables. The API sets '${settingName}'
-- for each request's transaction, so Postgres itself refuses other tenants' rows.
--
-- Apply with: psql "$DATABASE_URL" -f sql/rls.sql
--
-- Notes:
-- * FORCE makes the policy apply to the table owner too. Superusers and roles
--   with BYPASSRLS still skip it, so run the API as an ordinary role.
-- * Outside an API request the setting is empty and the policy hides every row.
--   Run migrations and admin scripts as a role with BYPASSRLS, or set the
--   setting first: SELECT set_config('${settingName}', '<tenant id>', false);

SET client_min_messages = warning;

BEGIN;

${statements.join('\n\n') || '-- No tenant-scoped tables found.'}

COMMIT;
`;
  }
}
