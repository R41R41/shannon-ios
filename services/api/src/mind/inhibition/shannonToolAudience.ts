/**
 * What the server itself knows about who else may see or hear her, whatever a client sent with the turn
 * (owner decision 2026-10-05: her study and her folder are used only with the owner alone). Her tools are not
 * offered while
 * - her body said lately that someone other than the owner can see or hear it (the same freshness rules the
 *   body's own audience check uses), or
 * - a turn with someone else present arrived in the last ten minutes: a 「友人も一緒」 call, an owner call with
 *   someone listening, or a text turn marked `others`. A call of that kind is taken to be live until it is quiet.
 * A body that cannot be read counts as others present.
 */
export const OTHERS_HEARD_WINDOW_MILLISECONDS = 10 * 60_000;

export interface ToolAudienceSource {
  othersPresent(scopeKey: string, at: string): boolean;
}

export class ToolAudienceWatch {
  private readonly othersHeard = new Map<string, number>();

  constructor(private readonly body: ToolAudienceSource | null, private readonly now: () => string) {}

  /** A turn with someone else present arrived. */
  noteOthers(scopeKey: string): void {
    this.othersHeard.set(scopeKey, Date.parse(this.now()));
  }

  othersKnown(scopeKey: string): boolean {
    const at = this.now();
    const heard = this.othersHeard.get(scopeKey);
    if (heard !== undefined && Date.parse(at) - heard < OTHERS_HEARD_WINDOW_MILLISECONDS) return true;
    try { return this.body?.othersPresent(scopeKey, at) ?? false; } catch { return true; }
  }
}
