import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import { autonomyDayKey, yenFromUsd } from '../../inhibition/autonomyBudget.js';
import { storyNotes } from './autonomyLoopPlan.js';
import { heldForOthers, unmarkedOnly } from './autonomyLoopProvenance.js';
import {
  AUTONOMY_REACH_OUT_MAXIMUM_CHARACTERS, REACH_OUT_REASON_LABEL, parsedModelObject, reachOutPrompt,
  type ReachOutReason, type ThinkingExtras,
} from './autonomyLoopPrompts.js';
import { observeReachOut } from './autonomyLoopObserve.js';
import type { ReachOutCallOutcome, ReachOutFacts } from './store/autonomyLoopObservations.js';
import { REACH_OUT_HELD_TOOL, conversationInProgress } from './autonomyLoopReachOutStep.js';
import type { AutonomyLoopCycle, AutonomyPlannedStep } from './store/autonomyLoopState.js';
import type { PreparedStep, StepDependencies } from './autonomyLoopSteps.js';
import { autonomyModelCostUsd } from './autonomyModels.js';
import { AUTONOMY_CALL_DOMAIN, AUTONOMY_CALL_TOOL } from '../../inhibition/autonomyPolicy.js';
import { AutonomyModelError, resolveAutonomyModel } from './autonomyTextModel.js';
import { STUDY_STATUS_LABEL } from './store/studyStore.js';

/**
 * The step 「電話をかける」 (owner decision 2026-10-03): from her own activity she may phone the owner's iPhone.
 *
 * It is her deliberate act, beside `reach_out`: she wants to tell him something, he is not in the app, and she chooses
 * to ring him. His phone rings and whether he answers is his choice. The step words her opening line with one model
 * call, writes it as a message of hers (the Talk, an initiative, the ordinary notification), asks for the call, and
 * stays until it knows what became of it: answered, declined, not answered, or could not connect.
 *
 * There is no count of calls a day: the daily budget and the approval gate bound it, and so do three technical
 * guards. She never calls while a conversation is in progress, never while a call of hers rings, and never sooner
 * than the minimum interval after her last call. It is offered only while the owner switched calls on in the iPhone
 * app and the server can send one.
 *
 * This file names interfaces only: it opens no store, sends no push, and reads no word of the owner's.
 */
export interface PhoneFacts {
  /** The owner switched 「シャノンからの着信を受ける」 on, on an iPhone the server knows. */
  switchedOn: boolean;
  /** The server may ring: its switches are on and it holds what Apple's push service needs. */
  serverReady: boolean;
  /** A call of hers is on its way or ringing now. */
  ringing: boolean;
  /** Minutes until the minimum interval after her last call is over; 0 when it is. */
  waitMinutes: number;
  /** One of his apps says only he can hear it now (earphones). */
  earphones: boolean;
  /** Her desktop body read presence a moment ago. */
  body: boolean;
  /** When he last wrote or spoke in any Talk. A timestamp; never what he said. */
  ownerLastActiveAt: string | null;
  /** Her last call: when she placed it and what became of it. */
  last: { at: string; outcome: ReachOutCallOutcome | 'ringing' } | null;
}

export interface AutonomyPhone {
  facts(scopeKey: string, at: string): PhoneFacts;
  /** Asks for the call with one message of hers. Anything but `requested` is why not, as a code. */
  request(scopeKey: string, initiativeId: string, at: string): 'requested' | 'unavailable' | 'too_soon' | 'ringing' | 'taken';
  /** What became of the call for one message; null while it has not ended. */
  outcome(scopeKey: string, initiativeId: string): ReachOutCallOutcome | null;
}

export const CALL_TOOL = AUTONOMY_CALL_TOOL;
/** The pause between two looks at what became of the call, and how long she stays with it at most (a ring is 30 seconds). */
export const CALL_OBSERVE_POLL_MILLISECONDS = 3_000;
export const CALL_OBSERVE_LIMIT_MILLISECONDS = 75_000;
const OUTPUT_TOKENS = 600;

function phoneFacts(dependencies: StepDependencies, scopeKey: string, at: string): PhoneFacts | null {
  try { return dependencies.phone?.facts(scopeKey, at) ?? null; } catch { return null; }
}

