/** Her feeling for the game screen (`GET /v1/body/mind`, `contracts/bodyMindContract.ts`): the present feeling with its reason, and the last ten minutes of it. */
import { presentShannonFeeling, SHANNON_CONVERSATION_CAUSES, SHANNON_SETTLED_CAUSE, type CompanionStateSnapshot, type ShannonEmotionTiming } from '@shannon/cognition';
import { BODY_MIND_LIMITS, BODY_MIND_SCHEMA_VERSION, type BodyMind, type BodyMindPoint } from '../../contracts/bodyMindContract.js';

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** The reason as one short line: no control characters or brackets, the game prefix dropped (the screen is the game), at most 240 characters. */
export function mindCauseLine(cause: unknown): string {
  if (typeof cause !== 'string') return '';
  // The wordings her own resolver gives a feeling that came from talking are not a reason a person should read: leave the reason empty.
  if (cause === SHANNON_SETTLED_CAUSE || SHANNON_CONVERSATION_CAUSES.includes(cause)) return '';
  const line = cause.replace(/[「」『』【】<>]/gu, '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().replace(/^マイクラで\s*/u, '');
  return Array.from(line).slice(0, BODY_MIND_LIMITS.causeCharacters).join('');
}

/**
 * The points of the flow, kept in memory per scope. A read adds one when the feeling changed, got stronger or weaker by a step, or a minute went by.
 * A restart empties it: the flow is only ever what was read, so it is short at first and never invented.
 */
export class MindFlow {
  private readonly points = new Map<string, BodyMindPoint[]>();

  note(scopeKey: string, point: BodyMindPoint): BodyMindPoint[] {
    let list = this.points.get(scopeKey);
    if (!list) {
      if (this.points.size >= BODY_MIND_LIMITS.scopes) this.points.clear();
      list = [];
      this.points.set(scopeKey, list);
    }
    const time = Date.parse(point.at);
    const last = list.at(-1);
    if (!last || last.primary !== point.primary || Math.abs(last.intensity - point.intensity) >= BODY_MIND_LIMITS.strengthStep
      || time - Date.parse(last.at) >= BODY_MIND_LIMITS.samePointMilliseconds) list.push(point);
    const from = time - BODY_MIND_LIMITS.flowMilliseconds;
    while (list.length > 0 && (Date.parse(list[0]!.at) < from || list.length > BODY_MIND_LIMITS.flowPoints)) list.shift();
    return list;
  }
}

/** What a body reads: the present feeling (with its reason), the mood's three numbers, and the flow of the last ten minutes. */
export function bodyMindView(snapshot: CompanionStateSnapshot, at: string, timing: ShannonEmotionTiming, flow: MindFlow, scopeKey: string): BodyMind {
  const current = presentShannonFeeling(snapshot, at, timing);
  const showing = current.primary !== 'neutral' && current.visibility !== 'hidden';
  const feeling: BodyMind['feeling'] = showing
    ? { primary: current.primary, intensity: round(clamp01(current.intensity), 2), cause: mindCauseLine(current.cause), since: current.startedAt }
    : { primary: 'neutral', intensity: 0, cause: '' };
  const points = flow.note(scopeKey, { at, primary: feeling.primary, intensity: feeling.intensity });
  return {
    schemaVersion: BODY_MIND_SCHEMA_VERSION,
    generatedAt: at,
    pollAfterSeconds: BODY_MIND_LIMITS.pollAfterSeconds,
    feeling,
    mood: { valence: round(snapshot.emotion.valence, 2), arousal: round(snapshot.emotion.arousal, 2), openness: round(snapshot.emotion.openness, 2) },
    flow: points.map(point => ({ ...point })),
  };
}
