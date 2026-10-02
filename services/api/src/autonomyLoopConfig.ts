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
  /**
   * After a message of hers, how long the step stays open to see whether he answers. 0 observes at once.
   * Never longer than the lease allows (`reachOutWait`).
   */
  reachOutWaitMilliseconds: number;
  /** Thinking steps a cycle may add after the first, when a step's outcome is worth thinking about again. */
  maximumRethinksPerCycle: number;
  /** How long a runner owns the loop without renewing. Longer than any single step. */
  leaseMilliseconds: number;
  /** What she asks for when the day's cap blocks a step she cares about. */
  budgetRequestYen: number;
  /** Places to start reading from, besides links she found herself. */
  readingSeeds: readonly { title: string; url: string }[];
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
    reachOutSpacingMilliseconds: integer(environment.SHANNON_AUTONOMY_REACH_OUT_SPACING_MINUTES, 0, 24 * 60, 60) * 60_000,
    reachOutWaitMilliseconds: integer(environment.SHANNON_AUTONOMY_REACH_OUT_WAIT_SECONDS, 0, 300, 180) * 1_000,
    maximumRethinksPerCycle: integer(environment.SHANNON_AUTONOMY_CYCLE_MAX_RETHINKS, 0, 3, 2),
    leaseMilliseconds: integer(environment.SHANNON_AUTONOMY_LEASE_SECONDS, 240, 3_600, 600) * 1_000,
    budgetRequestYen: integer(environment.SHANNON_AUTONOMY_BUDGET_REQUEST_YEN, 1, 100_000, 300),
    readingSeeds: readingSeeds(environment.SHANNON_AUTONOMY_READING_SEEDS_JSON),
  });
}

/** The wait after a message of hers, kept two minutes inside the lease so the model call that follows still fits in it. */
export function reachOutWait(loop: Pick<AutonomyLoopConfig, 'reachOutWaitMilliseconds' | 'leaseMilliseconds'>): number {
  return Math.max(0, Math.min(loop.reachOutWaitMilliseconds, loop.leaseMilliseconds - 120_000));
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

function integer(value: string | undefined, minimum: number, maximum: number, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
