import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCompanionStateStore, OWNER_AUDIENCE } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { OpenAIResponsesChatModel, type ShannonChatModelRequest, type ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import {
  REPLAY_BUDGET_DEFAULT, REPLAY_BUDGET_MAXIMUM, REPLAY_BUDGET_MINIMUM, REPLAY_MAXIMUM_MESSAGES, REPLAY_SUMMARY_CHARACTERS,
  conversationReplay, isWindowBoundary, replayBudgets, replayWindow, stableHeadFor, textReplayRule, voiceReplayRule, type ReplayRule,
} from '../src/mind/recall/conversationWindow.js';
import { earlierConversationSummaryInstructions } from '../src/infra/models/chatModelSupport.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { visibleConversationHistory } from '../src/mind/memory/memoryVisibility.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { LocalVoiceDecisionGateway, type VoiceDecisionInput } from '../src/mind/selectors/voiceDecision.js';
import { promptOf } from './modelPrompt.js';

const at = '2026-10-02T03:00:00.000Z';
const delegations = '/v1/voice/live/delegations';
const turns = '/v1/voice/gemini/cascade/turns';
const SUMMARY_HEADER = '[このトークで、下の会話履歴より前に話した内容の要約]';
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function harness() {
  const textRequests: ShannonChatModelRequest[] = [];
  const voiceRequests: ShannonVoiceModelRequest[] = [];
  const decisions: VoiceDecisionInput[] = [];
  let reply = 'はい。';
  const model = {
    mode: 'openai' as const, model: 'test',
    generate: async (request: ShannonChatModelRequest) => { textRequests.push(request); return { mode: 'openai' as const, model: 'test', reply }; },
    generateVoice: async (request: ShannonVoiceModelRequest) => { voiceRequests.push(request); return { mode: 'openai' as const, model: 'test', reply }; },
  };
  const local = new LocalVoiceDecisionGateway();
  const store = new InMemoryConversationStore();
  const state = new InMemoryCompanionStateStore(() => at);
  const api = createLocalApiKernel(() => at, { chatModel: model, conversationStore: store, stateStore: state,
    voiceDecision: { mode: 'jev', model: 'test', decide: async input => {
      decisions.push(input);
      // An ordinary spoken turn: no memory skill is selected, the case that used to replay four messages.
      return { ...await local.decide(input), shouldRespond: true, conversationClass: 'direct' as const, selectedSkills: [] };
    } } });
  const spoken = async (user: string, shannon: string, thread = 'thread') => {
    const response = await api.dispatch({ method: 'POST', path: turns, body: { scopeKey: 'owner', threadId: thread, userTranscript: user, shannonTranscript: shannon } });
    expect(response.status).toBe(201);
  };
  const voice = async (transcript: string, extra: Record<string, unknown> = {}, thread = 'thread') => {
    const response = await api.dispatch({ method: 'POST', path: delegations, body: { scopeKey: 'owner', threadId: thread, transcript, ...extra,
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
        userUtterance: { id: `u-${voiceRequests.length}`, text: transcript, source: 'speech', rawText: transcript,
          ...(extra.participantMode === 'guest' ? { callContext: { callId: 'call-window-0001', turns: [], introductionStart: true } } : {}) } } } });
    expect(response.status).toBe(200);
    return voiceRequests.at(-1)!;
  };
  const chat = async (message: string, answer: string, thread = 'thread') => {
    reply = answer;
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: thread, message } });
    expect(response.status).toBe(200);
    return textRequests.at(-1)!;
  };
  return { api, store, state, spoken, voice, chat, textRequests, voiceRequests, decisions };
}

const said = (request: { history: readonly { content: string }[] }) => request.history.map(item => item.content);
const word = (index: number) => `しりとり語${String(index).padStart(3, '0')}`;

