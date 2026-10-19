/** Turns table names into identifiers for generated code. */
export class Naming {
  /** `project_members` → `ProjectMembers`. */
  static pascal(name: string): string {
    const pascal = name
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
    return /^[0-9]/.test(pascal) ? `T${pascal}` : pascal || 'Table';
  }

  /** `project_members` → `projectMembers`. */
  static camel(name: string): string {
    const pascal = Naming.pascal(name);
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
  }
}
