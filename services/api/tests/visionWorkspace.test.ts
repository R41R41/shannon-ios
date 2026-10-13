import { describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE, UNKNOWN_GUEST_PRESENCE } from '@shannon/cognition';
import { applyOp, emptyScope, initialSalience, orderedHeld, perceptExpired, snapshotOf, scopeFromSnapshot } from '../src/mind/workspace/workspaceState.js';
import { workspaceBlocks } from '../src/mind/workspace/workspacePorts.js';
import { visionPerception } from '../src/mind/perception/perceptionPorts.js';

// Syzygy ADR-0011 §3.2 and §11 slice 2: a percept enters attention by its probability, leaves by its TTL, renders its closed code
// only, and is not shown to anyone but the owner when it came from what only the owner showed.
const AT = '2026-10-14T09:00:00.000Z';
const later = (milliseconds: number) => new Date(Date.parse(AT) + milliseconds).toISOString();

function percept(code: string, ttlMs = 60_000) {
  return visionPerception({ code, probability: 0.9, sourceId: `decision-${code}`, sourceKind: 'app_camera', body: 'device-1', privacy: 'owner_private',
    ttlMs, frameRef: null, at: AT })!;
}

describe('workspace percept', () => {
  it('is admitted by its percept salience and leaves at its TTL', () => {
    const scope = emptyScope();
    const event = percept('notice:owner_returned', 60_000);
    const initial = initialSalience(event, []);
    expect(initial).toBeGreaterThanOrEqual(0.5);
    expect(applyOp(scope, { op: 'perceive', event, initial, detail: { code: 'notice:owner_returned', tool: 'app_camera', reason: null }, at: AT }))
      .toMatchObject({ verdict: 'admitted' });
    expect(orderedHeld(scope, later(59_000))).toHaveLength(1);
    expect(perceptExpired(scope.held[0]!, later(60_000))).toBe(true);
    expect(orderedHeld(scope, later(60_000))).toEqual([]);
    const restored = scopeFromSnapshot(snapshotOf(scope));
    expect(restored.held[0]?.percept).toEqual({ ttlMs: 60_000, privacy: 'owner_private', frameRef: null });
  });

  it('renders the closed code for the owner and nothing for anyone else', () => {
    const scope = emptyScope();
    const event = percept('notice:showing_something');
    applyOp(scope, { op: 'perceive', event, initial: initialSalience(event, []), detail: { code: 'notice:showing_something', tool: 'app_camera', reason: null }, at: AT });
    const turn = { surface: 'text' as const, at: later(1_000), currentItemId: null, current: null, dataFrames: false, text: () => null };
    expect(workspaceBlocks(scope, { ...turn, present: OWNER_AUDIENCE })).toContain('目：ライ氏が何かを見せているのを見た');
    expect(workspaceBlocks(scope, { ...turn, present: UNKNOWN_GUEST_PRESENCE })).not.toContain('見せている');
  });

  it('refuses a code outside the closed vocabulary', () => {
    expect(visionPerception({ code: 'notice:the screen says hello', probability: 1, sourceId: 'x', sourceKind: 'app_camera', body: null,
      privacy: 'owner_private', ttlMs: 1_000, frameRef: null, at: AT })).toBeNull();
  });
});
