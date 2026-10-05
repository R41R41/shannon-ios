/**
 * How many game-chat turns her Minecraft body may ask the model for (review S3, 2026-10-06). Every turn is a model call.
 * The owner and everyone else count apart, so players who write a lot never use up the owner's turns; each other player
 * has his own share, all others together a smaller one, and both a cap a day. Counted before the model is called, after
 * the device, the turn and a repeated requestId were checked: a refused or replayed turn costs nothing. In memory: a
 * restart begins the counts again.
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

export class MinecraftTurnAllowance {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly limits: Readonly<Record<keyof typeof MINECRAFT_TURN_ALLOWANCE, number>> = MINECRAFT_TURN_ALLOWANCE) {}

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
