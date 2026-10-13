import type { InnerNoteEvent } from '@shannon/cognition';

/**
 * Touches as sessions for her inner note (Syzygy ADR-0012 D2.3, touch coalescing). Core: emotion.
 *
 * The iPhone asks for a reaction after every short touch (up to once per 45 s), and one reflection a touch would spend the day's cap
 * on an hour of petting. A run of touches is one session: she reflects on its first touch, again when what she is getting changes
 * (another kind of touch, or another stance she took), at most every `refreshMilliseconds` while it goes on, and once on what it held
 * when it ends (`quietMilliseconds` without a touch). What it holds in between rides along with any reflection on his words, and a
 * touch past the touches' own cap waits for the next one of those. Bounded: the last `held` touches of a session.
 */
export interface TouchSessionLimits {
  quietMilliseconds: number;
  refreshMilliseconds: number;
  held: number;
}

export interface TouchEntry { event: InnerNoteEvent; source?: string }

interface Session { held: TouchEntry[]; lastAt: number; key: string; reflectedAt: number }

export class InnerNoteTouchSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly carried = new Map<string, TouchEntry[]>();

  constructor(private readonly limits: TouchSessionLimits) {}

  /** A touch arrived: what to reflect on now (empty while it only continues the session). `key` is its kind and her stance. */
  arrive(scopeKey: string, entry: TouchEntry, key: string, at: number): TouchEntry[] {
    const session = this.sessions.get(scopeKey);
    if (!session || at - session.lastAt >= this.limits.quietMilliseconds) {
      this.sessions.set(scopeKey, { held: [], lastAt: at, key, reflectedAt: at });
      return [...session?.held ?? [], entry];
    }
    session.lastAt = at;
    if (key === session.key && at - session.reflectedAt < this.limits.refreshMilliseconds) {
      session.held = [...session.held, entry].slice(-this.limits.held);
      return [];
    }
    const now = [...session.held, entry];
    Object.assign(session, { held: [], key, reflectedAt: at });
    return now;
  }

  /** The sweep: a session quiet for the window has ended; what it held is reflected on once. */
  ended(scopeKey: string, at: number): TouchEntry[] {
    const session = this.sessions.get(scopeKey);
    if (!session || at - session.lastAt < this.limits.quietMilliseconds) return [];
    this.sessions.delete(scopeKey);
    return session.held;
  }

  /** A reflection on something else (his words, her day's end) takes what the session holds and what waited past the cap. */
  fold(scopeKey: string): TouchEntry[] {
    const session = this.sessions.get(scopeKey);
    const folded = [...this.carried.get(scopeKey) ?? [], ...session?.held ?? []].slice(-this.limits.held);
    if (session) session.held = [];
    this.carried.delete(scopeKey);
    return folded;
  }

  /** Touches past the touches' cap: they wait for the next reflection on something else. */
  carry(scopeKey: string, entries: readonly TouchEntry[]): void {
    this.carried.set(scopeKey, [...this.carried.get(scopeKey) ?? [], ...entries].slice(-this.limits.held));
  }

  /** What waits (readers' pending events). */
  waiting(scopeKey: string): readonly TouchEntry[] {
    return [...this.carried.get(scopeKey) ?? [], ...this.sessions.get(scopeKey)?.held ?? []];
  }
}
