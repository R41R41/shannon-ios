import { describe, expect, it } from 'vitest';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

describe('the End text says what a dragon in flight does to a body that stands outside 20 m of the perch (19th and 20th runs, 11/28)', () => {
  const end = V2_STAGES.end;
  it('gives the rule that starts a charge, the wing box and the numbers of the two runs, as facts with their reason', () => {
    for (const part of ['止まり木で見回している間（phase 6）だけ', '20m 以内かつ高さ 10m 以内に人が居ない状態が 5 秒続き', '固定の目標', '秒速約 23m',
      '2m 下から 4m 上', '水平 6m 以内', '箱に長く居るほど高く上がる', '11〜13.5m', 'y67 から y81.7', 'y65 から y103.9', '10〜14m）は 20m 以内なので、体当たりの条件に入らない']) expect(end).toContain(part);
  });
  it('does not say what was not read from the source: the knockback resistance, and a roof or a shaft against the push', () => {
    const at = end.indexOf('飛んでくる竜（体当たり phase 8');
    const block = end.slice(at, at + 1400);
    expect(block).not.toContain('耐性');
    expect(block).not.toContain('屋根');
    expect(block).not.toContain('縦穴');
  });
});
