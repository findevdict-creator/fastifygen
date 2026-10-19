import type { FastifyRequest } from 'fastify';
import { UnauthorizedError } from './errors.js';
import { PermissionChecker } from './PermissionChecker.js';
import type { PermissionAction, SchemaOverview } from './SchemaOverview.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Permission a route needs, e.g. `read:company`. Declared in the route's `config`. */
    permission?: string;
    action?: PermissionAction;
    table?: string;
  }
}

/**
 * Route-level permission check. Each generated route declares its permission
 * in `config` and lists `guard.checkPermission` as a `preHandler`, so the
 * permission is visible in the route declaration itself.
 */
export class RouteGuard {
  constructor(private readonly schema: SchemaOverview) {}

  checkPermission = async (request: FastifyRequest): Promise<void> => {
    const { action, table } = request.routeOptions.config;
    if (!action || !table) return;
    if (!request.accountability) throw new UnauthorizedError();
    new PermissionChecker(this.schema, request.accountability).assert(action, table);
  };
}
