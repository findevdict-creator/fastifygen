/** Reads and immutably updates nested values in a config object by key path, e.g. `['api', 'maxLimit']`. */
export class ConfigPath {
  static get(source: unknown, path: readonly string[]): unknown {
    let node = source;
    for (const key of path) {
      if (node === null || typeof node !== 'object') return undefined;
      node = (node as Record<string, unknown>)[key];
    }
    return node;
  }

  /**
   * Returns a copy of `source` with the value at `path` replaced. `undefined`
   * removes the key, and objects left empty by a removal are removed too, so
   * clearing a field puts the default back instead of saving `{}`.
   */
  static set<T extends Record<string, unknown>>(source: T, path: readonly string[], value: unknown): T {
    const [key, ...rest] = path;
    if (key === undefined) return source;
    const copy: Record<string, unknown> = { ...source };
    const next = rest.length === 0 ? value : ConfigPath.set(ConfigPath.asObject(copy[key]), rest, value);
    if (next === undefined || (rest.length > 0 && ConfigPath.isEmptyObject(next))) delete copy[key];
    else copy[key] = next;
    return copy as T;
  }

  private static asObject(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  private static isEmptyObject(value: unknown): boolean {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
  }
}

/** Turns config keys into labels: `defaultLimit` → "Default limit", `ssl` → "SSL". */
export class Labels {
  private static readonly ACRONYMS: Record<string, string> = { url: 'URL', ssl: 'SSL', rls: 'RLS', api: 'API', id: 'ID' };

  static humanize(key: string): string {
    const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().split(' ');
    return words
      .map((word, index) => Labels.ACRONYMS[word] ?? (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
      .join(' ');
  }
}
