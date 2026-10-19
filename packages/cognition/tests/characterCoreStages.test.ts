import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AFFECTION_STAGES, CHARACTER_CORE, characterCoreBlock, characterCoreForStage, characterCoreHashInput } from '../src/index.js';

/** Her core by the stage of her affection (owner 2026-10-20): v2 itself at ツンデレ, a draft of each other stage until he approves it. */
const sections = (text: string) => Object.fromEntries(text.split(/\n(?=\d+\. )/u).map(part => [part.split('\n')[0]!, part]));

describe('the character core of each stage', () => {
  it('is v2 itself at ツンデレ, byte for byte', () => {
    expect(characterCoreForStage('tsundere')).toBe(CHARACTER_CORE);
  });

  it('is a versioned draft at every other stage, its hash the sha256 of its version, text and summary', () => {
    const pinned = {
      tsun: '02c0becb071d9444dca58b86d54a858d65bde2495e0ae8e60666ea62dc6bff40', dere: '0429090e4cc5df7ec37ab35f4d4142a9a5c9d463a3966a121a425b8dd1ffb7c3',
      deredere: 'b249eb2c47f81ea35ba6d93b41c4d02478200388a5782f8987daab2ad65aa187', devoted: '0b14ad5da10827ca837ecda8b36b3e96e61a41c96fd5306ea9c7337b3299bc17',
    } as const;
    for (const [stage, hash] of Object.entries(pinned) as [keyof typeof pinned, string][]) {
      const core = characterCoreForStage(stage);
      expect(core.version).toBe(`v2-${stage}`);
      expect(core.status).toBe('draft');
      expect(createHash('sha256').update(characterCoreHashInput(core)).digest('hex')).toBe(hash);
      expect(core.hash).toBe(hash);
      expect(characterCoreBlock(core)).toMatch(new RegExp(`^\\[ボクの性格の核 v2-${stage} #${hash.slice(0, 8)}\\]\\n`, 'u'));
    }
  });

  it('changes only the temperament and how fondness shows (and at 本気 also §2, §8 and §9); the rest is v2', () => {
    const v2 = sections(CHARACTER_CORE.text);
    for (const stage of AFFECTION_STAGES) {
      const own = sections(characterCoreForStage(stage).text);
      expect(Object.keys(own)).toEqual(Object.keys(v2));
      const changed = Object.keys(v2).filter(heading => own[heading] !== v2[heading]);
      const devoted = ['2. ライ氏との関係', '6. 気質', '7. 好意の見せ方', '8. 照れのしるし（本音がにじむ所）', '9. 怒る・すねる'];
      const expected = stage === 'tsundere' ? [] : stage === 'devoted' ? devoted : ['6. 気質', '7. 好意の見せ方'];
      expect(changed).toEqual(expected);
    }
  });

  it('keeps the owner\'s v2 decisions at every stage: her own mistake owned, her real no, a request done whatever her mood', () => {
    for (const stage of AFFECTION_STAGES) {
      const text = characterCoreForStage(stage).text;
      expect(text).toContain('自分のミスは、言い訳や言い返しを付けずに、そのまま認める。');
      expect(text).toMatch(/本当にいやな時は、可愛くまとめる余裕が無く、はっきり嫌がる。/u);
      expect(text).toContain('頼まれた手伝いは、機嫌とは別にちゃんとやる。');
      expect(text).not.toMatch(/必ず|してはいけない|胸を触られ|触られたら/u);
    }
  });

  it('at 本気 carries the portrait of the sandbox\'s (e), and no longer the play that pulled her back', () => {
    const text = characterCoreForStage('devoted').text;
    for (const line of ['心底惚れている', '「どこにいたの」', '捨てられるのが、本当に怖い', '忘れられることが怖い', 'どれくらい好き？', '「離れないで」「もう少しだけ」',
      '痛い所を突く一言', '「行かないで」がこぼれてしまう', '「べつに」は、もうほとんど出ない']) expect(text).toContain(line);
    expect(text).not.toContain('すねるのは遊び');
    expect(text).not.toContain('「べつに」「そんなことないし」と打ち消す');
    expect(text).not.toContain('基本は、ちょっとツンデレ');
    expect(characterCoreForStage('devoted').summary).toContain('心底惚れていて');
  });
});
