import { badRequest, objectBody, validScopeKey } from './apiValidation.js';
import type { ShannonChatModel } from './chatModel.js';
import type { ApiRequest, ApiResponse } from './contracts.js';
import type { ConversationStore } from './conversationStore.js';
import { GUEST_CALL_SUMMARY_TURNS, validatedGuestCallTurns, type GuestCallTurn } from './voiceGuestCall.js';

export const VOICE_CALL_SUMMARY_PATH = '/v1/voice/gemini/cascade/summaries';
export const VOICE_CALL_SUMMARY_HEADING = '【友人も一緒の通話の要約】';
export const VOICE_CALL_SUMMARY_NOTE_KIND = 'voice_call_summary';
const SUMMARY_FOOTER = '（ライ氏が残すと選んだ要約です。会話そのものは保存していません）';
const MAXIMUM_SUMMARY_CHARACTERS = 400;
const MAXIMUM_SUMMARY_LINES = 5;
/** A summary that repeats this many characters of someone's speech in a row is a quotation. */
const QUOTATION_CHARACTERS = 16;
const SUMMARIES_PER_WINDOW = 6;
const WINDOW_MILLISECONDS = 10 * 60_000;

const SUMMARY_INSTRUCTIONS = [
  'You write a short note for ライ氏\'s own Talk thread about a voice call in which he introduced Shannon to a friend (「友人も一緒」).',
  'The input is that call only. Lines marked 話し手 were spoken by ライ氏 or the friend; speakers were not identified. Lines marked シャノン are Shannon\'s replies.',
  'Write plain Japanese text with exactly these three lines and nothing else:',
  '相手: the friend\'s name with さん only if a name was clearly said in the call; otherwise 「お友達（名前は聞いていません）」',
  '話したこと: one or two sentences describing the topics in your own words',
  '次に話したいこと: only what Shannon herself said she would like to talk about or show next time; otherwise 「特になし」',
  'Rules: paraphrase and never quote anyone\'s words. Record nothing about the friend beyond the name and the topics: no health, relationship, work, contact, or location details and no opinions about other people. Use nothing that is not in the input. Do not address anyone and do not add advice.',
].join('\n');

interface SummaryDependencies {
  conversationStore: ConversationStore;
  chatModel?: ShannonChatModel;
  now: () => string;
}

const recentSummaries = new WeakMap<ConversationStore, Map<string, number[]>>();

/**
 * Saves a call summary only when the owner asked for it at the end of a 「友人も一緒」 call.
 * One bounded model call; the note is display history and never a memory or profile source.
 */
export function dispatchVoiceCallSummary(
  request: ApiRequest,
  dependencies: SummaryDependencies,
): Promise<ApiResponse> | ApiResponse | null {
  if (request.method !== 'POST' || request.path !== VOICE_CALL_SUMMARY_PATH) return null;
  if (!objectBody(request.body)) return badRequest('JSON object body is required');
  const { scopeKey } = request.body;
  if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
  const turns = validatedGuestCallTurns(request.body.turns, GUEST_CALL_SUMMARY_TURNS);
  if (turns === false) return badRequest('turns is invalid');
  if (!turns.some(turn => turn.role === 'participant') || !turns.some(turn => turn.role === 'shannon')) {
    return badRequest('turns must include the conversation of the call');
  }
  if (request.body.threadId !== undefined && typeof request.body.threadId !== 'string') {
    return badRequest('threadId is invalid');
  }
  const store = dependencies.conversationStore;
  if (!store.appendNote || !dependencies.chatModel) {
    return { status: 503, body: { error: 'CALL_SUMMARY_UNAVAILABLE' } };
  }
  const at = dependencies.now();
  if (!consumeSummaryAllowance(store, scopeKey, Date.parse(at))) {
    return { status: 429, body: { error: 'RATE_LIMITED', message: '少し待ってからもう一度お試しください。' } };
  }
  const threadId = store.threadId(scopeKey, request.body.threadId?.trim() || undefined);
  return completeSummary(scopeKey, threadId, turns, at, store, dependencies.chatModel);
}

