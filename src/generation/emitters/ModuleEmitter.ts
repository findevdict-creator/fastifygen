import type { GeneratorConfig } from '../../config/types.js';
import type { TableModel } from '../../introspection/types.js';
import { JsonSchemaBuilder } from '../JsonSchemaBuilder.js';
import { Naming } from '../Naming.js';
import { GENERATED_HEADER, SCAFFOLD_HEADER } from './headers.js';

export interface ModuleFile {
  path: string;
  content: string;
  kind: 'generated' | 'scaffold';
}

type RouteName = 'readMany' | 'readOne' | 'create' | 'updateOne' | 'updateMany' | 'deleteOne' | 'deleteMany';

interface RouteSpec {
  name: RouteName;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: '/' | '/:id';
  action: 'read' | 'create' | 'update' | 'delete';
  schema: string[];
}

/** Emits the files for one table's module: routes, schemas, types and the extension classes. */
export class ModuleEmitter {
  private static readonly ROUTES: RouteSpec[] = [
    { name: 'readMany', method: 'GET', url: '/', action: 'read', schema: ['querystring: schemas.query', 'response: { 200: schemas.listResponse }'] },
    { name: 'readOne', method: 'GET', url: '/:id', action: 'read', schema: ['params: schemas.params', 'querystring: schemas.query', 'response: { 200: schemas.itemResponse }'] },
    { name: 'create', method: 'POST', url: '/', action: 'create', schema: ['querystring: schemas.query', 'body: schemas.createBody', 'response: { 200: schemas.writeResponse }'] },
    { name: 'updateMany', method: 'PATCH', url: '/', action: 'update', schema: ['querystring: schemas.query', 'body: schemas.updateManyBody', 'response: { 200: schemas.writeResponse }'] },
    { name: 'updateOne', method: 'PATCH', url: '/:id', action: 'update', schema: ['params: schemas.params', 'querystring: schemas.query', 'body: schemas.updateBody', 'response: { 200: schemas.itemResponse }'] },
    { name: 'deleteMany', method: 'DELETE', url: '/', action: 'delete', schema: ['body: schemas.deleteManyBody'] },
    { name: 'deleteOne', method: 'DELETE', url: '/:id', action: 'delete', schema: ['params: schemas.params'] },
  ];

  private readonly schemas: JsonSchemaBuilder;

  constructor(private readonly config: GeneratorConfig) {
    this.schemas = new JsonSchemaBuilder(config);
  }

  /** Routes this table gets: read-only tables only read; tables without a primary key cannot be addressed by key. */
  routesFor(table: TableModel): RouteSpec[] {
    const readOnly = this.config.overrides[table.name]?.readOnly ?? false;
    const hasKey = table.primaryKey.length > 0;
    return ModuleEmitter.ROUTES.filter((route) => {
      if (readOnly && route.action !== 'read') return false;
      if (!hasKey && !(route.name === 'readMany' || route.name === 'create')) return false;
      return this.config.permissions.actions.includes(route.action) || route.action === 'read';
    });
  }

  emit(table: TableModel): ModuleFile[] {
    const name = Naming.pascal(table.name);
    const dir = `src/modules/${table.name}`;
    return [
      { path: `${dir}/${table.name}.schemas.ts`, content: this.schemasFile(table), kind: 'generated' },
      { path: `${dir}/${table.name}.types.ts`, content: this.typesFile(table), kind: 'generated' },
      { path: `${dir}/${name}Routes.ts`, content: this.routesFile(table), kind: 'generated' },
      { path: `${dir}/${name}Repository.ts`, content: this.repositoryFile(table), kind: 'scaffold' },
      { path: `${dir}/${name}Service.ts`, content: this.serviceFile(table), kind: 'scaffold' },
      { path: `${dir}/${name}Controller.ts`, content: this.controllerFile(table), kind: 'scaffold' },
    ];
  }

  permissionName(action: string, table: string): string {
    return this.config.permissions.format.replaceAll('{action}', action).replaceAll('{table}', table);
  }

