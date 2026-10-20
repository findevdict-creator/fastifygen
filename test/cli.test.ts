import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigLoader } from '../src/config/ConfigLoader.js';
import { ConfigTemplate } from '../src/config/ConfigTemplate.js';
import { DatabaseConnectionError, Generator } from '../src/Generator.js';
import { databaseUrl } from './helpers/database.js';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const tsx = path.join(repoRoot, 'node_modules/.bin/tsx');
const cli = path.join(repoRoot, 'src/cli.ts');

/** Runs the CLI in `cwd` and returns its exit code and stderr, without throwing on failure. */
async function fastifygen(cwd: string, args: string[], env: Record<string, string> = {}) {
  try {
    const { stderr } = await run(tsx, [cli, ...args], { cwd, env: { ...process.env, DATABASE_URL: '', ...env } });
    return { code: 0, stderr };
  } catch (error) {
    const failed = error as { code: number; stderr: string };
    return { code: failed.code, stderr: failed.stderr };
  }
}

describe('ConfigTemplate', () => {
  it('spells out exactly the defaults a minimal config gets', () => {
    const loader = new ConfigLoader({ env: { DATABASE_URL: 'postgres://localhost/app' } });
    const { $schema, ...template } = ConfigTemplate.build();
    expect($schema).toBe('./node_modules/fastifygen/schema/config.schema.json');
    expect(loader.parse(template)).toEqual(loader.parse({ database: { url: '${DATABASE_URL}' } }));
  });
});

describe('Generator', () => {
  it('reports an unreachable database in one line', async () => {
    const config = new ConfigLoader({ env: {} }).parse({ database: { url: 'postgres://nobody:x@127.0.0.1:1/none' } });
    const attempt = new Generator(config).introspect();
    await expect(attempt).rejects.toBeInstanceOf(DatabaseConnectionError);
    await expect(attempt).rejects.toThrow(/^Cannot connect to the database: .*ECONNREFUSED/);
  });
});

describe('fastifygen CLI', () => {
  it('points at init when there is no config, then init writes one once', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fastifygen-cli-'));

    const missing = await fastifygen(dir, ['generate']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('Run "fastifygen init" to create one.');

    const init = await fastifygen(dir, ['init']);
    expect(init.code).toBe(0);
    expect(init.stderr).toContain('Created config.json');
    expect(JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'))).toEqual(ConfigTemplate.build());

    const again = await fastifygen(dir, ['init']);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already exists');
  }, 30_000);

  it('prints one line, not a stack trace, when the database is unreachable', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fastifygen-cli-'));
    await fastifygen(dir, ['init']);
    const result = await fastifygen(dir, ['introspect'], { DATABASE_URL: 'postgres://nobody:x@127.0.0.1:1/none' });
    expect(result.code).toBe(1);
    expect(result.stderr.trim().split('\n')).toEqual([expect.stringMatching(/^Cannot connect to the database: /)]);
  }, 30_000);

  it('only accepts development or production as the mode', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fastifygen-cli-'));
    const result = await fastifygen(dir, ['generate', '--mode', 'staging']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Allowed choices are development, production');
  }, 30_000);

  it.skipIf(!databaseUrl)('generates without development files with --mode production', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fastifygen-cli-'));
    await fastifygen(dir, ['init']);
    const result = await fastifygen(dir, ['generate', '--mode', 'production'], { DATABASE_URL: databaseUrl! });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Next: cd generated && npm install && npm run build && npm start');
    expect(existsSync(path.join(dir, 'generated/src/server.ts'))).toBe(true);
    expect(existsSync(path.join(dir, 'generated/scripts/token.ts'))).toBe(false);
    expect(existsSync(path.join(dir, 'generated/README.md'))).toBe(false);
    expect(JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8')).output.mode).toBe('development');
  }, 30_000);
});
