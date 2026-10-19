import { ForbiddenError } from './errors.js';
import type { PermissionAction, SchemaOverview } from './SchemaOverview.js';
import type { Accountability } from './types.js';

/**
 * Checks `{action}:{table}` permissions. Grants `*` (everything),
 * `{action}:*` (an action on every table) and `*:{table}` (every action on a table).
 */
export class PermissionChecker {
  private readonly granted: Set<string>;

  constructor(
    private readonly schema: SchemaOverview,
    accountability: Accountability,
  ) {
    this.granted = new Set(accountability.permissions);
  }

  can(action: PermissionAction, table: string): boolean {
    return (
      this.granted.has('*') ||
      this.granted.has(this.schema.permissionName(action, table)) ||
      this.granted.has(this.schema.permissionName(action, '*')) ||
      this.granted.has(this.schema.permissionName('*', table))
    );
  }

  assert(action: PermissionAction, table: string): void {
    if (!this.can(action, table)) {
      throw new ForbiddenError(`Missing permission "${this.schema.permissionName(action, table)}"`);
    }
  }
}
