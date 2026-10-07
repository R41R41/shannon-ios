import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ShannonApiKernel } from '../../src/infra/http/apiKernel.js';
import { createLocalApiKernel } from '../../src/wiring/apiKernelWiring.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../../src/infra/models/chatModel.js';
import { SQLiteShannonStore } from '../../src/infra/sqlite/sqliteStore.js';
import { SQLiteBodyStore } from '../../src/surfaces/body/store/bodyStore.js';
import { SQLiteBodyReactionStore } from '../../src/surfaces/body/store/bodyReactionStore.js';
import { configuredMind } from '../../src/wiring/mindWiring.js';
import { BackgroundUpdateCoordinator } from '../../src/mind/sleep/backgroundUpdates.js';
import { SQLiteMinecraftTurnLog } from '../../src/mind/action/respond/store/surfaceTurnStore.js';
import { MinecraftBody } from '../../src/surfaces/minecraft/minecraftBody.js';
import { configuredMinecraftBody } from '../../src/contracts/minecraftBodyContract.js';
import { SQLitePeopleMemoryStore } from '../../src/mind/memory/store/peopleMemoryStore.js';

/**
 * A small world for the tests of Syzygy ADR-0008 stage 3's workspace: one database, the API kernel with the production wiring of
 * the mind (`configuredMind`) built from an environment, her body registered, a model that keeps every request, and a clock.
 * `restart()` drops the process (the kernel and the mind) and starts a new one on the same database, as a deployment would.
 */
export const MIND_WORLD_START = '2026-10-07T03:00:00.000Z';

export function mindWorld(environment: Readonly<Record<string, string | undefined>> = {}, name = 'mind') {
  const directory = mkdtempSync(join(tmpdir(), `shannon-${name}-`));
  const path = join(directory, 'shannon.sqlite');
  const clock = { at: Date.parse(MIND_WORLD_START) };
  const now = () => new Date(clock.at).toISOString();
  const store = new SQLiteShannonStore({ path, now });
  const bodyStore = new SQLiteBodyStore(path);
  const reactionStore = new SQLiteBodyReactionStore(path);
  const requests: ShannonChatModelRequest[] = [];
  const answer = async (request: ShannonChatModelRequest) => { requests.push(request); return { reply: 'はい。', mode: 'openai' as const, model: 'test' }; };
  const chatModel = { mode: 'openai', model: 'test', generate: answer, generateVoice: answer } as unknown as ShannonChatModel;
  const logs: string[] = [];
  let mind = configuredMind(environment, { databasePath: path, now, schedule: task => task(), log: line => logs.push(line) });
  const build = (): ShannonApiKernel => createLocalApiKernel(now, {
    chatModel, stateStore: store, conversationStore: store, knowledgeStore: store, ...(mind ? { mind: mind.mind } : {}),
    body: { store: bodyStore, ingestEnabled: true, reactions: { store: reactionStore, speaker: null, config: {}, experiences: null } },
  });
  let api = build();
  // Her Minecraft body on a test server, for someone else's words in a game chat (the surface whose words reach a frame).
  const OWNER_UUID = 'b9191317-c52d-4d67-85fe-ab831e6db146';
  const minecraftTurns = new SQLiteMinecraftTurnLog(path);
  const minecraftPeople = new SQLitePeopleMemoryStore(path);
  const minecraftBackground = new BackgroundUpdateCoordinator(store, store);
  let minecraftRequest = 0;
  const minecraft = () => new MinecraftBody({
    configuration: configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot-dev', servers: [
      { serverId: 'lab-qywEbW', ownerUuid: OWNER_UUID, title: 'マイクラ実験ワールド', onlineMode: true }] }) })!,
    stateStore: store, conversationStore: store, background: minecraftBackground, now, chatModel, turns: minecraftTurns,
    conversation: { textTurn: input => api.textTurn(input) }, peopleStore: minecraftPeople, peopleEnabled: () => true,
  });
  const world = {
    path, store, requests, logs, now,
    get api() { return api; },
    get mind() { return mind; },
    advance(milliseconds: number) { clock.at += milliseconds; },
    async registerBody(deviceId = 'body-pc') {
      await api.dispatch({ method: 'PUT', path: '/v1/body/capabilities', body: { scopeKey: 'owner', expressions: ['smile'], gestures: [], flags: {} }, deviceId });
    },
    async chat(message: string, extra: Record<string, unknown> = {}) {
      const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message, ...extra } });
      await api.waitForBackground('owner');
      return response;
    },
    async speak(transcript: string, extra: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
      const response = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: {
        scopeKey: 'owner', threadId: 'thread-voice', transcript, ...body,
        deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null, ...extra,
          userUtterance: { id: `u-${clock.at}`, text: transcript, source: 'speech', rawText: transcript } },
      } });
      await api.waitForBackground('owner');
      return response;
    },
    /** A friend's words in her Minecraft body's shared game chat (someone else's words, untrusted). */
    async friendInGame(message: string, name = 'Mina_77') {
      minecraftRequest += 1;
      const result = await minecraft().turn('owner', 'minebot-dev', { requestId: `mc-${minecraftRequest}`, serverId: 'lab-qywEbW', conversation: { kind: 'channel' },
        observedAt: now(), speaker: { uuid: '0f6a8c52-1b2d-4e3f-9a8b-7c6d5e4f3a2b', name }, message });
      await api.waitForBackground('owner');
      await minecraftBackground.waitForIdle('owner');
      return result;
    },
    async touch(id: string, type = 'pet', audience: 'owner' | 'others' = 'owner', deviceId = 'body-pc') {
      return api.dispatch({ method: 'POST', path: '/v1/body/reactions', body: { scopeKey: 'owner', id, touch: { type, durationMs: 1_500, ongoing: false }, audience, occurredAt: now() }, deviceId });
    },
    /** The turn's context the model was last given (the developer message after the history). */
    lastContext(): string { return requests.at(-1)?.turnContext ?? ''; },
    /** A deployment: the mind writes what it has and snapshots on SIGTERM, and a new process restores it from the same database. */
    restart(next: Readonly<Record<string, string | undefined>> = environment) {
      mind?.close();
      mind = configuredMind(next, { databasePath: path, now, schedule: task => task(), log: line => logs.push(line) });
      api = build();
    },
    async close() {
      await api.waitForBackground('owner');
      for (let tick = 0; tick < 3; tick += 1) await new Promise(resolve => setImmediate(resolve));
      await minecraftBackground.waitForIdle('owner');
      mind?.close();
      minecraftTurns.close(); minecraftPeople.close(); reactionStore.close(); bodyStore.close(); store.close();
    },
  };
  return world;
}
