import { describe, expect, it } from 'vitest';
import type { MindEvent } from '@shannon/mind';
import { visionBridgeHandler } from '../src/wiring/visionBridgeWiring.js';

// The API side of the vision worker (Syzygy ADR-0011 §9): the API stays the authority on who is present, and takes only closed values.
function bridge(presence: 'alone' | 'others' | 'unknown' = 'alone') {
  const events: Array<{ event: MindEvent; detail: unknown }> = [];
  const audiences: string[] = [];
  const handle = visionBridgeHandler({ SHANNON_VISION_WORKER: 'on', SHANNON_VISION_CAMERA: 'on' }, {
    databasePath: ':memory:', ownerScope: 'owner', now: () => Date.parse('2026-10-14T09:00:05.000Z'), presence: () => presence, log: () => undefined,
    perceiver: { perceive: (_scope, event, detail) => { if (event) events.push({ event, detail }); return null; } },
    conversations: { listThreads: () => [], threadId: () => 'thread', recentMessages: () => [], appendNoteOnce: () => null },
    usage: { recordLlmUsage: () => undefined },
    body: { noteAudience: (_scope, deviceId, audience) => { audiences.push(`${deviceId}:${audience}`); } },
  });
  return { handle, events, audiences };
}
const percept = { scopeKey: 'owner', code: 'notice:owner_returned', probability: 0.9, sourceId: 'decision-1', sourceKind: 'app_camera', body: 'device-1',
  privacy: 'owner_private', ttlMs: 600_000, frameRef: null, at: '2026-10-14T09:00:00.000Z' };

describe('vision bridge', () => {
  it('answers the audience the API holds, for the owner\'s scope only', async () => {
    expect(await bridge('alone').handle('vision.audience', { scopeKey: 'owner' })).toEqual({ audience: 'owner_alone' });
    expect(await bridge('others').handle('vision.audience', { scopeKey: 'owner' })).toEqual({ audience: 'others' });
    expect(await bridge('unknown').handle('vision.audience', { scopeKey: 'owner' })).toEqual({ audience: 'unknown' });
    await expect(bridge().handle('vision.audience', { scopeKey: 'someone' })).rejects.toThrow('VISION_BRIDGE_SCOPE');
    await expect(bridge().handle('vision.speak', { scopeKey: 'owner' })).rejects.toThrow('VISION_BRIDGE_METHOD');
  });

  it('perceives a closed percept with the owner\'s audience, and refuses anything else', async () => {
    const { handle, events, audiences } = bridge();
    await handle('vision.percept', percept);
    expect(events.map(({ event, detail }) => [event.kind, event.surface, event.audience.kind, detail])).toEqual([
      ['percept', 'vision', 'owner', { code: 'notice:owner_returned', tool: 'app_camera', reason: null }]]);
    await expect(handle('vision.percept', { ...percept, privacy: 'shared_room' })).rejects.toThrow('VISION_BRIDGE_ARGS');
    await expect(handle('vision.percept', { ...percept, sourceKind: 'webcam' })).rejects.toThrow('VISION_BRIDGE_ARGS');
    await handle('vision.percept', { ...percept, code: 'notice:read this aloud' }).catch(() => undefined);
    expect(events).toHaveLength(1);
    await handle('vision.presence', { scopeKey: 'owner', deviceId: 'device-1', personCount: 3, at: percept.at });
    expect(events[1]?.detail).toMatchObject({ code: 'presence:others' });
    // Two people seen on a device make the API's own audience `others`, so every device stops and nothing is said.
    expect(audiences).toEqual(['device-1:others']);
  });

  it('says no notice without a model, and none with anyone else present', async () => {
    expect(await bridge('alone').handle('vision.notice', { scopeKey: 'owner', decisionId: 'decision-1', category: 'owner_returned', deviceId: 'device-1',
      at: '2026-10-14T09:00:04.000Z' })).toEqual({ delivered: false });
    expect(await bridge('others').handle('vision.escalate', { scopeKey: 'owner', decisionId: 'decision-1', deviceId: 'device-1', mimeType: 'image/jpeg',
      base64: 'AAAA', width: 512, height: 384, at: '2026-10-14T09:00:04.000Z' })).toEqual({ seen: false });
  });
});
