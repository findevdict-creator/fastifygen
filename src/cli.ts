#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { ConfigError, ConfigLoader } from './config/ConfigLoader.js';
import { Generator } from './Generator.js';

const program = new Command()
  .name('fastifygen')
  .description('Generate a class-based Fastify REST API from a PostgreSQL schema')
  .option('--env-file <path>', 'load environment variables from this file if it exists', '.env')
  .hook('preAction', (command) => {
    const envFile = command.opts<{ envFile: string }>().envFile;
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  });

program
  .command('introspect')
  .description('Read the database schema and print it as JSON')
  .option('-c, --config <path>', 'path to config.json', 'config.json')
  .option('-o, --out <path>', 'write the JSON to a file instead of stdout')
  .action(async (options: { config: string; out?: string }) => {
    const { config } = await new ConfigLoader().load(options.config);
    const model = await new Generator(config).introspect();
    for (const warning of model.warnings) console.error(`warning: ${warning}`);
    const json = `${JSON.stringify(model, null, 2)}\n`;
    if (options.out) {
      await writeFile(options.out, json);
      console.error(`Wrote ${model.tables.length} tables to ${options.out}`);
    } else {
      process.stdout.write(json);
    }
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 1;
});
