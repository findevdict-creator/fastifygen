#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Command } from 'commander';
import { ConfigError, ConfigLoader, type LoadedConfig } from './config/ConfigLoader.js';
import { ConfigTemplate } from './config/ConfigTemplate.js';
import { DatabaseConnectionError, Generator } from './Generator.js';
import { UiServer } from './ui-server/UiServer.js';

/** Loads the config, pointing new users at `init` when there is none yet. */
async function loadConfig(file: string): Promise<LoadedConfig> {
  if (!existsSync(file)) {
    throw new ConfigError(`No config file at ${path.resolve(file)}. Run "fastifygen init" to create one.`);
  }
  return new ConfigLoader().load(file);
}

const program = new Command()
  .name('fastifygen')
  .description('Generate a class-based Fastify REST API from a PostgreSQL schema')
  .option('--env-file <path>', 'load environment variables from this file if it exists', '.env')
  .hook('preAction', (command) => {
    const envFile = command.opts<{ envFile: string }>().envFile;
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  });

program
  .command('init')
  .description('Write a starter config.json with every setting at its default')
  .option('-c, --config <path>', 'where to write it', 'config.json')
  .option('--database-url <url>', 'value for database.url (default: ${DATABASE_URL})')
  .option('-f, --force', 'overwrite an existing file')
  .action(async (options: { config: string; databaseUrl?: string; force?: boolean }) => {
    if (existsSync(options.config) && !options.force) {
      throw new ConfigError(`${options.config} already exists. Use --force to overwrite it.`);
    }
    await writeFile(options.config, ConfigTemplate.render({ databaseUrl: options.databaseUrl }));
    const usesEnv = !options.databaseUrl;
    console.error(
      [
        `Created ${options.config}. Next:`,
        usesEnv ? '  1. Set DATABASE_URL in your environment or in .env' : '  1. Review the settings in the file',
        `  2. npx fastifygen generate${options.config === 'config.json' ? '' : ` -c ${options.config}`} -o ./api`,
      ].join('\n'),
    );
  });

program
  .command('introspect')
  .description('Read the database schema and print it as JSON')
  .option('-c, --config <path>', 'path to config.json', 'config.json')
  .option('-o, --out <path>', 'write the JSON to a file instead of stdout')
  .action(async (options: { config: string; out?: string }) => {
    const { config } = await loadConfig(options.config);
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
    const loaded = await loadConfig(options.config);
    const outputDir = options.out ? path.resolve(options.out) : loaded.outputDir;
    const result = await new Generator(loaded.config).generate(outputDir);
    const count = (status: string) => result.files.filter((file) => file.status === status).length;
    console.error(
      `Generated ${result.tables.length} table module(s) in ${outputDir}: ` +
        `${count('created')} created, ${count('updated')} updated, ${count('unchanged')} unchanged, ${count('kept')} kept.`,
    );
    for (const warning of result.warnings) console.error(`warning: ${warning}`);
    const created = count('created') > 0 && count('kept') === 0;
    if (created) {
      const relative = path.relative(process.cwd(), outputDir) || '.';
      console.error(`\nNext: cd ${relative} && npm install && cp .env.example .env && npm run dev`);
    }
  });

program
  .command('ui')
  .description('Open the web UI to edit config.json, browse the schema and generate')
  .option('-c, --config <path>', 'config file to edit (created on first save)', 'config.json')
  .option('-p, --port <port>', 'port to listen on', '4321')
  .option('--no-open', 'do not open a browser')
  .action(async (options: { config: string; port: string; open: boolean }) => {
    const { url } = await new UiServer({ configPath: options.config, port: Number(options.port) }).listen();
    console.error(`fastifygen UI running at ${url} (editing ${path.resolve(options.config)}). Press Ctrl+C to stop.`);
    if (options.open) openBrowser(url);
  });

/** Best effort: if no browser opens, the URL is already printed. */
function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // Ignore: the URL is printed above.
  }
}

program.parseAsync().catch((error: unknown) => {
  const known = error instanceof ConfigError || error instanceof DatabaseConnectionError;
  console.error(known ? error.message : error);
  process.exitCode = 1;
});
