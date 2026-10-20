import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import type { MinecraftControlPoll } from '../src/contracts/minecraftControlContract.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../src/infra/models/chatModel.js';
import { configuredPlatformBridge, platformBridgeThreadId } from '../src/mind/memory/platformBridge.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { configuredMinecraftLive, minecraftLiveEnabled, minecraftLiveSpeechEnabled } from '../src/wiring/minecraftLiveWiring.js';
import { createMinecraftBodyWiring } from '../src/wiring/serverMinecraftBodyWiring.js';
import type { CompanionStateSnapshot } from '@shannon/cognition';

const BRIDGE = configuredPlatformBridge({ SHANNON_PLATFORM_BRIDGE_TOKEN: 'b'.repeat(40), SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner',
  SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify([{ platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: '900000000000000001', title: 'server' },
    { platform: 'discord', conversationId: 'discord::555', ownerUserId: '900000000000000001', title: 'DM', audience: 'owner-private' }]) })!;
const ON = { SHANNON_MINECRAFT_LIVE: 'on', SHANNON_MINECRAFT_LIVE_SPEECH: 'on' };

class Model implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  reply = 'ダイヤ見つけた！';
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: this.reply };
  }
}

describe('the switches', () => {
  it('are off unless said on, and speech needs the view', () => {
    expect(minecraftLiveEnabled({})).toBe(false);
    expect(minecraftLiveEnabled({ SHANNON_MINECRAFT_LIVE: 'on' })).toBe(true);
    expect(minecraftLiveEnabled({ SHANNON_MINECRAFT_LIVE: 'true' })).toBe(false);
    expect(minecraftLiveSpeechEnabled({ SHANNON_MINECRAFT_LIVE_SPEECH: 'on' })).toBe(false);
    expect(minecraftLiveSpeechEnabled(ON)).toBe(true);
    expect(configuredMinecraftLive({})).toBeNull();
    expect(createMinecraftBodyWiring({}, ':memory:').live).toBeNull();
  });
});

