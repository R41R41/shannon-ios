import { describe, expect, it } from 'vitest';
import {
  FEELING_INTENSITIES, FEELING_REGISTERS, FEELING_STANCES, TEXT_REGISTER_LIMITS, bypassedTextRegister, checkReply, textPacingBypassIn,
  textRegisterFor, textRegisterLines, textRegisterMismatch,
} from '../src/index.js';

/** Item 10 (owner's choice 「B. 形＋間と分け方」): the form and pacing of a text reply from her feeling and composure. */
const alone = 'owner_alone' as const;

describe('the directive', () => {
  it('keeps an ordinary turn as it was: no length limit, no pause, no split', () => {
    expect(textRegisterFor({ stance: 'neutral', intensity: 'subtle', register: 'normal', audience: alone }))
      .toMatchObject({ length: 'free', maxCharacters: 0, pauseMs: 0, typingMs: 0, split: false });
  });

  it('is short, plain and a little late when she is miffed, and split in two', () => {
    const miffed = textRegisterFor({ stance: 'sulky', intensity: 'moderate', register: 'normal', audience: alone });
    expect(miffed).toMatchObject({ length: 'short', emoji: 'none', lineBreaks: false, split: true, pauseMs: 2_000, typingMs: 5_000 });
  });

  it('keeps quiet longest when she sulks, never past 20 s, whatever the stance, strength or register', () => {
    expect(textRegisterFor({ stance: 'sulk', intensity: 'strong', register: 'normal', audience: alone }).pauseMs).toBe(20_000);
    for (const stance of FEELING_STANCES) for (const intensity of FEELING_INTENSITIES) for (const register of FEELING_REGISTERS) {
      const directive = textRegisterFor({ stance, intensity, register, audience: alone });
      expect(directive.pauseMs).toBeLessThanOrEqual(TEXT_REGISTER_LIMITS.maximumPauseMilliseconds);
      expect(directive.pauseMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('lets warmth show in emoji with the owner alone, rarely in front of others; a worn composure drops them', () => {
    expect(textRegisterFor({ stance: 'shy', intensity: 'moderate', register: 'normal', audience: alone })).toMatchObject({ emoji: 'free', split: true });
    expect(textRegisterFor({ stance: 'shy', intensity: 'moderate', register: 'normal', audience: 'people' }).emoji).toBe('rare');
    const worn = textRegisterFor({ stance: 'neutral', intensity: 'subtle', register: 'curt', audience: alone });
    expect(worn).toMatchObject({ emoji: 'none', lineBreaks: false, endings: 'curt', maxCharacters: 80 });
  });

  it('is the form for the model, with no line to say', () => {
    const lines = textRegisterLines(textRegisterFor({ stance: 'sulk', intensity: 'moderate', register: 'normal', audience: alone }));
    expect(lines).toContain('[この番の書き方]');
    expect(lines).toContain('言葉はボクが決める');
    expect(lines).toContain('絵文字: 使わない');
  });
});

describe('what bypasses it', () => {
  it('urgent and safety words, his or hers', () => {
    expect(textPacingBypassIn('地震だ！', '')).toBe('urgent');
    expect(textPacingBypassIn('死にたい', '')).toBe('safety');
    expect(textPacingBypassIn('怒ってる？', '別に。')).toBeNull();
  });

  it('a bypassed reply is delivered at once, whole, and a system notice without emoji', () => {
    const sulk = textRegisterFor({ stance: 'sulk', intensity: 'strong', register: 'normal', audience: alone });
    expect(bypassedTextRegister(sulk, 'promise')).toMatchObject({ pauseMs: 0, typingMs: 0, split: false });
    const warm = textRegisterFor({ stance: 'shy', intensity: 'subtle', register: 'normal', audience: alone });
    expect(bypassedTextRegister(warm, 'system').emoji).toBe('none');
  });
});

describe('the reply check (D8): the form against her state', () => {
  const form = { maxCharacters: 30, emoji: 'none' as const, lineBreaks: false };
  it('finds emoji where none, far too long, or line breaks', () => {
    expect(textRegisterMismatch('別に。😊', form)).toBe(true);
    expect(textRegisterMismatch('あ'.repeat(60), form)).toBe(true);
    expect(textRegisterMismatch('別に。\n怒ってません。', form)).toBe(true);
    expect(textRegisterMismatch('別に。怒ってません。', form)).toBe(false);
  });

  it('flags it only when the form is known', () => {
    const context = { stance: 'sulky' as const, intensity: 'moderate' as const, audience: alone, order: false, violation: false };
    expect(checkReply('別に。😊', context)).not.toContain('text_register_mismatch');
    expect(checkReply('別に。😊', { ...context, form })).toContain('text_register_mismatch');
  });
});
