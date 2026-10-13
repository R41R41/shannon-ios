import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { InMemoryCompanionStateStore, OWNER_AUDIENCE } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { LocalVoiceDecisionGateway, type VoiceDecisionInput } from '../src/mind/selectors/voiceDecision.js';
import type { ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { InMemoryOrganizeStore } from '../src/integrations/voyager/organize.js';
import {
  NOTHING_CHANGED_LINE, transcriptNeedsInterpretation, transcriptScore, transcriptThreshold, transcriptTrust,
} from '../src/surfaces/voice/voiceTranscriptContext.js';
import { validatedVoiceDeviceContext } from '../src/surfaces/voice/voiceDeviceContext.js';
import { afterLongSilence, conversationReplay, silenceAwareMessages, voiceReplayGap } from '../src/mind/recall/conversationWindow.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { TurnTiming } from '../src/infra/observer/turnTiming.js';
import { voicePlanner } from '../src/surfaces/voice/voiceObservation.js';
import { asksHerSomething, ownerVoiceTurnFacts, settleOwnerVoiceTurn } from '../src/mind/attention/voiceSilence.js';
import { perceptionOrActionRequest } from '../src/surfaces/voice/voiceRecallScope.js';
import { SemanticMemoryRecall } from '../src/mind/recall/semanticMemoryRecall.js';
import { PERCEPTION_HONESTY_LINE, SOCIAL_LENGTH_LINE, spokenReplyLines } from '../src/surfaces/voice/voiceConversationInstructions.js';
import { VOICE_ROOM_LOOK_CONFIRM_PROMPT, asksToLookNow, voiceRoomLookPrompt, voiceRoomLookTurn } from '../src/surfaces/voice/voiceRoomLook.js';
import { foregroundRunner, interruptedTurn } from '../src/wiring/actionExecutionWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { currentActionExecution } from '../src/infra/context/actionExecution.js';
import { promptOf } from './modelPrompt.js';

/**
 * The owner's Windows call of 2026-10-14 00:24–00:38 JST: every turn scored 0.44–0.84, two camera requests were refused, a
 * four-day-old request was taken up as current, a 360 ms pause split his sentences, an unanswered turn left no trace, a camera
 * request waited 2.2 s for a memory rerank, and replies ran long, opened with his name and claimed to hear his tone.
 */
const at = '2026-10-14T00:30:00.000Z';
afterEach(() => vi.unstubAllEnvs());

const local = new LocalVoiceDecisionGateway();
const input: VoiceDecisionInput = { scopeKey: 'owner', transcript: '写真整理をタスクにして', participantMode: 'owner', requestedLocation: false, hasFreshLocation: false };
const speech = (confidence?: number) => ({ id: 'u', text: input.transcript, source: 'speech' as const, ...(confidence === undefined ? {} : { confidence }) });

describe('P1: what a spoken transcript is trusted for', () => {
  it('reads two thresholds: 0.85 to act, 0.6 to talk, look and run FCA; configurable, and talk never above act', async () => {
    expect(transcriptThreshold('act')).toBe(0.85);
    expect(transcriptThreshold('converse')).toBe(0.6);
    const decision = { ...await local.decide(input), transcriptReliabilityProbability: 0.7 };
    expect(transcriptTrust(decision, speech())).toBe('uncertain');
    expect(transcriptTrust(decision, speech(), 'converse')).toBe('reliable');
    expect(transcriptNeedsInterpretation(decision, speech(), 'converse')).toBe(false);
    vi.stubEnv('SHANNON_VOICE_TRANSCRIPT_CONVERSE_THRESHOLD', '0.75');
    expect(transcriptNeedsInterpretation(decision, speech(), 'converse')).toBe(true);
    vi.stubEnv('SHANNON_VOICE_TRANSCRIPT_RELIABILITY_THRESHOLD', '0.5');
    expect(transcriptThreshold('converse')).toBe(0.5);
    vi.stubEnv('SHANNON_VOICE_TRANSCRIPT_CONVERSE_THRESHOLD', 'nonsense');
    vi.stubEnv('SHANNON_VOICE_TRANSCRIPT_RELIABILITY_THRESHOLD', '');
    expect(transcriptThreshold('converse')).toBe(0.6);
  });

  it('lets the client\'s confidence only lower what acts, fail closed without a router score, and averages it to talk (review H1)', async () => {
    const scored = (value: number | undefined) => ({ transcriptReliabilityProbability: value });
    expect(transcriptScore(scored(0.6), speech(), 'act')).toBe(0.6);
    expect(transcriptScore(scored(0.8), speech(0.96), 'act')).toBe(0.8);
    expect(transcriptScore(scored(0.9), speech(0.7), 'act')).toBe(0.7);
    expect(transcriptScore(scored(undefined), speech(0.92), 'act')).toBeUndefined();
    expect(transcriptScore(scored(0.6), speech(0.96), 'converse')).toBeCloseTo(0.78);
    expect(transcriptScore(scored(undefined), speech(0.9), 'converse')).toBe(0.9);
    // Jev timed out, the local fallback decided, the client is sure: a write is still unknown, talking is trusted.
    expect(transcriptTrust(scored(undefined), speech(0.92))).toBe('unknown');
    expect(transcriptTrust(scored(undefined), speech(0.92), 'converse')).toBe('reliable');
    // A high logprob never lifts a 0.72–0.85 semantic score past 0.85.
    expect(transcriptTrust(scored(0.8), speech(0.99))).toBe('uncertain');
    // Typed words carry no recognition confidence.
    expect(transcriptScore(scored(0.6), { ...speech(0.1), source: 'typed' }, 'act')).toBe(0.6);
  });

  it('takes `userUtterance.confidence` only as a number in 0…1, and never refuses a turn for it', () => {
    const context = (confidence: unknown) => validatedVoiceDeviceContext({ timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false,
      userUtterance: { id: 'u', text: 'こんにちは', source: 'speech', confidence } }, at);
    expect(context(0.82)).toMatchObject({ userUtterance: { confidence: 0.82 } });
    for (const value of [1.4, -0.1, '0.9', Number.NaN, null]) {
      const valid = context(value);
      expect(valid, String(value)).not.toBe(false);
      expect(valid && valid.userUtterance, String(value)).not.toHaveProperty('confidence');
    }
  });

  function harness(score: number | undefined) {
    const requests: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
    const store = new InMemoryOrganizeStore();
    const reply = async (request: ShannonChatModelRequest | ShannonVoiceModelRequest) => {
      requests.push(request);
      return { mode: 'openai' as const, model: 'test', reply: 'はい。' };
    };
    const api = createLocalApiKernel(() => at, { chatModel: { mode: 'openai', model: 'test', generate: reply, generateVoice: reply }, organizeStore: store,
      voiceDecision: { mode: 'jev', model: 'test', decide: async value => ({ ...await local.decide(value), transcriptReliabilityProbability: score }) } });
    const turn = (transcript: string, confidence?: number, extra: Record<string, unknown> = {}) => api.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body: {
      scopeKey: 'owner', threadId: 'thread', transcript, participantMode: 'owner', deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false,
        userUtterance: { id: 'u1', text: transcript, source: 'speech', ...(confidence === undefined ? {} : { confidence }), ...extra } } } });
    return { turn, requests, store };
  }

  it('answers a 0.7 turn without the re-read-and-confirm instruction, runs no command on it, and says so (review M1)', async () => {
    const h = harness(0.7);
    expect((await h.turn('写真整理をタスクにして')).status).toBe(200);
    expect(promptOf(h.requests[0])).not.toContain('[Contextual transcript interpretation required]');
    expect(promptOf(h.requests[0])).toContain(NOTHING_CHANGED_LINE);
    expect(h.store.list('owner', 'thread')).toEqual([]);
    // Trusted to act: no such line.
    const sure = harness(0.95);
    await sure.turn('今日はどうだった');
    expect(promptOf(sure.requests[0])).not.toContain(NOTHING_CHANGED_LINE);
    // Below the lower threshold she re-reads and may ask, as before.
    const low = harness(0.5);
    await low.turn('今日はどうだった');
    expect(promptOf(low.requests[0])).toContain('[Contextual transcript interpretation required]');
  });

  it('runs no command on the client\'s confidence alone, nor when it would lift a lower router score', async () => {
    for (const [score, confidence] of [[undefined, 0.92], [0.8, 0.99]] as const) {
      const h = harness(score);
      await h.turn('写真整理をタスクにして', confidence);
      expect(h.store.list('owner', 'thread'), String(score)).toEqual([]);
    }
    // A low client confidence lowers a sure router score below acting.
    const doubted = harness(0.95);
    await doubted.turn('写真整理をタスクにして', 0.5);
    expect(doubted.store.list('owner', 'thread')).toEqual([]);
    const sure = harness(0.95);
    expect((await sure.turn('写真整理をタスクにして', 0.9)).body).toHaveProperty('receipt');
  });

  it('runs a command once when the next utterance continues the one that ran it, and records the trigger without words', async () => {
    const h = harness(0.95);
    await h.turn('写真整理をタスクにして', undefined, { trigger: 'wake' });
    expect(h.store.list('owner', 'thread')).toHaveLength(1);
    // Re-sent with the rest under a new id: the command does not run again.
    await h.turn('写真整理をタスクにして', undefined, { id: 'u2', continues: 'u1' });
    expect(h.store.list('owner', 'thread')).toHaveLength(1);
    // An utterance that continues nothing runs it as before.
    await h.turn('洗濯をタスクにして', undefined, { id: 'u3' });
    expect(h.store.list('owner', 'thread')).toHaveLength(2);
    const context = (extra: Record<string, unknown>) => validatedVoiceDeviceContext({ timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false,
      userUtterance: { id: 'u', text: 'こんにちは', source: 'speech', ...extra } }, at);
    expect(context({ trigger: 'wake', continues: 'u0' })).toMatchObject({ userUtterance: { trigger: 'wake', continues: 'u0' } });
    for (const extra of [{ trigger: 'ウェイク' }, { trigger: 7 }, { continues: 'x'.repeat(200) }, { continues: 'u' }]) {
      const valid = context(extra);
      expect(valid, JSON.stringify(extra)).not.toBe(false);
      expect(valid && valid.userUtterance, JSON.stringify(extra)).not.toHaveProperty(Object.keys(extra)[0]!);
    }
    const lines: string[] = [];
    const timing = new TurnTiming('voice', 'abcd1234', () => 0, line => lines.push(line));
    timing.note('trigger', 'wake');
    timing.finish('responded');
    expect(lines[0]).toMatch(/ trigger=wake$/u);
  });
});