/** Whether she may phone him now: switched on by him, possible for the server, nothing ringing, the interval over, no conversation. */
export function callAvailable(dependencies: StepDependencies, scopeKey: string, at: string, facts = phoneFacts(dependencies, scopeKey, at)): boolean {
  if (!facts || !dependencies.reachOuts?.sayByPhone) return false;
  if (!facts.switchedOn || !facts.serverReady || facts.ringing || facts.waitMinutes > 0) return false;
  try { return !conversationInProgress(dependencies, scopeKey, at); } catch { return false; }
}

/** What the gate is told about calls (`autonomyPolicy.ts`): whether one may be placed now. */
export function callGateContext(phone: AutonomyPhone, scopeKey: string, at: string): { available: boolean } {
  try {
    const facts = phone.facts(scopeKey, at);
    return { available: facts.switchedOn && facts.serverReady && !facts.ringing && facts.waitMinutes === 0 };
  } catch { return { available: false }; }
}

const OUTCOME_WORDS: Readonly<Record<ReachOutCallOutcome | 'ringing', string>> = Object.freeze({
  answered: '出てくれた', declined: `${SHANNON_OWNER_NAME}は出ないことを選んだ`, unanswered: '出なかった', failed: 'つながらなかった', ringing: 'まだ鳴らしている',
});

export const PHONE_FACTS_HEADER = '[いまの様子]（サーバーが見た事実）';

function ago(from: string, at: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(at) - Date.parse(from)) / 60_000));
  return minutes < 1 ? 'たったいま' : minutes < 60 ? `${minutes}分前` : minutes < 24 * 60 ? `${Math.round(minutes / 60)}時間前` : '1日より前';
}

/** The facts of the moment she chooses with: fixed sentences, yes-or-no facts and times. Never a word of his. */
export function phoneFactLines(facts: PhoneFacts, input: { at: string; inConversation: boolean }): string[] {
  const phone = !facts.serverReady ? 'いまはかけられない（サーバーの準備がまだ）'
    : facts.ringing ? 'いまはかけられない（電話を鳴らしている最中）'
      : input.inConversation ? `いまはかけられない（${SHANNON_OWNER_NAME}と会話が続いている）`
        : facts.waitMinutes > 0 ? `いまはかけられない（前の電話から間もない。あと約${facts.waitMinutes}分）`
          : 'いまかけられる';
  return [
    `- イヤホン: ${facts.earphones ? `いま、${SHANNON_OWNER_NAME}にだけ聞こえるイヤホンでアプリを聞いている（reach_out は声でも届く）` : `いま、${SHANNON_OWNER_NAME}のイヤホンでアプリは聞かれていない`}。`,
    `- 体: ${facts.body ? 'ボクの体（デスクトップ）はいま表示されている' : 'ボクの体（デスクトップ）が表示されているかは分からない'}。`,
    `- 会話: ${input.inConversation ? `いま${SHANNON_OWNER_NAME}と会話が続いている` : 'いまは会話していない'}。`,
    `- ${SHANNON_OWNER_NAME}が最後に書くか話すかしたのは: ${facts.ownerLastActiveAt ? ago(facts.ownerLastActiveAt, input.at) : '記録がない'}。`,
    `- 電話: ${phone}。`,
    `- 前の電話: ${facts.last ? `${ago(facts.last.at, input.at)}にかけた。${OUTCOME_WORDS[facts.last.outcome]}` : 'まだかけたことがない'}。`,
  ];
}

const CALL_ACTION = (reasons: string) => `call（${SHANNON_OWNER_NAME}のiPhoneに電話をかける。伝えたいことがあって、${SHANNON_OWNER_NAME}がアプリを開いていない時のためのもの。${SHANNON_OWNER_NAME}の電話が鳴り、出るかどうかは${SHANNON_OWNER_NAME}が選ぶ。出てくれたら、最初の一言をボクの声で伝えて、そのまま会話になる。同じ一言はトークにも文字で残る。reason は ${reasons} のどれか。かけたあとで、出てくれた・出ないことを選んだ・出なかった・つながらなかった、のどれだったかが分かる。時間帯の決まりはなく夜中でも鳴るので、時刻と下の「いまの様子」を見て、本当にかけたい時だけ。一度の計画で1回まで、reach_out とは一緒に置かない）、`;

const PHONE_RULE = `- 「いまの様子」は、サーバーが見た事実。電話に出なかったことも、出ないことを選んだことも、悪いことではない。出ないことを選んだのは、${SHANNON_OWNER_NAME}がいまは出ないと決めたということ。あとでもう一度かけるか、書いて伝えるか、そのままにするかは、ボクが決める。責めたり、急がせたりしない。`;

