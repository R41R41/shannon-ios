import { isOwnerMemoryEvidence, type ProspectiveMemory } from '@shannon/cognition';
import { commitmentDeadline, COMMITMENT_TEMPORAL_SOURCE } from './commitmentTime.js';
import { containsUnresolvedConversationReference } from './conversationReference.js';

const TEMPORAL_PROMISE = new RegExp(`^(${COMMITMENT_TEMPORAL_SOURCE})(?:までに|の|に|は)?[、,\\s]*(.{2,160}?)(?:しよう|したい|する|やる|やりたい|話そう|お願い)(?:ね|よ)?$`, 'u');
const EXPLICIT_REMINDER = /^(.{2,180}?)(?:を)?(?:覚えておいて|忘れないで|リマインドして)(?:ね|ください)?$/u;

function prospectiveId(summary: string): string {
  let hash = 2_166_136_261;
  for (const character of summary.toLocaleLowerCase('ja-JP')) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `prospective-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Captures only explicit future intent; vague predictions and questions are ignored. */
export function extractProspectiveMemories(
  userMessage: string,
  observedAt: string,
  sourceExperienceId?: string,
  timeZone = 'Asia/Tokyo',
): readonly ProspectiveMemory[] {
  const sentences = userMessage.replace(/\s+/g, ' ').trim()
    .match(/[^。！？!?]+[。！？!?]?/gu) ?? [];
  const memories = new Map<string, ProspectiveMemory>();
  for (const raw of sentences) {
    if (/[？?]\s*$/u.test(raw)) continue;
    const sentence = raw.replace(/[。！!]\s*$/u, '').trim().slice(0, 200);
    if (!sentence || !isOwnerMemoryEvidence(sentence) || /(?:かもしれない|たぶん|多分|予定は未定)/u.test(sentence)) continue;
    const temporal = sentence.match(TEMPORAL_PROMISE);
    const reminder = sentence.match(EXPLICIT_REMINDER);
    if (!temporal && !reminder) continue;
    if (containsUnresolvedConversationReference(temporal?.[2] ?? reminder?.[1] ?? '')) continue;
    const summary = sentence;
    const id = prospectiveId(`${sourceExperienceId ?? observedAt}:${summary}`);
    memories.set(id, Object.freeze({
      id,
      summary,
      status: 'pending',
      createdAt: observedAt,
      updatedAt: observedAt,
      ...commitmentDeadline(summary, observedAt, timeZone),
      ...(sourceExperienceId ? { sourceExperienceId } : {}),
      evidence: sentence,
    }));
  }
  return Object.freeze([...memories.values()].slice(0, 4));
}