  private schemasFile(table: TableModel): string {
    const schemas = this.schemas.build(table);
    return `${GENERATED_HEADER}
/** JSON Schemas for \`${table.name}\`. Fastify validates requests and serializes responses with them. */
export const ${Naming.camel(table.name)}Schemas = ${JSON.stringify(schemas, null, 2)} as const;
`;
  }

  private typesFile(table: TableModel): string {
    const hidden = new Set(this.config.overrides[table.name]?.hiddenColumns ?? []);
    const lines = table.columns.map((column) => {
      const comment = column.comment ? `  /** ${column.comment.replaceAll('*/', '*\\/')} */\n` : '';
      const hiddenNote = hidden.has(column.name) ? '  /** Hidden: never returned by the API. */\n' : '';
      const type = column.nullable ? `${column.tsType} | null` : column.tsType;
      return `${comment}${hiddenNote}  ${column.name}: ${type};`;
    });
    return `${GENERATED_HEADER}
/** A row of \`${table.name}\` as Postgres returns it. */
export interface ${Naming.pascal(table.name)} {
${lines.join('\n')}
}
`;
  }

  private routesFile(table: TableModel): string {
    const name = Naming.pascal(table.name);
    const routes = this.routesFor(table).map((route) => {
      const permission = this.permissionName(route.action, table.name);
      return `    fastify.route({
      method: '${route.method}',
      url: '${route.url}',
      schema: {
        ${route.schema.join(',\n        ')},
      },
      config: { permission: '${permission}', action: '${route.action}', table: '${table.name}' },
      preValidation: [this.auth.authenticate],
      preHandler: [this.guard.checkPermission],
      handler: this.controller.${route.name},
    });`;
    });

    return `${GENERATED_HEADER}
import type { FastifyInstance } from 'fastify';
import type { AuthHook } from '../../auth/AuthHook.js';
import type { RouteGuard } from '../../core/index.js';
import type { ${name}Controller } from './${name}Controller.js';
import { ${Naming.camel(table.name)}Schemas as schemas } from './${table.name}.schemas.js';

/** Routes for \`${table.name}\`, declared with Fastify's full route options. */
export class ${name}Routes {
  constructor(
    private readonly controller: ${name}Controller,
    private readonly auth: AuthHook,
    private readonly guard: RouteGuard,
  ) {}

  register = async (fastify: FastifyInstance): Promise<void> => {
${routes.join('\n\n')}
  };
}
`;
  }

  private repositoryFile(table: TableModel): string {
    const name = Naming.pascal(table.name);
    return `${SCAFFOLD_HEADER}
import { ItemsRepository, type RepositoryContext } from '../../core/index.js';

/** Data access for \`${table.name}\`. Add custom queries here. */
export class ${name}Repository extends ItemsRepository {
  constructor(ctx: RepositoryContext) {
    super('${table.name}', ctx);
  }
}
`;
  }

  private serviceFile(table: TableModel): string {
    const name = Naming.pascal(table.name);
    return `${SCAFFOLD_HEADER}
import type { Knex } from 'knex';
import { ItemsService, type ServiceContext } from '../../core/index.js';
import { ${name}Repository } from './${name}Repository.js';

/**
 * Business logic for \`${table.name}\`. Override \`prepareCreate\` or
 * \`prepareUpdate\` to transform input, or any method to change behaviour.
 */
export class ${name}Service extends ItemsService {
  constructor(ctx: ServiceContext) {
    super('${table.name}', ctx);
  }

  protected override createRepository(trx: Knex.Transaction): ${name}Repository {
    return new ${name}Repository(this.repositoryContext(trx));
  }
}
`;
  }

  private controllerFile(table: TableModel): string {
    const name = Naming.pascal(table.name);
    return `${SCAFFOLD_HEADER}
import { ItemsController, type ControllerContext } from '../../core/index.js';
import { ${name}Service } from './${name}Service.js';

/** HTTP handlers for \`${table.name}\`. */
export class ${name}Controller extends ItemsController {
  constructor(ctx: Omit<ControllerContext, 'createService'>) {
    super('${table.name}', { ...ctx, createService: (_table, serviceCtx) => new ${name}Service(serviceCtx) });
  }
}
`;
  }
}
