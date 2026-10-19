import knexFactory, { type Knex } from 'knex';
import type { GeneratorConfig } from './config/types.js';
import { ProjectGenerator, type GenerationResult } from './generation/ProjectGenerator.js';
import { SchemaIntrospector } from './introspection/SchemaIntrospector.js';
import type { DatabaseModel } from './introspection/types.js';

/** The database could not be reached; the message says why in one line. */
export class DatabaseConnectionError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DatabaseConnectionError';
  }
}

/**
 * Entry point for programmatic use. The CLI and a future frontend both drive
 * the generator through this class.
 */
export class Generator {
  constructor(private readonly config: GeneratorConfig) {}

  /** Connects to the database, reads its schema and disconnects. */
  async introspect(): Promise<DatabaseModel> {
    const knex = this.createKnex();
    try {
      await this.checkConnection(knex);
      return await new SchemaIntrospector(knex, this.config).introspect();
    } finally {
      await knex.destroy();
    }
  }

  /** Reads the schema and writes a complete Fastify project to `outputDir`. */
  async generate(outputDir: string): Promise<GenerationResult> {
    return new ProjectGenerator(this.config).generate(await this.introspect(), outputDir);
  }

  private async checkConnection(knex: Knex): Promise<void> {
    try {
      await knex.raw('select 1');
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : String(error);
      throw new DatabaseConnectionError(`Cannot connect to the database: ${reason}`, error);
    }
  }

  private createKnex(): Knex {
    const { url, host, port, user, password, database, ssl } = this.config.database;
    const connection: Knex.PgConnectionConfig = url
      ? { connectionString: url }
      : { host, port, user, password, database };
    if (ssl !== undefined) connection.ssl = ssl;
    const quiet = () => {};
    return knexFactory({
      client: 'pg',
      connection,
      pool: { min: 0, max: 4 },
      acquireConnectionTimeout: 10_000,
      // Connection failures surface once, as a DatabaseConnectionError, instead of Knex's retry log.
      log: { warn: quiet, error: quiet, debug: quiet, deprecate: quiet },
    });
  }
}