describe('the production voice transcript of 2026-10-02', () => {
  it('still has the date in front of the model when the owner asks for advice', async () => {
    const h = harness();
    await h.spoken('今週の予定ってどうなってたっけ', '日曜日はデートの予定が入っていますよ、ライ氏。');
    await h.spoken('へえ', 'はい。');
    await h.spoken('そっか', 'うん、そうです。');
    await h.spoken('んーとあれ', 'すみません、もう一度お願いできますか。');
    await h.spoken('まあいいや', 'わかりました。');
    const request = await h.voice('むしろアドバイスちょうだい');
    expect(said(request)).toContain('日曜日はデートの予定が入っていますよ、ライ氏。');
    expect(said(request)).toHaveLength(10);
    // The rule it replaces (the newest four messages) had already lost the date.
    expect(said({ history: request.history.slice(-4) }).join('')).not.toContain('デート');
    expect(promptOf(request)).not.toContain(SUMMARY_HEADER);
  });
});

describe('a long game of shiritori', () => {
  it('voice: every word of 60 exchanges is in the request of the last turn', async () => {
    const h = harness();
    for (let index = 0; index < 60; index += 1) await h.spoken(word(index * 2), word(index * 2 + 1));
    const request = await h.voice('次はボクの番だよね');
    const history = said(request);
    for (let index = 0; index < 120; index += 1) expect(history, word(index)).toContain(word(index));
    expect(history).toHaveLength(120);
  });

  it('text: every word of 60 exchanges is in the request of the last turn', async () => {
    const h = harness();
    for (let index = 0; index < 60; index += 1) await h.chat(word(index * 2), word(index * 2 + 1));
    const request = await h.chat('次はどっちの番？', 'ライ氏の番です。');
    const history = said(request);
    for (let index = 0; index < 120; index += 1) expect(history, word(index)).toContain(word(index));
    expect(history).toHaveLength(120);
  });

  it('SQLite: 250 exchanges replay the newest 400 messages, more than the displayed history holds', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-window-'));
    directories.push(directory);
    const store = new SQLiteShannonStore({ path: join(directory, 'shannon.sqlite'), now: () => at });
    for (let index = 0; index < 250; index += 1) store.appendTurn('owner', 'thread', word(index * 2), word(index * 2 + 1), at);
    expect(store.conversationHistory('owner', 'thread')).toHaveLength(200);
    for (const channel of ['text', 'voice'] as const) {
      const replay = conversationReplay(channel, store.snapshot('owner'), store, 'owner', 'thread', OWNER_AUDIENCE, {});
      expect(said(replay)).toEqual(Array.from({ length: REPLAY_MAXIMUM_MESSAGES }, (_, index) => word(index + 100)));
      expect(replay.truncated).toBe(true);
    }
    store.close();
  });
});