export interface PhoneThinking {
  /** She may plan `call` now. */
  offered: boolean;
  extras: Pick<ThinkingExtras, 'actions' | 'examples' | 'rules' | 'sections'>;
}

/**
 * What a thinking step is given about the phone: the facts of the moment, and the action while she may use it.
 * Null while the owner has not switched calls on (or nothing is wired): the prompt is then what it was.
 */
export function phoneThinking(
  dependencies: StepDependencies, scopeKey: string, at: string, input: { look: boolean; upcoming: boolean; spoke: boolean },
): PhoneThinking | null {
  const facts = phoneFacts(dependencies, scopeKey, at);
  if (!facts?.switchedOn) return null;
  let inConversation = true;
  try { inConversation = conversationInProgress(dependencies, scopeKey, at); } catch { inConversation = true; }
  const offered = !input.spoke && callAvailable(dependencies, scopeKey, at, facts);
  const reasons = ['share', 'wonder', ...(input.upcoming ? ['upcoming'] : []), ...(input.look ? ['saw（この計画の look より後に置く）'] : [])].join('、');
  return {
    offered,
    extras: {
      actions: offered ? CALL_ACTION(reasons) : '', examples: offered ? '{"action":"call","reason":"share"},' : '',
      rules: [PHONE_RULE], sections: [[PHONE_FACTS_HEADER, ...phoneFactLines(facts, { at, inConversation })].join('\n')],
    },
  };
}

/** The extras of a thinking step with the phone's added: its action after the others, its facts after the other sections. */
export function withPhone(base: ThinkingExtras | null, phone: PhoneThinking | null): ThinkingExtras | null {
  if (!phone) return base;
  return {
    ...(base ?? {}),
    actions: `${base?.actions ?? ''}${phone.extras.actions}`, examples: `${base?.examples ?? ''}${phone.extras.examples}`,
    rules: [...(base?.rules ?? []), ...phone.extras.rules], sections: [...(base?.sections ?? []), ...phone.extras.sections],
  };
}

const CALL_LINE_RULE = `[電話の最初の一言]
これは電話。${SHANNON_OWNER_NAME}が出てくれた時に、最初にボクの声で言う一言になる。同じ言葉がトークに文字で残り、通知にも出る。
- 耳で聞いて分かる、短い話し言葉にする。出てもらえなかった時に、あとで文字で読まれても困らない言葉にする。`;

