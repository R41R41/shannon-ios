import { describe, expect, it } from 'vitest';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

// run 10 (11/14, warped forest): about 4 minutes on fungus caps with 0 kills, then down into the cap where two angry ones stood and dead in 7 s.
describe('the pearl stage: stand on the ground, do not come down beside an angry one (run 10)', () => {
  it('says the hunt stands on the ground and why a tree top waits long, and how to tell one', () => {
    expect(V2_STAGES.pearl).toContain('平らな地面（ナイリウム・ネザーラック）で 3×3×2');
    expect(V2_STAGES.pearl).toContain('地面のエンダーマンは登って来ず');
    expect(V2_STAGES.pearl).toContain('「（木の上）」で見分け');
  });
  it('says not to come down to an angry one\'s cell, over it or beside it, and to roof the ground away from it first', () => {
    expect(V2_STAGES.pearl).toContain('怒った相手のマス・真上・隣へは下りない');
    expect(V2_STAGES.pearl).toContain('相手から離れた地面で屋根を作ってから目を合わせる');
  });
});
