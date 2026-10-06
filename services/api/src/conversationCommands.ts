import type { CompanionStateStore, ShannonActionReceipt } from '@shannon/cognition';
import type { ConversationStore, StoredConversationMessage } from './mind/memory/store/conversationStore.js';
import type { OrganizeSession, OrganizeStore } from './integrations/voyager/organize.js';
import type { AetherProposalStore } from './integrations/aether/aetherProposal.js';
import type { AgentTask, AgentTaskStore } from './agentTaskStore.js';
import { applyExplicitCommitmentCommand } from './commitmentCommands.js';
import {
  boundOwnerTurn, contentPreview, containsUnresolvedConversationReference, isBareConversationReference, keepableStatement,
  resolveConversationContent, type ResolvedConversationContent,
} from './conversationReference.js';
import { aetherNoteRequest, asksWhichPlace, memoRequestContent, type AetherNoteRequest } from './memoPlace.js';
import { TOOL_FOLLOW_UP_MILLISECONDS } from './shannonToolTurns.js';
import { ShannonMemoryService } from './mind/memory/memoryService.js';
import { forgetCitedMemories } from './mind/memory/memoryForgetCommand.js';
import type { CognitiveIntentStore } from './cognitiveIntent.js';
import type { TurnMemoryRecall } from './mind/recall/turnMemoryRecall.js';
import { resolveReminderReply } from './reminderReply.js';

export interface UserUtterance {
  id: string; text: string;
  source?: 'speech' | 'typed' | 'camera';
  rawText?: string;
}
export interface ConversationCommandDependencies {
  stateStore: CompanionStateStore; conversationStore: ConversationStore;
  organizeStore?: OrganizeStore; aetherProposals?: AetherProposalStore;
  agentTasks?: AgentTaskStore;
  cognitiveIntents?: CognitiveIntentStore; memoryRecall?: TurnMemoryRecall | null;
}

/** Only the actual user utterance can authorize a proposal. Tool-model
 * paraphrases and retrieved material must never be passed as this argument. */
