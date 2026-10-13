/**
 * Syzygy ADR-0011 §11 slice 11: does the vision worker leave the API's event loop alone? A synthetic harness, no model and no
 * camera: the "API" process runs the real vision bridge socket and an HTTP route that stands in for a turn's first response
 * (a JSON body parsed and a small synchronous assembly), and measures its event-loop delay and the route's latency while a load
 * generator asks it 20 times a second. It runs twice: before (no worker), and after (the real vision worker in a child process,
 * a fake Decisions answer of 250 ms, and four devices each posting a synthetic 40 KB JPEG every 2 s, the most the worker accepts).
 *
 *   node --import tsx services/api/scripts/visionEventLoopCheck.ts [seconds]
 */
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { SQLiteDeviceAuthStore } from '../src/infra/auth/deviceAuth.js';
import { configuredVisionBridge } from '../src/wiring/visionBridgeWiring.js';

const PEPPER = 'synthetic-vision-pepper-longer-than-32-characters';
const seconds = Number(process.argv[2] ?? 20);
const values = { SHANNON_VISION_WORKER: 'on', SHANNON_VISION_CAMERA: 'on', SHANNON_AUTH_PEPPER: PEPPER, SHANNON_VISION_PORT: '0' };

if (process.env.VISION_CHECK_CHILD) {
  // The worker process: the real worker with a Decisions stand-in that answers after 250 ms.
  const { configuredVisionWorker } = await import('../src/wiring/visionWorkerWiring.js');
  const decisions = { decide: async () => {
    await new Promise(resolve => setTimeout(resolve, 250));
    return { predicate: 0.1, choice: { id: 'quiet', confidence: 0.9, probabilities: [] }, refused: false,
      usage: { usageComplete: true, inputTokens: 602, estimatedCostUsd: 0.00006 }, elapsedMs: 250 };
  } };
  const worker = await configuredVisionWorker(values, process.env.VISION_CHECK_DB!, { port: 0, decisions });
  process.send?.({ port: worker.port });
  process.on('message', async () => { await worker.close(); process.exit(0); });
} else {
  await main();
}

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]! * 10) / 10;
}

function syntheticJpeg(size: number): Buffer {
  const bytes = Buffer.alloc(size, 0x5a);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
}

async function phase(label: string, withWorker: boolean, databasePath: string, tokens: string[]) {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  const api = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { history: string[] };
      const assembled = body.history.map(line => line.split('').reverse().join('')).join('\n');
      response.end(JSON.stringify({ length: assembled.length }));
    });
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', () => resolve()));
  const port = (api.address() as { port: number }).port;
  let child: ReturnType<typeof fork> | null = null;
  let workerPort = 0;
  if (withWorker) {
    child = fork(new URL(import.meta.url).pathname, [], { env: { ...process.env, VISION_CHECK_CHILD: '1', VISION_CHECK_DB: databasePath }, execArgv: ['--import', 'tsx'] });
    workerPort = await new Promise<number>(resolve => child!.once('message', message => resolve((message as { port: number }).port)));
  }
  histogram.enable();
  const latencies: number[] = [];
  const frameCodes: Record<string, number> = {};
  const history = Array.from({ length: 40 }, (_, index) => `turn ${index} `.repeat(30));
  const until = Date.now() + seconds * 1_000;
  const timers: NodeJS.Timeout[] = [];
  timers.push(setInterval(() => {
    const started = performance.now();
    void fetch(`http://127.0.0.1:${port}/first-response`, { method: 'POST', body: JSON.stringify({ history }) })
      .then(response => response.text()).then(() => { latencies.push(performance.now() - started); });
  }, 50));
  if (withWorker) {
    tokens.forEach((token, device) => {
      const generation = 1;
      timers.push(setInterval(() => {
        const bytes = syntheticJpeg(40_000);
        const meta = { schema: 'vision.frame.v1', frameId: `frame-${device}-${Date.now()}`, capturedAt: new Date().toISOString(), receivedAt: null,
          source: { kind: 'app_camera', bodyId: null, deviceId: null }, sessionId: `watch-${device}`, generation, privacy: 'owner_private',
          audienceAtCapture: 'owner_alone', ttlMs: 4_000, encoding: { width: 512, height: 384, format: 'jpeg', byteLength: bytes.length },
          gate: { reason: 'difference', difference: 0.3, personCount: 1 }, state: null };
        void fetch(`http://127.0.0.1:${workerPort}/v1/vision/frames`, { method: 'POST', body: bytes,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg', 'x-shannon-vision-frame': JSON.stringify(meta) } })
          .then(response => { frameCodes[response.status] = (frameCodes[response.status] ?? 0) + 1; return response.text(); }).catch(() => undefined);
      }, 2_050));
    });
  }
  await new Promise(resolve => setTimeout(resolve, Math.max(0, until - Date.now())));
  timers.forEach(clearInterval);
  histogram.disable();
  await new Promise(resolve => setTimeout(resolve, 500));
  if (child) {
    child.send('stop');
    await new Promise(resolve => child!.once('exit', resolve));
  }
  await new Promise<void>(resolve => api.close(() => resolve()));
  return { label, requests: latencies.length, firstResponseP50Ms: percentile(latencies, 0.5), firstResponseP95Ms: percentile(latencies, 0.95),
    loopDelayP50Ms: Math.round(histogram.percentile(50) / 1e4) / 100, loopDelayP99Ms: Math.round(histogram.percentile(99) / 1e4) / 100,
    loopDelayMaxMs: Math.round(histogram.max / 1e4) / 100, frames: frameCodes };
}

async function main() {
  const directory = mkdtempSync(join(tmpdir(), 'svl-'));
  const databasePath = join(directory, 'state.db');
  const auth = new SQLiteDeviceAuthStore({ path: databasePath, pepper: PEPPER });
  const tokens = [0, 1, 2, 3].map(() => auth.pair(auth.issuePairingCode('owner').code)!.token);
  auth.close();
  const percepts: number[] = [];
  const bridge = await configuredVisionBridge(values, { databasePath, ownerScope: 'owner', now: Date.now, presence: () => 'alone',
    perceiver: { perceive: () => { percepts.push(1); return null; } }, log: () => undefined, usage: { recordLlmUsage: () => undefined },
    conversations: { listThreads: () => [], threadId: () => 'thread', recentMessages: () => [], appendNoteOnce: () => null } });
  try {
    const before = await phase('before (no vision worker)', false, databasePath, tokens);
    const after = await phase('after (vision worker, 4 devices at the accepted rate)', true, databasePath, tokens);
    console.log(JSON.stringify({ seconds, before, after }, null, 1));
  } finally {
    await bridge?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
