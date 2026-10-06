/**
 * How many turns a surface answered by her conversation kernel may ask the model for (review S3, 2026-10-06): her
 * Minecraft body's game chat, and the platform reply route (`platformReply.ts`, second review). Every turn is a model call.
 * The owner and everyone else count apart, so people who write a lot never use up the owner's turns; each other person
 * has his own share, all others together a smaller one, and both a cap a day. Counted right before the model is called,
 * after the device or token, the turn, a repeated requestId and its age were checked: a refused or replayed turn costs
 * nothing. In memory: a restart begins the counts again. Fixed windows (a minute, a day) from the first turn counted in
 * them: across a window's boundary up to twice a limit can pass in a short time, and a clock that goes back starts a
 * window afresh (review nit N-b, 2026-10-06). They bound cost and fairness, not an exact rate.
 */
export const MINECRAFT_TURN_ALLOWANCE = Object.freeze({
  ownerPerMinute: 20,
  ownerPerDay: 1_000,
  /** One player other than the owner. */
  speakerPerMinute: 6,
  speakerPerDay: 100,
  /**
   * Everyone other than the owner together. At most the platform bridge's 120 person turns a minute
   * (`PEOPLE_TURNS_PER_MINUTE`), so the bridge never has to refuse to remember a turn that was already answered.
   */
  othersPerMinute: 20,
  othersPerDay: 400,
});

type Window = { startedAt: number; count: number };
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TRACKED_SPEAKERS = 1_000;

/** The same shares for `POST /v1/platform/reply`: others together stay below the bridge's 120 person turns a minute. */
export const PLATFORM_REPLY_ALLOWANCE = MINECRAFT_TURN_ALLOWANCE;

export type SurfaceTurnLimits = Readonly<Record<keyof typeof MINECRAFT_TURN_ALLOWANCE, number>>;

export class SurfaceTurnAllowance {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly limits: SurfaceTurnLimits) {}

  /** Takes one turn of `speaker` (the owner, or another player's id), or refuses it without counting anything. */
  take(owner: boolean, speaker: string, at: number): boolean {
    const buckets: Array<[string, number, number]> = owner
      ? [['owner:minute', MINUTE, this.limits.ownerPerMinute], ['owner:day', DAY, this.limits.ownerPerDay]]
      : [[`speaker:${speaker}:minute`, MINUTE, this.limits.speakerPerMinute], [`speaker:${speaker}:day`, DAY, this.limits.speakerPerDay],
        ['others:minute', MINUTE, this.limits.othersPerMinute], ['others:day', DAY, this.limits.othersPerDay]];
    const current = buckets.map(([key, length, limit]) => {
      const window = this.windows.get(key);
      const fresh = !window || at - window.startedAt >= length || at < window.startedAt;
      return { key, limit, window: fresh ? { startedAt: at, count: 0 } : window! };
    });
    if (current.some(bucket => bucket.window.count >= bucket.limit)) return false;
    if (this.windows.size > TRACKED_SPEAKERS * 2) for (const key of [...this.windows.keys()]) if (key.startsWith('speaker:')) this.windows.delete(key);
    for (const bucket of current) this.windows.set(bucket.key, { startedAt: bucket.window.startedAt, count: bucket.window.count + 1 });
    return true;
  }
}

/** Her Minecraft body's game chat (`minecraftBody.ts`). */
export class MinecraftTurnAllowance extends SurfaceTurnAllowance {
  constructor(limits: SurfaceTurnLimits = MINECRAFT_TURN_ALLOWANCE) { super(limits); }
}
