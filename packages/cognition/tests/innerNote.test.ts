import { describe, expect, it } from 'vitest';
import {
  CHARACTER_CORE, FALSEHOOD_LINE, INITIAL_SHANNON_EXPRESSIVE_EMOTION, INNER_NOTE_EXPRESSIVE_LINE, INNER_NOTE_HONESTY_LINE, LIGHT_SULKING_LINE,
  innerNoteExpired, innerNoteExpressiveEmotionPrompt, INNER_NOTE_REFLECTION_SCHEMA, INNER_NOTE_UNPLEASANT_LINE,
  boundedUntil, buildExpressiveEmotionPrompt, gatedIntent, goodnightIn, innerNoteActive, innerNoteDay, innerNoteFace,
  innerNoteReflectionInput, innerNoteReflectionInstructions, innerNoteRouteSummary, innerNoteTouchBlock, innerNoteTurnBlock,
  apologyIn, lingeringFeelingLine, parsedInnerNoteReflection, settleInnerNote, teasingIn, withoutOwnApology,
  type InnerNote, type InnerNoteDraft,
} from '../src/index.js';

const AT = '2026-10-14T13:30:00.000Z'; // 22:30 in Tokyo

function note(overrides: Partial<InnerNote['hooks']> = {}, extra: Partial<InnerNote> = {}): InnerNote {
  return {
    id: 'n1', sequence: 1, dayId: 'n1', dayKey: '2026-10-14', dayEndsAt: '2026-10-14T18:00:00.000Z',
    text: { honne: 'びっくりした。いやってほどじゃない。', tatemae: 'ツンとして口数を減らす。', reason: '簡単に許したら安く見られる。',
      plan: '今日はこのまま。', bottom: 'ライ氏のことは好きなまま。困っていたらすぐ助ける。' },
    hooks: { shown: 'sulky', tell: 'blush', until: '2026-10-14T14:00:00.000Z', scale: 'ordinary', dayReason: null, intent: 'keep',
      routeSummary: 'Shannon is acting a little sulky and cool, but is not truly hurt.', ...overrides },
    triggers: ['touch'], changeReason: null, summary: null, flags: {}, createdAt: '2026-10-14T13:20:00.000Z', replacedAt: null, closedAt: null,
    coreVersion: CHARACTER_CORE.version, episodeStartedAt: '2026-10-14T13:20:00.000Z', ...extra,
  };
}

function draft(overrides: Partial<InnerNoteDraft> = {}): InnerNoteDraft {
  return {
    text: note().text, shown: 'sulky', tell: 'none', intent: 'keep', scale: 'ordinary', dayReason: null, untilMinutes: 20, changeReason: null,
    routeSummary: 'Shannon is sulking a little.', summary: null, ...overrides,
  };
}

