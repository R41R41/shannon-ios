import { describe, expect, it } from 'vitest';
import { VisionDecisionsError } from '../src/infra/models/openAIVisionDecisions.js';
import { VISION_BUDGET_DEFAULTS, visionDegradeLevel } from '../src/mind/vision/visionPorts.js';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteVisionChoiceStore } from '../src/mind/vision/store/visionChoiceStore.js';
import { answer, frameMeta, syntheticJpeg, visionWorld } from './support/visionWorld.js';

// Syzygy ADR-0011 §4.3, §4.4, §7 and §8.1: the worker's handling of one gated camera frame.
async function send(world: ReturnType<typeof visionWorld>, overrides: Parameters<typeof frameMeta>[2] = {}) {
  const bytes = syntheticJpeg();
  return world.watch.frame(world.principal, frameMeta(bytes, world.now(), overrides), bytes, 'image/jpeg');
}

describe('vision watch: a camera frame', () => {
  it('asks one Decisions request with the predicate and the choice together, and says nothing when the answer is quiet', async () => {
    const world = visionWorld();
    world.decisions.next = [answer('quiet', 0.2)];
    const result = await send(world);
    expect(result).toMatchObject({ status: 200, reply: { watch: 'continue', outcome: 'quiet', candidateId: null, reaction: null } });
    expect(world.decisions.requests).toHaveLength(1);
    const request = world.decisions.requests[0]!;
    expect(request.predicate.name).toBe('needs_response');
    expect(request.choice.candidates.map(candidate => candidate.id)).toEqual(expect.arrayContaining(['quiet', 'react:smile', 'notice:owner_returned', 'other']));
    expect(request.choice.candidates.map(candidate => candidate.id)).not.toContain('escalate');
    expect(world.bridge.percepts).toEqual([]);
    expect(world.frames.size).toBe(0);
  });

  it('prefers quiet when the predicate or the confidence is low, even if a candidate was chosen', async () => {
    const world = visionWorld();
    world.decisions.next = [answer('notice:owner_returned', 0.6, 0.9), answer('notice:owner_returned', 0.95, 0.4)];
    expect(await send(world)).toMatchObject({ reply: { outcome: 'quiet' } });
    world.advance(2_000);
    expect(await send(world)).toMatchObject({ reply: { outcome: 'quiet' } });
    expect(world.bridge.notices).toEqual([]);
  });

  it('answers a reaction at once, and sends a notice to the API with a percept', async () => {
    const world = visionWorld();
    world.decisions.next = [answer('react:smile'), answer('notice:owner_returned')];
    expect(await send(world)).toMatchObject({ reply: { outcome: 'chosen', candidateId: 'react:smile', reaction: 'smile' } });
    world.advance(2_000);
    expect(await send(world)).toMatchObject({ reply: { outcome: 'chosen', candidateId: 'notice:owner_returned', reaction: null } });
    expect(world.bridge.notices.map(notice => notice.category)).toEqual(['owner_returned']);
    expect(world.bridge.percepts.map(percept => percept.code)).toEqual(['react:smile', 'notice:owner_returned']);
    expect(world.bridge.percepts.every(percept => percept.frameRef === null && percept.privacy === 'owner_private')).toBe(true);
  });

  it('does not repeat the same notice within its window', async () => {
    const world = visionWorld();
    world.decisions.next = [answer('notice:owner_waved'), answer('notice:owner_waved')];
    await send(world);
    world.advance(2_000);
    expect(await send(world)).toMatchObject({ reply: { outcome: 'quiet' } });
    expect(world.bridge.notices).toHaveLength(1);
  });

  it('keeps the device to one frame per 2 s and one decision at a time', async () => {
    const world = visionWorld();
    const first = send(world);
    expect(await send(world)).toMatchObject({ status: 429, error: 'VISION_TOO_SOON' });
    await first;
    world.advance(1_000);
    expect(await send(world)).toMatchObject({ status: 429 });
    world.advance(1_000);
    expect(await send(world)).toMatchObject({ status: 200 });
  });

  it('stops the device when anyone else may be present, before any paid call', async () => {
    const world = visionWorld();
    world.bridge.audienceNow = 'others';
    expect(await send(world)).toMatchObject({ reply: { watch: 'stop', stopReason: 'audience' } });
    world.advance(2_000);
    world.bridge.audienceNow = 'unknown';
    expect(await send(world, { generation: 2 })).toMatchObject({ reply: { watch: 'stop', stopReason: 'audience' } });
    expect(world.decisions.requests).toEqual([]);
    expect(world.budget.spentUsd('owner', new Date(world.now()).toISOString())).toBe(0);
  });

  it('discards an answer when the audience changed, the generation moved or the frame expired while it was out', async () => {
    const world = visionWorld();
    world.decisions.next = [answer('notice:owner_returned'), answer('react:smile'), answer('react:curious')];
    world.decisions.during = () => { world.bridge.audienceNow = 'others'; };
    expect(await send(world)).toMatchObject({ reply: { outcome: 'discarded' } });
    world.bridge.audienceNow = 'owner_alone';
    world.decisions.during = () => { world.advance(5_000); };
    world.advance(2_000);
    expect(await send(world)).toMatchObject({ reply: { outcome: 'discarded' } });
    world.decisions.during = null;
    world.advance(2_000);
    await world.watch.presence(world.principal, 2, new Date(world.now()).toISOString());
    expect(await send(world)).toMatchObject({ status: 409, error: 'VISION_STALE_GENERATION' });
    expect(world.bridge.notices).toEqual([]);
    expect(world.bridge.presences).toEqual([2]);
  });

  it('refuses frames that are not the owner\'s gated camera frame', async () => {
    const world = visionWorld();
    const bytes = syntheticJpeg();
    const meta = frameMeta(bytes, world.now());
    expect(await world.watch.frame(world.principal, { ...meta, audienceAtCapture: 'others' }, bytes, 'image/jpeg')).toMatchObject({ status: 400 });
    expect(await world.watch.frame(world.principal, { ...meta, encoding: { ...meta.encoding, width: 1024 } }, bytes, 'image/jpeg')).toMatchObject({ status: 400 });
    expect(await world.watch.frame(world.principal, meta, bytes, 'image/png')).toMatchObject({ status: 400, error: 'VISION_FRAME_FORMAT' });
    const other = { ...meta, source: { ...meta.source, deviceId: 'device-2' } };
    expect(await world.watch.frame(world.principal, other, bytes, 'image/jpeg')).toMatchObject({ status: 403 });
  });
});