export function preparePhoneCall(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep, at: string): PreparedStep | null {
  const { store, config, reachOuts, upcoming } = dependencies;
  const reason = step.reason;
  if (!reason || reason === 'follow_up' || !reachOuts?.sayByPhone || !callAvailable(dependencies, cycle.scopeKey, at)) return null;
  const others = reachOuts.audience(cycle.scopeKey, at);
  // The same materials as a message of hers, by the same reasons: nothing to be about means nothing to say.
  // What she wrote after reading the owner's is given only to a marked session, and never with anyone else present (ADR-0007).
  const shown = unmarkedOnly(dependencies, cycle, others !== null);
  const notes = reason === 'share' ? storyNotes(store, cycle.scopeKey, undefined, 12, false, shown).filter(note => !note.seen).slice(0, 4) : [];
  const stories = reason === 'share' ? store.study.list(cycle.scopeKey).filter(piece => piece.kind === 'story' && piece.status !== 'put_away' && shown(piece)).slice(0, 3)
    .map(piece => ({ title: piece.title, statusLabel: STUDY_STATUS_LABEL[piece.status] })) : [];
  const items = reason === 'upcoming' ? upcoming?.lines(cycle.scopeKey, at, others ? 'others' : 'owner') ?? [] : [];
  const seen = reason === 'saw' ? store.study.list(cycle.scopeKey)
    .filter(piece => piece.kind === 'note' && piece.origin === 'room_look' && piece.status !== 'put_away' && piece.createdAt >= cycle.startedAt)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.body : undefined;
  if ((reason === 'share' && !notes.length && !stories.length) || (reason === 'upcoming' && !items.length) || (reason === 'saw' && !seen)) return null;
  let owned: string | null = null;
  try {
    owned = dependencies.loop.ownerContext ? dependencies.ownerContext?.forMessage(cycle.scopeKey, at, notes.map(note => note.title).join(' '), others !== null)?.section ?? null : null;
  } catch { owned = null; }
  const worded = reachOutPrompt({
    reason: reason as ReachOutReason, localTime: localTime(at, config.timeZone), notes, stories, upcoming: items, ...(seen ? { seen } : {}), others,
    ...(owned ? { ownerContext: owned } : {}), ...(dependencies.loop.ownerContext && dependencies.ownerContext ? { notesPrivate: true } : {}),
  });
  const prompt = { system: `${worded.system}\n\n${CALL_LINE_RULE}`, prompt: worded.prompt };
  const model = resolveAutonomyModel('prose', store.modelPreferences(cycle.scopeKey), id => dependencies.model.canUse(id));
  if (!model) return null;
  const estimate = { inputTokens: Math.ceil((prompt.system.length + prompt.prompt.length) * 1.5) + 64, outputTokens: OUTPUT_TOKENS };
  const costUsd = autonomyModelCostUsd(model, estimate, config.modelPrices);
  if (costUsd === null) return null;
  const label = REACH_OUT_REASON_LABEL[reason as ReachOutReason];
  return {
    request: {
      domain: AUTONOMY_CALL_DOMAIN, summary: `持ち主のiPhoneに電話をかけます（理由: ${label}）。`, tool: CALL_TOOL,
      paid: { model, estimatedCostYen: yenFromUsd(costUsd, config) },
    },
    purpose: 'prose', estimate,
    async perform(adapters, performAt, signal) {
      if (!adapters.model || !adapters.reachOuts?.sayByPhone || !adapters.phone) return { outcome: 'failed', summary: '電話をかける道具が渡されなかったため、かけませんでした。' };
      const now = dependencies.now ?? (() => performAt);
      // He may have started talking since the plan was made, or a call may be ringing: then she does not call, and nothing is spent.
      const unavailable = (moment: string): 'conversation_in_progress' | 'call_unavailable' | null => {
        if (callAvailable({ ...dependencies, phone: adapters.phone }, cycle.scopeKey, moment)) return null;
        let talking = false;
        try { talking = conversationInProgress(dependencies, cycle.scopeKey, moment); } catch { talking = false; }
        return talking ? 'conversation_in_progress' : 'call_unavailable';
      };
      const before = unavailable(performAt);
      if (before) return { outcome: 'failed', summary: `いまは電話をかけられないので、かけませんでした（理由: ${label}）。`, reasonCode: before };
      let reply: Record<string, unknown> | null = null;
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      try {
        const result = await adapters.model.generate({ model, system: prompt.system, prompt: prompt.prompt, maximumOutputTokens: OUTPUT_TOKENS, signal });
        reply = parsedModelObject(result.text);
        usage = result.usage;
      } catch (error) {
        usage = error instanceof AutonomyModelError ? error.usage : estimate;
        return { outcome: 'failed', summary: `電話をかけようとしましたが、最初の一言が言葉になりませんでした（理由: ${label}）。`, reasonCode: 'model_failed', ...(usage ? { usage } : {}) };
      }
      if (!reply || typeof reply.message !== 'string') return { outcome: 'failed', summary: `電話をかけようとしましたが、最初の一言が言葉になりませんでした（理由: ${label}）。`, reasonCode: 'model_failed', usage };
      const text = reply.message.replace(/\s+/gu, ' ').trim().slice(0, AUTONOMY_REACH_OUT_MAXIMUM_CHARACTERS);
      // Not calling is hers to choose.
      if (!text) return { outcome: 'done', usage, tool: REACH_OUT_HELD_TOOL, reasonCode: 'held', summary: `電話をかけようかと思いましたが、やめておきました（理由: ${label}）。` };
      const writeAt = now();
      // Checked again with her words in hand: the model took a moment, and he may have begun to talk meanwhile.
      const after = unavailable(writeAt);
      if (after) return { outcome: 'failed', usage, summary: `いまは電話をかけられないので、かけませんでした（理由: ${label}）。`, reasonCode: after };
      // Someone else may have come while she wrote it: in a marked session she holds the call (ADR-0007).
      if (heldForOthers(dependencies, cycle, writeAt)) return { outcome: 'done', usage, tool: REACH_OUT_HELD_TOOL, reasonCode: 'others_present', summary: `ほかの人がいるので、電話はやめておきました（理由: ${label}）。` };
      let written: ReturnType<NonNullable<typeof adapters.reachOuts.sayByPhone>>;
      try {
        written = adapters.reachOuts.sayByPhone(cycle.scopeKey, { reason: reason as ReachOutReason, text, dayKey: autonomyDayKey(writeAt, config) }, writeAt);
      } catch { written = 'unavailable'; }
      if (written !== 'sent') return { outcome: 'failed', usage, reasonCode: 'nowhere_to_speak', summary: `電話の一言を残す場所がなかったので、かけませんでした（理由: ${label}）。` };
      let sent: { id: string; at: string } | null = null;
      try { sent = adapters.reachOuts.latest?.(cycle.scopeKey) ?? null; } catch { sent = null; }
      if (!sent) return { outcome: 'failed', usage, reasonCode: 'call_failed', summary: `電話をかけようとしましたが、つながりませんでした（理由: ${label}）。一言はトークに残っています。` };
      // Her line is in the Talk. Now the call itself: asked for here, sent by the API process.
      let asked: ReturnType<AutonomyPhone['request']> = 'unavailable';
      try { asked = adapters.phone.request(cycle.scopeKey, sent.id, writeAt); } catch { asked = 'unavailable'; }
      let call: ReachOutCallOutcome | null = 'failed';
      if (asked === 'requested') {
        // Syzygy ADR-0008 stage 1: whether he answers is predicted now and settled by what became of the call.
        dependencies.prediction?.called?.(cycle.scopeKey, { id: sent.id, reason, others: others !== null }, writeAt);
        const watched = await callOutcome(dependencies, adapters.phone, cycle.scopeKey, sent, signal);
        // No outcome by the limit means the API process, which rings and closes every call, is not running: nothing rang.
        // No outcome because she was paused or stopped meanwhile means only that she did not see it: the phone may be ringing.
        call = watched.outcome ?? (watched.timedOut ? 'failed' : null);
      }
      let observed: ReachOutFacts;
      try {
        observed = await observeReachOut(dependencies, cycle.scopeKey, { id: sent.id, at: sent.at, reason }, { wait: false, signal });
      } catch {
        observed = { id: sent.id, reason, sentAt: sent.at, waitedSeconds: 0, replied: false, delivery: 'unknown', windowVisible: false, owner: 'unknown', others: false };
      }
      // Answering is his reply: she does not call after him as after a message nobody answered.
      const waited = Math.max(0, Math.round((Date.parse(now()) - Date.parse(sent.at)) / 1_000));
      if (!call) {
        return {
          outcome: 'done', usage, observed: { ...observed, waitedSeconds: waited, unwatched: true }, reasonCode: 'unwatched',
          summary: `持ち主のiPhoneに電話をかけました（理由: ${label}）。そのあとは見届けられませんでした。`,
        };
      }
      observed = { ...observed, call, waitedSeconds: waited, ...(call === 'answered' ? { replied: true, repliedAfterSeconds: observed.repliedAfterSeconds ?? waited } : {}) };
      return {
        outcome: 'done', usage, observed, reasonCode: `call_${call}`,
        summary: `持ち主のiPhoneに電話をかけました（理由: ${label}）。${CALL_SUMMARY[call]}`,
      };
    },
  };
}

