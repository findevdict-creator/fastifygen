import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GeneratorConfig } from '../config/types.js';
import type { DatabaseModel } from '../introspection/types.js';
import { GENERATED_HEADER } from './emitters/headers.js';
import { ModuleEmitter } from './emitters/ModuleEmitter.js';
import { ProjectEmitter } from './emitters/ProjectEmitter.js';
import { RlsEmitter } from './emitters/RlsEmitter.js';
import { FileWriter, type WrittenFile } from './FileWriter.js';
import { RuntimeSchemaBuilder } from './RuntimeSchemaBuilder.js';

export interface GenerationResult {
  outputDir: string;
  tables: string[];
  files: WrittenFile[];
  warnings: string[];
}

/** Writes a complete, runnable Fastify project for a database model. */
export class ProjectGenerator {
  private readonly modules: ModuleEmitter;

  constructor(private readonly config: GeneratorConfig) {
    this.modules = new ModuleEmitter(config);
  }

  async generate(model: DatabaseModel, outputDir: string): Promise<GenerationResult> {
    const writer = new FileWriter(outputDir);
    const warnings = [...model.warnings];

    await this.copyRuntime(writer);

    const permissions: Record<string, Record<string, string>> = {};
    for (const table of model.tables) {
      for (const file of this.modules.emit(table)) await writer.write(file.path, file.content, file.kind);
      permissions[table.name] = Object.fromEntries(
        [...new Set(this.modules.routesFor(table).map((route) => route.action))].map((action) => [
          action,
          this.modules.permissionName(action, table.name),
        ]),
      );
    }

    const project = new ProjectEmitter(this.config).emit({
      name: path.basename(outputDir),
      model,
      runtimeSchema: new RuntimeSchemaBuilder(this.config).build(model),
      permissions,
    });
    for (const file of project) await writer.write(file.path, file.content, file.kind);

    if (this.config.tenancy.enabled && this.config.tenancy.rls) {
      await writer.write('sql/rls.sql', new RlsEmitter(this.config).emit(model), 'generated');
    }

    const kept = writer.files.filter((file) => file.status === 'kept').map((file) => file.path);
    if (kept.length > 0 && writer.files.some((file) => file.status === 'updated')) {
      warnings.push(`Kept ${kept.length} file(s) you own unchanged; update them by hand if the schema change affects them.`);
    }
    return { outputDir, tables: model.tables.map((table) => table.name), files: writer.files, warnings };
  }

  /** Copies the runtime core's TypeScript source into `src/core/`. */
  private async copyRuntime(writer: FileWriter): Promise<void> {
    const runtimeDir = ProjectGenerator.runtimeSourceDir();
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const files = await Promise.all(
        entries.map((entry) => {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) return walk(full);
          return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
        }),
      );
      return files.flat();
    };
    for (const file of (await walk(runtimeDir)).sort()) {
      const content = await readFile(file, 'utf8');
      await writer.write(path.join('src/core', path.relative(runtimeDir, file)), `${GENERATED_HEADER}\n${content}`, 'generated');
    }
  }

  /** The runtime's TypeScript source: next to this file in development, or shipped in `src/runtime` with the package. */
  static runtimeSourceDir(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [path.resolve(here, '../runtime'), path.resolve(here, '../../src/runtime')];
    const found = candidates.find((dir) => existsSync(path.join(dir, 'ItemsService.ts')));
    if (!found) throw new Error(`Cannot find the runtime source (looked in ${candidates.join(', ')})`);
    return found;
  }
}
