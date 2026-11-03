/**
 * Pi Matrix Integration — minimal domain-event dispatcher
 *
 * The full transport-and-state.md `DomainEvent` union (user/agent/milestone/
 * session-thread-* families) is deferred — it ships with its first
 * real consumer (e.g. `thread-resume-requested`). This slice carries
 * only the events with a live consumer today (the "minimal funnel"
 * decision):
 *
 * - `decision-closed` — an rpiv ask-user questionnaire is no longer
 *   blocked; consumer (registered per stack build in index.ts): the
 *   mirror reset (`onBlocked(false)`) + the thread ledger
 *   (`noteDecisionClosed`).
 *
 * Sync errors do NOT ride the dispatcher: the SdkOutbox sync handler
 * feeds them straight to `lifecycle.noteSyncError` through the delivery
 * callbacks bundle (`onSyncError`) — one producer, one consumer, no
 * indirection needed.
 *
 * Growth rule (documented): a new capability = one new union member +
 * its handler(s) — the dispatcher never changes shape (handlers register
 * per event type).
 */

export type DomainEvent = { type: "decision-closed"; source: "rpiv" };

export type DomainEventType = DomainEvent["type"];

export interface EventDispatcher {
  /** Emit to the registered handlers of the event's family (sync, registration order). */
  emit(event: DomainEvent): void;
  /**
   * Register a handler for one event type. Returns the unsubscribe.
   * A throwing handler is caught + logged — the funnel must never take
   * down the caller (the "no message is ever dropped" contract).
   */
  on<K extends DomainEventType>(
    type: K,
    handler: (event: Extract<DomainEvent, { type: K }>) => void,
  ): () => void;
}

/**
 * Build the dispatcher. `warn` (optional) receives a handler-failure
 * line; pass the extension logger's `warn` in.
 */
export function createEventDispatcher(warn?: (message: string) => void): EventDispatcher {
  const handlers = new Map<DomainEventType, Set<(event: DomainEvent) => void>>();
  const register = (type: DomainEventType) => {
    let set = handlers.get(type);
    if (!set) {
      set = new Set();
      handlers.set(type, set);
    }
    return set;
  };
  return {
    emit(event) {
      for (const handler of handlers.get(event.type) ?? []) {
        try {
          handler(event);
        } catch (error) {
          warn?.(`[matrix] ${event.type} handler failed: ${error}`);
        }
      }
    },
    on(type, handler) {
      const set = register(type);
      const cast = handler as (event: DomainEvent) => void;
      set.add(cast);
      return () => {
        set.delete(cast);
      };
    },
  };
}