describe('the wiring, end to end through the control', () => {
  const databases: DatabaseSync[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    databases.splice(0).forEach(db => db.close());
  });

  function setup(environment: Record<string, string>) {
    const db = new DatabaseSync(':memory:');
    databases.push(db);
    const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot',
      servers: [{ serverId: 'world', title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
    const control = new MinecraftControl(new MinecraftControlStore(db), configuration, { now: Date.now, leaseValid: () => true, leaseKnown: () => true, ownerAlone: () => true });
    const wiring = configuredMinecraftLive(environment)!;
    wiring.connectControl(control);
    const notes: Array<{ thread: string; id: string; text: string; kind: string; alone?: boolean }> = [];
    const store = { snapshot: () => ({}) as CompanionStateSnapshot,
      appendNoteOnce: (_scope: string, thread: string, id: string, text: string, _at: string, kind: string, alone?: boolean) => {
        notes.push({ thread, id, text, kind, ...(alone === undefined ? {} : { alone }) });
        return {} as never;
      } };
    const model = new Model();
    let sequence = 0;
    const scope = { scopeKey: 'owner', deviceId: 'minebot' };
    const poll = (world: Record<string, unknown>, patch: Partial<MinecraftControlPoll> = {}) => control.poll(scope, { schemaVersion: 1, serverId: 'world', connectionId: 'connection',
      observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: new Date().toISOString(), receivedAt: new Date().toISOString(), connected: true,
        state: { world: { dimension: 'overworld', health: 20, food: 20, time: '3000', inventory: [], ...world } }, facts: { alive: true, dimension: 'overworld' } },
      skills: [], candidates: [], receipts: [], activeOperationIds: [], liveRoom: { voice: false, humanSpeaking: false, sinceHumanMs: null }, ...patch });
    return { wiring, control, model, notes, store, poll };
  }

  it('hears a diamond in a frame, writes her line with her model, hands it in a reply, and keeps it in the thread once the body has posted it', async () => {
    const f = setup(ON);
    expect(f.control.speech).toBe(f.wiring.outbox);
    const commentary = f.wiring.startCommentary({ scopeKey: 'owner', model: f.model, store: f.store, bridge: BRIDGE })!;
    expect(commentary).not.toBeNull();
    expect(f.wiring.startCommentary({ scopeKey: 'owner', model: f.model, store: f.store, bridge: BRIDGE })).toBe(commentary);
    f.poll({});
    await vi.advanceTimersByTimeAsync(500);
    f.poll({ inventory: [{ name: 'diamond', count: 3 }] });
    await vi.advanceTimersByTimeAsync(50);
    expect(f.model.requests).toHaveLength(1);
    const system = f.model.requests[0]!.systemPrompt;
    expect(system).toContain('[実況の一言]');
    expect(system).toContain('[マイクラの体の今]');
    expect(system).toContain('ダイヤモンドを手に入れた（3個）。');
    expect(system).not.toContain('頼まれた作業の最中（中身');
    const reply = f.poll({});
    expect(reply.speech).toHaveLength(1);
    expect(reply.speech![0]).toMatchObject({ text: 'ダイヤ見つけた！', kind: 'diamond_found', urgency: 'ordinary' });
    const line = reply.speech![0]!;
    f.poll({}, { speechReceipts: [{ id: line.id, outcome: 'posted', conversationId: 'discord:111:222' }] });
    expect(f.notes).toEqual([{ thread: platformBridgeThreadId('discord', 'discord:111:222'), id: `live:${line.id}`, text: 'ダイヤ見つけた！', kind: 'minecraft-live', alone: false }]);
    expect(commentary.governor.recentWords()).toEqual(['ダイヤ見つけた！']);
    f.wiring.stop();
  });

  it('keeps a line in the owner-private conversation as the owner alone\'s, and nothing for a spoken one or an unbound conversation', async () => {
    const f = setup(ON);
    f.wiring.startCommentary({ scopeKey: 'owner', model: f.model, store: f.store, bridge: BRIDGE });
    f.poll({});
    await vi.advanceTimersByTimeAsync(500);
    f.poll({ inventory: [{ name: 'diamond', count: 1 }] });
    await vi.advanceTimersByTimeAsync(50);
    const line = f.poll({}).speech![0]!;
    f.poll({}, { speechReceipts: [{ id: line.id, outcome: 'posted', conversationId: 'discord::555' }] });
    expect(f.notes.map(note => note.alone)).toEqual([true]);
    await vi.advanceTimersByTimeAsync(30_000);
    // A line that says what the last one said is not said again (the model's second answer is a new one).
    f.model.reply = '防具ぜんぶそろった';
    f.poll({ inventory: [{ name: 'diamond', count: 1 }, { name: 'iron_pickaxe', count: 1 }, { name: 'iron_helmet' }, { name: 'iron_chestplate' }, { name: 'iron_leggings' }, { name: 'iron_boots' }] });
    await vi.advanceTimersByTimeAsync(50);
    const second = f.poll({}).speech?.[0];
    expect(second).toBeDefined();
    f.poll({}, { speechReceipts: [{ id: second!.id, outcome: 'spoken' }] });
    expect(f.notes).toHaveLength(1);
    f.wiring.stop();
  });

  it('with only the view on, the block is made and the moments are heard, but nothing is written and the reply carries no line', async () => {
    const f = setup({ SHANNON_MINECRAFT_LIVE: 'on' });
    expect(f.control.speech).toBeNull();
    expect(f.wiring.startCommentary({ scopeKey: 'owner', model: f.model, store: f.store })).toBeNull();
    f.poll({});
    await vi.advanceTimersByTimeAsync(500);
    f.poll({ inventory: [{ name: 'diamond', count: 3 }], health: 17 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.model.requests).toEqual([]);
    expect(f.poll({ health: 17 }).speech).toBeUndefined();
    expect(f.wiring.live.recentMoments().map(moment => moment.kind)).toEqual(['diamond_found']);
    expect(f.wiring.live.block({ alone: true })).toContain('体力 17/20');
  });

  it('writes nothing when the model gives no line, and drops a line with a coordinate in it', async () => {
    const f = setup(ON);
    const commentary = f.wiring.startCommentary({ scopeKey: 'owner', model: f.model, store: f.store, bridge: BRIDGE })!;
    f.model.reply = 'ここは 120, 64, -30 だよ';
    f.poll({});
    await vi.advanceTimersByTimeAsync(500);
    f.poll({ inventory: [{ name: 'diamond', count: 3 }] });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.model.requests).toHaveLength(1);
    expect(f.poll({}).speech).toBeUndefined();
    f.wiring.stop();
  });
});