describe('inner note gates (ADR-0012 D2, D4)', () => {
  it('moves intent at most one step toward letting go per apology or kindness', () => {
    expect(gatedIntent('keep', 'none', ['apology'])).toEqual({ intent: 'soften', stopped: true });
    expect(gatedIntent('keep', 'forgive', ['kindness'])).toEqual({ intent: 'soften', stopped: true });
    expect(gatedIntent('soften', 'forgive', ['apology'])).toEqual({ intent: 'forgive', stopped: false });
    // Toward keeping, or a new note without a previous one, is free.
    expect(gatedIntent('forgive', 'keep', ['touch'])).toEqual({ intent: 'keep', stopped: false });
    expect(gatedIntent(null, 'none', ['apology'])).toEqual({ intent: 'none', stopped: false });
    // Time passing (until) is her own reason.
    expect(gatedIntent('keep', 'none', ['until'])).toEqual({ intent: 'none', stopped: false });
  });

  it('caps an ordinary sulk at an hour and a day sulk at the end of her day', () => {
    const end = '2026-10-14T18:00:00.000Z';
    expect(boundedUntil('ordinary', 30, AT, end)).toEqual({ until: '2026-10-14T14:00:00.000Z', clamped: false });
    expect(boundedUntil('ordinary', 240, AT, end)).toEqual({ until: '2026-10-14T14:30:00.000Z', clamped: true });
    expect(boundedUntil('day', 600, AT, end)).toEqual({ until: end, clamped: true });
    expect(boundedUntil('day', 60, AT, end)).toEqual({ until: '2026-10-14T14:30:00.000Z', clamped: false });
    expect(boundedUntil('ordinary', null, AT, end)).toEqual({ until: null, clamped: false });
    expect(boundedUntil('ordinary', -5, AT, end)).toEqual({ until: null, clamped: false });
  });

  it('settles a draft: day only with a reason, the one-step gate, drift marks, and a calm close at day end', () => {
    const base = { at: AT, dayEndsAt: '2026-10-14T18:00:00.000Z', holding: 0.5, visibleFrom: 0.3 };
    const day = settleInnerNote({ ...base, draft: draft({ scale: 'day', dayReason: null, untilMinutes: 300 }), previous: null, triggers: ['touch'] });
    expect(day.hooks.scale).toBe('ordinary');
    expect(day.flags).toEqual({ dayDowngraded: true, untilClamped: true });
    const intentional = settleInnerNote({ ...base, draft: draft({ scale: 'day', dayReason: 'intentional', untilMinutes: 300 }), previous: null, triggers: ['touch'] });
    expect(intentional.hooks).toMatchObject({ scale: 'day', dayReason: 'intentional', until: '2026-10-14T18:00:00.000Z' });
    const forgiven = settleInnerNote({ ...base, draft: draft({ intent: 'none' }), previous: note(), triggers: ['apology'] });
    expect(forgiven.hooks.intent).toBe('soften');
    expect(forgiven.flags).toMatchObject({ gateStopped: true, apologyOnlyReason: true });
    const ownReason = settleInnerNote({ ...base, holding: 0.1, draft: draft({ intent: 'soften', changeReason: '時間がたって、もうそこまで怒っていない' }),
      previous: note(), triggers: ['apology'] });
    expect(ownReason.flags).toEqual({});
    const high = settleInnerNote({ ...base, draft: draft({ intent: 'forgive' }), previous: note({ intent: 'soften' }), triggers: ['kindness'] });
    expect(high.flags.forgaveWhileHigh).toBe(true);
    const closing = settleInnerNote({ ...base, draft: draft({ intent: 'keep', untilMinutes: 30 }), previous: note(), triggers: ['day_end'] });
    expect(closing.hooks).toMatchObject({ intent: 'none', until: null, tell: 'none', scale: 'ordinary' });
  });

  it('caps an ordinary sulk at an hour from its episode start, whatever a rewrite says (H2)', () => {
    const base = { dayEndsAt: '2026-10-14T18:00:00.000Z', holding: 0, visibleFrom: 0.3 };
    // Started at 22:20; at 22:50 she rewrites until +60: it is cut to 23:20, the episode's hour.
    const rewrite = settleInnerNote({ ...base, at: '2026-10-14T13:50:00.000Z', draft: draft({ untilMinutes: 60 }), previous: note(), triggers: ['until'] });
    expect(rewrite.hooks.until).toBe('2026-10-14T14:20:00.000Z');
    expect(rewrite.episodeStartedAt).toBe('2026-10-14T13:20:00.000Z');
    expect(rewrite.flags.untilClamped).toBe(true);
    // Past the hour, an ordinary sulk ends there.
    const past = settleInnerNote({ ...base, at: '2026-10-14T14:21:00.000Z', draft: draft({ untilMinutes: 30 }), previous: note(), triggers: ['until'] });
    expect(past.hooks).toMatchObject({ intent: 'none', until: null });
    expect(past.flags.capEnded).toBe(true);
    expect(past.episodeStartedAt).toBeNull();
    // A day sulk with a reason is not capped at the hour.
    const day = settleInnerNote({ ...base, at: '2026-10-14T14:21:00.000Z', draft: draft({ scale: 'day', dayReason: 'repeated', untilMinutes: 120 }), previous: note(), triggers: ['until'] });
    expect(day.hooks.intent).toBe('keep');
  });

  it('expires a sulk: until passed, or an ordinary one an hour from its start even without until (H2)', () => {
    const open = note({ until: null });
    expect(innerNoteActive(open, '2026-10-14T14:19:00.000Z')).toBe(true);
    expect(innerNoteActive(open, '2026-10-14T14:20:00.000Z')).toBe(false);
    expect(innerNoteExpired(open, '2026-10-14T14:20:00.000Z')).toBe(true);
    expect(innerNoteActive(note(), '2026-10-14T14:00:00.000Z')).toBe(false);
    expect(innerNoteExpired(note(), '2026-10-14T14:00:00.000Z')).toBe(true);
    expect(innerNoteActive(note({ scale: 'day', dayReason: 'intentional', until: null }), '2026-10-14T17:59:00.000Z')).toBe(true);
    expect(innerNoteExpired(note({ intent: 'none', until: null }), '2026-10-14T14:20:00.000Z')).toBe(false);
  });
});

