import type { JsonSchemaNode } from '../api/types.js';
import { ActionButton, ErrorNotice } from '../components/Feedback.js';
import { SchemaField } from '../components/SchemaField.js';
import { useStore } from '../state/Store.js';
import { configStore, projectStore } from '../stores.js';

/** Sections of config.json shown as forms. Per-table overrides live on the schema screen. */
const SECTIONS: { key: string; blurb: string }[] = [
  { key: 'database', blurb: 'Where to read the schema from. Use a url, or host and database.' },
  { key: 'output', blurb: 'Where the generated project is written.' },
  { key: 'tables', blurb: 'Which tables get an API.' },
  { key: 'api', blurb: 'Route prefix and page sizes.' },
  { key: 'tenancy', blurb: 'Shared tables with a tenant column, isolated per request.' },
  { key: 'auth', blurb: 'Where the caller’s tenant and permissions come from.' },
  { key: 'permissions', blurb: 'How permission names are built and which actions get routes.' },
];

export function SettingsScreen() {
  const config = useStore(configStore);
  const project = useStore(projectStore);
  const { connection } = project;

  return (
    <>
      <div className="screen-head">
        <div>
          <h1>Settings</h1>
          <p>
            Every setting in <code>config.json</code>. Empty fields use the default shown in grey. Values like{' '}
            <code>{'${DATABASE_URL}'}</code> are read from the environment where <code>fastifygen ui</code> runs.
          </p>
        </div>
      </div>

      {config.issues.length > 0 && !config.saveError && <ErrorNotice message="config.json has problems" issues={config.issues} />}

      {SECTIONS.map(({ key, blurb }) => {
        const section = config.schema.properties?.[key];
        if (!section?.properties) return null;
        return (
          <section className="card" key={key} aria-labelledby={`section-${key}`}>
            <div className="card-head">
              <div>
                <h2 id={`section-${key}`}>{section.title ?? key}</h2>
                <p>{blurb}</p>
              </div>
              {key === 'database' && (
                <ActionButton busy={connection.state === 'loading'} onClick={() => projectStore.testConnection(config.draft)}>
                  Test connection
                </ActionButton>
              )}
            </div>
            <div className="card-body">
              {key === 'database' && <ConnectionResult missingEnv={config.missingEnv} />}
              <div className="fields">
                {Object.entries(section.properties).map(([name, schema]) => (
                  <SchemaField
                    key={name}
                    idPrefix={key}
                    name={name}
                    schema={schema as JsonSchemaNode}
                    value={configStore.value([key, name])}
                    onChange={(value) => configStore.update([key, name], value)}
                  />
                ))}
              </div>
            </div>
          </section>
        );
      })}
    </>
  );
}

function ConnectionResult({ missingEnv }: { missingEnv: string[] }) {
  const { connection } = useStore(projectStore);
  return (
    <>
      {missingEnv.length > 0 && (
        <div className="notice warn">
          <span>
            Not set in the environment: {missingEnv.map((name) => `\${${name}}`).join(', ')}. Add them to <code>.env</code> in the folder
            where you started <code>fastifygen ui</code> and restart it, or type the value in directly.
          </span>
        </div>
      )}
      {connection.state === 'done' && (
        <div className="notice ok" role="status">
          Connected to PostgreSQL {connection.data.serverVersion}.
        </div>
      )}
      {connection.state === 'error' && <ErrorNotice message={connection.message} issues={connection.issues} />}
    </>
  );
}
