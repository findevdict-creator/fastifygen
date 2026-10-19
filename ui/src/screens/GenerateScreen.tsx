import type { FileStatus, GenerationResult, PlannedFile } from '../api/types.js';
import { ActionButton, ErrorNotice, Spinner } from '../components/Feedback.js';
import { ConfigStore } from '../state/ConfigStore.js';
import { useStore } from '../state/Store.js';
import { configStore, projectStore } from '../stores.js';

const STATUS: Record<FileStatus, { label: string; tone: string; meaning: string }> = {
  created: { label: 'new', tone: 'ok', meaning: 'will be created' },
  updated: { label: 'changed', tone: 'accent', meaning: 'will be rewritten' },
  unchanged: { label: 'same', tone: '', meaning: 'already up to date' },
  kept: { label: 'yours', tone: 'warn', meaning: 'exists and is left alone' },
};

export function GenerateScreen() {
  const config = useStore(configStore);
  const project = useStore(projectStore);
  const { preview, generation, file } = project;
  const dirty = ConfigStore.isDirty(config);
  const current = projectStore.isPreviewCurrent(config.draft);

  const generate = async () => {
    if (dirty && !(await configStore.save())) return;
    await projectStore.generate(configStore.getSnapshot().draft);
  };

  return (
    <>
      <div className="screen-head">
        <div>
          <h1>Generate</h1>
          <p>
            Preview shows every file and what will happen to it, without writing anything. Generated files are rewritten on each
            run; files marked <span className="pill warn">yours</span> are created once and never overwritten.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <ActionButton busy={preview.state === 'loading'} onClick={() => projectStore.preview(config.draft)}>
            {preview.state === 'done' ? 'Refresh preview' : 'Preview'}
          </ActionButton>
          <ActionButton variant="primary" busy={generation.state === 'loading' || config.saving} onClick={generate}>
            {dirty ? 'Save and generate' : 'Generate'}
          </ActionButton>
        </div>
      </div>

      {config.saveError && <ErrorNotice message={config.saveError} issues={config.issues} />}
      {generation.state === 'error' && <ErrorNotice message={generation.message} issues={generation.issues} />}
      {generation.state === 'done' && <GenerationDone result={generation.data} />}
      {preview.state === 'error' && <ErrorNotice message={preview.message} issues={preview.issues} />}
      {preview.state === 'done' && !current && generation.state !== 'done' && (
        <div className="notice info">The settings changed since this preview. Refresh it to see the effect.</div>
      )}

      {preview.state === 'idle' && generation.state !== 'done' && (
        <div className="card empty">
          <span>Nothing previewed yet.</span>
          <ActionButton variant="primary" onClick={() => projectStore.preview(config.draft)}>
            Preview the files
          </ActionButton>
        </div>
      )}
      {preview.state === 'loading' && (
        <div className="card empty">
          <Spinner />
          Reading the schema and planning files…
        </div>
      )}

      {preview.state === 'done' && (
        <div className="split" style={{ gridTemplateColumns: file.state === 'idle' ? '1fr' : 'minmax(0, 1fr) minmax(0, 1.3fr)' }}>
          <FileList result={preview.data} openPath={file.state === 'done' ? file.data.path : null} />
          {file.state !== 'idle' && (
            <section className="card viewer" aria-label="File preview">
              <div className="card-head">
                <h2 className="mono" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>
                  {file.state === 'done' ? file.data.path : 'Loading…'}
                </h2>
                <button type="button" className="btn small ghost" onClick={() => projectStore.closeFile()}>
                  Close
                </button>
              </div>
              {file.state === 'done' && <pre>{file.data.content}</pre>}
              {file.state === 'error' && (
                <div className="card-body">
                  <ErrorNotice message={file.message} />
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </>
  );
}

function FileList({ result, openPath }: { result: GenerationResult; openPath: string | null }) {
  const counts = Object.fromEntries(
    (Object.keys(STATUS) as FileStatus[]).map((status) => [status, result.files.filter((f) => f.status === status).length]),
  ) as Record<FileStatus, number>;
  const groups = groupByFolder(result.files);

  return (
    <section className="card" aria-label="Planned files">
      <div className="card-head">
        <div>
          <h2>
            {result.files.length} files for {result.tables.length} tables
          </h2>
          <p className="mono" style={{ overflowWrap: 'anywhere' }}>
            {result.outputDir}
          </p>
        </div>
        <div className="summary">
          {(Object.keys(STATUS) as FileStatus[])
            .filter((status) => counts[status] > 0)
            .map((status) => (
              <span key={status} className={`pill ${STATUS[status].tone}`} title={STATUS[status].meaning}>
                {counts[status]} {STATUS[status].label}
              </span>
            ))}
        </div>
      </div>
      {result.warnings.length > 0 && (
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <div className="notice warn">
            {result.warnings.map((warning) => (
              <span key={warning}>{warning}</span>
            ))}
          </div>
        </div>
      )}
      <div className="file-groups" style={{ paddingBottom: 8 }}>
        {groups.map(([folder, files]) => (
          <div key={folder}>
            <div className="group-label">{folder || 'project root'}</div>
            {files.map((planned) => (
              <button
                type="button"
                key={planned.path}
                className="file-row"
                aria-current={planned.path === openPath}
                onClick={() => projectStore.openFile(planned.path)}
                title={`${planned.path}: ${STATUS[planned.status].meaning}`}
              >
                <span className="mono">{planned.path.slice(folder ? folder.length + 1 : 0)}</span>
                <span className="pill">{planned.kind === 'scaffold' ? 'yours' : 'generated'}</span>
                <span className={`pill ${STATUS[planned.status].tone}`}>{STATUS[planned.status].label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function GenerationDone({ result }: { result: GenerationResult }) {
  const written = result.files.filter((file) => file.status === 'created' || file.status === 'updated').length;
  const kept = result.files.filter((file) => file.status === 'kept').length;
  const fresh = result.files.every((file) => file.status === 'created');
  return (
    <section className="card next-steps">
      <div className="card-head">
        <div>
          <h2>Generated {result.tables.length} table modules</h2>
          <p>
            {written} files written{kept ? `, ${kept} of your files left alone` : ''}, in <code>{result.outputDir}</code>.
          </p>
        </div>
        <span className="pill ok">done</span>
      </div>
      <div className="card-body">
        {fresh ? (
          <>
            <p>Next, install and start the API:</p>
            <pre>{`cd ${result.outputDir}
npm install
cp .env.example .env    # set DATABASE_URL and JWT_SECRET
npm run dev`}</pre>
          </>
        ) : (
          <p>Restart the API if it is running. If tables or tenancy changed, re-apply sql/rls.sql.</p>
        )}
      </div>
    </section>
  );
}

function groupByFolder(files: PlannedFile[]): [string, PlannedFile[]][] {
  const groups = new Map<string, PlannedFile[]>();
  for (const file of files) {
    const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    groups.set(folder, [...(groups.get(folder) ?? []), file]);
  }
  return [...groups.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
}
