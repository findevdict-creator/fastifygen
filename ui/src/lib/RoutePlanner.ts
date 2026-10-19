import type { ConfigDraft, TableModel } from '../api/types.js';

export interface PlannedRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  action: 'create' | 'read' | 'update' | 'delete';
  permission: string;
}

const ROUTES = [
  { name: 'readMany', method: 'GET', url: '', action: 'read' },
  { name: 'readOne', method: 'GET', url: '/:id', action: 'read' },
  { name: 'create', method: 'POST', url: '', action: 'create' },
  { name: 'updateMany', method: 'PATCH', url: '', action: 'update' },
  { name: 'updateOne', method: 'PATCH', url: '/:id', action: 'update' },
  { name: 'deleteMany', method: 'DELETE', url: '', action: 'delete' },
  { name: 'deleteOne', method: 'DELETE', url: '/:id', action: 'delete' },
] as const;

/**
 * Which routes and permissions a table gets under a draft config. Mirrors the
 * generator's ModuleEmitter.routesFor, so the schema screen can update live
 * without a round trip; a test keeps the two in step.
 */
export class RoutePlanner {
  constructor(private readonly config: ConfigDraft) {}

  routes(table: Pick<TableModel, 'name' | 'primaryKey'>): PlannedRoute[] {
    const override = this.config.overrides?.[table.name] ?? {};
    const actions = (this.setting<string[]>('permissions', 'actions') ?? ['create', 'read', 'update', 'delete']);
    const hasKey = table.primaryKey.length > 0;
    const base = `${this.setting<string>('api', 'prefix') ?? '/items'}/${override.routeName || table.name}`;

    return ROUTES.filter((route) => {
      if (override.readOnly && route.action !== 'read') return false;
      if (!hasKey && !(route.name === 'readMany' || route.name === 'create')) return false;
      return actions.includes(route.action) || route.action === 'read';
    }).map((route) => ({
      method: route.method,
      path: `${base}${route.url}`,
      action: route.action,
      permission: this.permission(route.action, table.name),
    }));
  }

  permission(action: string, table: string): string {
    const format = this.setting<string>('permissions', 'format') ?? '{action}:{table}';
    return format.replaceAll('{action}', action).replaceAll('{table}', table);
  }

  private setting<T>(section: string, key: string): T | undefined {
    const value = (this.config[section] as Record<string, unknown> | undefined)?.[key];
    return value === undefined ? undefined : (value as T);
  }
}
