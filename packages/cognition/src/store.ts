import { createInitialCompanionState, reduceCompanionState } from './state.js';
import type { CompanionStateEvent, CompanionStateSnapshot, CompanionStateStore } from './types.js';

export type CompanionClock = () => string;

/** Reference adapter. Production persistence belongs in services/api. */
export class InMemoryCompanionStateStore implements CompanionStateStore {
  private readonly states = new Map<string, CompanionStateSnapshot>();

  constructor(private readonly now: CompanionClock) {}

  snapshot(scopeKey: string): CompanionStateSnapshot {
    const existing = this.states.get(scopeKey);
    if (existing) return existing;
    const initial = createInitialCompanionState(scopeKey, this.now());
    this.states.set(scopeKey, initial);
    return initial;
  }

  apply(scopeKey: string, event: CompanionStateEvent): CompanionStateSnapshot {
    const next = reduceCompanionState(this.snapshot(scopeKey), event, this.now());
    this.states.set(scopeKey, next);
    return next;
  }
}

