import { describe, expect, it } from 'vitest';
import {
  bindReflexCandidates, freshBodyObservation, reflexCandidateCurrent,
  type BodyCandidateDraft, type BodyObservation, type BodyTaskContext, type ReflexLimits,
} from '../src/mind/action/reflex/reflexPorts.js';
const now = Date.parse('2026-10-09T00:00:00.000Z');
const context: BodyTaskContext = { scopeKey: 'owner', taskId: 'task', taskRevision: 1, bodyId: 'minecraft', sessionId: 'session', generation: 2,
  goal: 'ブロックを置く', completionCondition: '位置を観測して確認する' };
const limits: ReflexLimits = { maxDurationMs: 5_000, maxDecisions: 3, maxActions: 2, maxActionMs: 1_000, maxStateAgeMs: 1_000, maxImageAgeMs: 1_000 };
const observation: BodyObservation = { schemaVersion: 1, bodyId: 'minecraft', sequence: 10, stateAt: new Date(now).toISOString(),
  receivedAt: new Date(now).toISOString(), connected: true, state: {}, facts: { target: 'block:0:64:1', equipped: 'stone', health: 20 } };
const candidate = (): BodyCandidateDraft => ({ kind: 'action', label: '石を置く', operation: 'place', arguments: { face: 'up', slot: 2, target: 'block:0:64:1' },
  preconditions: [{ key: 'target', value: 'block:0:64:1' }, { key: 'equipped', value: 'stone' }], maxDurationMs: 500,
  expiresAt: new Date(now + 1_000).toISOString() });

describe('argument-resolved candidate lifecycle', () => {
  it('binds immutable candidates to complete arguments and task/session versions, with closed control choices', () => {
    const draft = candidate(), bound = bindReflexCandidates(context, observation, [draft], now, limits);
    expect(bound.map(item => item.kind)).toEqual(['action', 'observe', 'return', 'stop']);
    expect(Object.isFrozen(bound[0]!.arguments)).toBe(true);
    (draft.arguments as Record<string, number | string>).slot = 3;
    expect(bound[0]!.arguments.slot).toBe(2);
    const changed = bindReflexCandidates(context, observation, [draft], now, limits);
    expect(changed[0]!.id).not.toBe(bound[0]!.id);
    expect(bindReflexCandidates({ ...context, taskRevision: 2 }, observation, [candidate()], now, limits)[0]!.id).not.toBe(bound[0]!.id);
    expect(bindReflexCandidates({ ...context, generation: 3 }, observation, [candidate()], now, limits)[0]!.id).not.toBe(bound[0]!.id);
    expect(bindReflexCandidates(context, observation, [{ ...candidate(), arguments: { target: 'block:0:64:1', slot: 2, face: 'up' } }], now, limits)[0]!.id).toBe(bound[0]!.id);
  });
  it('accepts unrelated state updates but invalidates equipment, target, expiry and generation', () => {
    const bound = bindReflexCandidates(context, observation, [candidate()], now, limits)[0]!;
    expect(reflexCandidateCurrent(bound, context, { ...observation, sequence: 11, facts: { ...observation.facts, health: 19 } }, now, limits)).toBe(true);
    expect(reflexCandidateCurrent(bound, context, { ...observation, facts: { ...observation.facts, equipped: 'torch' } }, now, limits)).toBe(false);
    expect(reflexCandidateCurrent(bound, context, { ...observation, facts: { ...observation.facts, target: 'other-block' } }, now, limits)).toBe(false);
    expect(reflexCandidateCurrent(bound, context, observation, now + 1_000, limits)).toBe(false);
    expect(reflexCandidateCurrent(bound, { ...context, generation: 3 }, observation, now, limits)).toBe(false);
    expect(reflexCandidateCurrent(bound, context, { ...observation, sequence: 9 }, now, limits)).toBe(false);
  });
  it('rejects duplicate candidates, unknown conditions, unbounded actions and excessive menus', () => {
    expect(() => bindReflexCandidates(context, observation, [candidate(), candidate()], now, limits)).toThrow('DUPLICATE');
    expect(() => bindReflexCandidates(context, observation, [{ ...candidate(), preconditions: [{ key: 'not_observed', value: true }] }], now, limits)).toThrow('INVALID');
    expect(() => bindReflexCandidates(context, observation, [{ ...candidate(), maxDurationMs: 10_000 }], now, limits)).toThrow('INVALID');
    expect(() => bindReflexCandidates(context, observation, Array.from({ length: 62 }, candidate), now, limits)).toThrow('LIMIT');
  });
  it('tracks state and image timestamps independently without accepting future or expired captures', () => {
    const image = { ref: 'frame:1', capturedAt: new Date(now - 500).toISOString(), expiresAt: new Date(now + 500).toISOString() };
    expect(freshBodyObservation({ ...observation, image }, context, now, limits, true)).toBe(true);
    expect(freshBodyObservation({ ...observation, image: { ...image, capturedAt: new Date(now + 1).toISOString() } }, context, now, limits, true)).toBe(false);
    expect(freshBodyObservation({ ...observation, image: { ...image, expiresAt: new Date(now).toISOString() } }, context, now, limits, true)).toBe(false);
    expect(freshBodyObservation({ ...observation, stateAt: new Date(now - 1_001).toISOString(), image }, context, now, limits, true)).toBe(false);
  });
});
