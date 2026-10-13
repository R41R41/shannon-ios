import { SHANNON_ONE_LINE_VOICE, SHANNON_OWNER_NAME, SHANNON_ROOM_LOOK_RULES } from '@shannon/cognition';
import { VISION_NOTICE_CATEGORIES, type VisionNoticeCategory } from '../../contracts/visionContract.js';

/**
 * What she says when the camera noticed something (Syzygy ADR-0011 §4.3): Decisions chose only the kind of topic; the words are
 * made here by the voice path's model from that kind alone (no picture, no words read from one), and said once in the Talk as her
 * note, marked as said with the owner alone. It is her speaking up on her own (ADR-0002, 2026-10-03), so:
 * - the audience is checked again right before and right after the words are made: with anyone else present nothing is said;
 * - the owner talking just now holds it (she does not cut in), and a notice older than its freshness is dropped, never queued;
 * - the words are made outside the foreground speaking right (ADR-0008 answer 3); only the instant of saying needs it free: when a
 *   turn holds it then, the notice is given up, never waited for. Nothing takes the owner's `respond` slot for her notice, so no
 *   action of hers is recorded as an owner request.
 */
export const VISION_NOTICE_LIMITS = Object.freeze({
  /** A decision older than this when it reaches the API is not said. */
  freshMs: 10_000,
  /** The owner wrote or spoke within this: she does not cut in. */
  ownerActiveMs: 20_000,
  lineCharacters: 80,
});

const TOPIC: Readonly<Record<VisionNoticeCategory, string>> = Object.freeze({
  owner_returned: `${SHANNON_OWNER_NAME}が席に戻ってきた`,
  owner_waved: `${SHANNON_OWNER_NAME}がカメラに手を振っている`,
  showing_something: `${SHANNON_OWNER_NAME}がカメラに何かを見せている`,
  new_object: `${SHANNON_OWNER_NAME}のそばに新しい物が見えた`,
  owner_looks_tired: `${SHANNON_OWNER_NAME}が疲れていそうに見える`,
});

/** The fixed instruction of a notice's line. The room-look rules come from `packages/cognition`, where the owner approved them. */
export function visionNoticeInstructions(category: VisionNoticeCategory): string {
  return [
    SHANNON_ONE_LINE_VOICE,
    `[アプリのカメラで気づいた]\nアプリを開いている間、カメラで${SHANNON_OWNER_NAME}の様子を見ていて、気づいたこと: ${TOPIC[category]}。`
      + `画像は渡されていない。気づいたことの種類だけをもとに、${SHANNON_OWNER_NAME}へ短く一言だけ話しかける（40字以内）。`,
    ['守ること:', ...SHANNON_ROOM_LOOK_RULES.map(rule => `- ${rule}。`), '- 見ていない細部を作らない。'].join('\n'),
  ].join('\n\n');
}

export interface VisionNoticeDependencies {
  /** One short line from the voice path's model, or null when it gives nothing usable. */
  compose(scopeKey: string, instructions: string, signal: AbortSignal): Promise<string | null>;
  /** Whether the owner alone can see or hear her now (the API's own audience, not the device's). */
  alone(scopeKey: string): boolean;
  /** When the owner last wrote or spoke, or null. */
  ownerLastActiveAt(scopeKey: string): string | null;
  /** Whether a voice call with her is going on now (its words may not be in the Talk yet): she does not cut in. */
  voiceActive?(scopeKey: string): boolean;
  /** Her note in the Talk, once per decision id (marked owner-alone), or null when there is nowhere to say it. */
  say(scopeKey: string, decisionId: string, text: string, at: string): { threadId: string } | null;
  /** Whether a turn holds the foreground speaking right now (a live `respond` action); an unknown answer counts as held. */
  foregroundBusy?(scopeKey: string): Promise<boolean>;
  now(): number;
}

/** Whether the foreground is free this instant; without a mind (stage 4 off) there is no slot to read, and it is free. */
export async function foregroundFree(dependencies: Pick<VisionNoticeDependencies, 'foregroundBusy'>, scopeKey: string): Promise<boolean> {
  if (!dependencies.foregroundBusy) return true;
  try {
    return !await dependencies.foregroundBusy(scopeKey);
  } catch {
    return false;
  }
}

export type VisionNoticeResult = { delivered: true; threadId: string }
  | { delivered: false; reason: 'stale' | 'others' | 'owner_active' | 'no_line' | 'nowhere' | 'invalid' | 'foreground_busy' };

export class VisionNoticeSpeaker {
  constructor(private readonly dependencies: VisionNoticeDependencies) {}

  async deliver(input: { scopeKey: string; decisionId: string; category: string; at: string }): Promise<VisionNoticeResult> {
    if (!(VISION_NOTICE_CATEGORIES as readonly string[]).includes(input.category)) return { delivered: false, reason: 'invalid' };
    const category = input.category as VisionNoticeCategory;
    const blocked = this.blocked(input.scopeKey, input.at);
    if (blocked) return { delivered: false, reason: blocked };
    return this.spoken(input.scopeKey, input.decisionId, category, input.at);
  }

  private blocked(scopeKey: string, at: string): 'stale' | 'others' | 'owner_active' | null {
    const now = this.dependencies.now();
    if (!Number.isFinite(Date.parse(at)) || now - Date.parse(at) > VISION_NOTICE_LIMITS.freshMs) return 'stale';
    if (!this.dependencies.alone(scopeKey)) return 'others';
    return ownerActive(this.dependencies, scopeKey, now) ? 'owner_active' : null;
  }

  private async spoken(scopeKey: string, decisionId: string, category: VisionNoticeCategory, at: string): Promise<VisionNoticeResult> {
    let line: string | null = null;
    try {
      line = await this.dependencies.compose(scopeKey, visionNoticeInstructions(category), AbortSignal.timeout(6_000));
    } catch {
      line = null;
    }
    const text = line?.replace(/\s+/gu, ' ').trim().slice(0, VISION_NOTICE_LIMITS.lineCharacters) ?? '';
    if (!text) return { delivered: false, reason: 'no_line' };
    // The audience and the freshness again, after the words were made: a guest who arrived meanwhile hears nothing.
    if (!await foregroundFree(this.dependencies, scopeKey)) return { delivered: false, reason: 'foreground_busy' };
    const blocked = this.blocked(scopeKey, at);
    if (blocked) return { delivered: false, reason: blocked };
    const said = this.dependencies.say(scopeKey, decisionId, text, new Date(this.dependencies.now()).toISOString());
    return said ? { delivered: true, threadId: said.threadId } : { delivered: false, reason: 'nowhere' };
  }
}

/** The owner wrote or spoke within `ownerActiveMs`, or a voice call with her is going on: she does not cut in. Unknown counts as active. */
export function ownerActive(dependencies: Pick<VisionNoticeDependencies, 'ownerLastActiveAt' | 'voiceActive'>, scopeKey: string, now: number): boolean {
  try {
    if (dependencies.voiceActive?.(scopeKey)) return true;
    const active = dependencies.ownerLastActiveAt(scopeKey);
    return active !== null && now - Date.parse(active) < VISION_NOTICE_LIMITS.ownerActiveMs;
  } catch {
    return true;
  }
}
