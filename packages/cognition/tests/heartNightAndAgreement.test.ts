import { describe, expect, it } from 'vitest';
import {
  CHARACTER_CORE, LINGERING_UNDERTONE_LINE, SHANNON_EMOTION_TIME, lingeringFeelingLine, livingLingering, nightsBetween, overnightRemaining,
  touchAgreementIn, type ShannonLingeringFeeling,
} from '../src/index.js';

const HOUR = 3_600_000;
/** 2026-10-14 17:45 JST, the poke that started five days of 「むっと」. */
const POKED = '2026-10-14T08:45:00.000Z';
const at = (hoursLater: number) => new Date(Date.parse(POKED) + hoursLater * HOUR).toISOString();

const sulk = (extra: Partial<ShannonLingeringFeeling> = {}): ShannonLingeringFeeling => ({
  kind: 'annoyed', target: 'ライ氏', cause: 'ライ氏に腰をつつかれた', span: 'lingering', strength: 0.9, awakeAt: 0, startedAwakeAt: 0,
  startedAt: POKED, ...extra,
});

describe('a night fades what lingers (owner 2026-10-19)', () => {
  it('counts the nights by her day ending at 3:00 in his time zone', () => {
    expect(nightsBetween(POKED, at(5))).toBe(0); // 22:45 the same evening
    expect(nightsBetween(POKED, at(10))).toBe(1); // 03:45 the next morning
    expect(nightsBetween(POKED, at(5 * 24))).toBe(5);
    expect(nightsBetween(at(10), POKED)).toBe(0);
  });

  it('halves a strong sulk each night: a little the next morning, out of sight after two nights, settled after three', () => {
    expect(overnightRemaining(POKED, at(24), SHANNON_EMOTION_TIME)).toBeCloseTo(0.5);
    expect(overnightRemaining(POKED, at(24), { overnightShare: undefined })).toBe(1);
    // Her awake clock stood still all the while (she was dormant): before this change it stayed 0.9 for four days.
    const state = (hours: number) => ({ emotionClock: { awakeMs: 0, at: at(hours) }, lingering: [sulk()] });
    expect(livingLingering(state(24), at(24), SHANNON_EMOTION_TIME)[0]?.strength).toBeCloseTo(0.45);
    expect(livingLingering(state(48), at(48), SHANNON_EMOTION_TIME)[0]?.strength).toBeCloseTo(0.225);
    expect(livingLingering(state(72), at(72), SHANNON_EMOTION_TIME)).toEqual([]);
  });

  it('counts the nights from when it was last noted, not from when it began', () => {
    const renewed = sulk({ notedAt: at(24) });
    const [left] = livingLingering({ emotionClock: { awakeMs: 0, at: at(25) }, lingering: [renewed] }, at(25), SHANNON_EMOTION_TIME);
    expect(left?.strength).toBeCloseTo(0.9);
  });

  it('tells nothing that no longer shows, and what still shows only as an undertone of the voice', () => {
    const now = at(2);
    const line = lingeringFeelingLine({ emotionClock: { awakeMs: 0, at: now }, lingering: [sulk()] }, now, SHANNON_EMOTION_TIME, { innerNote: true });
    expect(line).toContain('まだ残っている気持ち');
    expect(line).toContain(LINGERING_UNDERTONE_LINE);
    expect(line).toContain('頼まれた調べものや手伝いは、気持ちとは別にちゃんとやる');
    const twoNights = at(48);
    expect(lingeringFeelingLine({ emotionClock: { awakeMs: 0, at: twoNights }, lingering: [sulk()] }, twoNights, SHANNON_EMOTION_TIME)).toBe('');
  });
});

describe('what the exchange before a touch agreed (owner 2026-10-19)', () => {
  it('reads her yes to his asking, and his telling her he is about to', () => {
    expect(touchAgreementIn('うーん、じゃあもうちょっと触ってもいい?', 'ライ氏、もちろんいいですよ。えへへ、どうぞ。')).toBe('permitted');
    expect(touchAgreementIn('頭ヨシヨシしていいかな?', 'ライ氏、ヨシヨシ、どうぞ。')).toBe('permitted');
    expect(touchAgreementIn('じゃあ、よしよしするね。', 'ライ氏、よしよし、どうぞ。')).toBe('announced');
    expect(touchAgreementIn('じゃあ、手繋ぐね。', 'ライ氏、手を繋ぐのはいいですよ。')).toBe('announced');
  });

  it('reads nothing of a refusal, of a question about something else, or of a past touch', () => {
    expect(touchAgreementIn('胸触ってもいい?', 'だめです。')).toBeNull();
    expect(touchAgreementIn('このファイル触っていい？', 'どうぞ')).toBeNull();
    expect(touchAgreementIn('今撫でられてるのわかった?', 'わかりましたよ')).toBeNull();
    expect(touchAgreementIn('元気？', '元気です')).toBeNull();
  });
});

describe('character core v2 (owner 2026-10-19)', () => {
  it('owns her mistakes without a counter-attack, keeps a feeling from before in her voice, and feels her body', () => {
    expect(CHARACTER_CORE.text).toContain('自分のミスは、言い訳や言い返しを付けずに、そのまま認める');
    expect(CHARACTER_CORE.text).toContain('気持ちは本物でも、それで誰が悪いかが決まるわけではない');
    expect(CHARACTER_CORE.text).toContain('声の調子や間ににじむくらい');
    expect(CHARACTER_CORE.text).toContain('画面の上で体ごと動かされるのは、運ばれているだけ');
    expect(CHARACTER_CORE.text).not.toContain('失敗すると慌てて言い訳をして');
  });
});