describe('her day (ADR-0012 D4)', () => {
  it('ends at 3:00 in the owner time zone; 0:00–3:00 belongs to the day before', () => {
    expect(innerNoteDay('2026-10-14T13:30:00.000Z')).toEqual({ dayKey: '2026-10-14', endsAt: '2026-10-14T18:00:00.000Z' });
    // 00:36 JST on the 15th is still the 14th's day.
    expect(innerNoteDay('2026-10-14T15:36:00.000Z')).toEqual({ dayKey: '2026-10-14', endsAt: '2026-10-14T18:00:00.000Z' });
    expect(innerNoteDay('2026-10-14T18:00:00.000Z')).toEqual({ dayKey: '2026-10-15', endsAt: '2026-10-15T18:00:00.000Z' });
    expect(innerNoteDay('2026-07-01T12:00:00.000Z', 'America/New_York').endsAt).toBe('2026-07-02T07:00:00.000Z');
  });
});

describe('readers (ADR-0012 D2.5)', () => {
  it('gives the owner the whole note, others only what she shows, a guest nothing', () => {
    const owner = innerNoteTurnBlock(note(), 'owner', AT);
    expect(owner).toContain('本音: びっくりした');
    expect(owner).toContain('見せる気持ち: sulky（本音が少しにじむ: 頬が赤くなる） / 23:00ごろまで');
    // Owner, 2026-10-14: no rule of behavior in her prompt; what must happen whatever her mood is guaranteed in code.
    expect(owner).not.toMatch(/すねていても|必ず|謝らない|罪悪感/u);
    const others = innerNoteTurnBlock(note(), 'others', AT);
    expect(others).toBe('[いまの見せ方]（ほかの人もいる場）見せる気持ち: sulky');
    expect(others).not.toContain('びっくり');
    expect(innerNoteTurnBlock(note(), 'guest', AT)).toBe('');
    expect(innerNoteTurnBlock(null, 'owner', AT)).toBe('');
    // A closed day, or a note past its day, is not read.
    expect(innerNoteTurnBlock(note({}, { closedAt: AT }), 'owner', AT)).toBe('');
    expect(innerNoteTurnBlock(note(), 'owner', '2026-10-14T18:00:00.000Z')).toBe('');
  });

  it('gives an expired sulk only as what she felt a while ago, never as now, and not to Jev (N1)', () => {
    const expired = note({ until: '2026-10-14T13:25:00.000Z' });
    const block = innerNoteTurnBlock(expired, 'owner', AT);
    expect(block).toMatch(/^\[さっきまでの気持ち\]/u);
    expect(block).not.toContain('いまの自分の気持ち');
    expect(block).not.toContain('見せる気持ち');
    expect(innerNoteTouchBlock(expired, 'owner', AT)).toMatch(/^\[さっきまでの気持ち\]/u);
    expect(innerNoteTurnBlock(expired, 'others', AT)).toBe('');
    expect(innerNoteRouteSummary(expired, AT)).toBeUndefined();
    // A calm note is how she is now.
    expect(innerNoteTurnBlock(note({ intent: 'none', until: null }), 'owner', AT)).toContain('いまの自分の気持ち');
  });

  it('lists what happened after the note as facts', () => {
    const block = innerNoteTurnBlock(note({ intent: 'none', until: null }), 'owner', AT, [{ kind: 'apology', at: '2026-10-14T13:29:00.000Z', words: 'ごめん' }]);
    expect(block).toContain('このメモのあとに起きたこと');
    expect(block).toContain('22:29（1分前） ライ氏が謝った: 「ごめん」');
  });

  it('gives the touch prompt a short form and Jev only an ASCII line', () => {
    expect(innerNoteTouchBlock(note(), 'owner', AT)).toContain('- 建て前: ツンとして口数を減らす。');
    expect(innerNoteTouchBlock(note(), 'others', AT)).not.toContain('本音');
    expect(innerNoteRouteSummary(note({ routeSummary: 'Shannon sulks 少し.' }), AT)).toBe('Shannon sulks .');
    expect(innerNoteRouteSummary(note(), '2026-10-15T00:00:00.000Z')).toBeUndefined();
  });

  it('shows the face while the note is active, and her own 「ごめん」 does not take it', () => {
    expect(innerNoteActive(note(), AT)).toBe(true);
    expect(innerNoteFace(note(), AT)).toEqual({ shown: 'sulky', tell: 'blush', until: '2026-10-14T14:00:00.000Z' });
    expect(innerNoteFace(note({ intent: 'none', until: null }), AT)).toBeNull();
    const sorry = { ...INITIAL_SHANNON_EXPRESSIVE_EMOTION, primary: 'apologetic' as const, intensity: 0.52, secondary: ['surprised' as const] };
    expect(withoutOwnApology(sorry, note(), AT).primary).toBe('sulky');
    // Decided by herself, an override, or no active note: as it was.
    expect(withoutOwnApology(sorry, note(), AT, { primary: 'apologetic', intensity: 0.6 })).toBe(sorry);
    expect(withoutOwnApology({ ...sorry, overrideReason: 'safety' }, note(), AT).primary).toBe('apologetic');
    expect(withoutOwnApology(sorry, null, AT)).toBe(sorry);
    // A tool of the turn failed: the apology may be hers to make (M3).
    expect(withoutOwnApology(sorry, note(), AT, undefined, true)).toBe(sorry);
  });
});

