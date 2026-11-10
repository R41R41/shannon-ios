import { describe, expect, it } from 'vitest';
import { V2_ALWAYS } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { handFacts, STREAM_WORDS } from '../src/surfaces/minecraft/minecraftLlmcResultWords.js';
import type { ActHandLine } from '../src/contracts/minecraftActContract.js';

// Run 5 (2026-11-11): 308 s held in shallow flowing water; the head tried the block on the stream only after 4.5 minutes.
// 11/11 trim: the line was one of the instructions' 「落ちる・水・溶岩・空所」, read at every decision for a thing that comes in about one of a thousand; it is now the words of the
// receipt of a go or walk that the stream held (and the live state's water row, which says the same when water is near, is untouched).
const held = (changes: Partial<ActHandLine>): ActHandLine => ({ i: 1, do: 'go', status: 'stopped', line: 'go 止まった 道を見つけたが体は進まなかった・水の流れ 5', ...changes } as ActHandLine);
describe('a stream that holds the body is stopped at its source', () => {
  it('tells the planner what to do when go/walk do not move in a stream, with the reason, in one line, in the receipt', () => {
    expect(STREAM_WORDS).toContain('上流の 1 マスに dirt か cobblestone を place');
    expect(STREAM_WORDS).toContain('足の下も水でよい');
    expect(STREAM_WORDS.length).toBeLessThanOrEqual(110);
    for (const line of [held({}), held({ do: 'walk', line: 'walk 止 流れる水の中（(1,64,2) は 水の流れ 2）で 3秒ずつ進めない' }), held({ status: 'failed', line: 'go 止 流れる水の中で押し戻された' }),
      held({ line: 'go 止 時間切れ: 5秒進めず止まった。流れる水の中（(1,64,2) は 水の流れ 2）で押し戻された' })]) {
      expect(handFacts(line).join(' '), line.line).toContain(STREAM_WORDS);
    }
  });
  it('says nothing for a hand that went well, for another hand, for a stop with no stream, or when the body own line already names the blocks', () => {
    for (const line of [held({ status: 'done', line: 'go 済 (1,64,2) に着いた（水の流れ 1 を渡った）' }), held({ do: 'dig' }), held({ line: 'go 止まった 溶岩が流れ込む' }),
      // a bare 「水の流れ N」 is the cell she stands in: a stop for another cause while she wades gets no stream advice
      held({ line: 'go 止 敵が近い（足は 水の流れ 1）' }), held({ line: 'walk 止 反射（水の流れ 2 の中で溺れかけた）' }), held({ line: 'go 止 stopIf hostileWithin（そのマスは 水の流れ 1）' }),
      held({ do: 'walk', line: 'walk 止 時間切れ（そのマスは 水の流れ 3）' }),
      held({ line: 'go 止まった 流れる水の中で進めない。流れは dirt か cobblestone を 1 個持てば止められる（上流のマスに置く）' })]) {
      expect(handFacts(line).join(' '), line.line).not.toContain(STREAM_WORDS);
    }
  });
  it('is no longer a line of the instructions read at every decision', () => {
    expect(V2_ALWAYS).not.toMatch(/water flow N/i);
    expect(V2_ALWAYS).not.toMatch(/place (a )?dirt or cobblestone[^.]{0,40}upstream/i);
  });
});
