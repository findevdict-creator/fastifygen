import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * - `generated`: owned by the generator, rewritten on every run. Do not edit.
 * - `scaffold`: written once, then yours to edit; later runs leave it alone.
 */
export type FileKind = 'generated' | 'scaffold';

export type FileStatus = 'created' | 'updated' | 'unchanged' | 'kept';

export interface WrittenFile {
  /** Path relative to the output folder, with forward slashes. */
  path: string;
  kind: FileKind;
  status: FileStatus;
  /** The generated content, when {@link FileWriterOptions.includeContent} is set. */
  content?: string;
}

export interface FileWriterOptions {
  /** Work out each file's status without writing anything. */
  dryRun?: boolean;
  /** Keep each file's generated content on its {@link WrittenFile}, e.g. for a preview. */
  includeContent?: boolean;
}

/** Writes generated files and records what happened to each, for the CLI and the UI. */
export class FileWriter {
  readonly files: WrittenFile[] = [];

  constructor(
    private readonly outputDir: string,
    private readonly options: FileWriterOptions = {},
  ) {}

  async write(relativePath: string, content: string, kind: FileKind): Promise<WrittenFile> {
    const target = path.join(this.outputDir, relativePath);
    const existing = await readFile(target, 'utf8').catch(() => null);

    let status: FileStatus;
    if (existing === null) status = 'created';
    else if (kind === 'scaffold') status = 'kept';
    else if (existing === content) status = 'unchanged';
    else status = 'updated';

    if (!this.options.dryRun && (status === 'created' || status === 'updated')) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const file: WrittenFile = { path: relativePath.split(path.sep).join('/'), kind, status };
    if (this.options.includeContent) file.content = content;
    this.files.push(file);
    return file;
  }
}
