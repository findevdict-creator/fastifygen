#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
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

program
  .command('generate')
  .description('Read the database schema and write the Fastify API')
  .option('-c, --config <path>', 'path to config.json', 'config.json')
  .option('-o, --out <path>', 'output folder (overrides output.dir in the config)')
  .action(async (options: { config: string; out?: string }) => {
    const loaded = await new ConfigLoader().load(options.config);
    const outputDir = options.out ? path.resolve(options.out) : loaded.outputDir;
    const result = await new Generator(loaded.config).generate(outputDir);
    const count = (status: string) => result.files.filter((file) => file.status === status).length;
    console.error(
      `Generated ${result.tables.length} table module(s) in ${outputDir}: ` +
        `${count('created')} created, ${count('updated')} updated, ${count('unchanged')} unchanged, ${count('kept')} kept.`,
    );
    for (const warning of result.warnings) console.error(`warning: ${warning}`);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 1;
});