describe('P3: a long silence in a voice Talk', () => {
  const HOUR = 3_600_000;
  const ago = (hours: number) => new Date(Date.parse(at) - hours * HOUR).toISOString();

  it('finds where the live conversation starts, and stays put while the call goes on', () => {
    expect(afterLongSilence([ago(96), ago(95.9)], at, 12 * HOUR)).toBe(2);
    expect(afterLongSilence([ago(96), ago(95.9), ago(0.1), ago(0.05)], at, 12 * HOUR)).toBe(2);
    expect(afterLongSilence([ago(5), ago(4), ago(0.1)], at, 12 * HOUR)).toBe(0);
    expect(voiceReplayGap({})).toEqual({ cutoffMilliseconds: 12 * HOUR, markMilliseconds: 3 * HOUR });
    expect(voiceReplayGap({ SHANNON_VOICE_REPLAY_GAP_HOURS: '0' })).toBeNull();
    expect(voiceReplayGap({ SHANNON_VOICE_REPLAY_GAP_HOURS: '6', SHANNON_VOICE_REPLAY_MARK_HOURS: '9' })).toEqual({ cutoffMilliseconds: 6 * HOUR, markMilliseconds: 3 * HOUR });
  });

  it('marks an owner message after a shorter silence with a fact of the stored times, and says the gap since then in the turn only', () => {
    const message = (id: string, role: 'user' | 'assistant', content: string, observedAt: string) => ({ message: { id, role, content, observedAt }, item: { role, content } });
    const live = silenceAwareMessages([
      message('1', 'user', 'おはよう', ago(8)), message('2', 'assistant', 'おはようございます。', ago(8)),
      message('3', 'user', 'ただいま', ago(4)), message('4', 'assistant', 'おかえりなさい。', ago(4)),
    ], at, voiceReplayGap({})!);
    expect(live.cut).toBe(0);
    expect(live.messages.map(entry => entry.item.content)).toEqual(['おはよう', 'おはようございます。', '[前のやり取りから約4時間後] ただいま', 'おかえりなさい。']);
    expect(live.line).toContain('約4時間前');
  });

  it('replays nothing of a four-day-old Talk to a new call, gives no summary of it, and tells her how long it has been', () => {
    const conversations = new InMemoryConversationStore();
    const state = new InMemoryCompanionStateStore(() => at);
    conversations.appendTurn('owner', 'thread', 'エンダードラゴンを倒しに行こう', 'はい、準備しますね。', ago(96));
    const replay = conversationReplay('voice', state.snapshot('owner'), conversations, 'owner', 'thread', OWNER_AUDIENCE, {}, undefined, false, at);
    expect(replay.history).toEqual([]);
    expect(replay.summary).toBeUndefined();
    expect(replay.request('').turnContext).toContain('前のやり取りは約4日前');
    expect(JSON.stringify(replay.request(''))).not.toContain('エンダードラゴン');
    // Without the turn's time (text, an old caller), and with the switch off, the window is what it was.
    expect(conversationReplay('voice', state.snapshot('owner'), conversations, 'owner', 'thread', OWNER_AUDIENCE, {}).history).toHaveLength(2);
    expect(conversationReplay('voice', state.snapshot('owner'), conversations, 'owner', 'thread', OWNER_AUDIENCE,
      { SHANNON_VOICE_REPLAY_GAP_HOURS: 'off' }, undefined, false, at).history).toHaveLength(2);
    // The new call's own turns are replayed, and the same bytes from turn to turn.
    conversations.appendTurn('owner', 'thread', 'ねえ、聞こえる？', '聞こえますよ。', ago(0.01));
    const first = conversationReplay('voice', state.snapshot('owner'), conversations, 'owner', 'thread', OWNER_AUDIENCE, {}, undefined, false, at);
    expect(first.history.map(item => item.content)).toEqual(['[前のやり取りから約4日後] ねえ、聞こえる？', '聞こえますよ。']);
    const later = conversationReplay('voice', state.snapshot('owner'), conversations, 'owner', 'thread', OWNER_AUDIENCE, {}, undefined, false,
      new Date(Date.parse(at) + 600_000).toISOString());
    expect(later.history).toEqual(first.history);
    expect(later.request('').turnContext ?? '').not.toContain('[会話の間]');
  });
});

