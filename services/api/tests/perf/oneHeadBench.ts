/*
 * The one-head bench (not a test): `node --import tsx tests/perf/oneHeadBench.ts` from services/api.
 *
 * How much of the time to her first words is this process's own work, before and after one head (`SHANNON_ONE_HEAD`), for each entry:
 * the apps' voice (the stream route's delegation), Discord's voice channel (dc-voice's text turn read aloud, against the one voice turn)
 * and Discord's text. The chat model is scripted: its first word after `TTFT_MS`, then its words in pieces every `PACE_MS`, the same for
 * every way of asking it, so what differs is only what the server does. Printed per entry: `preModel` (arrival to the model call),
 * `emitLag` (from the model's first sentence end to the first sentence leaving), `first` (arrival to the first words out, model included)
 * and which way the model was asked. The router is the local rules (no Jev call), recall the deterministic one: their live costs are
 * added in the report, not here.
 *
 * TURNS=40 TTFT_MS=400 PACE_MS=20 node --import tsx tests/perf/oneHeadBench.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalApiKernel } from '../../src/wiring/apiKernelWiring.js';
import { BackgroundUpdateCoordinator } from '../../src/mind/sleep/backgroundUpdates.js';
import { SQLitePeopleMemoryStore } from '../../src/mind/memory/store/peopleMemoryStore.js';
import { PlatformBridgeService, configuredPlatformBridge } from '../../src/mind/memory/platformBridge.js';
import { PlatformPeople } from '../../src/mind/memory/platformPeople.js';
import { SQLiteSurfaceTurnLog } from '../../src/mind/action/respond/store/surfaceTurnStore.js';
import { PlatformVoiceService, type VoiceTurnLine } from '../../src/surfaces/platform/platformVoice.js';
import { PlatformReplyService } from '../../src/surfaces/platform/platformReply.js';
import { ChatSentenceSplitter, splitChatSentences } from '../../src/surfaces/text/chatSentenceSplitter.js';
import { VOICE_SENTENCE_CUT } from '../../src/surfaces/text/chatSentenceStream.js';
import { SQLiteShannonStore } from '../../src/infra/sqlite/sqliteStore.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult, ShannonVoiceModelRequest } from '../../src/infra/models/chatModel.js';

const turns = Number(process.env.TURNS ?? 40);
const ttftMs = Number(process.env.TTFT_MS ?? 400);
const paceMs = Number(process.env.PACE_MS ?? 20);
const OWNER = '900000000000000001';
const FRIEND = '900000000000000002';
const ROOM = 'discord:222:300';
const TOKEN = 'd'.repeat(40);
const BINDINGS = [{ platform: 'discord', conversationId: ROOM, ownerUserId: OWNER, title: 'ライ氏の部屋', audience: 'owner-private' }];
const BRIDGE = { SHANNON_PLATFORM_BRIDGE_TOKEN: TOKEN, SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner', SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify(BINDINGS) };
const REPLY = 'うん、いまは鉄を探しながら洞窟を下りてるところだよ。体力はまだ大丈夫だから、このまま奥まで行ってみるね。';
const FIRST_END = REPLY.indexOf('。') + 1;

/** The model: one first-word wait and one pace for every way of asking, and when it was called and reached its first sentence end. */
class TimedModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'bench-model';
  calledAt = 0;
  firstEndAt = 0;
  way = '';
  private async speak(way: string, onText: (text: string) => void | Promise<void>): Promise<ShannonChatModelResult> {
    this.calledAt = performance.now();
    this.way = way;
    await delay(ttftMs);
    for (let at = 0; at < REPLY.length; at += 4) {
      if (at < FIRST_END && at + 4 >= FIRST_END) this.firstEndAt = performance.now();
      await onText(REPLY.slice(at, at + 4));
      await delay(paceMs);
    }
    return { mode: this.mode, model: this.model, reply: REPLY };
  }
  generate(_request: ShannonChatModelRequest): Promise<ShannonChatModelResult> { return this.speak('structured', () => undefined); }
  generateStreaming(_request: ShannonChatModelRequest, onText: (text: string) => void | Promise<void>) { return this.speak('structured-stream', onText); }
  generateVoiceStreaming(_request: ShannonVoiceModelRequest, onText: (delta: string) => void | Promise<void>) { return this.speak('voice-stream', onText); }
}

interface Sample { preModel: number; emitLag: number; first: number; way: string }