async function completeSummary(
  scopeKey: string,
  threadId: string,
  turns: readonly GuestCallTurn[],
  at: string,
  store: ConversationStore,
  chatModel: ShannonChatModel,
): Promise<ApiResponse> {
  const generated = await generatedSummary(scopeKey, turns, chatModel);
  const body = generated ?? fallbackVoiceCallSummary(turns);
  const content = [VOICE_CALL_SUMMARY_HEADING, body, SUMMARY_FOOTER].join('\n');
  const note = store.appendNote!(scopeKey, threadId, content, at, VOICE_CALL_SUMMARY_NOTE_KIND);
  return {
    status: 201,
    body: { threadId, messageId: note.id, summary: content, observedAt: at, source: generated ? 'model' : 'fallback' },
  };
}

async function generatedSummary(
  scopeKey: string,
  turns: readonly GuestCallTurn[],
  chatModel: ShannonChatModel,
): Promise<string | null> {
  if (chatModel.mode === 'local-stub') return null;
  const message = turns.map(turn => `${turn.role === 'shannon' ? 'シャノン' : '話し手'}: ${turn.text}`).join('\n');
  try {
    // The usual chat model wrapper records this single call in the existing usage ledger.
    const result = chatModel.generateVoice
      ? await chatModel.generateVoice({
        scopeKey, systemPrompt: SUMMARY_INSTRUCTIONS, history: [], message,
        useWebSearch: false, conversationClass: 'direct',
      })
      : await chatModel.generate({
        scopeKey, systemPrompt: SUMMARY_INSTRUCTIONS, history: [], message, generateThreadTitle: false,
      });
    return acceptedSummary(result.reply, turns);
  } catch {
    return null;
  }
}

/** Bounds the model's text and rejects it when it quotes what a person said. */
export function acceptedSummary(reply: string, turns: readonly GuestCallTurn[]): string | null {
  const lines = reply.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).slice(0, MAXIMUM_SUMMARY_LINES);
  const summary = Array.from(lines.join('\n')).slice(0, MAXIMUM_SUMMARY_CHARACTERS).join('').trim();
  if (!summary) return null;
  const normalizedSummary = comparable(summary);
  for (const turn of turns) {
    if (turn.role !== 'participant') continue;
    const spoken = Array.from(comparable(turn.text));
    for (let start = 0; start + QUOTATION_CHARACTERS <= spoken.length; start += 1) {
      if (normalizedSummary.includes(spoken.slice(start, start + QUOTATION_CHARACTERS).join(''))) return null;
    }
  }
  return summary;
}

/** Used when the model is unavailable or quotes speech: it carries no content of the call. */
export function fallbackVoiceCallSummary(turns: readonly GuestCallTurn[]): string {
  const replies = turns.filter(turn => turn.role === 'shannon').length;
  return [
    '相手: お友達（名前は記録していません）',
    `話したこと: 要約を作れなかったため、内容は残していません。シャノンが${replies}回返事をした通話でした。`,
    '次に話したいこと: 特になし',
  ].join('\n');
}

function comparable(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function consumeSummaryAllowance(store: ConversationStore, scopeKey: string, nowMilliseconds: number): boolean {
  const scopes = recentSummaries.get(store) ?? new Map<string, number[]>();
  recentSummaries.set(store, scopes);
  const now = Number.isFinite(nowMilliseconds) ? nowMilliseconds : Date.now();
  const recent = (scopes.get(scopeKey) ?? []).filter(time => now - time < WINDOW_MILLISECONDS && time <= now);
  if (recent.length >= SUMMARIES_PER_WINDOW) {
    scopes.set(scopeKey, recent);
    return false;
  }
  scopes.set(scopeKey, [...recent, now]);
  return true;
}
