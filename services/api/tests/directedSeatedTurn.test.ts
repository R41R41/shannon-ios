import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { BackgroundUpdateCoordinator } from '../src/mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../src/infra/models/chatModel.js';
import { SQLiteSurfaceTurnLog } from '../src/mind/action/respond/store/surfaceTurnStore.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { PlatformBridgeService, configuredPlatformBridge } from '../src/mind/memory/platformBridge.js';
import { PlatformPeople } from '../src/mind/memory/platformPeople.js';
import { PlatformVoiceService, type VoiceTurnLine } from '../src/surfaces/platform/platformVoice.js';
import { ChatSentenceSplitter, splitChatSentences } from '../src/surfaces/text/chatSentenceSplitter.js';
import { VOICE_SENTENCE_CUT } from '../src/surfaces/text/chatSentenceStream.js';
import { oneHeadEnabled } from '../src/contracts/oneHeadContract.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { LocalVoiceDecisionGateway, type VoiceDecisionGateway } from '../src/mind/selectors/voiceDecision.js';
import type { VoiceMinecraftPort } from '../src/surfaces/platform/voiceMinecraftPort.js';
import { SEATED_BODY_REQUEST_LINE, voiceTranscriptInterpretationPrompt } from '../src/surfaces/voice/voiceTranscriptContext.js';

/**
 * A spoken turn the channel took as said to her (the talk key held, or the answer to a question of hers) is answered even when the router,
 * which sees only the words and the last lines of the thread, calls a bare 「うん」 no_response; a turn the channel did not take that way
 * keeps the router's silence. And the words of an unsure transcript no longer forbid a clear request from being taken.
 */
const OWNER = '900000000000000001';
const ROOM = 'discord:111:222';
const START = '2026-10-20T12:00:00.000Z';
const BRIDGE = { SHANNON_PLATFORM_BRIDGE_TOKEN: 'c'.repeat(40), SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner',
  SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify([{ platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: OWNER, title: 'テストサーバー' }]) };
const ENV = { SHANNON_DC_VOICE: 'on', SHANNON_ONE_HEAD: 'on' };
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

class Model implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  private result(): ShannonChatModelResult { return { mode: this.mode, model: this.model, reply: 'うん、作るね。' }; }
  async generate(request: ShannonChatModelRequest) { this.requests.push(request); return this.result(); }
  async generateStreaming(request: ShannonChatModelRequest, onText: (text: string) => void | Promise<void>) {
    this.requests.push(request); await onText('うん、作るね。'); return this.result();
  }
}

async function turn(words: string, fields: Record<string, unknown>): Promise<{ model: Model; lines: VoiceTurnLine[] }> {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-directed-seated-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  const now = () => START;
  const store = new SQLiteShannonStore({ path, now });
  const peopleStore = new SQLitePeopleMemoryStore(path);
  const background = new BackgroundUpdateCoordinator(store, store);
  const model = new Model();
  const local = new LocalVoiceDecisionGateway();
  // The router calls the words no_response, as it does for a bare 「うん」.
  const voiceDecision: VoiceDecisionGateway = { mode: local.mode, model: local.model, decide: async input => ({
    ...(await local.decide(input)), shouldRespond: false, conversationClass: 'no_response' as const }) };
  const api = createLocalApiKernel(now, { voiceDecision, chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store, background, peopleMemory: peopleStore });
  const bridge = new PlatformBridgeService(configuredPlatformBridge(BRIDGE)!, store, store, background, now, new PlatformPeople(peopleStore, store),
    () => true, () => oneHeadEnabled(ENV));
  const turns = new SQLiteSurfaceTurnLog(path, 'platform_voice_turns');
  const body: VoiceMinecraftPort = { state: () => ({ connected: true, running: null }), intent: async () => ({ delivered: true, as: 'task' as const }) };
  const voice = new PlatformVoiceService({
    scopeKey: 'owner', bridge, conversationStore: store, conversation: { textTurn: api.textTurn.bind(api), seatedVoiceTurn: api.seatedVoiceTurn.bind(api) },
    turns, now, chatModel: model, minecraft: () => body,
    sentences: text => splitChatSentences(text, VOICE_SENTENCE_CUT), splitter: () => new ChatSentenceSplitter(VOICE_SENTENCE_CUT),
    environment: () => ENV, log: () => undefined,
  });
  const lines: VoiceTurnLine[] = [];
  await voice.turn({ platform: 'discord', requestId: 'v-1', conversationId: ROOM, voiceChannelId: '700', sourceUserId: OWNER, sourceDisplayName: 'ライ',
    userMessage: words, observedAt: START, participants: [OWNER], ...fields }, line => lines.push(line));
  await background.waitForIdle('owner');
  await new Promise(resolve => setImmediate(resolve));
  turns.close(); peopleStore.close(); store.close();
  return { model, lines };
}

describe('a seated voice turn the router calls no_response', () => {
  it('is answered when the key was held', async () => {
    const { model, lines } = await turn('ケーキを作って', { directed: true });
    expect(model.requests).toHaveLength(1);
    expect(lines.find(line => line.type === 'done')).toMatchObject({ reply: 'うん、作るね。' });
  });

  it('is answered when it follows her last words with the key held (a bare 「うん」)', async () => {
    const { model } = await turn('うん', { directed: true, shannonSpokeMsAgo: 3_000 });
    expect(model.requests).toHaveLength(1);
  });

  it('keeps the router\'s silence when nothing took the words as said to her', async () => {
    const { model, lines } = await turn('ありがとう', {});
    expect(model.requests).toHaveLength(0);
    expect(lines.find(line => line.type === 'done')).toMatchObject({ reply: '' });
  });
});

describe('the interpretation of an unsure transcript, for a channel\'s seat', () => {
  it('does not forbid starting a request, and says a clear request is taken without asking back, with the reason', () => {
    const apps = voiceTranscriptInterpretationPrompt(true, 'ケーキを作って');
    expect(apps).toContain('No mutation, task start');
    expect(apps).not.toContain(SEATED_BODY_REQUEST_LINE);
    const seated = voiceTranscriptInterpretationPrompt(true, 'ケーキを作って', false, true);
    expect(seated).not.toContain('No mutation, task start');
    expect(seated).toContain(SEATED_BODY_REQUEST_LINE);
    expect(SEATED_BODY_REQUEST_LINE).toContain('理由');
    // Still asks when what is wanted is not clear: the rest of the unsure-transcript block stays.
    expect(seated).toContain('ask one short Japanese confirmation');
    expect(voiceTranscriptInterpretationPrompt(false, 'ケーキを作って', true, true)).toContain(SEATED_BODY_REQUEST_LINE);
    expect(voiceTranscriptInterpretationPrompt(false, 'ケーキを作って', false, true)).not.toContain(SEATED_BODY_REQUEST_LINE);
    // The line about what she did not change is the same, without 「タスク」 (the Minecraft request is a list she can change by voice).
    expect(voiceTranscriptInterpretationPrompt(false, 'ケーキを作って', true)).toContain('タスク');
    expect(voiceTranscriptInterpretationPrompt(false, 'ケーキを作って', true, true)).not.toContain('タスク');
    expect(voiceTranscriptInterpretationPrompt(false, 'ケーキを作って', true, true)).toContain('何をするか短く一度だけ確かめる');
  });
});
