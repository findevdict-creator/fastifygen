import knexFactory, { type Knex } from 'knex';
import type { GeneratorConfig } from './config/types.js';
import { SchemaIntrospector } from './introspection/SchemaIntrospector.js';
import type { DatabaseModel } from './introspection/types.js';

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
      return await new SchemaIntrospector(knex, this.config).introspect();
    } finally {
      await knex.destroy();
    }
  }

  private createKnex(): Knex {
    const { url, host, port, user, password, database, ssl } = this.config.database;
    const connection: Knex.PgConnectionConfig = url
      ? { connectionString: url }
      : { host, port, user, password, database };
    if (ssl !== undefined) connection.ssl = ssl;
    return knexFactory({ client: 'pg', connection, pool: { min: 0, max: 4 } });
  }
}
