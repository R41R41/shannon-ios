/**
 * Cadence and bounds of the activity loop (Syzygy ADR-0002 step 3). Like the rest of the
 * autonomy configuration these come from the deployment environment and nothing Shannon
 * can write changes them.
 */
export interface AutonomyLoopConfig {
  /** The one owner scope the loop works for. There is one budget, so there is one scope. */
  scopeKey: string;
  /** Activity cycles she may start in one owner-local day. */
  cyclesPerDay: number;
  /** Shortest time between the starts of two cycles. */
  cycleIntervalMilliseconds: number;
  /** Steps in one cycle, the thinking step included. */
  maximumStepsPerCycle: number;
  /** Public pages (and Notion pages) read in one cycle. */
  maximumReadsPerCycle: number;
  /** A cycle does not start while the owner has written or spoken this recently. */
  ownerActiveMilliseconds: number;
  /** Shortest time between two messages she starts on her own. */
  reachOutSpacingMilliseconds: number;
  /** After a message of hers, how long the step stays open to see whether he answers. 0 observes at once. The lease is renewed while it waits. */
  reachOutWaitMilliseconds: number;
  /** Thinking steps a cycle may add after the first, when a step's outcome is worth thinking about again. */
  maximumRethinksPerCycle: number;
  /** How long a runner owns the loop without renewing. Longer than any single step. */
  leaseMilliseconds: number;
  /** What she asks for when the day's cap blocks a step she cares about. */
  budgetRequestYen: number;
  /** Places to start reading from, besides links she found herself. */
  readingSeeds: readonly { title: string; url: string }[];
  /**
   * How her day is paced (owner decision 2026-10-02, Syzygy ADR-0003). `sessions`: she runs until she decides to rest and
   * says when she comes back, inside the bounds below. `cycles`: the fixed cycles above, exactly as before sessions existed.
   */
  pacing: 'sessions' | 'cycles';
  /** What one session may spend, estimates included, before it is stopped. */
  sessionMaximumYen: number;
  /** How long one session may run, not counting the time it stood still for the owner. */
  sessionMaximumMilliseconds: number;
  /** Steps in one session, thinking steps included: the hard stop if she never rests. */
  maximumStepsPerSession: number;
  /** Sessions she may start in one owner-local day. */
  sessionsPerDay: number;
  /** The shortest and the longest rest she may choose, and the rest taken when she names none or a bound stopped her. */
  sessionMinimumRestMilliseconds: number;
  sessionMaximumRestMilliseconds: number;
  sessionDefaultRestMilliseconds: number;
  /** The rest after a session in which her thinking led to no step: shorter, because nothing was done. */
  sessionNoPlanRestMilliseconds: number;
  /** The output ceiling of a thinking step in a session. The model's own reasoning counts against it, so it is wider than a cycle's 1,500. */
  sessionThinkOutputTokens: number;
  /** `low`: a thinking step asks the provider to spend little of its output ceiling on reasoning. `default`: the field is not sent. */
  planReasoning: 'low' | 'default';
  /** Her thinking may draw on the owner's context through the conversation's memory entry points (owner decision 2026-10-02). */
  ownerContext: boolean;
  /** Characters of that context in a thinking prompt; a message of hers gets half. */
  ownerContextCharacters: number;
  /**
   * Her own time may search and read the owner's Aether documents for one of her pursuits (owner decision 2026-10-06, Syzygy
   * ADR-0007; tools `ownerDocs.*`). Off unless `SHANNON_AUTONOMY_OWNER_DOCUMENTS=on`.
   */
  ownerDocuments: boolean;
}

const DEFAULT_READING_SEEDS = Object.freeze([
  { title: '青空文庫（著作権の切れた日本語の作品）', url: 'https://www.aozora.gr.jp/' },
  { title: 'Wikipedia「物語」', url: 'https://ja.wikipedia.org/wiki/物語' },
  { title: 'Wikipedia「短編小説」', url: 'https://ja.wikipedia.org/wiki/短編小説' },
]);

