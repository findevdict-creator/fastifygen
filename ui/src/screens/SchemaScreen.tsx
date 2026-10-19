import { useEffect, useState } from 'react';
import type { ColumnModel, TableModel } from '../api/types.js';
import { ActionButton, ErrorNotice, Spinner } from '../components/Feedback.js';
import { RelationNames } from '../lib/RelationNames.js';
import { RoutePlanner } from '../lib/RoutePlanner.js';
import { useStore } from '../state/Store.js';
import { configStore, projectStore } from '../stores.js';

export function SchemaScreen() {
  const config = useStore(configStore);
  const { model } = useStore(projectStore);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (model.state === 'idle') void projectStore.introspect(configStore.getSnapshot().draft);
  }, [model.state]);

  const tables = model.state === 'done' ? model.data.tables : [];
  const current = tables.find((table) => table.name === selected) ?? tables[0];
  const tenantColumn = String(configStore.value(['tenancy', 'column']) ?? 'tenant_id');

  return (
    <>
      <div className="screen-head">
        <div>
          <h1>Schema</h1>
          <p>
            The tables fastifygen found, with their columns and relations. Changes here are per-table overrides in config.json:
            save to keep them.
          </p>
        </div>
        <ActionButton busy={model.state === 'loading'} onClick={() => projectStore.introspect(config.draft)}>
          Reload schema
        </ActionButton>
      </div>

      {model.state === 'error' && <ErrorNotice message={model.message} issues={model.issues} />}
      {model.state === 'loading' && tables.length === 0 && (
        <div className="card empty">
          <Spinner />
          Reading the schema…
        </div>
      )}
      {model.state === 'done' && model.data.warnings.length > 0 && (
        <div className="notice warn">
          {model.data.warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      )}
      {model.state === 'done' && tables.length === 0 && (
        <div className="card empty">
          No tables matched. Check the schema name and the include and exclude patterns in Settings.
        </div>
      )}

      {current && (
        <div className="split">
          <nav className="card table-list" aria-label="Tables">
            {tables.map((table) => {
              const override = config.draft.overrides?.[table.name] ?? {};
              return (
                <button
                  type="button"
                  key={table.name}
                  className={override.skip ? 'skipped' : ''}
                  aria-current={table.name === current.name}
                  onClick={() => setSelected(table.name)}
                >
                  <span className="name">
                    {table.name}
                    <span className="pill">{table.columns.length}</span>
                  </span>
                  <span className="tags">
                    {override.skip && <span className="pill">skipped</span>}
                    {!override.skip && table.tenantScoped && <span className="pill accent">tenant</span>}
                    {!override.skip && override.readOnly && <span className="pill">read-only</span>}
                    {!override.skip && table.primaryKey.length === 0 && <span className="pill warn">no key</span>}
                  </span>
                </button>
              );
            })}
          </nav>
          <TableDetail table={current} tenantColumn={tenantColumn} />
        </div>
      )}
    </>
  );
}

