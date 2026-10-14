import { describe, expect, it } from 'vitest';
import { REPLY_CHECK_FLAGS, checkBeforeSending, checkReply, rewriteNote } from '../src/index.js';
import { LABELED_REPLIES } from './replyCheckLabeled.js';

/** The reply check on the labeled examples (the stage plan: misses and false alarms at most one in ten each). */
describe('the reply check on the labeled examples', () => {
  it('has about fifty examples, every flag among them', () => {
    expect(LABELED_REPLIES.length).toBeGreaterThanOrEqual(50);
    for (const flag of REPLY_CHECK_FLAGS) expect(LABELED_REPLIES.some(example => example.flags.includes(flag)), flag).toBe(true);
  });

  it('misses at most one in ten flags and raises at most one in ten false alarms', () => {
    let expected = 0, missed = 0, raised = 0, false_ = 0;
    const report: string[] = [];
    for (const example of LABELED_REPLIES) {
      const found = checkReply(example.reply, example.context);
      expected += example.flags.length;
      raised += found.length;
      const miss = example.flags.filter(flag => !found.includes(flag));
      const extra = found.filter(flag => !example.flags.includes(flag));
      missed += miss.length;
      false_ += extra.length;
      if (miss.length || extra.length) report.push(`${example.reply.slice(0, 24)} miss=${miss.join(',')} extra=${extra.join(',')}`);
    }
    // Examples whose reply should pass and was flagged, over all examples that should pass.
    const clean = LABELED_REPLIES.filter(example => !example.flags.length);
    const flaggedClean = clean.filter(example => checkReply(example.reply, example.context).length > 0).length;
    expect(missed / expected, report.join('\n')).toBeLessThanOrEqual(0.1);
    expect(false_ / Math.max(1, raised), report.join('\n')).toBeLessThanOrEqual(0.1);
    expect(flaggedClean / clean.length, report.join('\n')).toBeLessThanOrEqual(0.1);
  });

  it('checks before sending only a strong turn, a feeling order, or one in front of others; the rewrite note names no line', () => {
    expect(checkBeforeSending({ intensity: 'moderate', order: false, audience: 'owner_alone' })).toBe(false);
    expect(checkBeforeSending({ intensity: 'strong', order: false, audience: 'owner_alone' })).toBe(true);
    expect(checkBeforeSending({ intensity: 'subtle', order: true, audience: 'owner_alone' })).toBe(true);
    expect(checkBeforeSending({ intensity: 'subtle', order: false, audience: 'people' })).toBe(true);
    expect(rewriteNote(['helper_drift', 'numbers_spoken'])).toBe('[書き直し]（さっきの下書きは、手伝いや直す申し出で締めていた、回数を読み上げていた。この番の気持ちのまま、ボクの言葉で一から書き直す）');
  });
});
