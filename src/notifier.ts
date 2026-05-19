// In-process fan-out for long-poll wait endpoints. After the store appends an event,
// it calls notifier.notify(documentName) and the wait handler (which has registered a
// resolver) wakes and drains the DB for events past its cursor.
//
// Single-process for v1; multi-process scaling would swap this for a pub/sub-backed
// notifier (postgres LISTEN/NOTIFY, redis pub/sub) without changing the surface.

import type { DocumentName } from './models.js';

export type NotifierUnsubscribe = () => void;
export type NotifierResolver = () => void;

export class EventNotifier {
  private readonly resolvers = new Map<DocumentName, Set<NotifierResolver>>();

  /** Called by the store after an event is appended to `documentName`. */
  notify(documentName: DocumentName): void {
    const set = this.resolvers.get(documentName);
    if (!set) return;
    // Copy before iterating: a resolver may unregister itself synchronously.
    for (const resolver of [...set]) {
      try {
        resolver();
      } catch {
        // resolver errors are not our problem; the handler is responsible for its own state.
      }
    }
  }

  /** Register a resolver for `documentName`. Returns an unsubscribe function. */
  register(documentName: DocumentName, resolver: NotifierResolver): NotifierUnsubscribe {
    let set = this.resolvers.get(documentName);
    if (!set) {
      set = new Set();
      this.resolvers.set(documentName, set);
    }
    set.add(resolver);
    return () => {
      const s = this.resolvers.get(documentName);
      if (!s) return;
      s.delete(resolver);
      if (s.size === 0) this.resolvers.delete(documentName);
    };
  }

  /** Total number of registered resolvers across all documents. Test/debug helper. */
  size(): number {
    let n = 0;
    for (const set of this.resolvers.values()) n += set.size;
    return n;
  }
}
