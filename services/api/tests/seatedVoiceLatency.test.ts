import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { BackgroundUpdateCoordinator } from '../src/mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { SQLiteSurfaceTurnLog } from '../src/mind/action/respond/store/surfaceTurnStore.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { PlatformBridgeService, configuredPlatformBridge } from '../src/mind/memory/platformBridge.js';
import { PlatformPeople } from '../src/mind/memory/platformPeople.js';
import { PlatformVoiceService, type VoiceTurnLine } from '../src/surfaces/platform/platformVoice.js';
import { ChatSentenceSplitter, splitChatSentences } from '../src/surfaces/text/chatSentenceSplitter.js';
import { VOICE_SENTENCE_CUT } from '../src/surfaces/text/chatSentenceStream.js';
import { oneHeadEnabled } from '../src/contracts/oneHeadContract.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import type { VoiceMinecraftPort } from '../src/surfaces/platform/voiceMinecraftPort.js';
import { claudeTextBody } from '../src/infra/models/anthropic/anthropicRequest.js';
import { sonnetSettings } from '../src/infra/models/anthropic/anthropicConfig.js';

/** The seated voice turn of a shared Discord channel: what it asks the model, how it is asked, and how big the request is. */
const OWNER = '900000000000000001';
const SERVER_ROOM = 'discord:111:222';
const START = '2026-10-20T12:00:00.000Z';
const BRIDGE = { SHANNON_PLATFORM_BRIDGE_TOKEN: 'c'.repeat(40), SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner',
  SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify([{ platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: OWNER, title: 'テストサーバー' }]) };
const ENV = { SHANNON_DC_VOICE: 'on', SHANNON_ONE_HEAD: 'on' };
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

class Model implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  readonly kinds: string[] = [];
  private result(): ShannonChatModelResult { return { mode: this.mode, model: this.model, reply: 'うん、いいよ。' }; }
  async generate(request: ShannonChatModelRequest) { this.requests.push(request); this.kinds.push('generate'); return this.result(); }
  async generateStreaming(request: ShannonChatModelRequest, onText: (text: string) => void | Promise<void>) {
    this.requests.push(request); this.kinds.push('structured-stream'); await onText('うん、いいよ。'); return this.result();
  }
  async generateVoiceStreaming(request: ShannonVoiceModelRequest, onText: (text: string) => void | Promise<void>) {
    this.requests.push(request); this.kinds.push('voice-stream'); await onText('うん、いいよ。'); return this.result();
  }
}

async function seatedTurn(): Promise<{ model: Model; lines: VoiceTurnLine[]; close: () => Promise<void> }> {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-seated-latency-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  const now = () => START;
  const store = new SQLiteShannonStore({ path, now });
  const peopleStore = new SQLitePeopleMemoryStore(path);
  const background = new BackgroundUpdateCoordinator(store, store);
  const model = new Model();
  const api = createLocalApiKernel(now, { chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store, background, peopleMemory: peopleStore });
  const bridge = new PlatformBridgeService(configuredPlatformBridge(BRIDGE)!, store, store, background, now, new PlatformPeople(peopleStore, store),
    () => true, () => oneHeadEnabled(ENV));
  const turns = new SQLiteSurfaceTurnLog(path, 'platform_voice_turns');
  const body: VoiceMinecraftPort = { state: () => ({ connected: true, running: null }), intent: async () => ({ delivered: true, as: 'message' as const }) };
  const voice = new PlatformVoiceService({
    scopeKey: 'owner', bridge, conversationStore: store, conversation: { textTurn: api.textTurn.bind(api), seatedVoiceTurn: api.seatedVoiceTurn.bind(api) },
    turns, now, chatModel: model, minecraft: () => body,
    sentences: text => splitChatSentences(text, VOICE_SENTENCE_CUT), splitter: () => new ChatSentenceSplitter(VOICE_SENTENCE_CUT),
    environment: () => ENV, log: () => undefined,
  });
  const lines: VoiceTurnLine[] = [];
  await voice.turn({ platform: 'discord', requestId: 'v-1', conversationId: SERVER_ROOM, voiceChannelId: '700', sourceUserId: OWNER, sourceDisplayName: 'ライ氏',
    userMessage: 'シャノン、聞こえる？', observedAt: START, participants: [OWNER] }, line => lines.push(line));
  return { model, lines, close: async () => { await background.waitForIdle('owner'); await new Promise(resolve => setImmediate(resolve)); turns.close(); peopleStore.close(); store.close(); } };
}

describe('a seated voice turn of a shared channel', () => {
  it('asks for the structured stream without thinking first, and the Sonnet request then thinks only between tools', async () => {
    const { model, close } = await seatedTurn();
    expect(model.kinds).toEqual(['structured-stream']);
    const request = model.requests[0] as ShannonChatModelRequest;
    expect(request.skipThinking).toBe(true);
    expect(claudeTextBody({ ...sonnetSettings({}), model: 'claude-sonnet-5-5' }, request, undefined).thinking).toEqual({ type: 'between_tools' });
    await close();
  });

  it('reports the size of the request it sends (characters of each part)', async () => {
    const { model, close } = await seatedTurn();
    const request = model.requests[0] as ShannonChatModelRequest;
    const body = claudeTextBody({ ...sonnetSettings({}), model: 'claude-sonnet-5-5' }, request, undefined);
    const sizes = { system: JSON.stringify(body.system).length, tools: JSON.stringify(body.tools ?? []).length, schema: JSON.stringify(body.output_config).length,
      messages: JSON.stringify(body.messages).length, turnContext: request.turnContext?.length ?? 0, history: request.history.length };
    const total = Object.values(sizes).reduce((sum, value, index) => (index < 4 ? sum + value : sum), 0);
    console.info(`seated voice request size ${JSON.stringify({ ...sizes, total })}`);
    expect(total).toBeGreaterThan(0);
    await close();
  });
});
