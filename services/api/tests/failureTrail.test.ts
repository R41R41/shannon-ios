import { describe, expect, it } from 'vitest';
import { failureTrail } from '../src/infra/http/failureTrail.js';

describe('failureTrail', () => {
  it('names the error and the first frames of our code, never the message', () => {
    let error: unknown;
    try { new Intl.DateTimeFormat('en-CA').formatToParts(new Date('secret words')); } catch (caught) { error = caught; }
    const trail = failureTrail(error, 3);
    expect(trail.startsWith('RangeError ')).toBe(true);
    expect(trail).toContain('failureTrail.test.ts');
    expect(trail).not.toContain('Invalid time value');
    expect(trail).not.toContain('secret words');
    expect(trail.split(' < ').length).toBeLessThanOrEqual(3);
  });
  it('is only a name without a stack, and unknown for a non-error', () => {
    const bare = new TypeError('x'); bare.stack = undefined;
    expect(failureTrail(bare)).toBe('TypeError');
    expect(failureTrail('boom')).toBe('UnknownError');
  });
});
