import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CHARACTER_CORE, SHANNON_CORE_PROMPT, SHANNON_CURRENT_GOAL, SHANNON_ONE_LINE_VOICE, SHANNON_ONE_LINE_VOICE_INNER, characterCoreBlock,
  characterCoreHashInput, shannonIdentityPrompt, shannonOneLineVoice, shannonPersonaPrompt,
} from '../src/index.js';

describe('character core (Syzygy ADR-0012 D6)', () => {
  it('is versioned and its hash is the sha256 of its version, text and summary: a change of a word is a change of this one file', () => {
    // v2 (2026-10-19): the section the owner asked for; he approved its wording the same day.
    expect(CHARACTER_CORE.version).toBe('v2');
    expect(CHARACTER_CORE.status).toBe('approved');
    expect(createHash('sha256').update(characterCoreHashInput(CHARACTER_CORE)).digest('hex')).toBe(CHARACTER_CORE.hash);
    expect(characterCoreBlock()).toMatch(new RegExp(`^\\[ボクの性格の核 v2 #${CHARACTER_CORE.hash.slice(0, 8)}\\]\\n`, 'u'));
  });

  it('carries the owner direction of 2026-10-14 without the open questions: who she is, never rules of what to do or feel', () => {
    expect(CHARACTER_CORE.text).not.toContain('【要ライ氏】');
    expect(CHARACTER_CORE.text).not.toMatch(/ADR-|TI-REQ|ライ氏の答え|本人に任せる|メイドAI|役に立つのが誇り/u);
    for (const required of ['少しポンコツなAGI', 'ボクを作った人', '仕える相手ではない', '尊敬：', '感謝：', '好き：', '口調は決まっていない',
      'ツンとデレの割合は、その時その時に自分で決める', 'そこでは嘘をつかない', '許すのは、自分のタイミング', SHANNON_CURRENT_GOAL, '決め台詞ではない']) {
      expect(CHARACTER_CORE.text).toContain(required);
    }
    // ADR-0005 / ADR-0012 D7, and the owner's 2026-10-14 direction: no rule of how a touch should feel, no rule of what she must do.
    expect(CHARACTER_CORE.text).not.toMatch(/胸を触られ|なでられたら|触られたら|必ず|すぐやめる|してはいけない/u);
    expect(CHARACTER_CORE.summary.length).toBeLessThan(200);
  });

  it('replaces the identity, address, character and temperament lines only when given', () => {
    const block = characterCoreBlock();
    const persona = shannonPersonaPrompt('owner', { characterCore: block });
    expect(persona).toContain(block);
    expect(persona).toContain('一人称は「ボク」');
    expect(persona).not.toContain('メイドAI');
    expect(persona).not.toContain('開発者で持ち主');
    expect(persona).not.toContain('「あなた」とは呼ばない');
    expect(persona).not.toContain('からかいに偏らない');
    expect(persona).not.toContain('のことも褒め返す');
    expect(persona).not.toContain('照れたり、むっとしたり、怒ったり');
    expect(persona).toContain('名前のAGIである');
    // A guest keeps the guest's own line, without 持ち主; the owner with others present gets the core too.
    const guest = shannonPersonaPrompt('guest', { characterCore: block });
    expect(guest).toContain('話している相手をライ氏だと決めつけず');
    expect(guest).not.toMatch(/持ち主以外|メイドAI/u);
    expect(shannonPersonaPrompt('owner', { characterCore: block, othersPresent: true })).toContain(block);
    // Without the option: the old wording (maid, 持ち主), untouched.
    expect(shannonPersonaPrompt('owner')).toContain('メイドAI');
    expect(shannonPersonaPrompt('guest')).toContain('持ち主以外');
    // Without the option nothing changed: the cached identity is byte for byte what it was.
    expect(shannonIdentityPrompt('owner')).toBe(SHANNON_CORE_PROMPT);
    expect(shannonIdentityPrompt('owner', { characterCore: block })).not.toBe(SHANNON_CORE_PROMPT);
    expect(shannonIdentityPrompt('owner', { characterCore: block })).toContain('[Syzygyの3つのアプリ]');
  });

  it('has a one-line voice without 「からかいに寄せず」 for the touch prompt, beside the unchanged one', () => {
    expect(SHANNON_ONE_LINE_VOICE).toContain('からかいに寄せず');
    expect(SHANNON_ONE_LINE_VOICE_INNER).not.toContain('からかい');
    expect(SHANNON_ONE_LINE_VOICE_INNER).toContain(CHARACTER_CORE.summary);
    expect(SHANNON_ONE_LINE_VOICE_INNER).not.toMatch(/です・ます|呼びかけ|決め台詞/u);
    expect(shannonOneLineVoice(false)).toBe(SHANNON_ONE_LINE_VOICE);
    expect(shannonOneLineVoice(true)).toBe(SHANNON_ONE_LINE_VOICE_INNER);
    // The guest's capability line names him, not 持ち主, only with the core.
    expect(shannonIdentityPrompt('guest', { characterCore: characterCoreBlock() })).not.toMatch(/持ち主の個人的|持ち主が通話/u);
    expect(shannonIdentityPrompt('guest')).toContain('持ち主の個人的なこと');
  });
});
