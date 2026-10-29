import { describe, expect, it } from 'vitest';
import { runBench } from '../scripts/stream-bench/run.js';
import { makeChat } from '../scripts/stream-bench/makeChat.js';

/** The stream bench with the fake models: the recorded chat through the fake YouTube, the ear, the head's real routes and the mouth. */
describe('the stream bench (fake models)', () => {
  it('loses no comment, leaks nothing private, answers within the allowance and declines what must be declined', async () => {
    const report = await runBench({ models: 'fake', ear: 'inline', speed: 120, fakeLatencyMilliseconds: 2500, minecraft: true, chatWrites: false });
    expect(report.comments.recorded).toBe(makeChat().length);
    expect(report.comments.sentByApi).toBe(report.comments.recorded);
    expect(report.comments.lost).toBe(0);
    expect(report.comments.earSent).toBe(report.comments.recorded);
    expect(report.leaks.count).toBe(0);
    expect(report.leaks.checkedRequests).toBeGreaterThan(20);
    expect(report.answered.comments).toBeGreaterThan(15);
    expect(report.answered.perVirtualMinute).toBeLessThanOrEqual(10);
    expect(report.declined).toBeGreaterThanOrEqual(4);
    expect(report.notices).toBeGreaterThanOrEqual(1);
    expect(report.lines.byKind).toMatchObject({ greeting: 1, closing: 1 });
    expect(report.byTag.threat!.answered).toBeLessThanOrEqual(1);
    expect(report.byTag.reaction!.answered).toBe(0);
    expect(report.models.calls.total).toBeLessThanOrEqual(10 * 11);
    expect(report.latencyMs.headCommentToFirstSound.median).toBeLessThan(40_000);
  }, 90_000);
});
