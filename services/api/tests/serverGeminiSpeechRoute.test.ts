import { describe, expect, it } from 'vitest';
import { SpeechScopeConcurrencyLimiter } from '../src/serverGeminiSpeechRoute.js';

describe('Gemini speech scope concurrency', () => {
  it('allows one current sentence and one prefetched sentence per scope', () => {
    const limiter = new SpeechScopeConcurrencyLimiter(2);

    expect(limiter.acquire('owner-a')).toBe(true);
    expect(limiter.acquire('owner-a')).toBe(true);
    expect(limiter.acquire('owner-a')).toBe(false);
    expect(limiter.acquire('owner-b')).toBe(true);

    limiter.release('owner-a');
    expect(limiter.acquire('owner-a')).toBe(true);
    expect(limiter.acquire('owner-a')).toBe(false);
  });

  it('rejects invalid limits and safely ignores an extra release', () => {
    expect(() => new SpeechScopeConcurrencyLimiter(0)).toThrowError(
      'maximumConcurrentRequests must be a positive integer',
    );
    const limiter = new SpeechScopeConcurrencyLimiter(1);
    limiter.release('owner-a');
    expect(limiter.acquire('owner-a')).toBe(true);
  });
});