export function executeConversationCommand(
  scopeKey: string, threadId: string, utterance: UserUtterance, at: string,
  dependencies: ConversationCommandDependencies,
): { reply: string; receipt?: ShannonActionReceipt; organizeSession?: OrganizeSession } | null {
  const text = utterance.text.trim().replace(/[。！!]$/u, '');
  if (/^(?:例えば|もし|仮に)/u.test(text)) return null;
  const workCommand = dependencies.agentTasks
    ? executeAgentWorkCommand(scopeKey, threadId, utterance, text, at, dependencies.agentTasks)
    : null;
  if (workCommand) return workCommand;
  const reminderReply = resolveReminderReply(dependencies.conversationStore.conversationHistory(scopeKey, threadId),
    dependencies.stateStore.snapshot(scopeKey), text, at);
  if (reminderReply) {
    const quoted = contentPreview(reminderReply.summary);
    try {
      new ShannonMemoryService(dependencies.stateStore, dependencies.conversationStore, () => at)
        .mutate(scopeKey, { memoryId: reminderReply.memoryId, action: reminderReply.action });
    } catch { return { reply: `「${quoted}」の約束を更新できたか確認できませんでした。まだ変更していない可能性があるので、頭の中の「約束と目的」で確認してください。` }; }
    return { reply: reminderReply.action === 'complete' ? `「${quoted}」の約束を完了にしました。`
      : `わかりました。「${quoted}」は、あとでもう一度だけ声をかけます。声かけは1日1回の枠の中なので、時刻は約束できません。`,
      receipt: { id: reminderReply.memoryId, capability: 'memory.control', status: 'completed',
        summary: reminderReply.action === 'complete' ? 'リマインドへの返事で約束を完了' : 'リマインドへの返事で約束を後回し', occurredAt: at } };
  }
  const task = text.match(/^(?:[「"])?(.{1,500}?)(?:[」"])?を(?:タスクにして|タスクに追加して)$/u);
  if (task && dependencies.organizeStore) {
    const resolved = resolveConversationContent(task[1]!, scopeKey, threadId, at,
      dependencies.stateStore.snapshot(scopeKey), dependencies.conversationStore, 500, 'task');
    if ('clarification' in resolved) return { reply: resolved.clarification };
    const session = dependencies.organizeStore.create({ scopeKey, threadId,
      sourceMessageIds: [...resolved.sourceMessageIds, `utterance:${utterance.id}`], requestKey: utterance.id,
      drafts: [{ title: resolved.content, details: resolved.content }],
    }, at);
    return { organizeSession: session, reply: `「${session.items[0]?.title}」のタスク案を作りました。トークの整理カードで確認して反映してください。タスク本体はまだ変更していません。`,
      receipt: { id: session.id, capability: 'voyager.propose', status: 'proposed', summary: '確認待ちのタスク案', occurredAt: session.createdAt } };
  }
  // Only a note that names Aether goes there; an unqualified 「メモを作って」 is the model's to place, or to ask about.
  const aether = aetherNoteRequest(text);
  const resolved = aether && aetherNoteContent(aether, scopeKey, threadId, at, dependencies);
  if (resolved) {
    if ('clarification' in resolved) return { reply: resolved.clarification };
    if (!dependencies.aetherProposals?.configured) return { reply: 'ノートの提案先がまだつながっていないので、保存できていません。設定でノート連携を確認してください。' };
    try {
      const proposal = dependencies.aetherProposals.create(scopeKey, { content: resolved.content, requestKey: utterance.id,
        ...(resolved.referenced ? { reason: `本人の保存依頼に基づく直前の発言 (source: ${resolved.sourceMessageIds.join(', ')})` } : {}),
      });
      return { reply: `「${contentPreview(proposal.content)}」をノートへの保存案として送りました。ノート側の提案受信箱で確認してください。ノート本文にはまだ反映していません。`,
        receipt: { id: proposal.id, capability: 'aether.propose', status: 'proposed', summary: 'ノートの提案受信箱へ送信', occurredAt: proposal.createdAt } };
    } catch { return { reply: 'ノートへの保存案がどうなったか、ボクのほうで確認できませんでした。重複を避けるため自動では再送しないので、提案受信箱を確認してください。' }; }
  }
  const remember = text.match(/^(.{1,180}?)(?:を)?(?:覚えておいて|忘れないで)(?:ね|ください)?$/u);
  if (remember && containsUnresolvedConversationReference(remember[1]!)) {
    const resolved = resolveConversationContent(remember[1]!, scopeKey, threadId, at,
      dependencies.stateStore.snapshot(scopeKey), dependencies.conversationStore, 2_000, 'memory');
    if ('clarification' in resolved) return { reply: resolved.clarification };
    if (!resolved.sourceExperienceId) return { reply: '覚えておく内容を、そのまま教えてもらえますか？ 記憶はまだ変更していません。' };
    try {
      new ShannonMemoryService(dependencies.stateStore, dependencies.conversationStore, () => at)
        .mutate(scopeKey, { memoryId: resolved.sourceExperienceId, action: 'pin' });
    } catch { return { reply: 'その発言を記憶に固定できたか、確認できませんでした。保存できたとはまだ言えないので、記憶の詳細を確認してください。' }; }
    return { reply: `「${contentPreview(resolved.content)}」というライ氏の発言を、出典のある会話の記憶として固定しました。`,
      receipt: { id: resolved.sourceExperienceId, capability: 'memory.control', status: 'completed',
        summary: '参照元の会話の記憶を固定', occurredAt: at } };
  }
  const forgotten = forgetCitedMemories(scopeKey, threadId, text, at, dependencies);
  if (forgotten) return forgotten;
  const memory = applyExplicitCommitmentCommand(dependencies.stateStore, dependencies.conversationStore, scopeKey, text, at);
  if (!memory) return null;
  if (!memory.startsWith('[Verified')) return { reply: memory };
  const action = memory.match(/action=(\w+)/u)?.[1];
  return { reply: action === 'complete' ? 'その約束を完了にしました。'
    : action === 'dismiss' ? 'その約束を取り消しました。'
    : action === 'forget' ? 'その約束と元の会話は、今後の想起に使わないようにしました。'
    : '約束の期限を変更しました。記憶の詳細で確認できます。',
    receipt: { id: memory.match(/id=([^;]+)/u)?.[1] ?? utterance.id, capability: 'memory.control',
      status: 'completed', summary: action ?? 'memory updated', occurredAt: at } };
}

/**
 * What an Aether note keeps: its own words; what he just said (「Aetherにメモして」); or, when he answers her question
 * where (「書斎・PCのフォルダ・Aetherのどこに作りますか？」 → 「Aetherに」), the memo he asked for just before it. That
 * answer is held to the rules of `resolveConversationContent` and more: the asking turn, and an earlier turn that held
 * what to keep, are bound to their stored turns, of the owner alone in his words, and what is kept is a statement.
 * Null when the words are not a request to Aether here.
 */
function aetherNoteContent(
  request: AetherNoteRequest, scopeKey: string, threadId: string, at: string, dependencies: ConversationCommandDependencies,
): ResolvedConversationContent | null {
  const snapshot = dependencies.stateStore.snapshot(scopeKey);
  const store = dependencies.conversationStore;
  if ('content' in request) return resolveConversationContent(request.content, scopeKey, threadId, at, snapshot, store, 6_000);
  const history = store.conversationHistory(scopeKey, threadId).slice(-8);
  if (!answersPlaceQuestion(history, at)) {
    return request.bare === 'request' ? resolveConversationContent('それ', scopeKey, threadId, at, snapshot, store, 6_000) : null;
  }
  const clarify = { clarification: 'Aetherに残すことを、「〇〇をAetherに残して」と言ってもらえますか？ まだ何も送っていません。' };
  const asked = history.at(-2);
  if (!asked || !boundOwnerTurn(asked, scopeKey, threadId, at, snapshot, store, true)) return clarify;
  let source = asked;
  // Not a memo request (she asked on her own): his turn itself is what to keep, if it is a statement.
  let content = memoRequestContent(asked.content.trim()) ?? asked.content.trim();
  // 「明日10時に歯医者」 then 「それメモして」: what to keep is the owner's turn before the request.
  if (!content || isBareConversationReference(content)) {
    const before = history.slice(0, -2).filter(message => message.role === 'user').at(-1);
    if (!before || !boundOwnerTurn(before, scopeKey, threadId, at, snapshot, store, true)) return clarify;
    source = before;
    content = before.content.trim();
  }
  if (!keepableStatement(content, 6_000)) return clarify;
  return { content, sourceMessageIds: [source.id], ...(source.sourceExperienceId ? { sourceExperienceId: source.sourceExperienceId } : {}), referenced: true };
}

