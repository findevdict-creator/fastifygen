import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ConfigError, ConfigLoader } from '../config/ConfigLoader.js';
import { configSchema } from '../config/config.schema.js';
import { ConfigTemplate } from '../config/ConfigTemplate.js';
import type { GeneratorConfig } from '../config/types.js';
import type { GenerationResult } from '../generation/ProjectGenerator.js';
import { DatabaseConnectionError, Generator } from '../Generator.js';

export interface UiServerOptions {
  /** The config.json the UI reads and saves. It may not exist yet. */
  configPath: string;
  host?: string;
  port?: number;
  /** Folder with the built frontend. Defaults to the one shipped with the package. */
  staticDir?: string;
  /** Variables for `${VAR}` substitution. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  logger?: boolean;
}

/** Every API request carries this header, so a cross-site page can't call the API without a CORS preflight it will fail. */
export const UI_HEADER = 'x-fastifygen-ui';

interface ConfigBody {
  config: unknown;
}

const configBodySchema = {
  type: 'object',
  properties: { config: { type: 'object' } },
  required: ['config'],
} as const;

/**
 * The local server behind `fastifygen ui`: a JSON API over the generator's
 * classes, plus the built frontend. Only for 127.0.0.1, since it can read
 * database credentials and write files.
 */
export class UiServer {
  private readonly configPath: string;
  private readonly loader: ConfigLoader;
  private lastPreview: Map<string, string> | null = null;

  constructor(private readonly options: UiServerOptions) {
    this.configPath = path.resolve(options.configPath);
    this.loader = new ConfigLoader({ env: options.env });
  }

  /** The built frontend: next to this file once compiled, or in `dist/ui-app` when running from source. */
  static defaultStaticDir(): string | null {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [path.resolve(here, '../ui-app'), path.resolve(here, '../../dist/ui-app')];
    return candidates.find((dir) => existsSync(path.join(dir, 'index.html'))) ?? null;
  }

  async build(): Promise<FastifyInstance> {
    const app = Fastify({ logger: this.options.logger ?? false, bodyLimit: 5 * 1024 * 1024 });
    app.addHook('onRequest', this.guard);
    app.setErrorHandler(this.errorHandler);

    await app.register(this.api, { prefix: '/api' });

    const staticDir = this.options.staticDir ?? UiServer.defaultStaticDir();
    if (staticDir) {
      await app.register(fastifyStatic, { root: staticDir, wildcard: false });
      // Any other GET is a frontend route.
      app.setNotFoundHandler((request, reply) =>
        request.method === 'GET' && !request.url.startsWith('/api/')
          ? reply.sendFile('index.html')
          : reply.status(404).send({ error: { message: `Route ${request.method} ${request.url} doesn't exist` } }),
      );
    } else {
      app.get('/', async (_request, reply) =>
        reply.type('text/plain').send('The fastifygen UI has not been built. Run "npm run build" in the fastifygen folder.'),
      );
    }
    return app;
  }

