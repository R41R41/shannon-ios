import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  VISION_FORBIDDEN_KEYS, checkedVisionDecision, checkedVisionFrame, checkedVisionSession, visionCandidateId, visionCandidateOf,
  visionDecisionRecord, visionFrameFresh,
} from '../src/contracts/visionContract.js';

// Syzygy ADR-0011 §3.2 and §11 slice 1: the three records, read from the fixture the Swift mirror decodes too.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/vision-contract-v1.json', import.meta.url), 'utf8')) as Record<string, Record<string, unknown>>;

describe('vision contract v1', () => {
  it('accepts the fixture frame, session and decision unchanged', () => {
    expect(checkedVisionFrame(fixture.frame)).toEqual(fixture.frame);
    expect(checkedVisionSession(fixture.session)).toEqual(fixture.session);
    expect(checkedVisionDecision(fixture.decision)).toEqual(fixture.decision);
  });

  it('has no field that keeps a picture: every forbidden key is refused, at any depth', () => {
    for (const key of VISION_FORBIDDEN_KEYS) {
      expect(checkedVisionFrame({ ...fixture.frame, [key]: 'x' }), key).toMatch(/is not allowed/u);
      expect(checkedVisionFrame({ ...fixture.frame, encoding: { ...(fixture.frame.encoding as object), [key]: 'x' } }), key).toMatch(/is not allowed/u);
      expect(checkedVisionDecision({ ...fixture.decision, [key]: 'x' }), key).toMatch(/not allowed|FORBIDDEN/u);
    }
    expect(checkedVisionFrame({ ...fixture.frame, persist: 'none' })).toMatch(/persist is not allowed/u);
    expect(checkedVisionFrame({ ...fixture.frame, state: { base64: 'AAAA' } })).toMatch(/not allowed/u);
  });

  it('refuses what is not closed', () => {
    const frame = fixture.frame;
    const refused: Array<[string, Record<string, unknown>]> = [
      ['schema', { ...frame, schema: 'vision.frame.v2' }],
      ['privacy', { ...frame, privacy: 'public' }],
      ['audienceAtCapture', { ...frame, audienceAtCapture: 'everyone' }],
      ['ttlMs', { ...frame, ttlMs: 0 }],
      ['ttlMs', { ...frame, ttlMs: 3_600_000 }],
      ['source.kind', { ...frame, source: { kind: 'webcam', bodyId: null, deviceId: null } }],
      ['encoding.format', { ...frame, encoding: { width: 1, height: 1, format: 'gif', byteLength: 1 } }],
      ['gate.difference', { ...frame, gate: { reason: 'difference', difference: 2, personCount: 1 } }],
    ];
    for (const [label, value] of refused) expect(typeof checkedVisionFrame(value), label).toBe('string');
    expect(checkedVisionSession({ ...fixture.session, state: 'open' })).toBe('an open session has no end');
    expect(checkedVisionSession({ ...fixture.session, endReason: null })).toBe('an ended session names its reason and time');
  });

  it('names candidates in one closed vocabulary', () => {
    expect(visionCandidateId({ kind: 'react', reaction: 'smile', category: null })).toBe('react:smile');
    expect(visionCandidateOf('notice:owner_returned')).toMatchObject({ kind: 'notice', category: 'owner_returned' });
    for (const id of ['react:wink', 'notice:read_the_screen', 'speak', 'notice:', '']) expect(visionCandidateOf(id), id).toBeNull();
    const decision = fixture.decision as unknown as Parameters<typeof visionDecisionRecord>[0];
    expect(() => visionDecisionRecord({ ...decision, choice: { ...decision.choice, candidateId: 'react:wink' } })).toThrow('VISION_DECISION_CANDIDATE');
  });

  it('measures freshness from capture and the TTL', () => {
    const captured = Date.parse(fixture.frame.capturedAt as string);
    expect(visionFrameFresh({ capturedAt: fixture.frame.capturedAt as string, ttlMs: 4_000 }, captured + 3_999)).toBe(true);
    expect(visionFrameFresh({ capturedAt: fixture.frame.capturedAt as string, ttlMs: 4_000 }, captured + 4_001)).toBe(false);
  });
});
