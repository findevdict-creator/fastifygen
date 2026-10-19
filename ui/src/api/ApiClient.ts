import type { ConfigDraft, GenerationResult, IntrospectionResult, UiState } from './types.js';

/** An error the API answered with: a message, and the list of problems when a config is invalid. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Talks to the local `fastifygen ui` server. Every call sends the draft config, saved or not. */
export class ApiClient {
  constructor(private readonly base = '/api') {}

  state(): Promise<UiState> {
    return this.request('GET', '/state');
  }

  saveConfig(config: ConfigDraft): Promise<{ saved: true; configPath: string; missingEnv: string[] }> {
    return this.request('PUT', '/config', { config });
  }

  testConnection(config: ConfigDraft): Promise<{ ok: true; serverVersion: string }> {
    return this.request('POST', '/connection', { config });
  }

  introspect(config: ConfigDraft): Promise<IntrospectionResult> {
    return this.request('POST', '/introspect', { config });
  }

  preview(config: ConfigDraft): Promise<GenerationResult> {
    return this.request('POST', '/preview', { config });
  }

  previewFile(path: string): Promise<{ path: string; content: string }> {
    return this.request('GET', `/preview/file?path=${encodeURIComponent(path)}`);
  }

  generate(config: ConfigDraft): Promise<GenerationResult> {
    return this.request('POST', '/generate', { config });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: { 'x-fastifygen-ui': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError('Cannot reach the fastifygen UI server. Is "fastifygen ui" still running?', 0);
    }
    const payload = (await response.json().catch(() => null)) as { error?: { message: string; issues?: string[] } } | null;
    if (!response.ok) {
      throw new ApiError(payload?.error?.message ?? `Request failed (${response.status})`, response.status, payload?.error?.issues);
    }
    return payload as T;
  }
}
