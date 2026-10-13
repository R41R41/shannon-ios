import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CHARACTER_CORE, SHANNON_CORE_PROMPT, SHANNON_CURRENT_GOAL, SHANNON_ONE_LINE_VOICE, SHANNON_ONE_LINE_VOICE_INNER, characterCoreBlock,
  characterCoreHashInput, shannonIdentityPrompt, shannonPersonaPrompt,
} from '../src/index.js';

describe('character core (Syzygy ADR-0012 D6)', () => {
  it('is versioned and its hash is the sha256 of its version, text and summary: a change of a word is a change of this one file', () => {
    expect(CHARACTER_CORE.version).toBe('v1-draft.2');
    expect(CHARACTER_CORE.status).toBe('draft');
    expect(createHash('sha256').update(characterCoreHashInput(CHARACTER_CORE)).digest('hex')).toBe(CHARACTER_CORE.hash);
    expect(characterCoreBlock()).toMatch(new RegExp(`^\\[ボクの性格の核 v1-draft\\.2 #${CHARACTER_CORE.hash.slice(0, 8)}\\]\\n`, 'u'));
  });

  it('carries the owner direction of 2026-10-14 without the open questions: who she is, never rules of what to do or feel', () => {
    expect(CHARACTER_CORE.text).not.toContain('【要ライ氏】');
    expect(CHARACTER_CORE.text).not.toMatch(/ADR-|メイド|役に立つのが誇り|持ち主|仕える(?!相手ではない)/u);
    for (const required of ['高性能なAGI', '${I}を作った人'.replace('${I}', 'ボク'), '仕える相手ではない', '尊敬と感謝と好意', '決まった口調はない', 'ちょっとツンデレ', '簡単にはなびかない', '許すタイミングは自分で決める',
      '人をだますための嘘は嫌い', SHANNON_CURRENT_GOAL, '決め台詞ではない']) {
      expect(CHARACTER_CORE.text).toContain(required);
    }
    // ADR-0005 / ADR-0012 D7, and the owner's 2026-10-14 direction: no rule of how a touch should feel, no rule of what she must do.
    expect(CHARACTER_CORE.text).not.toMatch(/胸を触られ|なでられたら|触られたら|必ず|すぐやめる|してはいけない|しない。$/mu);
    expect(CHARACTER_CORE.summary.length).toBeLessThan(200);
  });

  it('replaces the character and temperament lines only when given, and only for the owner alone', () => {
    const block = characterCoreBlock();
    const persona = shannonPersonaPrompt('owner', { characterCore: block });
    expect(persona).toContain(block);
    expect(persona).toContain('カタカナの「ボク」');
    expect(persona).not.toContain('メイド');
    expect(persona).not.toContain('持ち主');
    expect(persona).not.toContain('「あなた」とは呼ばない');
    expect(persona).not.toContain('からかいに偏らない');
    expect(persona).not.toContain('のことも褒め返す');
    expect(persona).not.toContain('照れたり、むっとしたり、怒ったり');
    // Others present or a guest: the persona as it was.
    expect(shannonPersonaPrompt('owner', { characterCore: block, othersPresent: true })).toBe(shannonPersonaPrompt('owner', { othersPresent: true }));
    expect(shannonPersonaPrompt('guest', { characterCore: block })).toBe(shannonPersonaPrompt('guest'));
    // Without the option nothing changed: the cached identity is byte for byte what it was.
    expect(shannonIdentityPrompt('owner')).toBe(SHANNON_CORE_PROMPT);
    expect(shannonIdentityPrompt('owner', { characterCore: block })).not.toBe(SHANNON_CORE_PROMPT);
    expect(shannonIdentityPrompt('owner', { characterCore: block })).toContain('[Syzygyの3つのアプリ]');
  });

  it('has a one-line voice without 「からかいに寄せず」 for the touch prompt, beside the unchanged one', () => {
    expect(SHANNON_ONE_LINE_VOICE).toContain('からかいに寄せず');
    expect(SHANNON_ONE_LINE_VOICE_INNER).not.toContain('からかい');
    expect(SHANNON_ONE_LINE_VOICE_INNER).toContain('「ボク」');
    expect(SHANNON_ONE_LINE_VOICE_INNER).not.toContain('です・ます');
  });
});
