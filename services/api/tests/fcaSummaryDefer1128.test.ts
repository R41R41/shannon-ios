import { describe, expect, it } from 'vitest';

/** The bed burst texts of 11/28 (end run 18). The history summary's deferral that shared this file is gone: a summary never waits (`fcaSummaryNeverWaits1128.test.ts`). */
describe('the bed burst texts keep to the facts of run 18 (11/28)', () => {
  it('say the stand is not the waiting cell, and give phase 2 as the sampled 14 to 49 seconds, not 13 to 21', async () => {
    const { BED_BURST_DESCRIPTION } = await import('../src/contracts/minecraftBedBurstContract.js');
    const { PROBE_DESCRIPTION } = await import('../src/contracts/minecraftProbeContract.js');
    expect(BED_BURST_DESCRIPTION).toContain('待つ場所（止まり木から10〜14m）と起爆に立つ場所（stand）は別');
    expect(BED_BURST_DESCRIPTION).toContain('14〜49秒');
    expect(BED_BURST_DESCRIPTION).not.toContain('13〜21');
    expect(PROBE_DESCRIPTION).not.toContain('no_layout_within_twelve');
    expect(BED_BURST_DESCRIPTION).not.toContain('新しく読めない');
  });
});