describe('vision watch: budget and degrade', () => {
  it('reserves before each call and settles it with the measured usage', async () => {
    const world = visionWorld();
    world.decisions.next = [answer('quiet', 0.1, 0.9, 602)];
    await send(world);
    const totals = world.ledger.totals('owner', new Date(world.now()).toISOString().slice(0, 10));
    expect(totals).toEqual({ settledUsd: 602 * 0.1 / 1_000_000, heldUsd: 0, reservedUsd: 0 });
  });

  it('keeps the reservation when the usage is unknown, and drops to level 2 after failures in a row', async () => {
    const world = visionWorld();
    const unknown = { usageComplete: false, inputTokens: 0, estimatedCostUsd: VISION_BUDGET_DEFAULTS.decisionReserveUsd };
    world.decisions.next = [0, 1, 2].map(() => new VisionDecisionsError('timeout', unknown));
    for (let index = 0; index < 3; index += 1) {
      expect(await send(world)).toMatchObject({ reply: { outcome: 'failed' } });
      world.advance(2_000);
    }
    const day = new Date(world.now()).toISOString().slice(0, 10);
    expect(world.ledger.totals('owner', day).heldUsd).toBeCloseTo(3 * VISION_BUDGET_DEFAULTS.decisionReserveUsd);
    expect(await send(world)).toMatchObject({ reply: { watch: 'stop', stopReason: 'degraded', degrade: 2 } });
    expect(world.bridge.percepts.map(percept => percept.code)).toContain('degrade:2');
  });

  it('stops at the daily cap, and at the stop switch (level 3)', async () => {
    const world = visionWorld({ capUsd: 0.0015 });
    world.decisions.next = [new VisionDecisionsError('usage_unknown', null)];
    await send(world);
    world.advance(2_000);
    expect(await send(world)).toMatchObject({ reply: { watch: 'stop', stopReason: 'budget' } });
    const halted = visionWorld({ halted: true });
    expect(await send(halted)).toMatchObject({ reply: { watch: 'stop', stopReason: 'disabled', degrade: 3 } });
    expect(halted.decisions.requests).toEqual([]);
  });

  it('computes the levels of §7.3', () => {
    const base = { spentUsd: 0, capUsd: 2, p95Ms: 400, failuresInRow: 0, lastFailureAt: null };
    expect(visionDegradeLevel(base, false, 0)).toBe(0);
    expect(visionDegradeLevel({ ...base, spentUsd: 1.6 }, false, 0)).toBe(1);
    expect(visionDegradeLevel({ ...base, p95Ms: 4_001 }, false, 0)).toBe(1);
    expect(visionDegradeLevel({ ...base, spentUsd: 2 }, false, 0)).toBe(2);
    expect(visionDegradeLevel({ ...base, failuresInRow: 3, lastFailureAt: 0 }, false, 1_000)).toBe(2);
    expect(visionDegradeLevel({ ...base, failuresInRow: 3, lastFailureAt: 0 }, false, 6 * 60_000)).toBe(0);
    expect(visionDegradeLevel(base, true, 0)).toBe(3);
  });

  it('answers stop to every frame with the camera switch off', async () => {
    const world = visionWorld({ camera: false });
    expect(await send(world)).toMatchObject({ reply: { watch: 'stop', stopReason: 'disabled' } });
    expect((await world.watch.status(world.principal)).watchAllowed).toBe(false);
  });

  it('offers escalate only with its switch, and hands the frame to the API once', async () => {
    const world = visionWorld({ escalate: true });
    world.decisions.next = [answer('escalate')];
    await send(world);
    expect(world.decisions.requests[0]!.choice.candidates.map(candidate => candidate.id)).toContain('escalate');
    expect(world.bridge.escalations).toHaveLength(1);
    expect(world.frames.size).toBe(0);
  });
});

