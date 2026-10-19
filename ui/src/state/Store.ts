import { useSyncExternalStore } from 'react';

/**
 * Base class for the app's state. Subclasses hold the logic as methods and
 * call `set` to publish a new immutable snapshot; components read it with
 * {@link useStore}.
 */
export abstract class Store<T extends object> {
  private readonly listeners = new Set<() => void>();

  protected constructor(private state: T) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): T => this.state;

  protected set(patch: Partial<T>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** Re-renders the component whenever the store publishes a new snapshot. */
export function useStore<T extends object>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** The lifecycle of one request, for showing spinners, results and errors. */
export type Request<T> =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'done'; data: T }
  | { state: 'error'; message: string; issues: string[] };
