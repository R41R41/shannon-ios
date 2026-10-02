import { emotionTiming } from './emotionTiming.js';
import { sqliteOwnerSnapshot } from './ownerUpcomingWiring.js';
import { SQLiteShannonStore } from './sqliteStore.js';

/**
 * While she works in a session of her own she is awake, so her awake clock runs. Core: emotion.
 *
 * This is the one write the activity loop's process makes to the companion state: the reducer event
 * `awake-observed`, through the state store. The event carries no content, and this module gives
 * the loop nothing back, so the loop learns nothing of her feeling or of any conversation from it.
 * It is not written more often than once a minute; the time between two writes is still counted,
 * up to the idle cap. A failure here never stops a step.
 */
const MINIMUM_INTERVAL_MILLISECONDS = 60_000;

export interface AutonomyAwakeClock {
  /** She just took a step of her own for this scope. */
  observe(scopeKey: string): void;
  close(): void;
}

export function configuredAwakeClock(databasePath: string, options: { now: () => string }): AutonomyAwakeClock {
  let opened: { store: SQLiteShannonStore; exists: ReturnType<typeof sqliteOwnerSnapshot> } | null = null;
  const last = new Map<string, number>();
  return {
    observe(scopeKey) {
      try {
        // Under the kill switch nothing fades on an awake clock, so nothing is opened or written.
        if (emotionTiming().clock !== 'awake') return;
        const at = options.now();
        const time = Date.parse(at);
        const previous = last.get(scopeKey);
        if (previous !== undefined && time - previous >= 0 && time - previous < MINIMUM_INTERVAL_MILLISECONDS) return;
        opened ??= { store: new SQLiteShannonStore({ path: databasePath, now: options.now }), exists: sqliteOwnerSnapshot(databasePath) };
        // The state store writes a first state for a scope it has never seen; the loop never causes that write.
        if (!opened.exists.read(scopeKey, at)) return;
        opened.store.apply(scopeKey, { type: 'awake-observed' });
        last.set(scopeKey, time);
      } catch (error) {
        console.error('Shannon awake clock failed', error instanceof Error ? error.message : 'unknown');
      }
    },
    close() {
      opened?.exists.close();
      opened?.store.close();
      opened = null;
    },
  };
}
