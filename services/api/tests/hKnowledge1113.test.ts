import { describe, expect, it } from 'vitest';
import { expandShortAct, SHORT_ACT_DESCRIPTION } from '../src/contracts/minecraftActShortContract.js';
import { handToLine, lineToHand } from '../src/contracts/minecraftActShortHands.js';
import { handProblem } from '../src/contracts/minecraftActHandRules.js';
import { oreRouteHands } from '../src/surfaces/minecraft/minecraftOreRoute.js';
import { goBlocksProblem } from '../src/surfaces/minecraft/minecraftLlmcGoGuard.js';
import { VERTICAL_STOP_WORDS } from '../src/surfaces/minecraft/minecraftLlmcResultWords.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

// 11/13 (h-knowledge): exposeOk on mine and vertical, the stair to a diamond mark from where the stair has to start, and the words of the stages.
describe('exposeOk on mine and vertical (M6)', () => {
  it('a short mine and a short vertical with exposeOk become exposeOk: true in the act, pass the hand rules, and read back', () => {
    const mine = expandShortAct({ hands: ['mine iron_ore 1,2,3 count=3 exposeOk'], why: 't' });
    const vertical = expandShortAct({ hands: ['vertical down stairs north y=16 dig=stone liquid=seal place=cobblestone exposeOk'], why: 't' });
    expect(mine.errors).toEqual([]);
    expect(vertical.errors).toEqual([]);
    const hands = [...(mine.input as { hands: Array<Record<string, unknown>> }).hands, ...(vertical.input as { hands: Array<Record<string, unknown>> }).hands];
    expect(hands.map(hand => hand.exposeOk)).toEqual([true, true]);
    for (const hand of hands) expect(handProblem(hand as never)).toBeNull();
    for (const line of ['mine iron_ore 1,2,3 count=3 exposeOk', 'vertical down stairs north y=16 dig=stone liquid=seal place=cobblestone exposeOk']) {
      const hand = lineToHand(line);
      expect('error' in hand).toBe(false);
      expect(handToLine(hand as never)).toContain('exposeOk');
    }
    expect(SHORT_ACT_DESCRIPTION).toContain('[collect=false] [exposeOk]');
    expect(SHORT_ACT_DESCRIPTION).toContain('[range=1|2] [exposeOk]');
  });
});

describe('the stair to a diamond mark (M7) and the seal of the descent (G4)', () => {
  const mark = 'd ダイヤ[deepslate_diamond_ore] (10,-50,20) 北3・下100 ×2 見えている';
  const at = { position: { x: 3.5, y: 64, z: 101.5 } };
  it('uses the mark\'s y as toY and starts the stair where it ends beside the mark (north: the start is the drop south of the mark)', () => {
    const text = oreRouteHands({ ...at, mapLandmarks: [mark] }, 'diamond')!;
    expect(text).toContain('「go 10,64,134 ');   // z 20 + (64 - -50) = 134
    expect(text).toContain('「vertical down stairs north y=-50 ');
    expect(text).toContain('「mine deepslate_diamond_ore 10,-50,20 count=3」');
    expect(text.indexOf('「go ')).toBeLessThan(text.indexOf('「vertical '));
    expect(text).not.toContain('y=-58');
    for (const line of [...text.matchAll(/「((?:go|vertical|mine) [^」]+)」/gu)].map(m => m[1]!)) {
      expect(expandShortAct({ hands: [line], why: 't' }).errors, line).toEqual([]);
    }
    const dig = /「go [^」]*? dig=([^ 」]+)/u.exec(text)![1]!.split(',');
    expect(goBlocksProblem({ canDig: dig })).toBeNull();
  });
  it('with no mark the default y=-58 stays; the stair and the shaft seal (cobblestone) and say when to stop', () => {
    const text = oreRouteHands(at, 'diamond')!;
    expect(text).toContain('y=-58');
    expect(text).toContain('liquid=seal place=cobblestone');
    expect(text).toContain('丸石が 20 個未満の時だけ liquid=stop');
    expect(oreRouteHands(at, 'iron')!).toContain('liquid=seal place=cobblestone');
  });
});

describe('the words of the stages and the results', () => {
  it('say what the 11/13 holes need', () => {
    expect(VERTICAL_STOP_WORDS.cannot_dig).toContain('同じ場所から canDig を足して続ける');
    const all = Object.values(V2_STAGES).join('\n');
    for (const piece of ['stairs は 1 段で向きへ 1 マス進む', 'obsidian X,Y,Z count=N maxDig=N', '黒曜石 n 個が (x,y,z) に未回収', '落ちた先 (x,y,z)・立てる所 (x,y,z)',
      'dependsOn' /* in the contract */ ].filter(piece => piece !== 'dependsOn')) expect(all, piece).toContain(piece);
    expect(V2_STAGES.nether).toContain('来た道（ゲートから）');
    expect(V2_STAGES.nether).toContain('立てる最寄り (x,y,z)');
    expect(V2_STAGES.pearl).toContain('seconds 120〜150');
    expect(V2_STAGES.pearl).toContain('アイが 13 個そろってから');
    expect(V2_STAGES.stronghold).toContain('dig at=そのマス で最初に 1 回壊す');
    expect(V2_STAGES.stronghold).toContain('枠の台の縁（立てる）');
    expect(V2_STAGES.stronghold).toContain('6 枠分並べ');
    expect(V2_STAGES.stronghold).toContain('地下の水の溜まりの中を掘る go には waterOk を付けない');
    expect(V2_STAGES.stronghold).toContain('枠の真上が海');
    expect(V2_STAGES.stronghold).toContain('感染石');
    expect(V2_STAGES.stronghold).not.toContain('目の無い枠ごとに 1 回の act');
    expect(SHORT_ACT_DESCRIPTION).toContain('次の決断まで約 T 秒');
  });
});
