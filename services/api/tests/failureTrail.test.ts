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
  it('never takes a frame-looking line of a multi-line message, and cuts long frames', () => {
    const quoted = new Error('first line\n    at leaked (prompt text from the turn)');
    quoted.stack = `Error: ${quoted.message}\n    at real (/srv/app/services/api/src/x.ts:1:2)\n    at ${'y'.repeat(500)} (z.js:1:1)`;
    const trail = failureTrail(quoted);
    expect(trail).not.toContain('leaked');
    expect(trail).not.toContain('prompt text');
    expect(trail).toContain('real (src/x.ts:1:2)');
    expect(trail.split(' < ').every(frame => frame.length <= 206)).toBe(true);
  });
  it('is only a name without a stack, and unknown for a non-error', () => {
    const bare = new TypeError('x'); bare.stack = undefined;
    expect(failureTrail(bare)).toBe('TypeError');
    expect(failureTrail('boom')).toBe('UnknownError');
  });
});