const CALL_SUMMARY: Readonly<Record<ReachOutCallOutcome, string>> = Object.freeze({
  answered: '出てくれました。', declined: 'いまは出ないことを選ばれました。', unanswered: '出ませんでした。', failed: 'つながりませんでした。一言はトークに残っています。',
});

/**
 * Stays with the call until it ended or the limit is over, renewing the runner's lease at every look. Null when it
 * has not ended by then, or she was paused or asked to stop meanwhile.
 */
async function callOutcome(
  dependencies: StepDependencies, phone: AutonomyPhone, scopeKey: string, sent: { id: string; at: string }, signal?: AbortSignal,
): Promise<{ outcome: ReachOutCallOutcome | null; timedOut: boolean }> {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const pause = dependencies.wait ?? sleep;
  const held = () => { try { return dependencies.renew?.() ?? true; } catch { return false; } };
  const read = () => { try { return phone.outcome(scopeKey, sent.id); } catch { return null; } };
  const over = () => Date.parse(now()) - Date.parse(sent.at) >= CALL_OBSERVE_LIMIT_MILLISECONDS;
  let outcome = read();
  while (!outcome && !over() && held() && !signal?.aborted) {
    let paused = true;
    try { paused = dependencies.store.control(scopeKey).paused; } catch { paused = true; }
    if (paused) break;
    try { await pause(CALL_OBSERVE_POLL_MILLISECONDS, signal); } catch { break; }
    outcome = read();
  }
  return { outcome, timedOut: !outcome && over() };
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('ABORTED')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); reject(new Error('ABORTED')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function localTime(at: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('ja-JP', { timeZone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
  } catch {
    return at.slice(0, 16);
  }
}
