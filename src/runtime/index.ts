// Runtime core shared by every generated API. Self-contained: it depends only
// on knex and fastify, never on the generator.
export * from './errors.js';
export * from './types.js';
export { SchemaOverview, type ResolvedRelation, type PermissionAction } from './SchemaOverview.js';
export { PermissionChecker } from './PermissionChecker.js';
export { QueryParser, type QueryParserLimits } from './query/QueryParser.js';
export { FieldsResolver, type FieldTree } from './query/FieldsResolver.js';
export { FilterApplier, type FilterContext } from './query/FilterApplier.js';
export { ItemsRepository, type RepositoryContext } from './ItemsRepository.js';
export { ItemsService, type ServiceContext } from './ItemsService.js';
export { ItemsController, type ControllerContext } from './ItemsController.js';
export { RouteGuard } from './RouteGuard.js';