describe('P3: a long Talk (review M3)', () => {
  it('gives no summary of what lies before the silence even when the Talk is longer than the read limit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-voice-gap-'));
    const conversations = new SQLiteShannonStore({ path: join(directory, 'shannon.sqlite'), now: () => at });
    const state = conversations;
    const old = new Date(Date.parse(at) - 96 * 3_600_000).toISOString();
    for (let index = 0; index < 250; index += 1) conversations.appendTurn('owner', 'thread', `古い話${index}`, `古い返事${index}`, old);
    conversations.saveReplaySummary('owner', 'thread', { summary: 'エンダードラゴンの要約', coveredThroughMessageId: 'none', chainStartedAt: old, updatedAt: old });
    const replay = conversationReplay('voice', state.snapshot('owner'), conversations, 'owner', 'thread', OWNER_AUDIENCE, {}, undefined, false, at);
    expect(replay.history).toEqual([]);
    expect(replay.summary).toBeUndefined();
    expect(JSON.stringify(replay.request(''))).not.toContain('エンダードラゴン');
    // The control: without the turn's time the summary of the long Talk is given as before.
    expect(conversationReplay('voice', state.snapshot('owner'), conversations, 'owner', 'thread', OWNER_AUDIENCE, {}).summary).toBe('エンダードラゴンの要約');
    conversations.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

describe('P2: looks on doubtful words (review L2, L6)', () => {
  const look = (reliability: number, extra: Record<string, unknown> = {}, transcript = '僕のこと見える？') => voiceRoomLookTurn(
    { voiceTurn: () => ({ unavailable: null, open: () => true, cutOff: () => undefined }) },
    { scopeKey: 'owner', transcript, at, audience: 'owner', uncertain: true,
      decision: { shouldRespond: true, roomLookProbability: 0.8, transcriptReliabilityProbability: reliability } as never, ...extra }, {}).prompt;
  it('has a floor, and never opens on doubtful words with someone else listening', () => {
    expect(look(0.44)).toBe(voiceRoomLookPrompt(true));
    expect(look(0.2)).toBe(VOICE_ROOM_LOOK_CONFIRM_PROMPT);
    // The app's camera is judged as the owner's own, but someone else can hear the reply.
    expect(look(0.44, { heardBy: 'others' })).toBe(VOICE_ROOM_LOOK_CONFIRM_PROMPT);
  });

  it('reads a request to look now, not a past or reported look', () => {
    for (const words of ['これ見て', '部屋見える？', 'カメラで見てみて', 'こっち見てくれる？']) expect(asksToLookNow(words), words).toBe(true);
    for (const words of ['映画、見てくれた？', 'これ見てくれた？', 'カメラを買った', '昨日テレビ見てた']) expect(asksToLookNow(words), words).toBe(false);
    expect(perceptionOrActionRequest('映画、見てくれた？')).toBe(false);
  });
});

describe('P5: an unanswered turn is observable, and a request is not left to die', () => {
  it('writes silence=<category> and chars=<n> on the timing line, never words', async () => {
    const lines: string[] = [];
    const timing = new TurnTiming('voice', 'abcd1234', () => 0, line => lines.push(line));
    const silent = { ...await local.decide({ ...input, transcript: 'うん' }), shouldRespond: false, silence: 'backchannel' as const };
    const plan = voicePlanner(silent, undefined, { ownerAlone: true, transcript: 'うん、そうだね', timing });
    expect(plan()).toMatchObject({ shouldRespond: false, silenceCategory: 'backchannel' });
    timing.finish('no_response');
    expect(lines[0]).toMatch(/outcome=no_response silence=backchannel chars=7$/u);
    expect(lines[0]).not.toContain('そうだね');
    timing.note('silence', 'not a code!');
    expect(new TurnTiming('voice', 'x', () => 0).line('responded')).not.toContain('silence=');
  });

  it('answers a request at 0.6 when his previous utterance had asked her something (turn 2e5c9325 scored .69)', async () => {
    const decision = { ...await local.decide(input), shouldRespond: false, solutionWantedProbability: 0.69, selectedSkills: [] };
    const after = ownerVoiceTurnFacts({ history: [{ role: 'user', content: '明日の予定を教えて' }, { role: 'assistant', content: 'はい。' }], at, othersPresent: false });
    const fresh = ownerVoiceTurnFacts({ history: [{ role: 'user', content: '今日は寒かった' }, { role: 'assistant', content: 'そうですね。' }], at, othersPresent: false });
    expect(after.ownerAskedBefore).toBe(true);
    expect(fresh.ownerAskedBefore).toBeUndefined();
    expect(asksHerSomething(decision, after, 'それと夜のも', {})).toBe(true);
    expect(asksHerSomething(decision, fresh, 'それと夜のも', {})).toBe(false);
    expect(asksHerSomething(decision, after, 'それと夜のも', { SHANNON_VOICE_RESCUE_AFTER_REQUEST: '0.8' })).toBe(false);
    expect(settleOwnerVoiceTurn(decision, { transcript: 'それと夜のも', facts: after, uncertain: false }, {}).shouldRespond).toBe(true);
  });
});

describe('P6: a request to look or act searches no memory, and a voice rerank is capped', () => {
  it('knows a perception or action request, and keeps a question about what she remembers', () => {
    for (const words of ['僕のこと見える？', 'カメラで部屋見て', 'これ見て', '3分後にタイマーかけて', '音楽かけて']) expect(perceptionOrActionRequest(words), words).toBe(true);
    for (const words of ['今日は寒いね', 'カメラを買ったんだ', '前にセットしたタイマーのこと覚えてる？', 'エンダードラゴンについて何を覚えてる？']) {
      expect(perceptionOrActionRequest(words), words).toBe(false);
    }
  });

  it('drops a rerank past its cap and keeps the similarity order', async () => {
    const vector = new Float32Array([1, 0]);
    const candidate = (id: string, summary: string, similar: number[]) => ({ id, kind: 'experience' as const, sourceId: id, summary, observedAt: at, vector: new Float32Array(similar) });
    const index = { embeddingCandidates: () => [candidate('experience:a', '近い記憶', [0.9, 0.1]), candidate('experience:b', '遠い記憶', [0.3, 0.9])] };
    let aborted = false;
    const gateway = {
      embeddingModel: 'test', embed: async () => [vector], rewriteQuery: async () => [], selectSections: async () => [],
      rerank: (_scope: string, _query: string, _candidates: unknown, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
      }),
    };
    const recall = new SemanticMemoryRecall(gateway as never, index as never);
    const snapshot = new InMemoryCompanionStateStore(() => at).snapshot('owner');
    const started = performance.now();
    const outcome = await recall.recall({ scopeKey: 'owner', query: 'カメラ', snapshot, present: OWNER_AUDIENCE, withoutRewrite: true, rerankTimeoutMilliseconds: 50 });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(aborted).toBe(true);
    expect(outcome.status).toBe('used');
    expect(outcome.hits.map(hit => hit.id)).toEqual(['experience:a', 'experience:b']);
    expect(outcome.hits[0]!.relevance).toBeGreaterThan(outcome.hits[1]!.relevance);
  });
});

