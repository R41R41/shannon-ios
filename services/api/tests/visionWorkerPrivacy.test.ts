import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MindEvent } from '@shannon/mind';
import { VISION_FRAME_HEADER } from '../src/contracts/visionContract.js';
import { SQLiteDeviceAuthStore } from '../src/infra/auth/deviceAuth.js';
import { startObserverPublisher } from '../src/infra/observer/store/observerStore.js';
import { configuredVisionBridge } from '../src/wiring/visionBridgeWiring.js';
import { configuredVisionWorker } from '../src/wiring/visionWorkerWiring.js';
import { FRAME_MARKER, FakeDecisions, answer, frameMeta, syntheticJpeg } from './support/visionWorld.js';

// Syzygy ADR-0011 absolute rule: camera images are never saved, not to the DB, logs, error reports or the Observer. The worker and
// the API's bridge run as they do in production (a loopback HTTP listener, the owner-only socket, the shared SQLite file, the
// Observer's sidecar file), a synthetic frame with a marker goes through them, and every sink is scanned for the marker and the
// frame's base64.
const PEPPER = 'synthetic-vision-pepper-longer-than-32-characters';
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function filesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    const stat = statSync(path);
    return stat.isDirectory() ? filesBelow(path) : stat.isFile() ? [path] : [];
  });
}

async function world(presence: () => 'alone' | 'others' | 'unknown' = () => 'alone') {
  const directory = mkdtempSync(join(tmpdir(), 'svw-'));
  directories.push(directory);
  const databasePath = join(directory, 'state.db');
  const values = { SHANNON_VISION_WORKER: 'on', SHANNON_VISION_CAMERA: 'on', SHANNON_VISION_ESCALATE: 'on', SHANNON_AUTH_PEPPER: PEPPER };
  const auth = new SQLiteDeviceAuthStore({ path: databasePath, pepper: PEPPER });
  const owner = auth.pair(auth.issuePairingCode('owner').code)!;
  const other = auth.pair(auth.issuePairingCode('someone-else').code)!;
  auth.close();
  const perceived: MindEvent[] = [];
  const notes: string[] = [];
  const logs: string[] = [];
  for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation((...args) => { logs.push(args.map(String).join(' ')); });
  const observer = startObserverPublisher(databasePath);
  const bridge = await configuredVisionBridge(values, {
    databasePath, ownerScope: 'owner', now: Date.now, presence, log: line => logs.push(line),
    perceiver: { perceive: (_scope, event) => { if (event) perceived.push(event); return null; } },
    conversations: { listThreads: () => [{ threadId: 'thread-1' }], threadId: () => 'thread-1', recentMessages: () => [],
      appendNoteOnce: (_scope, _thread, _id, content) => { notes.push(content); return null; } },
    usage: { recordLlmUsage: () => undefined },
  });
  const decisions = new FakeDecisions();
  const worker = await configuredVisionWorker(values, databasePath, { port: 0, decisions, log: line => logs.push(line) });
  const post = (token: string, bytes: Uint8Array, meta = frameMeta(bytes, Date.now(), { source: { kind: 'app_camera', bodyId: null, deviceId: null } })) =>
    fetch(`http://127.0.0.1:${worker.port}/v1/vision/frames`, {
      method: 'POST', body: Buffer.from(bytes),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg', [VISION_FRAME_HEADER]: JSON.stringify(meta) },
    });
  const close = async () => { await worker.close(); await bridge?.close(); observer?.close(); };
  return { directory, owner, other, decisions, perceived, notes, logs, post, worker, close };
}

describe('vision worker over HTTP and the bridge', () => {
  it('serves only the owner\'s paired devices', async () => {
    const test = await world();
    try {
      const bytes = syntheticJpeg();
      expect((await test.post('not-a-token', bytes)).status).toBe(401);
      expect((await test.post(test.other.token, bytes)).status).toBe(403);
      const status = await fetch(`http://127.0.0.1:${test.worker.port}/v1/vision/status`, { headers: { authorization: `Bearer ${test.owner.token}` } });
      expect(await status.json()).toMatchObject({ schema: 'vision.status.v1', watchAllowed: true, degrade: 0 });
    } finally { await test.close(); }
  });

  it('answers a reaction, puts a closed percept in the workspace, and tells the device to stop when others are present', async () => {
    let presence: 'alone' | 'others' = 'alone';
    const test = await world(() => presence);
    try {
      test.decisions.next = [answer('react:smile')];
      const reply = await (await test.post(test.owner.token, syntheticJpeg())).json();
      expect(reply).toMatchObject({ schema: 'vision.frame.reply.v1', watch: 'continue', reaction: 'smile' });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(test.perceived.map(event => [event.kind, event.surface, event.percept?.privacy])).toEqual([['percept', 'vision', 'owner_private']]);
      presence = 'others';
      await new Promise(resolve => setTimeout(resolve, 2_000));
      const stopped = await (await test.post(test.owner.token, syntheticJpeg())).json();
      expect(stopped).toMatchObject({ watch: 'stop', stopReason: 'audience' });
    } finally { await test.close(); }
  }, 10_000);

  it('saves the picture nowhere: not in the database files, the Observer sidecar, the logs, or a note', async () => {
    const test = await world();
    const bytes = syntheticJpeg(4_096);
    const base64 = Buffer.from(bytes).toString('base64');
    try {
      test.decisions.next = [answer('escalate')];
      expect((await test.post(test.owner.token, bytes)).status).toBe(200);
      expect(test.decisions.requests[0]!.image?.bytes.length).toBe(bytes.length);
      await new Promise(resolve => setTimeout(resolve, 50));
    } finally { await test.close(); }
    const needles = [FRAME_MARKER, base64.slice(0, 64), Buffer.from(FRAME_MARKER).toString('base64'), 'data:image/jpeg;base64'];
    const files = filesBelow(test.directory).filter(path => !path.endsWith('.sock'));
    expect(files.some(path => path.endsWith('.observer'))).toBe(true);
    const observer = files.filter(path => path.includes('.observer')).map(path => readFileSync(path).toString('latin1')).join('');
    expect(observer).toContain('visionDecision');
    for (const path of files) {
      const content = readFileSync(path).toString('latin1');
      for (const needle of needles) expect(content.includes(needle), `${needle} in ${path}`).toBe(false);
    }
    const said = [...test.logs, ...test.notes].join('\n');
    for (const needle of needles) expect(said.includes(needle), `${needle} in logs or notes`).toBe(false);
  }, 10_000);
});