  async listen(): Promise<{ app: FastifyInstance; url: string }> {
    const app = await this.build();
    const host = this.options.host ?? '127.0.0.1';
    await app.listen({ host, port: this.options.port ?? 4321 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : this.options.port;
    return { app, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}` };
  }

  // ---- API -----------------------------------------------------------------

  private api = async (api: FastifyInstance): Promise<void> => {
    api.addHook('onRequest', async (request) => {
      if (request.headers[UI_HEADER] !== '1') throw new UiError(403, `Missing the ${UI_HEADER} header`);
    });

    /** Everything the frontend needs to start: the saved config (with `${VAR}` references intact), defaults and the JSON Schema. */
    api.get('/state', async () => {
      const raw = await this.readRawConfig();
      return {
        configPath: this.configPath,
        exists: raw !== null,
        config: raw,
        defaults: ConfigTemplate.build(),
        schema: configSchema,
        issues: raw === null ? [] : this.loader.validate(raw),
        missingEnv: raw === null ? [] : this.loader.missingEnv(raw),
      };
    });

    api.put<{ Body: ConfigBody }>('/config', { schema: { body: configBodySchema } }, async (request) => {
      const issues = this.loader.validate(request.body.config);
      if (issues.length > 0) throw new UiError(400, 'The config is not valid', issues);
      await writeFile(this.configPath, `${JSON.stringify(request.body.config, null, 2)}\n`);
      return { saved: true, configPath: this.configPath, missingEnv: this.loader.missingEnv(request.body.config) };
    });

    api.post<{ Body: ConfigBody }>('/connection', { schema: { body: configBodySchema } }, async (request) => {
      const config = this.resolve(request.body.config);
      return { ok: true, ...(await new Generator(config).testConnection()) };
    });

    /** The schema, including tables an override skips, so the UI can show them and bring them back. */
    api.post<{ Body: ConfigBody }>('/introspect', { schema: { body: configBodySchema } }, async (request) => {
      const config = this.resolve(request.body.config);
      const skipped = Object.entries(config.overrides)
        .filter(([, override]) => override.skip)
        .map(([table]) => table);
      const overrides = Object.fromEntries(
        Object.entries(config.overrides).map(([table, { skip: _skip, ...rest }]) => [table, rest]),
      );
      const model = await new Generator({ ...config, overrides }).introspect();
      return { ...model, skipped: skipped.filter((table) => model.tables.some((t) => t.name === table)) };
    });

    /** What `generate` would do, without writing. File contents are kept for `/preview/file`. */
    api.post<{ Body: ConfigBody }>('/preview', { schema: { body: configBodySchema } }, async (request) => {
      const config = this.resolve(request.body.config);
      const result = await new Generator(config).generate(this.outputDir(config), { dryRun: true, includeContent: true });
      this.lastPreview = new Map(result.files.map((file) => [file.path, file.content ?? '']));
      return this.withoutContent(result);
    });

    api.get<{ Querystring: { path: string } }>(
      '/preview/file',
      { schema: { querystring: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
      async (request) => {
        const content = this.lastPreview?.get(request.query.path);
        if (content === undefined) throw new UiError(404, 'No such file in the last preview. Run a preview first.');
        return { path: request.query.path, content };
      },
    );

    api.post<{ Body: ConfigBody }>('/generate', { schema: { body: configBodySchema } }, async (request) => {
      const config = this.resolve(request.body.config);
      return this.withoutContent(await new Generator(config).generate(this.outputDir(config)));
    });
  };

  // ---- Helpers -------------------------------------------------------------

  private async readRawConfig(): Promise<unknown> {
    const text = await readFile(this.configPath, 'utf8').catch(() => null);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new UiError(500, `${this.configPath} is not valid JSON: ${(error as Error).message}`);
    }
  }

  private resolve(raw: unknown): GeneratorConfig {
    return this.loader.parse(raw);
  }

  private outputDir(config: GeneratorConfig): string {
    return ConfigLoader.outputDir(this.configPath, config);
  }

  private withoutContent(result: GenerationResult): GenerationResult {
    return { ...result, files: result.files.map(({ content: _content, ...file }) => file) };
  }

  /** Refuses requests whose Host isn't this machine, so a DNS-rebinding page can't reach the API. */
  private guard = async (request: FastifyRequest): Promise<void> => {
    const host = (request.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new UiError(403, 'The fastifygen UI only answers on localhost');
  };

  private errorHandler = (error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof UiError) return reply.status(error.status).send(error.toJSON());
    if (error instanceof ConfigError) {
      return reply.status(400).send({ error: { message: error.message.split('\n')[0], issues: error.issues } });
    }
    if (error instanceof DatabaseConnectionError) return reply.status(503).send({ error: { message: error.message } });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: { message: (error as Error).message } });
    request.log.error(error);
    return reply.status(500).send({ error: { message: (error as Error).message ?? 'Unexpected error' } });
  };
}

class UiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }

  toJSON() {
    return { error: { message: this.message, ...(this.issues.length ? { issues: this.issues } : {}) } };
  }
}
