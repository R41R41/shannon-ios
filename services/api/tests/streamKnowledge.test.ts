import { describe, expect, it } from 'vitest';
import { V2_ALWAYS } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

// Run 5 (2026-11-11): 308 s held in shallow flowing water; the head tried the block on the stream only after 4.5 minutes.
describe('a stream that holds the body is stopped at its source', () => {
  it('tells the planner what to do when go/walk do not move in a stream, with the reason, in one line', () => {
    const line = V2_ALWAYS.split('\n').find(row => row.includes('水の流れ N'));
    expect(line).toBeDefined();
    expect(line).toContain('上流の 1 マスに dirt か cobblestone を place');
    expect(line).toContain('足の下も水でよい');
    expect(line!.length).toBeLessThanOrEqual(110);
  });
});