export function configuredAutonomyLoop(environment: Readonly<Record<string, string | undefined>> = process.env): AutonomyLoopConfig {
  const cyclesPerDay = integer(environment.SHANNON_AUTONOMY_CYCLES_PER_DAY, 1, 24, 4);
  return Object.freeze({
    scopeKey: environment.SHANNON_OWNER_SCOPE_KEY?.trim() || 'owner',
    cyclesPerDay,
    cycleIntervalMilliseconds: integer(environment.SHANNON_AUTONOMY_CYCLE_INTERVAL_MINUTES, 10, 24 * 60, Math.floor((24 * 60) / cyclesPerDay)) * 60_000,
    maximumStepsPerCycle: integer(environment.SHANNON_AUTONOMY_CYCLE_MAX_STEPS, 1, 12, 6),
    maximumReadsPerCycle: integer(environment.SHANNON_AUTONOMY_CYCLE_MAX_READS, 0, 6, 2),
    ownerActiveMilliseconds: integer(environment.SHANNON_AUTONOMY_OWNER_ACTIVE_MINUTES, 0, 240, 10) * 60_000,
    reachOutSpacingMilliseconds: integer(environment.SHANNON_AUTONOMY_REACH_OUT_SPACING_MINUTES, 0, 24 * 60, 5) * 60_000,
    reachOutWaitMilliseconds: integer(environment.SHANNON_AUTONOMY_REACH_OUT_WAIT_SECONDS, 0, 300, 180) * 1_000,
    maximumRethinksPerCycle: integer(environment.SHANNON_AUTONOMY_CYCLE_MAX_RETHINKS, 0, 3, 2),
    leaseMilliseconds: integer(environment.SHANNON_AUTONOMY_LEASE_SECONDS, 240, 3_600, 600) * 1_000,
    budgetRequestYen: integer(environment.SHANNON_AUTONOMY_BUDGET_REQUEST_YEN, 1, 100_000, 300),
    readingSeeds: readingSeeds(environment.SHANNON_AUTONOMY_READING_SEEDS_JSON),
    pacing: autonomyPacing(environment),
    sessionMaximumYen: integer(environment.SHANNON_AUTONOMY_SESSION_MAX_YEN, 1, 100_000, 400),
    sessionMaximumMilliseconds: integer(environment.SHANNON_AUTONOMY_SESSION_MAX_MINUTES, 1, 240, 40) * 60_000,
    maximumStepsPerSession: integer(environment.SHANNON_AUTONOMY_SESSION_MAX_STEPS, 2, 200, 40),
    sessionsPerDay: integer(environment.SHANNON_AUTONOMY_SESSIONS_PER_DAY, 1, 48, 12),
    ...restBounds(environment),
    sessionThinkOutputTokens: clamped(environment.SHANNON_AUTONOMY_SESSION_THINK_OUTPUT_TOKENS, 1_500, 8_000, 4_000),
    // Unset or `low` asks for little reasoning; any other value leaves the field out, so a mistyped switch switches it off.
    planReasoning: !environment.SHANNON_AUTONOMY_PLAN_REASONING?.trim() || environment.SHANNON_AUTONOMY_PLAN_REASONING.trim() === 'low' ? 'low' as const : 'default' as const,
    ownerContext: environment.SHANNON_AUTONOMY_OWNER_CONTEXT?.trim() !== 'off',
    ownerContextCharacters: integer(environment.SHANNON_AUTONOMY_OWNER_CONTEXT_CHARACTERS, 400, 8_000, 2_400),
    ownerDocuments: ownerDocumentsEnabled(environment),
  });
}

/** `on` only: unset, `off`, or anything mistyped leaves her own time without the owner's documents. */
export function ownerDocumentsEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return environment.SHANNON_AUTONOMY_OWNER_DOCUMENTS?.trim() === 'on';
}

/** `sessions` when unset or named; any other value is the fixed cycles, so a mistyped kill switch still switches sessions off. */
export function autonomyPacing(environment: Readonly<Record<string, string | undefined>> = process.env): 'sessions' | 'cycles' {
  const value = environment.SHANNON_AUTONOMY_PACING?.trim();
  return !value || value === 'sessions' ? 'sessions' : 'cycles';
}

/** The rests she may take between sessions: the shortest is never under ten minutes' default, and the default lies between the two. */
function restBounds(environment: Readonly<Record<string, string | undefined>>): Pick<AutonomyLoopConfig, 'sessionMinimumRestMilliseconds' | 'sessionMaximumRestMilliseconds' | 'sessionDefaultRestMilliseconds' | 'sessionNoPlanRestMilliseconds'> {
  const minimum = integer(environment.SHANNON_AUTONOMY_SESSION_MIN_REST_MINUTES, 1, 720, 10);
  const maximum = Math.max(minimum, integer(environment.SHANNON_AUTONOMY_SESSION_MAX_REST_MINUTES, 1, 24 * 60, 720));
  const fallback = Math.min(maximum, Math.max(minimum, integer(environment.SHANNON_AUTONOMY_SESSION_DEFAULT_REST_MINUTES, 1, 24 * 60, 150)));
  // Never longer than the default rest: it is the shorter of the two.
  const noPlan = Math.min(fallback, Math.max(minimum, integer(environment.SHANNON_AUTONOMY_SESSION_NO_PLAN_REST_MINUTES, 1, 24 * 60, 30)));
  return { sessionMinimumRestMilliseconds: minimum * 60_000, sessionMaximumRestMilliseconds: maximum * 60_000, sessionDefaultRestMilliseconds: fallback * 60_000, sessionNoPlanRestMilliseconds: noPlan * 60_000 };
}

/**
 * The wait after a message of hers. It may be longer than the lease: the step renews the lease and the heartbeat at every
 * look, five seconds apart, and the wait begins only after the step's one model call, whose timeout is shorter than the
 * shortest lease.
 */
export function reachOutWait(loop: Pick<AutonomyLoopConfig, 'reachOutWaitMilliseconds'>): number {
  return Math.max(0, loop.reachOutWaitMilliseconds);
}

/** `[{"title":"…","url":"https://…"}]`; anything unreadable falls back to the defaults. */
function readingSeeds(raw: string | undefined): readonly { title: string; url: string }[] {
  if (!raw?.trim()) return DEFAULT_READING_SEEDS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_READING_SEEDS;
    const seeds = parsed.flatMap(item => {
      const seed = item as { title?: unknown; url?: unknown };
      if (typeof seed?.title !== 'string' || typeof seed?.url !== 'string') return [];
      try {
        const url = new URL(seed.url);
        return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
          ? [{ title: seed.title.replace(/\s+/gu, ' ').trim().slice(0, 80), url: url.href }] : [];
      } catch { return []; }
    }).filter(seed => seed.title).slice(0, 12);
    return Object.freeze(seeds);
  } catch {
    return DEFAULT_READING_SEEDS;
  }
}

/** A whole number held inside the range; anything that is not a whole number is the fallback. */
function clamped(value: string | undefined, minimum: number, maximum: number, fallback: number): number {
  const parsed = value?.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function integer(value: string | undefined, minimum: number, maximum: number, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
