import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { configSchema } from './config.schema.js';
import type { GeneratorConfig } from './types.js';

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length ? `${message}\n  - ${issues.join('\n  - ')}` : message);
    this.name = 'ConfigError';
  }
}

export interface LoadedConfig {
  config: GeneratorConfig;
  /** Absolute path of the config file. */
  path: string;
  /** Absolute output folder, resolved against the config file's folder. */
  outputDir: string;
}

export interface ConfigLoaderOptions {
  /** Variables used for `${VAR}` substitution. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/** Reads `config.json`, substitutes `${ENV}` references, validates it and applies defaults. */
export class ConfigLoader {
  private static readonly ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

  private readonly env: Record<string, string | undefined>;
  private readonly validator: ValidateFunction;

  constructor(options: ConfigLoaderOptions = {}) {
    this.env = options.env ?? process.env;
    const ajv = new Ajv({ allErrors: true, useDefaults: true, coerceTypes: true });
    this.validator = ajv.compile(configSchema);
  }

  async load(configPath: string): Promise<LoadedConfig> {
    const absolutePath = path.resolve(configPath);
    let text: string;
    try {
      text = await readFile(absolutePath, 'utf8');
    } catch (error) {
      throw new ConfigError(`Cannot read config file ${absolutePath}: ${(error as Error).message}`);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new ConfigError(`Config file ${absolutePath} is not valid JSON: ${(error as Error).message}`);
    }

    const config = this.parse(raw);
    return {
      config,
      path: absolutePath,
      outputDir: path.resolve(path.dirname(absolutePath), config.output.dir),
    };
  }

  /** Validates an already-parsed config object. Does not modify the input. */
  parse(raw: unknown): GeneratorConfig {
    const resolved = this.substituteEnv(structuredClone(raw));
    if (!this.validator(resolved)) {
      throw new ConfigError('Invalid config', this.formatErrors(this.validator.errors ?? []));
    }
    return resolved as GeneratorConfig;
  }

  private substituteEnv(value: unknown): unknown {
    const missing = new Set<string>();
    const walk = (node: unknown): unknown => {
      if (typeof node === 'string') {
        return node.replace(ConfigLoader.ENV_REF, (_match, name: string, fallback?: string) => {
          const envValue = this.env[name];
          if (envValue !== undefined && envValue !== '') return envValue;
          if (fallback !== undefined) return fallback;
          missing.add(name);
          return '';
        });
      }
      if (Array.isArray(node)) return node.map(walk);
      if (node !== null && typeof node === 'object') {
        return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
      }
      return node;
    };

    const result = walk(value);
    if (missing.size > 0) {
      throw new ConfigError(
        'Config references environment variables that are not set',
        [...missing].map((name) => `\${${name}}`),
      );
    }
    return result;
  }

  private formatErrors(errors: ErrorObject[]): string[] {
    return errors
      .filter((error) => !error.schemaPath.includes('/anyOf'))
      .map((error) => {
        const where = error.instancePath || '(root)';
        if (error.keyword === 'additionalProperties') {
          return `${where}: unknown property "${String(error.params.additionalProperty)}"`;
        }
        if (error.keyword === 'enum') {
          return `${where}: must be one of ${(error.params.allowedValues as unknown[]).join(', ')}`;
        }
        return `${where}: ${error.message ?? 'is invalid'}`;
      })
      .concat(
        errors.some((error) => error.keyword === 'anyOf' && error.instancePath === '/database')
          ? ['/database: set either "url" or both "host" and "database"']
          : [],
      );
  }
}
