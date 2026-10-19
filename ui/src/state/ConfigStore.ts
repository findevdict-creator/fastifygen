import { ApiClient, ApiError } from '../api/ApiClient.js';
import type { ConfigDraft, JsonSchemaNode, TableOverride } from '../api/types.js';
import { ConfigPath } from '../lib/ConfigPath.js';
import { Store } from './Store.js';

export interface ConfigState {
  phase: 'loading' | 'ready' | 'failed';
  loadError: string | null;
  configPath: string;
  /** Whether config.json exists on disk. */
  exists: boolean;
  /** The config as last saved (or read), with `${VAR}` references intact. */
  saved: ConfigDraft | null;
  /** The config being edited. */
  draft: ConfigDraft;
  defaults: ConfigDraft;
  schema: JsonSchemaNode;
  /** Problems the server found in the last save, or in the file as read. */
  issues: string[];
  /** `${VAR}` references that have no value where the UI server runs. */
  missingEnv: string[];
  saving: boolean;
  saveError: string | null;
}

/** The config.json being edited: loading, editing by path, per-table overrides and saving. */
export class ConfigStore extends Store<ConfigState> {
  constructor(private readonly api: ApiClient) {
    super({
      phase: 'loading',
      loadError: null,
      configPath: '',
      exists: false,
      saved: null,
      draft: {},
      defaults: {},
      schema: {},
      issues: [],
      missingEnv: [],
      saving: false,
      saveError: null,
    });
  }

  static isDirty(state: ConfigState): boolean {
    return state.saved === null || JSON.stringify(state.saved) !== JSON.stringify(state.draft);
  }

  async load(): Promise<void> {
    try {
      const state = await this.api.state();
      this.set({
        phase: 'ready',
        configPath: state.configPath,
        exists: state.exists,
        saved: state.config,
        draft: state.config ?? state.defaults,
        defaults: state.defaults,
        schema: state.schema,
        issues: state.issues,
        missingEnv: state.missingEnv,
      });
    } catch (error) {
      this.set({ phase: 'failed', loadError: (error as Error).message });
    }
  }

  value(path: readonly string[]): unknown {
    return ConfigPath.get(this.getSnapshot().draft, path);
  }

  update(path: readonly string[], value: unknown): void {
    this.set({ draft: ConfigPath.set(this.getSnapshot().draft, path, value), saveError: null });
  }

  /** Sets one override for a table; `undefined` or `false` removes it so the file stays minimal. */
  setOverride<K extends keyof TableOverride>(table: string, key: K, value: TableOverride[K] | undefined): void {
    const empty = value === undefined || value === false || (Array.isArray(value) && value.length === 0) || value === '';
    this.update(['overrides', table, key], empty ? undefined : value);
  }

  override(table: string): TableOverride {
    return (this.getSnapshot().draft.overrides?.[table] ?? {}) as TableOverride;
  }

  discard(): void {
    const { saved, defaults } = this.getSnapshot();
    this.set({ draft: saved ?? defaults, saveError: null });
  }

  async save(): Promise<boolean> {
    const { draft } = this.getSnapshot();
    this.set({ saving: true, saveError: null });
    try {
      const result = await this.api.saveConfig(draft);
      this.set({ saving: false, saved: draft, exists: true, issues: [], missingEnv: result.missingEnv });
      return true;
    } catch (error) {
      const issues = error instanceof ApiError ? error.issues : [];
      this.set({ saving: false, saveError: (error as Error).message, issues });
      return false;
    }
  }
}