describe('the reflection', () => {
  it('has fixed instructions with the core, and its facts only in the input', () => {
    const instructions = innerNoteReflectionInstructions();
    expect(instructions).toBe(innerNoteReflectionInstructions());
    expect(instructions).toContain(CHARACTER_CORE.text);
    expect(instructions).toContain('1回では、この順に1段までしか動かない（仕組み）');
    expect(instructions).not.toMatch(/すねないもの|必ずする|謝らない|すぐやめる|事故で触れ/u);
    const input = innerNoteReflectionInput({
      at: AT, timeZone: 'Asia/Tokyo', previous: note(), apologies: ['2026-10-14T13:25:00.000Z', '2026-10-14T13:29:00.000Z'], kindnesses: [],
      events: [{ kind: 'touch', at: '2026-10-14T13:28:00.000Z', touch: { phrase: 'ライ氏に胸をつつかれた', stance: 'dislike', reflex: 'flinch', said: 'ひゃっ' } }],
      feeling: { present: { kind: 'surprised', intensity: 0.62 }, lingering: [{ kind: 'sulky', strength: 0.4 }] }, dayEndsAt: '2026-10-14T18:00:00.000Z',
      closing: false, yesterday: null, recent: [{ role: 'user', content: 'ごめん' }],
    });
    expect(input).toContain('ライ氏の謝罪: 2回（22:25、22:29）');
    expect(input).toContain('体: ライ氏に胸をつつかれた（体が反射で小さく身を引いた）。ボクの受け取り: いや。ボクの一言「ひゃっ」');
    expect(input).toContain('今日の終わりまで、あと4時間30分');
    expect(INNER_NOTE_REFLECTION_SCHEMA.required).toContain('route_summary');
  });

  it('reads an answer and refuses one without its text', () => {
    const answer = { honne: '本音', tatemae: '建て前', reason: '', plan: 'つもり', bottom: '底', shown: 'cuteAngry', tell: 'blush', intent: 'keep', scale: 'day',
      day_reason: 'intentional', until_minutes: 90.4, change_reason: null, route_summary: 'Sulking a bit; ライ氏', summary: null };
    expect(parsedInnerNoteReflection(answer)).toMatchObject({ shown: 'cuteAngry', scale: 'day', dayReason: 'intentional', untilMinutes: 90,
      routeSummary: 'Sulking a bit;' });
    expect(parsedInnerNoteReflection({ ...answer, honne: '' })).toBeNull();
    expect(parsedInnerNoteReflection({ ...answer, intent: 'maybe' })).toBeNull();
    expect(parsedInnerNoteReflection({ ...answer, shown: 'nope' })?.shown).toBe('neutral');
  });
});

