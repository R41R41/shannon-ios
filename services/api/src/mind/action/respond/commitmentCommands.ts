import { visibleMemoryText, type CompanionStateSnapshot, type CompanionStateStore } from '@shannon/cognition';
import { ShannonMemoryService, type MemoryMutation } from '../../memory/memoryService.js';
import type { ConversationStore } from '../../memory/store/conversationStore.js';

/** Conservative local command resolution. Ambiguous references never change state. */
export function resolveCommitmentCommand(state: CompanionStateSnapshot, message: string):
  { mutation: MemoryMutation } | { clarification: string } | null {
  if (!/(?:約束|リマインド|予定)/u.test(message)
    || /[?？]|(?:しないで|しなくて|取り消さない|忘れない|(?:完了して|終わって|済んで)(?:い)?ない|まだ|もし|例えば|たら|なら|場合|わけじゃない|わけではない)/u.test(message)) return null;
  const instruction = message.trim().replace(/[。！!\s]+$/u, '');
  // A mention of completion/cancellation is not an instruction. Require an
  // explicit terminal request or a positive report, not a question or condition.
  const action = /(?:忘れて(?:ください)?|忘れる)$/u.test(instruction) ? 'forget'
    : /(?:(?:取り消して|取り消し|取消|キャンセル)(?:してください|ください|して)?|取り消す)$/u.test(instruction) ? 'dismiss'
    : /(?:完了(?:にして|にしてください|にする|した|しました|です|したよ)|終わった(?:よ)?|済んだ(?:よ)?)$/u.test(instruction) ? 'complete'
    : /(?:変更|延期)(?:して|してください|する)$/u.test(instruction) ? 'correct' : null;
  if (!action) return null;
  const normalize = (text: string) => text.replace(/(?:約束|リマインド|予定|一緒に|写真を|の|を|は|と|に|、|。|\s)/gu, match => match === '写真を' ? '写真' : '');
  const target = normalize(message.split(/約束|リマインド|予定/u)[0] ?? '');
  const pending = state.prospectiveMemories.filter(memory => memory.status === 'pending'
    && visibleMemoryText(state, memory.id, memory.summary));
  const candidates = pending.filter(memory => target.length >= 2 && normalize(memory.summary).includes(target));
  // Do not guess what "that promise" refers to, even if there is only one stored.
  if (candidates.length !== 1) return { clarification: 'どの約束のことか、約束の内容を短く教えてもらえますか。まだ変更していません。' };
  const memory = candidates[0]!;
  if (action === 'correct') {
    const due = message.match(/(?:明後日|あさって|明日|あした|今日|(?:来週の?)?[月火水木金土日]曜(?:日)?|(?:\d{4}年)?\d{1,2}月\d{1,2}日)(?:(?:の|\s)*(?:午前|午後)?\d{1,2}時(?:\d{1,2}分|半)?)?/u)?.[0];
    if (!due) return { clarification: '変更先の日付を教えてもらえますか。元の約束はまだ変更していません。' };
    const topic = memory.summary.replace(/^(?:明日|あした|今日|明後日|あさって|(?:来週の?)?[月火水木金土日]曜(?:日)?|(?:\d{4}年)?\d{1,2}月\d{1,2}日)(?:(?:の|\s)*(?:午前|午後)?\d{1,2}時(?:\d{1,2}分|半)?)?[、\s]*/u, '');
    return { mutation: { memoryId: memory.id, action, text: `${due}、${topic}` } };
  }
  return { mutation: { memoryId: memory.id, action } };
}

export function applyExplicitCommitmentCommand(
  stateStore: CompanionStateStore, history: ConversationStore, scopeKey: string, message: string, at: string,
): string {
  const command = resolveCommitmentCommand(stateStore.snapshot(scopeKey), message);
  if (!command) return '';
  if ('clarification' in command) return command.clarification;
  const target = stateStore.snapshot(scopeKey).prospectiveMemories.find(memory => memory.id === command.mutation.memoryId);
  if (target && target.updatedAt > at) return '';
  new ShannonMemoryService(stateStore, history, () => at).mutate(scopeKey, command.mutation);
  return `[Verified commitment receipt] id=${command.mutation.memoryId}; action=${command.mutation.action}; persisted_at=${at}. Only this memory change succeeded; no external app action was executed.`;
}
