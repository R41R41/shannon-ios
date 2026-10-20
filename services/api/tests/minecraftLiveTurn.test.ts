import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { BackgroundUpdateCoordinator } from '../src/mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../src/infra/models/chatModel.js';
import { SQLiteSurfaceTurnLog } from '../src/mind/action/respond/store/surfaceTurnStore.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { PlatformBridgeService, configuredPlatformBridge } from '../src/mind/memory/platformBridge.js';
import { PlatformPeople } from '../src/mind/memory/platformPeople.js';
import { PlatformReplyService } from '../src/surfaces/platform/platformReply.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { MinecraftLive } from '../src/surfaces/minecraft/minecraftLive.js';
import { promptOf } from './modelPrompt.js';

const OWNER = '900000000000000001';
const FRIEND = '900000000000000002';
const DM = 'discord::555';
const CHANNEL = 'discord:111:222';
const START = '2026-10-20T12:00:00.000Z';
const BINDINGS = [
  { platform: 'discord', conversationId: DM, ownerUserId: OWNER, title: 'DM', audience: 'owner-private' },
  { platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: OWNER, title: 'server' },
];
const ENVIRONMENT = { SHANNON_PLATFORM_BRIDGE_TOKEN: 'b'.repeat(40), SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner', SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify(BINDINGS) };
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

class Model implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: 'はい' };
  }
}

const observation: BodyObservation = { schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1, stateAt: START, receivedAt: START, connected: true,
  state: { world: { dimension: 'overworld', biome: 'plains', health: 17, food: 15, time: '3000', inventory: [{ name: 'stone_pickaxe', count: 1 }] } },
  facts: { alive: true, dimension: 'overworld' } };

function harness(options: { live: boolean }) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-live-turn-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  const clock = Date.parse(START);
  const now = () => new Date(clock).toISOString();
  const store = new SQLiteShannonStore({ path, now });
  const peopleStore = new SQLitePeopleMemoryStore(path);
  const background = new BackgroundUpdateCoordinator(store, store);
  const autonomyStore = new SQLiteAutonomyStore(':memory:');
  const autonomy = createInMemoryAutonomyService(now, { store: autonomyStore });
  const live = new MinecraftLive({ now: () => clock, frames: { latest: () => ({ observation, ageMs: 1000 }), available: () => ['minecraft:world'] } });
  live.begin({ taskId: 'task', scopeKey: 'owner', goal: 'エンドラを討伐してください', origin: 'owner_request', createdAtMs: clock - 130_000, bodyId: 'minecraft:world', netherReached: null });
  const marks: string[] = [];
  const reader = { block: (o: { alone: boolean }) => live.block(o), replying: (on: boolean) => { marks.push(on ? 'on' : 'off'); live.replying(on); }, heard: () => marks.push('heard') };
  const model = new Model();
  const api = createLocalApiKernel(now, { chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store, background, peopleMemory: peopleStore, autonomy,
    ...(options.live ? { minecraftLive: reader } : {}) });
  const bridge = new PlatformBridgeService(configuredPlatformBridge(ENVIRONMENT)!, store, store, background, now, new PlatformPeople(peopleStore, store), () => true);
  const turns = new SQLiteSurfaceTurnLog(path, 'platform_reply_turns');
  const service = new PlatformReplyService({ scopeKey: 'owner', bridge, conversationStore: store, conversation: api, turns, now });
  const reply = (fields: Record<string, unknown> = {}) => service.reply({ platform: 'discord', requestId: `m-${Math.random().toString(36).slice(2)}`,
    conversationId: DM, sourceUserId: OWNER, userMessage: '今なにしてるの？', observedAt: now(), ...fields });
  const close = async () => {
    await background.waitForIdle('owner');
    await new Promise(resolve => setImmediate(resolve));
    await background.waitForIdle('owner');
    turns.close(); autonomyStore.close(); peopleStore.close(); store.close();
  };
  return { reply, model, marks, close, live };
}

describe('her body\'s present in a conversation (SHANNON_MINECRAFT_LIVE)', () => {
  it('gives the owner alone in his DM the task, what runs, the step and the body', async () => {
    const f = harness({ live: true });
    f.live.activity('task', { name: 'mc.mine-block', input: { blockName: 'iron_ore' } });
    await f.reply();
    const prompt = promptOf(f.model.requests[0]!);
    expect(prompt).toContain('[マイクラの体の今]');
    expect(prompt).toContain('エンドラを討伐してください');
    expect(prompt).toContain('いましていること: 鉄鉱石を掘っている');
    expect(prompt).toContain('今の段:');
    expect(prompt).toContain('体力 17/20、満腹度 15/20');
    await f.close();
  });

  it('gives a shared channel the game\'s facts but not the request, for the owner\'s own turn and a friend\'s alike', async () => {
    const f = harness({ live: true });
    await f.reply({ conversationId: CHANNEL, conversationKind: 'channel' });
    const owner = promptOf(f.model.requests[0]!);
    expect(owner).toContain('[マイクラの体の今]');
    expect(owner).toContain('頼まれた作業の最中');
    expect(owner).not.toContain('エンドラを討伐してください');
    expect(owner).toContain('体力 17/20');
    await f.close();
  });

  it('says nothing of the body with the switch off, and marks the turn begun and ended with it on', async () => {
    const off = harness({ live: false });
    await off.reply();
    expect(promptOf(off.model.requests[0]!)).not.toContain('[マイクラの体の今]');
    await off.close();
    const on = harness({ live: true });
    await on.reply();
    expect(on.marks).toEqual(['heard', 'on', 'off']);
    expect(on.live.conversation().replying).toBe(false);
    await on.close();
  });

  it('leaves a friend\'s turn the facts of the game without the request, as the game chat does (withoutRequestTask)', async () => {
    const f = harness({ live: true });
    await f.reply({ conversationId: CHANNEL, conversationKind: 'channel', sourceUserId: FRIEND, sourceDisplayName: 'ともだち' });
    const prompt = promptOf(f.model.requests[0]!);
    expect(prompt).toContain('[マイクラの体の今]');
    expect(prompt).toContain('頼まれた作業の最中');
    expect(prompt).not.toContain('エンドラを討伐してください');
    await f.close();
  });
});
