import { useEffect, useState } from 'react';
import { ActionButton, ErrorNotice, Spinner } from './components/Feedback.js';
import { GenerateScreen } from './screens/GenerateScreen.js';
import { SchemaScreen } from './screens/SchemaScreen.js';
import { SettingsScreen } from './screens/SettingsScreen.js';
import { ConfigStore } from './state/ConfigStore.js';
import { useStore } from './state/Store.js';
import { configStore } from './stores.js';

const SCREENS = [
  { id: 'settings', label: 'Settings', Component: SettingsScreen },
  { id: 'schema', label: 'Schema', Component: SchemaScreen },
  { id: 'generate', label: 'Generate', Component: GenerateScreen },
] as const;

type ScreenId = (typeof SCREENS)[number]['id'];

function screenFromHash(): ScreenId {
  const id = window.location.hash.slice(1);
  return SCREENS.some((screen) => screen.id === id) ? (id as ScreenId) : 'settings';
}

export function App() {
  const config = useStore(configStore);
  const [screen, setScreen] = useState<ScreenId>(screenFromHash);
  const dirty = config.phase === 'ready' && ConfigStore.isDirty(config);

  useEffect(() => {
    void configStore.load();
    const onHash = () => setScreen(screenFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    // Warn before closing the tab with unsaved settings.
    const onUnload = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  const go = (id: ScreenId) => {
    window.location.hash = id;
    setScreen(id);
  };

  const Active = SCREENS.find((s) => s.id === screen)!.Component;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="var(--accent)" />
            <path d="M9 22V10h10M9 16h7" stroke="var(--accent-ink)" strokeWidth="3" fill="none" strokeLinecap="round" />
          </svg>
          fastifygen
        </div>
        <nav className="nav" aria-label="Screens">
          {SCREENS.map((item, index) => (
            <button key={item.id} type="button" aria-current={screen === item.id ? 'page' : undefined} onClick={() => go(item.id)}>
              <span className="step">{index + 1}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <p className="foot">Runs on this machine only. Nothing leaves it except queries to your database.</p>
      </aside>

      <div className="main">
        <header className="topbar">
          <span className="path" title={config.configPath}>
            {config.configPath || 'Loading…'}
            {config.phase === 'ready' && !config.exists && <span className="pill warn" style={{ marginLeft: 8 }}>not created yet</span>}
          </span>
          {dirty && <span className="pill warn">unsaved changes</span>}
          {dirty && config.exists && (
            <button type="button" className="btn small ghost" onClick={() => configStore.discard()}>
              Discard
            </button>
          )}
          <ActionButton variant="primary" busy={config.saving} disabled={!dirty} onClick={() => configStore.save()}>
            {config.exists ? 'Save' : 'Create config.json'}
          </ActionButton>
        </header>

        <main className="content">
          {config.phase === 'loading' && (
            <div className="card empty">
              <Spinner />
              Loading config…
            </div>
          )}
          {config.phase === 'failed' && <ErrorNotice message={config.loadError ?? 'Could not load the config'} />}
          {config.phase === 'ready' && (
            <>
              {config.saveError && screen !== 'generate' && <ErrorNotice message={config.saveError} issues={config.issues} />}
              <Active />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