function TableDetail({ table, tenantColumn }: { table: TableModel; tenantColumn: string }) {
  const config = useStore(configStore);
  const override = config.draft.overrides?.[table.name] ?? {};
  const hidden = new Set(override.hiddenColumns ?? []);
  const routes = override.skip ? [] : new RoutePlanner(config.draft).routes(table);
  const reverseNames = RelationNames.oneToMany(table);
  const references = new Map(table.manyToOne.flatMap((fk) => fk.columns.map((column, i) => [column, `${fk.foreignTable}.${fk.foreignColumns[i]}`])));

  const toggleHidden = (column: string, hide: boolean) => {
    const next = hide ? [...hidden, column] : [...hidden].filter((name) => name !== column);
    configStore.setOverride(table.name, 'hiddenColumns', next.length ? next : undefined);
  };

  return (
    <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="mono" style={{ fontSize: 16 }}>
              {table.name}
            </h2>
            <p>
              {table.comment ?? (table.tenantScoped ? `Tenant-scoped by ${tenantColumn}.` : 'Global table, shared by every tenant.')}
            </p>
          </div>
          <div className="summary">
            {table.tenantScoped ? <span className="pill accent">tenant-scoped</span> : <span className="pill">global</span>}
            <span className="pill">
              key: {table.primaryKey.length ? table.primaryKey.join(', ') : 'none'}
            </span>
          </div>
        </div>
        <div className="card-body">
          <div className="overrides">
            <label className="toggle">
              <input
                type="checkbox"
                id={`skip-${table.name}`}
                checked={override.skip ?? false}
                onChange={(event) => configStore.setOverride(table.name, 'skip', event.target.checked)}
              />
              <span>Skip this table</span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                id={`readonly-${table.name}`}
                checked={override.readOnly ?? false}
                disabled={override.skip}
                onChange={(event) => configStore.setOverride(table.name, 'readOnly', event.target.checked)}
              />
              <span>Read-only</span>
            </label>
            <div className="field" style={{ minWidth: 220 }}>
              <label htmlFor={`route-${table.name}`}>Route name</label>
              <input
                id={`route-${table.name}`}
                className="input mono"
                value={override.routeName ?? ''}
                placeholder={table.name}
                disabled={override.skip}
                onChange={(event) => configStore.setOverride(table.name, 'routeName', event.target.value.trim() || undefined)}
              />
            </div>
          </div>
          {table.primaryKey.length === 0 && !override.skip && (
            <div className="notice warn">
              {override.readOnly
                ? 'No primary key, so only the list route is generated.'
                : 'No primary key, so only the list and create routes are generated.'}
            </div>
          )}
        </div>
      </section>

      {!override.skip && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Routes and permissions</h2>
              <p>Each route requires its permission. Wildcards like * and read:* also match.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Route</th>
                  <th>Permission</th>
                </tr>
              </thead>
              <tbody>
                {routes.map((route) => (
                  <tr key={`${route.method} ${route.path}`}>
                    <td className="mono">
                      <span className={`method ${route.method}`}>{route.method}</span>
                      {route.path}
                    </td>
                    <td>
                      <code>{route.permission}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Columns</h2>
            <p>Hidden columns are never returned, filtered, sorted or searched, but can still be written.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Column</th>
                <th>Type</th>
                <th>Null</th>
                <th>Default</th>
                <th>References</th>
                <th>Hidden</th>
              </tr>
            </thead>
            <tbody>
              {table.columns.map((column) => (
                <ColumnRow
                  key={column.name}
                  column={column}
                  reference={references.get(column.name)}
                  hidden={hidden.has(column.name)}
                  lockedReason={column.isPrimaryKey ? 'primary key' : table.tenantScoped && column.name === tenantColumn ? 'tenant column' : null}
                  onHide={(hide) => toggleHidden(column.name, hide)}
                  disabled={override.skip ?? false}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {(table.manyToOne.length > 0 || table.oneToMany.length > 0) && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Relations</h2>
              <p>
                Ask for related items with <code>fields</code>, for example <code>?fields=*,{relationExample(table)}</code>.
              </p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Kind</th>
                  <th>Points to</th>
                </tr>
              </thead>
              <tbody>
                {table.manyToOne.map((fk) => (
                  <tr key={fk.constraintName}>
                    <td className="mono">{fk.columns.length === 1 ? fk.columns[0] : fk.constraintName}</td>
                    <td>many-to-one</td>
                    <td className="mono">
                      {fk.foreignTable} ({fk.foreignColumns.join(', ')})
                    </td>
                  </tr>
                ))}
                {table.oneToMany.map((rel) => (
                  <tr key={rel.constraintName}>
                    <td className="mono">{reverseNames.get(rel.constraintName)}</td>
                    <td>one-to-many</td>
                    <td className="mono">
                      {rel.table} ({rel.columns.join(', ')})
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function ColumnRow({
  column,
  reference,
  hidden,
  lockedReason,
  onHide,
  disabled,
}: {
  column: ColumnModel;
  reference: string | undefined;
  hidden: boolean;
  lockedReason: string | null;
  onHide: (hide: boolean) => void;
  disabled: boolean;
}) {
  return (
    <tr>
      <td className="mono">
        {column.name}
        {column.isPrimaryKey && (
          <span className="pill accent" style={{ marginLeft: 8 }}>
            key
          </span>
        )}
        {column.readOnly && (
          <span className="pill" style={{ marginLeft: 6 }} title="Identity or generated: clients can't write it">
            auto
          </span>
        )}
      </td>
      <td className="mono" title={column.enumValues ? column.enumValues.join(' | ') : undefined}>
        {column.fullType}
      </td>
      <td>{column.nullable ? 'yes' : ''}</td>
      <td className="mono" style={{ color: 'var(--muted)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {column.defaultValue ?? ''}
      </td>
      <td className="mono">{reference ?? ''}</td>
      <td>
        <label className="toggle" title={lockedReason ? `The ${lockedReason} can't be hidden` : undefined}>
          <input
            type="checkbox"
            aria-label={`Hide ${column.name}`}
            checked={hidden}
            disabled={disabled || lockedReason !== null}
            onChange={(event) => onHide(event.target.checked)}
          />
        </label>
      </td>
    </tr>
  );
}

function relationExample(table: TableModel): string {
  const fk = table.manyToOne.find((relation) => relation.columns.length === 1);
  if (fk) return `${fk.columns[0]}.*`;
  const reverse = table.oneToMany[0];
  return reverse ? `${RelationNames.oneToMany(table).get(reverse.constraintName)}.*` : '*';
}