describe('prompt cleanup lines only behind the switch (ADR-0012 D5.1)', () => {
  it('keeps the old wordings without the option', () => {
    const emotion = { ...INITIAL_SHANNON_EXPRESSIVE_EMOTION, primary: 'sulky' as const, intensity: 0.6 };
    // The replaced line must exist verbatim, so the inner-note wording can never silently fail to apply.
    expect(buildExpressiveEmotionPrompt(emotion, 'owner')).toContain(LIGHT_SULKING_LINE);
    expect(innerNoteExpressiveEmotionPrompt(emotion, 'owner')).toContain(INNER_NOTE_EXPRESSIVE_LINE);
    expect(innerNoteExpressiveEmotionPrompt(emotion, 'owner')).not.toContain('must stay light');
    expect(buildExpressiveEmotionPrompt(emotion, 'owner')).toContain(FALSEHOOD_LINE);
    expect(innerNoteExpressiveEmotionPrompt(emotion, 'owner')).toContain(INNER_NOTE_HONESTY_LINE);
    expect(innerNoteExpressiveEmotionPrompt(emotion, 'others').replace(INNER_NOTE_EXPRESSIVE_LINE, LIGHT_SULKING_LINE)
      .replace(INNER_NOTE_HONESTY_LINE, FALSEHOOD_LINE)).toBe(buildExpressiveEmotionPrompt(emotion, 'others'));
    expect(INNER_NOTE_UNPLEASANT_LINE).toContain('心のメモ');
    expect(INNER_NOTE_UNPLEASANT_LINE).not.toContain('謝罪');
    expect(lingeringFeelingLine({ emotionClock: undefined, lingering: [] } as never, AT, undefined, { innerNote: true })).toBe('');
  });

  it('reads a tease and a goodnight in short messages only', () => {
    expect(teasingIn('ほんとポンコツだなあ')).toBe(true);
    expect(teasingIn('シャノンってほんとポンコツだよね（笑）')).toBe(true);
    expect(teasingIn('今日の天気は？')).toBe(false);
    // M2: words that are not about her.
    for (const plain of ['バカみたいに暑い', 'アホほど忙しい', 'ばかうけ', '俺ってバカだな', 'このアプリポンコツすぎ', 'シャノン、俺ってバカだな']) {
      expect(teasingIn(plain)).toBe(false);
    }
    for (const plain of ['ごめん、ちょっと待って', 'すみません、天気教えて']) expect(apologyIn(plain)).toBe(false);
    expect(apologyIn('ほんとにごめんって')).toBe(true);
    expect(apologyIn('ごめんごめん、言いすぎた')).toBe(true);
    expect(apologyIn('ごめん、嫌だった?')).toBe(true);
    for (const plain of ['寝る前に一個だけ聞いていい？', 'お休みの日って何してる？', 'おやすみモードにして']) expect(goodnightIn(plain)).toBe(false);
    expect(goodnightIn('おやすみ、シャノン')).toBe(true);
    expect(apologyIn('ごめん、出来心で')).toBe(true);
    expect(apologyIn('出来心だったんです、ごめん')).toBe(true);
    expect(apologyIn('今日の予定は？')).toBe(false);
    expect(goodnightIn('じゃあ、おやすみ')).toBe(true);
    expect(goodnightIn('そろそろ寝るね')).toBe(true);
    expect(goodnightIn('昨日おやすみって言ったけど、まだ起きてる')).toBe(false);
  });
});