describe('vision watch: review fixes', () => {
  it('caps notices and escalations together per hour, and keeps cooldowns in the ledger it is given', async () => {
    const world = visionWorld({ escalate: true });
    const categories = ['owner_returned', 'owner_waved', 'showing_something', 'new_object', 'owner_looks_tired'];
    world.decisions.next = categories.map(category => answer(`notice:${category}`));
    for (const _ of categories) {
      await send(world);
      world.advance(2_000);
    }
    expect(world.bridge.notices.map(notice => notice.category)).toEqual(categories.slice(0, 4));
  });

  it('never uses a camera frame past 4 s, whatever TTL the device sent', async () => {
    const world = visionWorld();
    world.decisions.next = [answer('react:smile')];
    world.decisions.during = () => { world.advance(4_500); };
    expect(await send(world, { ttlMs: 30_000 })).toMatchObject({ reply: { outcome: 'discarded' } });
  });

  it('counts a timeout\'s wait toward the latency p95, so a slow provider reaches level 1', async () => {
    const world = visionWorld();
    world.decisions.next = [0, 1].map(() => new VisionDecisionsError('timeout', null));
    world.decisions.during = () => { world.advance(5_000); };
    await send(world);
    world.decisions.during = null;
    world.advance(2_000);
    expect(world.budget.level('owner', new Date(world.now()).toISOString())).toBe(1);
  });

  it('keeps a notice\'s cooldown across a restart of the worker', async () => {
    const choices = new SQLiteVisionChoiceStore(new DatabaseSync(':memory:'));
    const first = visionWorld({ choices });
    first.decisions.next = [answer('notice:owner_returned')];
    await send(first);
    const restarted = visionWorld({ choices, start: first.now() + 60_000 });
    restarted.decisions.next = [answer('notice:owner_returned')];
    expect(await send(restarted)).toMatchObject({ reply: { outcome: 'quiet' } });
    expect(restarted.bridge.notices).toEqual([]);
  });
});

describe('vision watch: a ledger that cannot be read', () => {
  it('says no notice (fail closed)', async () => {
    const broken = { record: () => { throw new Error('busy'); }, lastChosenAt: () => null, countSince: () => { throw new Error('busy'); } };
    const world = visionWorld({ choices: broken });
    world.decisions.next = [answer('notice:owner_returned')];
    expect(await send(world)).toMatchObject({ reply: { outcome: 'quiet' } });
    expect(world.bridge.notices).toEqual([]);
  });
});