describe('P9: how a spoken reply is said, after the cached prefix', () => {
  it('asks for one or two sentences in a social turn only, and always for no habitual name and no invented perception', async () => {
    const social = { conversationClass: 'direct', selectedSkills: [], solutionWantedProbability: 0.2 };
    expect(spokenReplyLines('ごめんね', '', undefined, social)).toContain(SOCIAL_LENGTH_LINE);
    expect(spokenReplyLines('明日の予定は？', '', undefined, { ...social, solutionWantedProbability: 0.8 })).not.toContain(SOCIAL_LENGTH_LINE);
    expect(spokenReplyLines('天気は？', '', undefined, { ...social, selectedSkills: ['weather'] })).not.toContain(SOCIAL_LENGTH_LINE);
    const lines = spokenReplyLines('ごめんね', '', undefined, social).join('\n');
    expect(lines).toContain('「ライ氏、」で始めない');
    expect(lines).toContain(PERCEPTION_HONESTY_LINE);
    // A photo he shared is in the context: the line is not given then (review L7).
    expect(spokenReplyLines('これ見て', '', undefined, social, true)).not.toContain(PERCEPTION_HONESTY_LINE);
  });
});

describe('P11: a respond action interrupted by its caller is closed at once', () => {
  const abort = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
  const execution = (extra: Record<string, unknown> = {}) => ({ execution: { lease: {} as never, signal: new AbortController().signal, permit: async () => true, ...extra } });

  it('closes as cancelled, saying whether a sentence had been spoken; keeps unknown when an outcome is not known', () => {
    expect(interruptedTurn(execution({ spoken: true }), abort())).toEqual(['cancelled', 'response_interrupted_spoken']);
    expect(interruptedTurn(execution({ interrupted: true }), new Error('ACTION_STOPPED'))).toEqual(['cancelled', 'response_interrupted']);
    expect(interruptedTurn(execution({ spoken: true, writeInFlight: true }), abort())).toEqual(['unknown', 'response_interrupted']);
    expect(interruptedTurn(execution({ stepOutcome: 'unknown' }), abort())).toEqual(['unknown', 'response_interrupted']);
    expect(interruptedTurn(execution(), new Error('MODEL_UNAVAILABLE'))).toEqual(['unknown', 'response_interrupted']);
  });

  it('through the foreground runner: the respond row is terminal, not unknown for the exit time', async () => {
    const h = actionHarness(() => new Date().toISOString());
    const run = foregroundRunner(h.actions);
    await expect(run('owner', async () => {
      const active = currentActionExecution()!;
      active.spoken = true;
      throw abort();
    })).rejects.toThrow('aborted');
    expect(h.db.prepare("SELECT state, result FROM mind_actions WHERE kind='respond'").all()).toEqual([{ state: 'cancelled', result: 'response_interrupted_spoken' }]);
    h.close();
  });
});
