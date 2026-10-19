// Shapes of the `fastifygen ui` API. The model and config types come from the
// generator itself, so the two can't drift apart.
import type { GeneratorConfig, TableOverride } from '../../../src/config/types.js';
import type { ColumnModel, DatabaseModel, TableModel } from '../../../src/introspection/types.js';

export type { ColumnModel, GeneratorConfig, TableModel, TableOverride };

/** A config as edited in the form: any part may be missing until it is saved and validated. */
export type ConfigDraft = Record<string, unknown> & {
  $schema?: string;
  database?: Record<string, unknown>;
  overrides?: Record<string, TableOverride>;
};

export interface JsonSchemaNode {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

export interface UiState {
  configPath: string;
  exists: boolean;
  config: ConfigDraft | null;
  defaults: ConfigDraft;
  schema: JsonSchemaNode;
  issues: string[];
  missingEnv: string[];
}

export interface IntrospectionResult extends DatabaseModel {
  /** Tables an override skips; they are still listed so they can be brought back. */
  skipped: string[];
}

export type FileStatus = 'created' | 'updated' | 'unchanged' | 'kept';

export interface PlannedFile {
  path: string;
  kind: 'generated' | 'scaffold';
  status: FileStatus;
}

export interface GenerationResult {
  outputDir: string;
  tables: string[];
  files: PlannedFile[];
  warnings: string[];
  permissions: Record<string, Record<string, string>>;
  dryRun: boolean;
}
