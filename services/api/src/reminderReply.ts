import { visibleMemoryText, type CompanionStateSnapshot } from '@shannon/cognition';
import type { StoredConversationMessage } from './conversationStore.js';

/**
 * 「終わったよ」 names nothing, so it can only be bound to a promise by position:
 * the message directly before it in the same Talk must be Shannon's reminder
 * about that promise. The binding uses the reminder's stored source reference,
 * never wording similarity, and a longer or conditional sentence is left to the
 * ordinary reply.
 */
export interface ReminderReply { memoryId: string; action: 'complete' | 'snooze'; summary: string; }

const LEAD = '(?:(?:うん|はい|ええ|あ|ごめん|すみません|それ(?:は|なら)?|さっき|ちょうど|無事に?)[、,\\s]*)*';
const TAIL = '(?:よ|ね|よー|です|[!！。〜ー]|\\s)*';
const DONE = new RegExp(`^${LEAD}(?:もう)?(?:終わった|終わりました|おわった|済んだ|済みました|すんだ|やった|やりました|できた|できました`
  + `|完了(?:した|しました|です|にして(?:ください)?|で)?|済み|終えた|終えました|やっておいた|やっておきました)${TAIL}$`, 'u');
const LATER = new RegExp(`^${LEAD}(?:あとで|後で|また(?:あとで|後で|今度)|今は(?:無理|むり|やめておく|できない)|まだ(?:やってない|終わってない|できてない)?`
  + `|もう少し(?:あとで|後で|待って))(?:やる|やります|する|します|にする|にします|お願い|お願いします)?${TAIL}$`, 'u');
const MAXIMUM_REPLY_AGE_MILLISECONDS = 7 * 24 * 60 * 60_000;

export function resolveReminderReply(
  history: readonly StoredConversationMessage[], state: CompanionStateSnapshot, message: string, at: string,
): ReminderReply | null {
  const previous = history.at(-1);
  const reference = previous?.role === 'assistant' && previous.reminder && 'revision' in previous.reminder ? previous.reminder : null;
  if (!previous || !reference) return null;
  const age = Date.parse(at) - Date.parse(previous.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > MAXIMUM_REPLY_AGE_MILLISECONDS) return null;
  const text = message.trim();
  if (text.length > 24 || /[?？]/u.test(text)) return null;
  const action = DONE.test(text) ? 'complete' as const : LATER.test(text) ? 'snooze' as const : null;
  if (!action) return null;
  const memory = state.prospectiveMemories.find(item => item.id === reference.commitmentId);
  const summary = memory?.status === 'pending' ? visibleMemoryText(state, memory.id, memory.summary) : null;
  if (!memory || !summary || (memory.sourceExperienceId && !visibleMemoryText(state, memory.sourceExperienceId, memory.summary))) return null;
  return { memoryId: memory.id, action, summary };
}