/** The newest message is her question where a memo goes, from the last ten minutes, answering a turn of his. */
function answersPlaceQuestion(history: readonly StoredConversationMessage[], at: string): boolean {
  const question = history.at(-1);
  return question?.role === 'assistant' && history.at(-2)?.role === 'user' && asksWhichPlace(question.content)
    && Date.parse(at) - Date.parse(question.observedAt) <= TOOL_FOLLOW_UP_MILLISECONDS;
}

/**
 * Whether a spoken turn's words may run a command: reliable words; or, with no reliability score (the router fell back),
 * his answer 「Aetherに」 to her question where a memo goes, the same yes that lets 「書斎に」 write with her tools.
 */
export function spokenCommandAllowed(
  trust: 'reliable' | 'uncertain' | 'unknown', scopeKey: string, threadId: string, utterance: UserUtterance | undefined, at: string,
  store: Pick<ConversationStore, 'conversationHistory'>,
): boolean {
  if (trust === 'reliable') return true;
  const text = utterance?.text.trim().replace(/[。！!]$/u, '') ?? '';
  const request = trust === 'unknown' ? aetherNoteRequest(text) : null;
  return request !== null && 'bare' in request && request.bare === 'answer'
    && answersPlaceQuestion(store.conversationHistory(scopeKey, threadId).slice(-8), at);
}

function executeAgentWorkCommand(
  scopeKey: string,
  threadId: string,
  utterance: UserUtterance,
  text: string,
  at: string,
  tasks: AgentTaskStore,
): { reply: string; receipt?: ShannonActionReceipt } | null {
  const candidates = tasks.list(scopeKey).filter(task => task.conversationThreadID === threadId
    && ['queued', 'starting', 'running', 'waiting_approval', 'paused'].includes(task.status));
  const command = agentCommand(text);
  if (!command || candidates.length === 0) return null;
  if (candidates.length > 1) return { reply: 'どの作業への指示か、作業名をひとこと付けてもらえますか。変更はまだ送っていません。' };
  const task = candidates[0]!;
  if (command.type === 'steer' && task.status === 'waiting_approval') {
    return { reply: `「${task.title}」は許可待ちです。先に作業画面で許可するかを決めてから、追加指示を送ってください。` };
  }
  try {
    const result = tasks.enqueue(scopeKey, task.id, {
      idempotencyKey: `voice:${utterance.id}`,
      type: command.type,
      payload: command.payload,
    }, at);
    const summary = command.type === 'steer' ? '作業へ追加・訂正指示を送信'
      : command.type === 'resume' ? '作業の再開を送信'
        : command.payload.cancel === true ? '作業の取消を送信' : '作業の一時停止を送信';
    return {
      reply: command.type === 'steer' ? `「${task.title}」に今の指示を追加しました。古い前提と食い違う部分は、新しい指示を優先します。`
        : command.type === 'resume' ? `「${task.title}」を再開します。続きの状態は作業カードに反映しますね。`
          : command.payload.cancel === true ? `「${task.title}」の中止を受け付けました。停止結果は作業カードで確認できます。`
            : `「${task.title}」をここで一時停止します。再開するときは、そのまま「続けて」で大丈夫です。`,
      receipt: { id: result.command?.id ?? task.id, capability: `agent.${command.type}`,
        status: 'confirmed', summary, occurredAt: at },
    };
  } catch {
    return { reply: `「${task.title}」への指示を確実に保存できませんでした。重複送信はせず、作業カードの最新状態を確認してください。` };
  }
}

function agentCommand(text: string): { type: 'steer' | 'interrupt' | 'resume'; payload: Record<string, unknown> } | null {
  if (/^(?:再開して|続けて|続きをお願い|続きやって)(?:ください)?$/u.test(text)) return { type: 'resume', payload: {} };
  if (/^(?:この作業を)?(?:キャンセル|中止)(?:して|にして)?(?:ください)?$/u.test(text)) {
    return { type: 'interrupt', payload: { cancel: true } };
  }
  if (/^(?:いったん|一旦)?(?:止めて|中断して|待って|ストップ)(?:ください)?$/u.test(text)) {
    return { type: 'interrupt', payload: {} };
  }
  if (/^(?:あと|それと|それも|ついでに|追加で|もう一つ|違う|ちがう|訂正|そうじゃなく|そうではなく|いや[、,]|ではなく|じゃなく)/u.test(text)) {
    return { type: 'steer', payload: { instruction: text } };
  }
  return null;
}
