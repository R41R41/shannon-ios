/**
 * A voice turn's research (owner decision 2026-10-13, from the conversation audit: 「経路を調べてみますね、結果が出たらすぐ伝えます」
 * and then the answer as a separate message 24 s later). Research that finishes within `VOICE_RESEARCH_WAIT_MS` of its admission
 * is said in the same turn, after her short acknowledgement; later results reach him as before (the card, the call's report).
 * A short yes to her own offer to look something up asks the research what the offer was about (`voiceOfferCarry.ts`), and a
 * turn whose research runs on never ends with 「時間が足りなかった」.
 */
import { admitConversationWork } from '../../mind/action/fca/conversationWork.js';
export { admittedWorkContext } from '../../mind/action/fca/conversationWork.js';
import type { FcaConversationTurn } from '../../mind/action/fca/fcaConversationPorts.js';
import { fallbackSpokenReport } from '../../mind/action/fca/fcaSpokenReport.js';
import type { TaskView } from '../../mind/action/taskRuntime/taskRuntimePorts.js';
import { withResearchUnderWay } from '../../mind/action/respond/turnDeadline.js';
import { carriedOffer, carriedRequest } from '../../mind/selectors/voiceOfferCarry.js';
import type { VoiceDecisionInput } from '../../contracts/voiceDecisionContract.js';
import type { PlaceSearchContext } from '../../integrations/places/placeDiscovery.js';
import { ownerTimeZone } from '../../infra/time/localDate.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';

/** Research expected within this long of its admission is said in the turn that asked for it. */
export const VOICE_RESEARCH_WAIT_MS = 20_000;

/** Admits the turn's research: his words, or, after a short yes to her offer, his request, her offer and his yes. */
export function admitVoiceResearch(turn: FcaConversationTurn | null, input: {
  transcript: string; route: Pick<VoiceDecisionInput, 'transcript' | 'context' | 'participantMode'>; research: boolean;
  places: PlaceSearchContext | undefined; at: string; timeZone: string | undefined;
}): { work: TaskView | null; admittedAt: number } {
  const carried = carriedOffer(input.route);
  const message = carried ? carriedRequest(carried, input.transcript) : input.transcript;
  return { admittedAt: performance.now(), work: admitConversationWork(turn, { message, research: input.research, places: input.places, at: input.at,
    ...(input.timeZone ? { timeZone: input.timeZone } : {}) }) };
}

/** The owner's clock of a voice turn (`turnClockLine`): the device's zone, else the configured one. */
export function voiceTurnClock(at: string, timeZone: string | undefined): { clock: { at: string; timeZone: string } } {
  return { clock: { at, timeZone: timeZone ?? ownerTimeZone(serverEnvironment()) } };
}

/** What a turn whose research runs on says: her out-of-time line becomes the research line (`withResearchUnderWay`). */
export function researchSaid(text: string, work: TaskView | null): string {
  return work ? withResearchUnderWay(text) : text;
}

/**
 * After her acknowledgement, the research's result if it arrives within the wait: said as the rest of this turn (one or two
 * short sentences, the report's spoken form or a plain cut of it), and marked heard: its card stays, no call says it again. '' otherwise.
 */
export async function researchHeardInTurn(turn: FcaConversationTurn | null, admitted: { work: TaskView | null; admittedAt: number },
  said: { before: string; say: ((text: string) => Promise<void> | void) | undefined }, signal?: AbortSignal,
  waitMs = VOICE_RESEARCH_WAIT_MS): Promise<string> {
  if (!turn?.awaitWork || !admitted.work || !said.say) return '';
  const left = waitMs - (performance.now() - admitted.admittedAt);
  if (left <= 0) return '';
  const result = await turn.awaitWork(left, signal).catch(() => null);
  if (!result || signal?.aborted) return '';
  const answer = result.report.spoken?.trim() || fallbackSpokenReport(result.report.text, result.title);
  // A whole sentence after a closed one: the stream sends it as its own segment at once, and the text reads as two sentences.
  const text = `${SENTENCE_CLOSED.test(said.before) || !said.before.trim() ? '' : '。'}${answer}${SENTENCE_CLOSED.test(answer) ? '' : '。'}`;
  try { await said.say(text); } catch { return ''; }
  // Heard only once it went out whole; a turn cut off leaves the result to the card and the call.
  if (signal?.aborted) return '';
  turn.hearWork?.(result.taskId, result.report.id, answer);
  return text;
}

const SENTENCE_CLOSED = /[。！？!?\n][」』）】”"]?\s*$/u;
