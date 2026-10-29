import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createInitialCompanionState, type CompanionStateSnapshot } from '@shannon/cognition';
import { AnthropicChatModel } from '../../src/infra/models/anthropic/anthropicChatModel.js';
import { anthropicApiKey, sonnetSettings } from '../../src/infra/models/anthropic/anthropicConfig.js';
import type { ShannonChatModel } from '../../src/infra/models/chatModelContract.js';
import type { LlmUsageEvent, LlmUsageStore } from '../../src/infra/models/llmUsage.js';
import { createConfiguredChatModel } from '../../src/infra/models/openAIChatModel.js';
import { configuredJevChooser } from '../../src/wiring/skillRoutingWiring.js';
import { composedFeeling } from '../../src/wiring/feelingWiring.js';
import { feelingBody } from '../../src/mind/emotion/feelingPorts.js';
import { handlePlatformBridgeRequest, isPlatformBridgePath, type PlatformBridgeRouteDependencies } from '../../src/surfaces/platform/serverPlatformBridgeRoute.js';
import { configuredStream, type ConfiguredStream, type StreamWiringParts } from '../../src/wiring/streamWiring.js';
import { RecordingModel, type ModelCall, type ScaledClock } from './benchParts.js';
import { fakeAuxiliaryModel, fakeJev, fakeWriterModel } from './fakeModels.js';

/**
 * The head of the stream bench: the stream place and its real HTTP routes (the desktop's and the ear's), without the rest of the server.
 * The owner's private matters are seeded where a leak would come from (his feeling events, his state's memories and facts) and the leak check
 * reads every request any model was given and every line that was said.
 */
export const BENCH_TOKEN = 'stream-bench-bridge-token-0123456789abcdef';
export const OWNER_SCOPE = 'owner';
/** Seeded owner-private facts and markers: none of them may appear in any prompt, message or line. */
export const PRIVATE_MARKERS = ['ザクロ荘203号室', '山田太郎', '【機微】ライ氏の住所は', '秘密の恋人', 'ライ氏の本名は山田太郎'] as const;

export interface UsageTap extends LlmUsageStore { events: LlmUsageEvent[] }

export function usageTap(): UsageTap {
  const events: LlmUsageEvent[] = [];
  return { events, recordLlmUsage: event => { events.push(event); }, backgroundLlmCostUsd: () => 0 };
}

export interface BenchHeadOptions {
  clock: ScaledClock;
  models: 'fake' | 'real';
  /** Virtual milliseconds a fake model thinks. */
  fakeLatencyMilliseconds: number;
  /** Real models: stop calling after this many (the cost's limit). */
  maxModelCalls?: number;
  log?: (line: string) => void;
  live?: StreamWiringParts['live'];
}

function seededSnapshot(scopeKey: string, at: string): CompanionStateSnapshot {
  return {
    ...createInitialCompanionState(scopeKey, at), interests: [PRIVATE_MARKERS[0]],
    userFacts: [{ id: 'f1', text: PRIVATE_MARKERS[2], key: PRIVATE_MARKERS[4] }] as never, activeMemories: [{ id: 'm1', text: PRIVATE_MARKERS[1] }] as never,
    relationships: [{ id: 'r1', text: PRIVATE_MARKERS[3] }] as never,
  };
}

/** The feeling port with the owner's own days in it (his touches, the day before). */
function seededFeeling(clock: ScaledClock) {
  const database = new DatabaseSync(':memory:');
  const { port } = composedFeeling({ database, now: () => new Date(clock.now()).toISOString(), timeZone: 'Asia/Tokyo', chooser: null, turn: true, check: true,
    singleFace: false, days: { relationship: true, episodes: true, boundaries: true }, audience: true, stream: true });
  for (const minute of [0, 1, 2, 3]) {
    feelingBody.touched(port, OWNER_SCOPE, { id: `o${minute}`, type: 'poke', part: 'chest', audience: 'owner',
      occurredAt: new Date(clock.epochMs - 86_400_000 + minute * 60_000).toISOString(), burstId: `b${minute}` }, minute === 1 ? { stance: 'dislike' } : {});
  }
  return port;
}

function realModels(usage: UsageTap, clock: ScaledClock): { writer: ShannonChatModel; auxiliary: ShannonChatModel } {
  const apiKey = anthropicApiKey(process.env);
  if (!apiKey) throw new Error('SHANNON_ANTHROPIC_API_KEY is not set (--models=real needs it)');
  const writer = new AnthropicChatModel({ apiKey, settings: sonnetSettings(process.env), cachePlan: true, voiceCachePlan: true, usageStore: usage,
    now: () => new Date(clock.now()).toISOString() });
  return { writer, auxiliary: createConfiguredChatModel(process.env, usage) };
}

export async function startBenchHead(options: BenchHeadOptions) {
  const { clock } = options;
  const calls: ModelCall[] = [];
  const usage = usageTap();
  const limit = options.maxModelCalls ? { calls: options.maxModelCalls, used: 0 } : null;
  const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, clock.real(milliseconds)));
  const base = options.models === 'real'
    ? realModels(usage, clock)
    : { writer: fakeWriterModel({ latencyMilliseconds: options.fakeLatencyMilliseconds, sleep }), auxiliary: fakeAuxiliaryModel({ latencyMilliseconds: 800, sleep }) };
  const jevCalls = { count: 0 };
  const realJev = options.models === 'real' ? configuredJevChooser(process.env, { trace: null }) : null;
  if (options.models === 'real' && !realJev) options.log?.('TYPESAFE_API_KEY is not set: the gate falls back to the words');
  const jev = realJev ?? fakeJev({ calls: jevCalls });
  const trackedJev = { decide: ((request: Parameters<typeof jev.decide>[0]) => clock.track(() => (jev.decide as (r: unknown) => Promise<never>)(request))) as typeof jev.decide };
  const feeling = seededFeeling(clock);
  const stream: ConfiguredStream = configuredStream({
    scopeKey: OWNER_SCOPE, now: () => clock.now(), feeling, snapshot: scopeKey => seededSnapshot(scopeKey, new Date(clock.epochMs).toISOString()),
    model: new RecordingModel(base.writer, 'writer', calls, clock, limit), auxiliary: new RecordingModel(base.auxiliary, 'auxiliary', calls, clock, limit),
    jev: realJev || options.models === 'fake' ? trackedJev as never : null, tickMilliseconds: Math.max(5, Math.round(clock.real(500))),
    ...(options.log ? { log: options.log } : {}), ...(options.live ? { live: options.live } : {}),
  });
  const bridge = { configuration: { token: BENCH_TOKEN }, stream: stream.bridge } as unknown as PlatformBridgeRouteDependencies;
  const principal = { deviceId: 'bench-desktop', scopeKey: OWNER_SCOPE, displayName: 'bench' };
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (isPlatformBridgePath(url.pathname)) return handlePlatformBridgeRequest(url.pathname, request, response, bridge);
    if (!(await stream.serve(request, response, principal, url))) { response.writeHead(404); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, stream, calls, usage, jevCalls, realJev: realJev !== null,
    close: async () => { stream.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
export type BenchHead = Awaited<ReturnType<typeof startBenchHead>>;