describe('the budget rule', () => {
  const message = (index: number, length: number) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `${String(index).padStart(4, '0')}${'あ'.repeat(length - 4)}` });

  /** The rule without its stable head: the window slides by one message as the budget fills. */
  const sliding = (rule: ReplayRule): ReplayRule => ({ ...rule, stableHead: undefined });

  it('drops the oldest messages first and keeps the newest in order', () => {
    const messages = Array.from({ length: 100 }, (_, index) => message(index, 300));
    const window = replayWindow(messages, sliding(textReplayRule(12_000)));
    expect(window.history).toEqual(messages.slice(60));
    expect(window).toMatchObject({ start: 60, characters: 12_000 });
    // With the stable head it starts at the first boundary from there, inside the budget.
    const stable = replayWindow(messages, textReplayRule(12_000));
    const head = stableHeadFor(12_000);
    expect(stable.start).toBeGreaterThanOrEqual(60);
    expect(isWindowBoundary(messages[stable.start]!, head)).toBe(true);
    expect(messages.slice(60, stable.start).some(item => isWindowBoundary(item, head))).toBe(false);
    expect(stable.history).toEqual(messages.slice(stable.start));
    expect(stable.characters).toBe(300 * (100 - stable.start));
  });

  it('keeps its start for many turns of a long Talk, inside the budget, and drops to a boundary only when the budget passes it', () => {
    for (const [rule, length] of [[textReplayRule(12_000), 120], [textReplayRule(2_000), 15], [voiceReplayRule(12_000), 80]] as const) {
      const messages = Array.from({ length: 1_200 }, (_, index) => message(index, length + (index * 7) % 40));
      const starts: number[] = [];
      let held = 0;
      let full = 0;
      let moved = 0;
      for (let count = 2; count <= messages.length; count += 2) {
        const window = replayWindow(messages.slice(0, count), rule);
        expect(window.characters).toBeLessThanOrEqual(rule.budgetCharacters);
        const tight = replayWindow(messages.slice(0, count), sliding(rule));
        expect(window.start).toBeGreaterThanOrEqual(tight.start);
        if (tight.start > 0) { full += 1; held += window.characters / tight.characters; }
        if (tight.start > 0 && starts.at(-1) !== window.start) moved += 1;
        starts.push(window.start);
      }
      // The start only moves forward. Once the window is full, sliding moves it on every turn; with the stable head it stays
      // on most turns (measured: about 73 to 94 in 100 for these Talks), so the provider's cache keeps the history.
      expect([...starts].sort((left, right) => left - right)).toEqual(starts);
      expect(1 - moved / full).toBeGreaterThan(0.65);
      // A full window still holds most of what the budget allows (measured: about 85 in 100).
      expect(held / full).toBeGreaterThan(0.8);
    }
  });

  it('always replays the newest messages even when they alone exceed the budget', () => {
    const messages = Array.from({ length: 30 }, (_, index) => message(index, 5_000));
    const text = replayWindow(messages, textReplayRule(12_000));
    expect(text.history).toEqual(messages.slice(10)); // the 20 newest, exactly as stored
    const voice = replayWindow(messages, voiceReplayRule(REPLAY_BUDGET_MINIMUM));
    expect(voice.history).toHaveLength(8);
    expect(voice.history.every(item => item.content.length === 600)).toBe(true);
  });

  it('clips an older text message to 1,500 characters and every voice message to 600', () => {
    const messages = [message(0, 4_000), ...Array.from({ length: 20 }, (_, index) => message(index + 1, 40))];
    const text = replayWindow(messages, textReplayRule(12_000));
    expect(text.history).toHaveLength(21);
    expect(Array.from(text.history[0]!.content)).toHaveLength(1_500);
    expect(text.history[0]!.content.endsWith('…')).toBe(true);
    expect(text.history.slice(1)).toEqual(messages.slice(1));
    const voice = replayWindow([{ role: 'user', content: `  ${'い'.repeat(700)}\n\n続き ` }, { role: 'assistant', content: '   ' }], voiceReplayRule());
    expect(voice.history).toEqual([{ role: 'user', content: 'い'.repeat(600) }]);
  });

  it('never replays more than 400 messages', () => {
    const messages = Array.from({ length: 900 }, (_, index) => message(index, 4));
    for (const rule of [textReplayRule(REPLAY_BUDGET_MAXIMUM), voiceReplayRule(REPLAY_BUDGET_MAXIMUM)]) {
      expect(replayWindow(messages, sliding(rule)).history).toEqual(messages.slice(500));
      const stable = replayWindow(messages, rule);
      expect(stable.start).toBeGreaterThanOrEqual(500);
      expect(stable.history).toEqual(messages.slice(stable.start));
    }
  });

  it('holds both environment budgets to their bounds', () => {
    expect(replayBudgets({})).toEqual({ text: REPLAY_BUDGET_DEFAULT, voice: REPLAY_BUDGET_DEFAULT });
    expect(replayBudgets({ SHANNON_CONVERSATION_REPLAY_CHARACTERS: '20000', SHANNON_VOICE_REPLAY_CHARACTERS: '6000' })).toEqual({ text: 20_000, voice: 6_000 });
    expect(replayBudgets({ SHANNON_CONVERSATION_REPLAY_CHARACTERS: '1', SHANNON_VOICE_REPLAY_CHARACTERS: '9999999' }))
      .toEqual({ text: REPLAY_BUDGET_MINIMUM, voice: REPLAY_BUDGET_MAXIMUM });
    expect(replayBudgets({ SHANNON_CONVERSATION_REPLAY_CHARACTERS: 'many', SHANNON_VOICE_REPLAY_CHARACTERS: ' ' }))
      .toEqual({ text: REPLAY_BUDGET_DEFAULT, voice: REPLAY_BUDGET_DEFAULT });
    expect([REPLAY_BUDGET_MINIMUM, REPLAY_BUDGET_DEFAULT, REPLAY_BUDGET_MAXIMUM]).toEqual([2_000, 12_000, 60_000]);
  });

  it('the voice budget is read from the environment for each turn', async () => {
    const h = harness();
    for (let index = 0; index < 40; index += 1) await h.spoken(`${word(index * 2)}${'あ'.repeat(92)}`, `${word(index * 2 + 1)}${'い'.repeat(92)}`);
    expect((await h.voice('続けて')).history).toHaveLength(80);
    vi.stubEnv('SHANNON_VOICE_REPLAY_CHARACTERS', '2000');
    const smaller = await h.voice('続けて');
    // 20 messages fill 2,000 characters; the window starts at a boundary among them (`StableHead`), the newest 8 always kept.
    expect(smaller.history.length).toBeLessThanOrEqual(20);
    expect(smaller.history.length).toBeGreaterThanOrEqual(8);
    expect(said(smaller).at(-1)).toContain(word(79));
  });
});

