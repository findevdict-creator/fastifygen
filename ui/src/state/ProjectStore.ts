import { ApiClient, ApiError } from '../api/ApiClient.js';
import type { ConfigDraft, GenerationResult, IntrospectionResult } from '../api/types.js';
import { Store, type Request } from './Store.js';

export interface ProjectState {
  connection: Request<{ serverVersion: string }>;
  model: Request<IntrospectionResult>;
  preview: Request<GenerationResult>;
  /** The draft config the current preview was made from, to tell when it is out of date. */
  previewOf: string | null;
  file: Request<{ path: string; content: string }>;
  generation: Request<GenerationResult>;
}

/** Everything that talks to the database or the output folder: connection test, schema, preview and generate. */
export class ProjectStore extends Store<ProjectState> {
  constructor(private readonly api: ApiClient) {
    super({
      connection: { state: 'idle' },
      model: { state: 'idle' },
      preview: { state: 'idle' },
      previewOf: null,
      file: { state: 'idle' },
      generation: { state: 'idle' },
    });
  }

  async testConnection(config: ConfigDraft): Promise<void> {
    this.set({ connection: { state: 'loading' } });
    this.set({ connection: await this.run(() => this.api.testConnection(config)) });
  }

  async introspect(config: ConfigDraft): Promise<void> {
    this.set({ model: { state: 'loading' } });
    this.set({ model: await this.run(() => this.api.introspect(config)) });
  }

  async preview(config: ConfigDraft): Promise<void> {
    this.set({ preview: { state: 'loading' }, file: { state: 'idle' }, generation: { state: 'idle' } });
    const preview = await this.run(() => this.api.preview(config));
    this.set({ preview, previewOf: preview.state === 'done' ? JSON.stringify(config) : null });
  }

  isPreviewCurrent(config: ConfigDraft): boolean {
    return this.getSnapshot().previewOf === JSON.stringify(config);
  }

  async openFile(path: string): Promise<void> {
    this.set({ file: { state: 'loading' } });
    this.set({ file: await this.run(() => this.api.previewFile(path)) });
  }

  closeFile(): void {
    this.set({ file: { state: 'idle' } });
  }

  async generate(config: ConfigDraft): Promise<void> {
    this.set({ generation: { state: 'loading' } });
    const generation = await this.run(() => this.api.generate(config));
    // What was planned is now on disk, so the preview's statuses are out of date.
    if (generation.state === 'done') this.set({ generation, preview: { state: 'idle' }, previewOf: null, file: { state: 'idle' } });
    else this.set({ generation });
  }

  private async run<T>(call: () => Promise<T>): Promise<Request<T>> {
    try {
      return { state: 'done', data: await call() };
    } catch (error) {
      return {
        state: 'error',
        message: (error as Error).message,
        issues: error instanceof ApiError ? error.issues : [],
      };
    }
  }
}