function world() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-one-head-bench-'));
  const path = join(directory, 'shannon.sqlite');
  const now = () => new Date().toISOString();
  const store = new SQLiteShannonStore({ path, now });
  const peopleStore = new SQLitePeopleMemoryStore(path);
  const background = new BackgroundUpdateCoordinator(store, store);
  const model = new TimedModel();
  const api = createLocalApiKernel(now, { chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store, background, peopleMemory: peopleStore });
  const environment = { SHANNON_DC_VOICE: 'on', ...(process.env.SHANNON_ONE_HEAD ? { SHANNON_ONE_HEAD: process.env.SHANNON_ONE_HEAD } : {}) };
  const bridge = new PlatformBridgeService(configuredPlatformBridge(BRIDGE)!, store, store, background, now, new PlatformPeople(peopleStore, store), () => true,
    () => environment.SHANNON_ONE_HEAD === 'on');
  const conversation = { textTurn: api.textTurn.bind(api), seatedVoiceTurn: api.seatedVoiceTurn.bind(api) };
  const voiceTurns = new SQLiteSurfaceTurnLog(path, 'platform_voice_turns');
  const replyTurns = new SQLiteSurfaceTurnLog(path, 'platform_reply_turns');
  const voice = new PlatformVoiceService({ scopeKey: 'owner', bridge, conversationStore: store, conversation, turns: voiceTurns, now, chatModel: model,
    sentences: text => splitChatSentences(text, VOICE_SENTENCE_CUT), splitter: () => new ChatSentenceSplitter(VOICE_SENTENCE_CUT),
    environment: () => environment, log: () => undefined });
  const reply = new PlatformReplyService({ scopeKey: 'owner', bridge, conversationStore: store, conversation, turns: replyTurns, now });
  const close = async () => {
    await background.waitForIdle('owner');
    voiceTurns.close(); replyTurns.close(); peopleStore.close(); store.close();
    rmSync(directory, { recursive: true, force: true });
  };
  return { api, model, voice, reply, close };
}

async function appVoice(w: ReturnType<typeof world>, n: number): Promise<Sample> {
  const startedAt = performance.now();
  let firstOut = 0;
  await w.api.streamLiveVoiceDelegation({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', deviceId: 'bench',
    body: { scopeKey: 'owner', transcript: `ねえ、いまマイクラどうなってる？（${n}）` } }, {
    onPlan: () => undefined,
    onTextDelta: delta => { if (!firstOut && delta.includes('。')) firstOut = performance.now(); },
  });
  return { preModel: w.model.calledAt - startedAt, emitLag: firstOut - w.model.firstEndAt, first: firstOut - startedAt, way: w.model.way };
}

async function discordVoice(w: ReturnType<typeof world>, n: number, friend: boolean): Promise<Sample> {
  const startedAt = performance.now();
  let firstOut = 0;
  await w.voice.turn({ platform: 'discord', requestId: `b-${friend ? 'f' : 'o'}-${n}-${Math.random()}`, conversationId: ROOM, sourceUserId: OWNER,
    sourceDisplayName: 'ライ氏', userMessage: `シャノン、いまマイクラどうなってる？（${n}）`, observedAt: new Date().toISOString(),
    participants: friend ? [OWNER, FRIEND] : [OWNER] }, (line: VoiceTurnLine) => {
    if (!firstOut && line.type === 'sentence') firstOut = performance.now();
  });
  return { preModel: w.model.calledAt - startedAt, emitLag: firstOut - w.model.firstEndAt, first: firstOut - startedAt, way: w.model.way };
}

async function discordText(w: ReturnType<typeof world>, n: number): Promise<Sample> {
  const startedAt = performance.now();
  await w.reply.replyRequest({ platform: 'discord', requestId: `t-${n}-${Math.random()}`, conversationId: ROOM, conversationKind: 'dm',
    sourceUserId: OWNER, userMessage: `いまマイクラどうなってる？（${n}）`, observedAt: new Date().toISOString() });
  const done = performance.now();
  return { preModel: w.model.calledAt - startedAt, emitLag: 0, first: done - startedAt, way: w.model.way };
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};
const line = (label: string, samples: Sample[]) => {
  const part = (name: keyof Omit<Sample, 'way'>) => `${name} p50=${percentile(samples.map(s => s[name]), 50).toFixed(1)} p95=${percentile(samples.map(s => s[name]), 95).toFixed(1)}`;
  return `${label.padEnd(26)} ${part('preModel')}  ${part('emitLag')}  ${part('first')}  way=${[...new Set(samples.map(s => s.way))].join('/')}`;
};

/** A fresh world every chunk turns: the routes' allowances (turns a minute from the owner) are not what is measured. */
async function run(label: string, take: (w: ReturnType<typeof world>, n: number) => Promise<Sample>, chunk = 20): Promise<void> {
  const samples: Sample[] = [];
  for (let start = 0; start < turns; start += chunk) {
    const w = world();
    await take(w, -1); // warm up
    for (let n = start; n < Math.min(turns, start + chunk); n += 1) samples.push(await take(w, n));
    await w.close();
  }
  console.log(line(label, samples));
}

console.log(`one head=${process.env.SHANNON_ONE_HEAD ?? 'off'} turns=${turns} ttft=${ttftMs}ms pace=${paceMs}ms (ms; model included only in first)`);
await run('apps voice', appVoice);
await run('discord voice, owner alone', (w, n) => discordVoice(w, n, false));
await run('discord voice, with friend', (w, n) => discordVoice(w, n, true));
await run('discord text (owner DM)', discordText, 5);