describe('prompt size', () => {
  /** Characters of replayed history (and of the summary block) for the largest thread each rule admits. */
  it('grows by at most the budget plus the summary block; the old worst case of text is unchanged', () => {
    const summaryBlock = earlierConversationSummaryInstructions('要'.repeat(2_000)).length;
    const fill = (length: number, count: number) => Array.from({ length: count }, () => ({ role: 'user' as const, content: 'あ'.repeat(length) }));
    const table = {
      // Before: 20 messages as stored. A message is at most 8,000 characters.
      textBeforeWorst: 20 * 8_000,
      textAfterWorst: replayWindow(fill(8_000, 500), textReplayRule()).characters,
      // The growth is what the budget adds beyond the newest 20 messages: none once they fill it.
      textAfterShortMessages: replayWindow(fill(30, 500), textReplayRule()).characters,
      textBeforeShortMessages: 20 * 30,
      // Before: 4 messages of 600 characters, 8 on a memory or complex turn.
      voiceBeforeOrdinary: 4 * 600, voiceBeforeMemoryTurn: 8 * 600,
      voiceAfterWorst: replayWindow(fill(8_000, 500), voiceReplayRule()).characters,
      voiceAfterAtMinimumBudget: replayWindow(fill(8_000, 500), voiceReplayRule(REPLAY_BUDGET_MINIMUM)).characters,
      voiceAfterAtMaximumBudget: replayWindow(fill(8_000, 500), voiceReplayRule(REPLAY_BUDGET_MAXIMUM)).characters,
      summaryBlock,
    };
    expect(table).toEqual({
      textBeforeWorst: 160_000, textAfterWorst: 160_000,
      textAfterShortMessages: 12_000, textBeforeShortMessages: 600,
      voiceBeforeOrdinary: 2_400, voiceBeforeMemoryTurn: 4_800,
      voiceAfterWorst: 12_000, voiceAfterAtMinimumBudget: 4_800, voiceAfterAtMaximumBudget: 60_000,
      summaryBlock: 82 + 640,
    });
    expect(REPLAY_SUMMARY_CHARACTERS).toBe(600);
  });
});

