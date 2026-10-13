import { describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { SALIENCE_V1, checkedMindEvent, mindEvent, salience, withoutText, type MindEvent, type MindEventDraft } from '../src/index.js';

// Syzygy ADR-0011 §3.2: kind `percept` carries a TTL, a privacy and a frame reference; never a picture.
const AT = '2026-10-14T09:00:00.000Z';
const percept: MindEventDraft = {
  id: 'vision-1', kind: 'percept', surface: 'vision', body: 'device-owner-iphone', audience: OWNER_AUDIENCE,
  presence: { ownerOnlyHears: true, othersMayHear: false }, speaker: { kind: 'system' }, time: AT, salienceInputs: { percept: 0.8 },
  provenance: { source: 'vision', sourceId: 'decision-1', trust: 'system' }, content: null,
  percept: { ttlMs: 120_000, privacy: 'owner_private', frameRef: 'frame:frame-1' },
};

describe('mind.event.v1 percept', () => {
  it('builds a percept with its TTL, privacy and frame reference, and keeps them through JSON and withoutText', () => {
    const event = mindEvent(percept) as MindEvent;
    expect(event.percept).toEqual({ ttlMs: 120_000, privacy: 'owner_private', frameRef: 'frame:frame-1' });
    expect(Object.isFrozen(event.percept)).toBe(true);
    expect(checkedMindEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(withoutText({ ...event, content: { text: 'x' } }).percept).toEqual(event.percept);
  });

  it('refuses a percept without its fields, a percept field on another kind, and anything that is not a frame reference', () => {
    expect(mindEvent({ ...percept, percept: undefined })).toBe('a percept needs { ttlMs, privacy, frameRef }');
    expect(mindEvent({ ...percept, kind: 'presence' })).toBe('percept is only on kind percept');
    expect(mindEvent({ ...percept, percept: { ttlMs: 0, privacy: 'owner_private', frameRef: null } })).toBe('percept.ttlMs is invalid');
    expect(mindEvent({ ...percept, percept: { ttlMs: 31 * 60_000, privacy: 'owner_private', frameRef: null } })).toBe('percept.ttlMs is invalid');
    expect(mindEvent({ ...percept, percept: { ttlMs: 1_000, privacy: 'public', frameRef: null } } as never)).toBe('percept.privacy is invalid');
    for (const frameRef of ['data:image/jpeg;base64,AAAA', 'frame:', 'https://example.com/x.jpg', `frame:${'a'.repeat(200)}`]) {
      expect(mindEvent({ ...percept, percept: { ttlMs: 1_000, privacy: 'owner_private', frameRef } }), frameRef).toBe('percept.frameRef is invalid');
    }
    const extra = { ...(mindEvent(percept) as MindEvent), percept: { ttlMs: 1_000, privacy: 'owner_private', frameRef: null, image: 'AAAA' } };
    expect(checkedMindEvent(JSON.parse(JSON.stringify(extra)))).toBe('percept must be { ttlMs, privacy, frameRef }');
  });

  it('feeds attention through the percept salience input only', () => {
    expect(salience({ percept: 1 })).toBeCloseTo(SALIENCE_V1.weights.percept);
    expect(salience({ percept: 0 })).toBe(0);
    expect(mindEvent({ ...percept, salienceInputs: { percept: 1.5 } })).toBe('salienceInputs.percept must be in [0, 1]');
  });
});