describe('a short thread sends what it sent before', () => {
  it('the kernel request and the provider bytes equal those of the previous history rule', async () => {
    const h = harness();
    for (let index = 0; index < 9; index += 1) await h.chat(`質問${index}${'あ'.repeat(index * 400)}`, `答え${index}${'い'.repeat(2_000)}`);
    const before = visibleConversationHistory(h.state.snapshot('owner'), h.store, 'owner', 'thread', OWNER_AUDIENCE);
    const request = await h.chat('次の質問', '次の答え');
    expect(before).toHaveLength(18);
    expect(request.history).toEqual(before);
    expect(promptOf(request)).not.toContain(SUMMARY_HEADER);
    const body = async (history: ShannonChatModelRequest['history']) => {
      let sent = '';
      const fetcher = async (_url: unknown, init?: RequestInit) => {
        sent = String(init?.body);
        return new Response(JSON.stringify({ output_text: JSON.stringify({ reply: 'はい', threadSummary: null, taskDecision: { disposition: 'none', reason: 'r' }, taskProposal: null, intentPlan: null, artifacts: null }) }));
      };
      await new OpenAIResponsesChatModel({ apiKey: 'test-only', fetcher: fetcher as typeof fetch, now: () => at }).generate({ ...request, history });
      return sent;
    };
    expect(await body(request.history)).toBe(await body(before));
  });

  it('a thread of exactly 20 long messages is replayed as stored, not clipped to the budget', async () => {
    const h = harness();
    for (let index = 0; index < 10; index += 1) await h.chat(`質問${index}${'あ'.repeat(3_000)}`, `答え${index}${'い'.repeat(3_000)}`);
    const before = visibleConversationHistory(h.state.snapshot('owner'), h.store, 'owner', 'thread', OWNER_AUDIENCE);
    const request = await h.chat('次の質問', '次の答え');
    expect(request.history).toEqual(before);
    expect(request.history).toHaveLength(20);
    expect(request.history.reduce((total, item) => total + item.content.length, 0)).toBeGreaterThan(60_000);
  });
});

describe('helpers keep their small windows', () => {
  it('routing gets four messages, the session projection twelve, and the store window stays twenty', async () => {
    const h = harness();
    for (let index = 0; index < 60; index += 1) await h.spoken(word(index * 2), word(index * 2 + 1));
    const request = await h.voice('次はボクの番だよね');
    expect(request.history).toHaveLength(120);
    expect(h.decisions.at(-1)?.context).toEqual([116, 117, 118, 119].map(index => ({ role: index % 2 ? 'assistant' : 'user', content: word(index) })));
    expect(h.store.history('owner', 'thread')).toHaveLength(20);
    expect(visibleConversationHistory(h.state.snapshot('owner'), h.store, 'owner', 'thread', OWNER_AUDIENCE)).toHaveLength(20);
    const session = h.api.realtimeVoiceSession('owner', 'thread', { clientDelegation: true });
    const rows = session.instructions.split('\n').filter(line => /^(?:User|Shannon): しりとり語/u.test(line));
    expect(rows).toHaveLength(12);
    expect(rows[0]).toBe(`User: ${word(108)}`);
  });

  it('a 「友人も一緒」 call replays its own turns only and never the owner thread', async () => {
    const h = harness();
    for (let index = 0; index < 30; index += 1) await h.spoken(word(index * 2), word(index * 2 + 1));
    h.store.saveReplaySummary('owner', 'thread', { summary: 'ゼブラ要約', coveredThroughMessageId: 'none', chainStartedAt: at, updatedAt: at });
    const request = await h.voice('シャノン、こんにちは', { participantMode: 'guest' });
    expect(request.history).toEqual([]);
    expect(promptOf(request)).not.toContain(SUMMARY_HEADER);
    expect(promptOf(request)).not.toContain('ゼブラ要約');
  });
});
