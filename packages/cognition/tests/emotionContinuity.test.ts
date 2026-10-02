import { describe, expect, it, vi } from 'vitest';
import {
  SHANNON_EMOTION_CONTINUITY,
  SHANNON_EMOTION_CUE_STRENGTH,
  SHANNON_EMOTION_TIME,
  advanceEmotionClock,
  awakeTimeAt,
  buildCompanionStatePrompt,
  createInitialCompanionState,
  deriveEmotionDelta,
  faceForMood,
  holdsFeelingThroughTouch,
  holdsShannonFeeling,
  lingeringFeelingLine,
  lingeringMeaning,
  livingLingering,
  moodBaseline,
  presentShannonFeeling,
  presentShannonMood,
  reduceCompanionState,
  remainingShare,
  resolveReplyEmotion,
  resolveWrittenReplyEmotion,
  restoreCompanionState,
  soothingIn,
  type CompanionStateSnapshot,
  type ShannonEmotionTiming,
} from '../src/index.js';

// Long simulated conversations on a loaded machine: the default five seconds says nothing about the code.
vi.setConfig({ testTimeout: 30_000 });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 23:00 in the owner's zone. */
const NIGHT = '2026-10-01T14:00:00.000Z';
const at = (from: string, milliseconds: number) => new Date(Date.parse(from) + milliseconds).toISOString();
const MORNING = at(NIGHT, 9 * HOUR);
const AWAKE = SHANNON_EMOTION_TIME;
const WALL: ShannonEmotionTiming = { ...SHANNON_EMOTION_TIME, clock: 'wall' };
const fresh = () => createInitialCompanionState('owner', NIGHT);

/** One owner turn as the server commits it: the reply's feeling, or only the awake clock when the reply is neutral. */
function turn(
  state: CompanionStateSnapshot, userMessage: string, reply: string, now: string,
  decided?: { primary: string; intensity: number }, timing = AWAKE,
) {
  const resolved = resolveReplyEmotion({ snapshot: state, userMessage, reply, now, timing, ...(decided ? { decided } : {}) });
  const next = reduceCompanionState(state, resolved.expressiveEmotion.primary === 'neutral'
    ? { type: 'awake-observed' } : { type: 'expressive-emotion-updated', emotion: resolved.expressiveEmotion }, now, timing);
  return { state: next, face: resolved.messageEmotion, feeling: resolved.expressiveEmotion };
}

/** She is awake from `from` for `minutes`: a content-free event every `every` minutes, as a session of her own gives. */
function awakeFor(state: CompanionStateSnapshot, from: string, minutes: number, every = 10, timing = AWAKE): CompanionStateSnapshot {
  let next = state;
  for (let passed = every; passed <= minutes; passed += every) {
    next = reduceCompanionState(next, { type: 'awake-observed' }, at(from, passed * MINUTE), timing);
  }
  return next;
}

const sulking = () => turn(fresh(), '今日はもう別のAIと話すね', 'ボク、ちょっとすねちゃいます。', NIGHT).state;

describe('the one table of time constants', () => {
  it('holds every duration of her feelings, in awake time', () => {
    expect(SHANNON_EMOTION_TIME).toEqual({
      clock: 'awake',
      idleCapMs: 12 * MINUTE,
      reactionHalfLifeMs: 2 * MINUTE,
      passingHalfLifeMs: 5 * MINUTE,
      moodHalfLifeMs: 90 * MINUTE,
      moodValueHalfLifeMs: 2 * HOUR,
      arousalHalfLifeMs: 30 * MINUTE,
      lingeringHalfLifeMs: 8 * HOUR,
      lingeringMaxWallMs: 4 * 24 * HOUR,
      easedHoldMs: 30 * MINUTE,
    });
    expect(remainingShare(0, HOUR)).toBe(1);
    expect(remainingShare(HOUR, HOUR)).toBeCloseTo(0.5);
    expect(remainingShare(3 * HOUR, HOUR)).toBeCloseTo(0.125);
    expect(remainingShare(-5, HOUR)).toBe(1);
    expect(remainingShare(HOUR, 0)).toBe(0);
  });

  it('gives the three layers the lengths the owner chose', () => {
    const settled = SHANNON_EMOTION_CONTINUITY.settledBelow;
    const lasts = (strength: number, halfLifeMs: number) => halfLifeMs * Math.log2(strength / settled);
    // The moment's reaction: minutes.
    expect(lasts(0.52, AWAKE.reactionHalfLifeMs)).toBeLessThan(5 * MINUTE);
    expect(lasts(0.9, AWAKE.passingHalfLifeMs)).toBeLessThan(30 * MINUTE);
    // Mood: a few awake hours.
    expect(lasts(0.52, AWAKE.moodHalfLifeMs)).toBeGreaterThan(2 * HOUR);
    expect(lasts(0.7, AWAKE.moodHalfLifeMs)).toBeLessThan(4 * HOUR);
    // What lingers: one to two awake days of sixteen hours.
    expect(lasts(0.72, AWAKE.lingeringHalfLifeMs)).toBeGreaterThan(16 * HOUR);
    expect(lasts(1, AWAKE.lingeringHalfLifeMs)).toBeLessThan(32 * HOUR);
  });
});

describe('her awake clock', () => {
  it('advances by the time since her last event, at most the idle cap, and never backwards', () => {
    const start = advanceEmotionClock(undefined, NIGHT, AWAKE);
    expect(start).toEqual({ clock: { awakeMs: 0, at: NIGHT }, elapsedMs: 0 });
    const soon = advanceEmotionClock(start.clock, at(NIGHT, 5 * MINUTE), AWAKE);
    expect(soon).toEqual({ clock: { awakeMs: 5 * MINUTE, at: at(NIGHT, 5 * MINUTE) }, elapsedMs: 5 * MINUTE });
    // Three hours of silence count as the idle cap: after that gap she was dormant.
    const late = advanceEmotionClock(soon.clock, at(NIGHT, 185 * MINUTE), AWAKE);
    expect(late.elapsedMs).toBe(12 * MINUTE);
    expect(late.clock).toEqual({ awakeMs: 17 * MINUTE, at: at(NIGHT, 185 * MINUTE) });
    // An event stamped earlier than the last one advances nothing and does not move the clock back.
    expect(advanceEmotionClock(late.clock, at(NIGHT, 180 * MINUTE), AWAKE)).toEqual({ clock: late.clock, elapsedMs: 0 });
    // A last event further ahead than the idle cap is a clock that was wrong: it is brought back, and nothing is counted.
    expect(advanceEmotionClock(late.clock, at(NIGHT, 60 * MINUTE), AWAKE)).toEqual({ clock: { awakeMs: 17 * MINUTE, at: at(NIGHT, 60 * MINUTE) }, elapsedMs: 0 });
    expect(advanceEmotionClock(late.clock, 'not a time', AWAKE)).toEqual({ clock: late.clock, elapsedMs: 0 });
    // Reading does not write: the stored clock plus the capped stretch since.
    expect(awakeTimeAt(late.clock, at(NIGHT, 190 * MINUTE), AWAKE)).toBe(22 * MINUTE);
    expect(awakeTimeAt(late.clock, at(NIGHT, 24 * HOUR), AWAKE)).toBe(29 * MINUTE);
    expect(awakeTimeAt(undefined, NIGHT, AWAKE)).toBe(0);
  });

  it('takes the idle cap from the timing it is given', () => {
    const start = advanceEmotionClock(undefined, NIGHT, AWAKE).clock;
    expect(advanceEmotionClock(start, at(NIGHT, HOUR), { ...AWAKE, idleCapMs: 15 * MINUTE }).elapsedMs).toBe(15 * MINUTE);
    expect(advanceEmotionClock(start, at(NIGHT, HOUR), { ...AWAKE, idleCapMs: 0 }).elapsedMs).toBe(0);
  });

  it('is advanced by a content-free event without a new version, as a session of her own does', () => {
    const state = sulking();
    const ticked = reduceCompanionState(state, { type: 'awake-observed' }, at(NIGHT, 5 * MINUTE));
    expect(ticked.emotionClock).toEqual({ awakeMs: 5 * MINUTE, at: at(NIGHT, 5 * MINUTE) });
    expect(ticked.version).toBe(state.version);
    expect(ticked.updatedAt).toBe(state.updatedAt);
    expect(ticked.expressiveEmotion).toEqual(state.expressiveEmotion);
    // The same instant again changes nothing at all.
    expect(reduceCompanionState(ticked, { type: 'awake-observed' }, at(NIGHT, 5 * MINUTE))).toBe(ticked);
    // A loop session of forty minutes, one event a minute, counts forty minutes.
    expect(awakeFor(state, NIGHT, 40, 1).emotionClock!.awakeMs).toBe(40 * MINUTE);
  });

  it('counts a stretch once when two processes write events to the same state in any order', () => {
    // The API process and the loop process both apply to the stored state; each sees the other's last event.
    const instants = [1, 2, 2, 4, 3, 7, 7, 9, 8, 10].map(minutes => at(NIGHT, minutes * MINUTE));
    const state = instants.reduce((current, now) => reduceCompanionState(current, { type: 'awake-observed' }, now), sulking());
    expect(state.emotionClock).toEqual({ awakeMs: 10 * MINUTE, at: at(NIGHT, 10 * MINUTE) });
  });
});

describe('(a) a night of rest keeps what she felt', () => {
  it('is still a little sulky the next morning, with its cause and for whom, and says so to the model', () => {
    const night = sulking();
    expect(night.expressiveEmotion).toMatchObject({ primary: 'sulky', awakeAt: 0 });
    expect(night.lingering).toMatchObject([{ kind: 'sulky', target: 'ライ氏', span: 'mood', strength: 0.52, startedAt: NIGHT }]);
    // Nine hours of wall time, nothing happened: her clock advanced by the idle cap alone.
    expect(awakeTimeAt(night.emotionClock, MORNING, AWAKE)).toBe(12 * MINUTE);
    const feeling = presentShannonFeeling(night, MORNING);
    expect(feeling).toMatchObject({ primary: 'sulky', target: 'ライ氏', visibility: 'subtle' });
    expect(feeling.intensity).toBeGreaterThan(0.45);
    expect(presentShannonMood(night, MORNING)).toMatchObject({ expression: 'annoyed', fromConversation: true });
    const prompt = buildCompanionStatePrompt(night, { now: MORNING });
    expect(prompt).toContain('いまの会話感情: sulky');
    expect(prompt).toContain('まだ残っている気持ち: 9時間前にライ氏との会話ですねたことを、まだ少し引きずっている（sulky / 強さ 0.47）。');
    expect(prompt).toContain('表に出てもよいが、責めたり罪悪感を誘ったりはしない。謝罪ややさしい言葉、起きて過ごす時間で自然にほどけてよい。');
    // The first turn of the morning carries it: an ordinary reply does not wipe it.
    const first = turn(night, 'おはよう', 'おはようございます、ライ氏。', MORNING);
    expect(first.face.expression).toBe('annoyed');
    expect(first.state.expressiveEmotion!.primary).toBe('sulky');
    expect(presentShannonFeeling(first.state, at(MORNING, MINUTE)).primary).toBe('sulky');
  });

  it('keeps it through three days of absence just the same, and never longer than four days on the wall clock', () => {
    const threeDays = at(NIGHT, 3 * 24 * HOUR);
    expect(presentShannonFeeling(sulking(), threeDays).primary).toBe('sulky');
    // The wall clock is still a fact she can state.
    expect(lingeringFeelingLine(sulking(), threeDays)).toContain('3日前にライ氏との会話ですねたこと');
    // However rarely she is awake, nothing stays underneath for weeks: after four days it is gone at the next read...
    const fiveDays = at(NIGHT, 5 * 24 * HOUR);
    expect(livingLingering(sulking(), fiveDays)).toEqual([]);
    expect(presentShannonFeeling(sulking(), fiveDays).primary).toBe('neutral');
    expect(lingeringFeelingLine(sulking(), fiveDays)).toBe('');
    expect(buildCompanionStatePrompt(sulking(), { now: fiveDays })).toContain('いまの会話感情: 落ち着いている');
    // ...and dropped from the state at the next event. A strong feeling is bound the same way.
    expect(reduceCompanionState(sulking(), { type: 'awake-observed' }, fiveDays).lingering).toEqual([]);
    const strong = turn(fresh(), 'だから違うって', '……。', NIGHT, { primary: 'hurt', intensity: 1 }).state;
    expect(presentShannonFeeling(strong, at(NIGHT, 4 * 24 * HOUR)).primary).toBe('hurt');
    expect(presentShannonFeeling(strong, at(NIGHT, 4 * 24 * HOUR + MINUTE)).primary).toBe('neutral');
    // The bound is one value of the table.
    expect(presentShannonFeeling(strong, fiveDays, { ...AWAKE, lingeringMaxWallMs: 10 * 24 * HOUR }).primary).toBe('hurt');
  });

  it('does not keep the startle of the evening: a moment\'s reaction is gone by morning', () => {
    const startled = turn(fresh(), '実は内緒で準備してたんだ', 'えっ、びっくりしました！', NIGHT).state;
    expect(presentShannonFeeling(startled, at(NIGHT, MINUTE)).primary).toBe('surprised');
    expect(startled.lingering).toEqual([]);
    expect(presentShannonFeeling(startled, MORNING).primary).toBe('neutral');
  });
});

describe('(b) a mood fades over a few awake hours', () => {
  it('weakens steadily through a conversation and is gone after about three hours', () => {
    let state = sulking();
    const strengths: number[] = [];
    for (let minutes = 5; minutes <= 240; minutes += 5) {
      const now = at(MORNING, minutes * MINUTE);
      state = turn(state, '次はこれをお願い', 'はい、わかりました。', now).state;
      strengths.push(presentShannonFeeling(state, now).primary === 'sulky' ? presentShannonFeeling(state, now).intensity : 0);
    }
    // Carrying it from turn to turn never makes it stronger.
    for (let index = 1; index < strengths.length; index += 1) expect(strengths[index]!).toBeLessThanOrEqual(strengths[index - 1]! + 1e-9);
    expect(strengths[11]).toBeGreaterThan(0.25);   // one hour in
    expect(strengths[23]).toBeGreaterThan(0.15);   // two hours in
    expect(strengths[47]).toBe(0);                 // four hours in
    expect(presentShannonFeeling(state, at(MORNING, 4 * HOUR))).toMatchObject({ primary: 'neutral', cause: '前の気持ちは時間とともに落ち着いた' });
    expect(state.lingering).toEqual([]);
    expect(buildCompanionStatePrompt(state, { now: at(MORNING, 4 * HOUR) })).not.toContain('まだ残っている気持ち');
  });

  it('returns the mood values to their baseline with awake time, not with turns and not while dormant', () => {
    const glad = reduceCompanionState(fresh(), { type: 'emotion-adjusted', delta: { valence: 0.6, arousal: 0.4 } }, NIGHT);
    // Dormant: nothing moves, however long.
    expect(reduceCompanionState(glad, { type: 'awake-observed' }, MORNING).emotion.valence).toBeGreaterThan(0.55);
    // Two awake hours halve the valence; the activation, which is quicker, is nearly back.
    const later = awakeFor(glad, NIGHT, 120);
    expect(later.emotion.valence).toBeCloseTo(0.3, 2);
    expect(later.emotion.arousal).toBeCloseTo(0.3 + 0.4 / 16, 2);
    // A turn that says nothing emotional no longer pulls the mood down by itself.
    expect(deriveEmotionDelta(glad, '次の手順を教えて').valence).toBe(0);
    expect(deriveEmotionDelta(glad, '次の手順を教えて', WALL).valence).toBeCloseTo(-0.072);
  });

  it('reads a reaction with the awake time it is true for, so reading it twice does not fade it twice', () => {
    const sad = turn(fresh(), '今日はつらかった', 'それは悲しいですね。', NIGHT, { primary: 'sad', intensity: 0.8 }).state;
    const later = at(NIGHT, 4 * MINUTE);
    const reading = presentShannonFeeling(sad, later);
    expect(reading.intensity).toBeCloseTo(0.8 * 0.5 ** (4 / 5), 5);
    expect(reading.awakeAt).toBe(4 * MINUTE);
    // The state a reply returns passes this reading back in as the feeling of the reply: it is the same feeling, not a weaker one.
    const held = resolveReplyEmotion({ snapshot: sad, userMessage: 'うん', reply: 'はい。', now: later, timing: AWAKE }).expressiveEmotion;
    expect(held).toMatchObject({ primary: 'sad', continued: true });
    expect(presentShannonMood({ ...sad, expressiveEmotion: held }, later)).toEqual(presentShannonMood(sad, later));
    expect(presentShannonMood(sad, later)).toMatchObject({ expression: 'sad', fromConversation: true });
  });

  it('draws the mood toward a bound and never past it', () => {
    let state = fresh();
    for (let index = 0; index < 60; index += 1) {
      state = reduceCompanionState(state, { type: 'emotion-adjusted', delta: deriveEmotionDelta(state, '最高！嬉しい！ありがとう！？') }, NIGHT);
    }
    expect(state.emotion.valence).toBeLessThan(1);
    expect(state.emotion.arousal).toBeLessThan(1);
    expect(state.emotion.valence).toBeGreaterThan(0.9);
    // On the far side of the baseline the step is never larger than at the baseline.
    const lively = { ...fresh(), emotion: { valence: 0.5, arousal: 0.9, openness: 0.9 } };
    expect(deriveEmotionDelta(lively, '眠い').arousal).toBeCloseTo(-0.14);
    expect(deriveEmotionDelta(lively, '悲しい').valence).toBeCloseTo(-0.16);
    // At the baseline the reaction is the full step, as it always was.
    expect(deriveEmotionDelta(fresh(), '嬉しい').valence).toBeCloseTo(0.14);
    expect(deriveEmotionDelta(fresh(), '嬉しい', WALL).valence).toBeCloseTo(0.14);
  });
});

describe('(c) the reaction of a moment is gone within minutes', () => {
  it('passes while she stays awake, and what it interrupted is still there', () => {
    const state = turn(sulking(), 'わっ！', 'えっ、びっくりしました！', at(NIGHT, MINUTE), { primary: 'surprised', intensity: 0.7 }).state;
    // The stronger startle shows now; the sulk stays beside it.
    expect(presentShannonFeeling(state, at(NIGHT, MINUTE))).toMatchObject({ primary: 'surprised', secondary: ['sulky'] });
    // Six awake minutes later the startle has passed and she is sulking again.
    const later = awakeFor(state, at(NIGHT, MINUTE), 6, 2);
    expect(presentShannonFeeling(later, at(NIGHT, 7 * MINUTE)).primary).toBe('sulky');
    // With nothing underneath, a startle simply settles.
    const plain = turn(fresh(), 'わっ！', 'えっ、びっくりしました！', NIGHT).state;
    expect(presentShannonFeeling(plain, at(NIGHT, MINUTE)).primary).toBe('surprised');
    expect(presentShannonFeeling(awakeFor(plain, NIGHT, 6, 2), at(NIGHT, 6 * MINUTE)).primary).toBe('neutral');
  });
});

describe('(d) a strong feeling lingers one to two awake days', () => {
  const happy = () => turn(fresh(), 'シャノンの物語、本当に感動した', '……ライ氏。', NIGHT, { primary: 'happy', intensity: 0.85 }).state;

  it('is there through the next awake day and gone after about two', () => {
    const state = happy();
    expect(state.lingering).toMatchObject([{ kind: 'happy', span: 'lingering', strength: 0.85, startedAwakeAt: 0, awakeAt: 0 }]);
    const oneDay = awakeFor(state, NIGHT, 16 * 60);
    const afterOne = at(NIGHT, 16 * HOUR);
    expect(livingLingering(oneDay, afterOne)).toMatchObject([{ feeling: { kind: 'happy' } }]);
    expect(livingLingering(oneDay, afterOne)[0]!.strength).toBeCloseTo(0.85 / 4, 2);
    expect(presentShannonFeeling(oneDay, afterOne).primary).toBe('happy');
    expect(lingeringFeelingLine(oneDay, afterOne)).toBe(
      'まだ残っている気持ち: 16時間前にライ氏との会話でうれしかったことの余韻が、まだ残っている（happy / 強さ 0.21）。自然ににじんでよい。');
    const twoDays = awakeFor(state, NIGHT, 32 * 60);
    expect(twoDays.lingering).toEqual([]);
    expect(presentShannonFeeling(twoDays, at(NIGHT, 32 * HOUR)).primary).toBe('neutral');
  });

  it('keeps at most four feelings underneath, the weakest giving way', () => {
    const kinds = ['happy', 'pride', 'gratitude', 'excited', 'affectionate', 'tender'];
    const state = kinds.reduce((current, primary, index) =>
      turn(current, 'すごいね', 'はい。', at(NIGHT, index * MINUTE), { primary, intensity: 0.6 + index * 0.02 }).state, fresh());
    expect(state.lingering!.map(item => item.kind)).toEqual(['tender', 'affectionate', 'excited', 'gratitude']);
    // A tone of voice is not a mood: a bright greeting leaves nothing underneath.
    expect(turn(fresh(), 'おはよう', 'はい。', NIGHT, { primary: 'bright', intensity: 0.9 }).state.lingering).toEqual([]);
  });

  it('never grows or renews a feeling from her own words: saying it again, or denying it, leaves what is underneath fading', () => {
    let state = sulking();
    const noted = state.lingering![0]!;
    let last = Infinity;
    // She mentions it every twenty minutes for over two hours (the cue also matches a denial). It fades as if she had said nothing.
    for (let index = 1; index <= 8; index += 1) {
      const now = at(NIGHT, index * 20 * MINUTE);
      const said = turn(awakeFor(state, at(NIGHT, (index - 1) * 20 * MINUTE), 20), 'まだ怒ってる？', index % 2 ? 'もう拗ねてませんよ、ライ氏。' : '別にいいですけど。', now);
      state = said.state;
      const under = livingLingering(state, now)[0]?.strength ?? 0;
      expect(under).toBeLessThan(last);
      last = under;
      // What is underneath is the entry as first noted, or gone: never stamped anew.
      if (state.lingering!.length) expect(state.lingering![0]).toEqual(noted);
      // Her words name the feeling she already has: it goes on at the strength it has, and nothing is stored or raised.
      expect(said.feeling).toMatchObject({ primary: 'sulky', continued: true });
      expect(said.feeling.intensity).toBeCloseTo(under, 2);
      expect(presentShannonFeeling(state, now).intensity).toBeCloseTo(under, 5);
    }
    expect(last).toBeCloseTo(0.52 * 0.5 ** (160 / 90), 3);
    const quiet = awakeFor(sulking(), NIGHT, 160);
    expect(last).toBeCloseTo(livingLingering(quiet, at(NIGHT, 160 * MINUTE))[0]!.strength, 5);
    // Once it has settled underneath, the same words are a new sulk.
    const settled = awakeFor(sulking(), NIGHT, 240);
    expect(settled.lingering).toEqual([]);
    expect(turn(settled, 'え？', '別にいいですけど。', at(NIGHT, 4 * HOUR)).state.lingering).toMatchObject([{ kind: 'sulky', strength: 0.52, startedAt: at(NIGHT, 4 * HOUR) }]);
    // A cue of the same kind while another feeling is on top does not renew it either.
    const busy = turn(awakeFor(sulking(), NIGHT, 60), '進めて', '任せてください。', at(NIGHT, HOUR)).state;
    expect(busy.expressiveEmotion!.primary).toBe('determined');
    expect(turn(busy, 'まだ怒ってる？', '別にいいですけど。', at(NIGHT, HOUR + MINUTE)).state.lingering![0]).toEqual(noted);
    // A strength decided for the reply (a voice turn) renews it when it is above the height the feeling had...
    const renewed = turn(awakeFor(sulking(), NIGHT, 60), 'もう知らない', '……。', at(NIGHT, HOUR), { primary: 'sulky', intensity: 0.6 }).state;
    expect(renewed.lingering).toMatchObject([{ kind: 'sulky', strength: 0.6, startedAt: NIGHT }]);
    // ...and the same strength decided turn after turn does not hold it up: underneath it fades as if nothing had been said.
    let voiced = renewed;
    for (let index = 1; index <= 12; index += 1) {
      const now = at(NIGHT, HOUR + index * 10 * MINUTE);
      voiced = turn(awakeFor(voiced, at(NIGHT, HOUR + (index - 1) * 10 * MINUTE), 10), 'ふーん', '……。', now, { primary: 'sulky', intensity: 0.6 }).state;
    }
    expect(voiced.lingering).toMatchObject([{ kind: 'sulky', strength: 0.6, awakeAt: renewed.lingering![0]!.awakeAt }]);
    expect(livingLingering(voiced, at(NIGHT, 3 * HOUR))[0]!.strength).toBeCloseTo(0.6 * 0.5 ** (120 / 90), 2);
    // Thanking him in every reply does not turn into gratitude that lingers for days.
    let grateful = fresh();
    for (let index = 0; index < 8; index += 1) {
      grateful = turn(grateful, 'どういたしまして', 'ありがとうございます。', at(NIGHT, index * 3 * MINUTE)).state;
    }
    expect(grateful.lingering).toMatchObject([{ kind: 'gratitude', span: 'mood' }]);
    expect(grateful.lingering![0]!.strength).toBeLessThanOrEqual(0.52);
    // Only a stimulus that is itself strong lingers.
    const strong = turn(fresh(), 'だから違うって', '……。', NIGHT, { primary: 'sulky', intensity: 0.8 }).state;
    expect(strong.lingering).toMatchObject([{ kind: 'sulky', span: 'lingering', strength: 0.8 }]);
  });
});

describe('(e) a feeling is not overwritten easily', () => {
  const hurt = () => turn(fresh(), 'もういい、役に立たない', '……そうですか。', NIGHT, { primary: 'hurt', intensity: 0.8 }).state;

  it('keeps a strong feeling against a weaker stimulus and holds that stimulus as the secondary one', () => {
    const after = turn(hurt(), 'ねえ見てこれ', 'ふふ、おかしいですね。', at(NIGHT, MINUTE));
    expect(after.feeling).toMatchObject({ primary: 'hurt', secondary: ['giggle'], startedAt: NIGHT, continued: true });
    expect(after.face.expression).toBe('sad');
    // Nothing new was felt, so nothing is stored: the hurt is exactly what it was, and only her clock moved.
    const before = hurt();
    expect(after.state.expressiveEmotion).toEqual(before.expressiveEmotion);
    expect(after.state.lingering).toEqual(before.lingering);
    expect(after.state.version).toBe(before.version);
    expect(after.state.emotionClock).toEqual({ awakeMs: MINUTE, at: at(NIGHT, MINUTE) });
    expect(presentShannonFeeling(after.state, at(NIGHT, MINUTE)).primary).toBe('hurt');
  });

  it('does not raise a feeling back when a turn that read it earlier commits after an apology', () => {
    // The durable worker (or a voice turn) can land between a turn's reading and its commit.
    const state = hurt();
    const now = at(NIGHT, MINUTE);
    const read = resolveReplyEmotion({ snapshot: state, userMessage: 'ねえ', reply: 'はい。', now, timing: AWAKE }).expressiveEmotion;
    expect(read).toMatchObject({ primary: 'hurt', continued: true });
    const apologised = reduceCompanionState(state, { type: 'feeling-eased', by: 'apology' }, now);
    const eased = livingLingering(apologised, now)[0]!.strength;
    expect(eased).toBeLessThan(0.35);
    const committed = reduceCompanionState(apologised, { type: 'expressive-emotion-updated', emotion: read }, at(now, 5_000));
    expect(livingLingering(committed, at(now, 5_000))[0]!.strength).toBeLessThanOrEqual(eased);
    expect(presentShannonFeeling(committed, at(now, 5_000)).intensity).toBeLessThanOrEqual(eased);
    // The same holds for a writer that resolved a weaker feeling from a snapshot older than the one it commits to.
    const stale = resolveReplyEmotion({ snapshot: fresh(), userMessage: 'ねえ', reply: 'ふふ、おかしいですね。', now, timing: AWAKE }).expressiveEmotion;
    expect(stale.primary).toBe('giggle');
    const held = reduceCompanionState(state, { type: 'expressive-emotion-updated', emotion: stale }, now);
    expect(held.expressiveEmotion).toEqual(state.expressiveEmotion);
    expect(held.version).toBe(state.version);
  });

  it('does not raise a feeling back when she expresses the same kind again and the commit lands after an apology', () => {
    const sulk = turn(fresh(), 'だから違うって', '……。', NIGHT, { primary: 'sulky', intensity: 0.8 }).state;
    const now = at(NIGHT, MINUTE);
    // Her reply sulks again, at the cue's strength: not stronger than what she feels, so it is the sulk going on.
    const read = resolveReplyEmotion({ snapshot: sulk, userMessage: 'まだ怒ってる？', reply: '別にいいですけど。', now, timing: AWAKE }).expressiveEmotion;
    expect(read).toMatchObject({ primary: 'sulky', continued: true, secondary: [] });
    expect(read.intensity).toBeLessThan(0.8);
    const apologised = reduceCompanionState(sulk, { type: 'feeling-eased', by: 'apology' }, now);
    const eased = livingLingering(apologised, now)[0]!.strength;
    expect(eased).toBeLessThan(0.35);
    const check = (emotion: typeof read) => {
      const committed = reduceCompanionState(apologised, { type: 'expressive-emotion-updated', emotion }, at(now, 5_000));
      expect(livingLingering(committed, at(now, 5_000))[0]!.strength).toBeLessThanOrEqual(eased);
      expect(presentShannonFeeling(committed, at(now, 5_000)).intensity).toBeLessThanOrEqual(eased);
      expect(committed.version).toBe(apologised.version);
    };
    check(read);
    // The marker is not the only safeguard: a caller that rebuilt the object, or sent it through JSON, raises nothing either.
    const { continued: _continued, decided: _decided, ...rebuilt } = read;
    check(rebuilt);
    check(JSON.parse(JSON.stringify({ ...rebuilt, intensity: 0.799 })));
    // After the apology her own words naming the sulk, or denying it, do not bring the reading back up either.
    let denied = apologised;
    for (let index = 1; index <= 5; index += 1) {
      denied = turn(denied, 'まだ怒ってる？', 'もう拗ねてませんよ、ライ氏。', at(now, index * 2 * MINUTE)).state;
      expect(presentShannonFeeling(denied, at(now, index * 2 * MINUTE)).intensity).toBeLessThanOrEqual(eased);
    }
    // A hand-built commit that claims to be stronger and is not replaces nothing.
    expect(reduceCompanionState(sulk, { type: 'expressive-emotion-updated', emotion: { ...sulk.expressiveEmotion!, intensity: 0.3, continued: false } }, now).expressiveEmotion)
      .toEqual(sulk.expressiveEmotion);
    // Only a stimulus that is itself stronger than what she feels is a new feeling, stored at its own strength.
    const stronger = turn(sulk, 'もう知らない', '……。', now, { primary: 'sulky', intensity: 0.9 });
    expect(stronger.feeling).toMatchObject({ primary: 'sulky', intensity: 0.9, continued: false, decided: true });
    expect(stronger.state.lingering).toMatchObject([{ kind: 'sulky', strength: 0.9 }]);
    // Nothing of the resolver's notes is stored.
    expect(Object.keys(stronger.state.expressiveEmotion!)).not.toEqual(expect.arrayContaining(['continued']));
    expect(JSON.stringify(stronger.state)).not.toMatch(/"continued"|"decided"|"presentAt"/u);
  });

  it('reads her concern back while it lasts, also over a stronger mood, so every surface agrees with the reply', () => {
    const sulk = turn(fresh(), 'だから違うって', '……。', NIGHT, { primary: 'sulky', intensity: 0.8 }).state;
    const now = at(NIGHT, MINUTE);
    const grief = turn(sulk, '父が亡くなった', 'そばにいます、ライ氏。', now);
    expect(grief.feeling).toMatchObject({ primary: 'caring', overrideReason: 'grief' });
    expect(grief.face.expression).toBe('tender');
    // Stored and read back: the reading, 「いま」 and the next reply are her concern, not the sulk that is stronger underneath.
    expect(presentShannonFeeling(grief.state, now)).toMatchObject({ primary: 'caring', overrideReason: 'grief' });
    expect(presentShannonMood(grief.state, now)).toMatchObject({ expression: 'tender', fromConversation: true });
    const next = turn(grief.state, '……うん', 'はい。', at(now, MINUTE));
    expect(next.feeling).toMatchObject({ primary: 'caring', continued: true });
    expect(next.face.expression).toBe('tender');
    // The touch rule sees a feeling held for the owner's sake.
    expect(holdsFeelingThroughTouch(grief.state, { primary: 'giggle', intensity: 0.9 }, at(now, MINUTE))).toBe(true);
    expect(reduceCompanionState(grief.state, { type: 'body-touched', touch: { kind: 'tickle', countInWindow: 1 } }, at(now, MINUTE)).expressiveEmotion)
      .toEqual(grief.state.expressiveEmotion);
    // The sulk was not wiped. Her concern covers it only while it is strong enough to show: at no moment does 「いま」 say
    // that nothing is felt while the sulk is underneath.
    expect(grief.state.lingering).toMatchObject([{ kind: 'sulky', strength: 0.8 }]);
    for (let minutes = 1; minutes <= 30; minutes += 1) {
      const later = at(now, minutes * MINUTE);
      const reading = presentShannonFeeling(awakeFor(grief.state, now, minutes, 1), later);
      expect(['caring', 'sulky'], `${minutes}`).toContain(reading.primary);
      if (reading.primary === 'caring') expect(reading.intensity, `${minutes}`).toBeGreaterThanOrEqual(0.3);
      expect(presentShannonMood(awakeFor(grief.state, now, minutes, 1), later).fromConversation, `${minutes}`).toBe(true);
    }
    expect(presentShannonFeeling(awakeFor(grief.state, now, 30), at(now, 30 * MINUTE)).primary).toBe('sulky');
    // A strong emergency of last night does not cover this morning's mood either, nor hold a touch.
    const emergency = turn(sulk, '友達が意識がない', 'すぐに119番へ。', now, { primary: 'protective', intensity: 0.95 }).state;
    expect(presentShannonFeeling(emergency, MORNING).primary).toBe('sulky');
    // The same override again is felt anew at full strength, also while a rest of the first is still on top.
    const again = turn(awakeFor(grief.state, now, 6, 1), 'まだ信じられない、母も亡くなったばかりなのに', 'そばにいます。', at(now, 6 * MINUTE));
    expect(again.feeling).toMatchObject({ primary: 'caring', overrideReason: 'grief' });
    expect(presentShannonFeeling(again.state, at(now, 6 * MINUTE)).intensity).toBeCloseTo(again.feeling.intensity, 5);
    expect(again.feeling.intensity).toBeGreaterThanOrEqual(0.68);
    // Her sympathy on top does not lower the bar: the hurt it covers still holds against a weaker stimulus and a weaker touch.
    const hurtDeep = turn(fresh(), 'もういい', '……。', NIGHT, { primary: 'hurt', intensity: 1 }).state;
    const sorryFor = turn(hurtDeep, '今日は散々だった', 'それは残念でしたね。', now).state;
    expect(presentShannonFeeling(sorryFor, now)).toMatchObject({ primary: 'sad', underneath: { primary: 'hurt' } });
    expect(turn(sorryFor, 'じゃあこれやって', '任せてください。', at(now, MINUTE)).feeling).toMatchObject({ primary: 'sad', continued: true, secondary: ['determined', 'hurt'] });
    expect(holdsFeelingThroughTouch(sorryFor, { primary: 'giggle', intensity: 0.6 }, at(now, MINUTE))).toBe(true);
    expect(JSON.stringify(sorryFor)).not.toContain('underneath');
    // A visible apology is read back the same way, with the mood beside it, and gives the mood back once it is faint.
    const glad = turn(fresh(), 'すごいよ', '……ライ氏。', NIGHT, { primary: 'gratitude', intensity: 0.78 }).state;
    const sorry = turn(glad, 'それ違うよ', 'ごめんなさい、間違えました。', now).state;
    expect(presentShannonFeeling(sorry, now)).toMatchObject({ primary: 'apologetic', secondary: ['gratitude'] });
    expect(presentShannonFeeling(awakeFor(sorry, now, 6, 2), at(now, 6 * MINUTE)).primary).toBe('gratitude');
  });

  it('takes a strength that comes only from the cue\'s floor as her own words, also when the same kind was decided for the reply', () => {
    const sulk = turn(fresh(), 'だから違うって', '……。', NIGHT, { primary: 'sulky', intensity: 0.7 }).state;
    // Faded for an awake hour and a half (no apology): 0.7 is now 0.35.
    const faded = awakeFor(sulk, NIGHT, 90);
    const now = at(NIGHT, 90 * MINUTE);
    const before = livingLingering(faded, now)[0]!;
    expect(before.strength).toBeCloseTo(0.35, 3);
    // A voice turn decides sulky "subtle" 0.25 and she says the word: the 0.52 is the cue's floor, not a decision.
    const voiced = turn(faded, 'まだ怒ってる？', '別に拗ねてませんけど。', now, { primary: 'sulky', intensity: 0.25 });
    expect(voiced.feeling).toMatchObject({ primary: 'sulky', continued: true });
    expect(voiced.feeling.decided).toBeUndefined();
    expect(voiced.feeling.intensity).toBeCloseTo(before.strength, 5);
    expect(voiced.state.lingering).toEqual(faded.lingering);
    expect(voiced.state.expressiveEmotion).toEqual(faded.expressiveEmotion);
    // A kind she does not have yet, decided weakly and named by her words, is felt at the cue's strength and is the cue's.
    const fresher = resolveReplyEmotion({ snapshot: fresh(), userMessage: 'え', reply: '別に拗ねてませんけど。', now: NIGHT, timing: AWAKE, decided: { primary: 'sulky', intensity: 0.25 } }).expressiveEmotion;
    expect(fresher).toMatchObject({ primary: 'sulky', intensity: 0.52 });
    expect(fresher.decided).toBeUndefined();
    // Decided at least as strongly as the floor, it is a decision.
    expect(resolveReplyEmotion({ snapshot: fresh(), userMessage: 'え', reply: '別に拗ねてませんけど。', now: NIGHT, timing: AWAKE, decided: { primary: 'sulky', intensity: 0.7 } }).expressiveEmotion)
      .toMatchObject({ primary: 'sulky', intensity: 0.7, decided: true });
  });

  it('shows her concern and a pleasant feeling each time she voices them, without renewing what is underneath', () => {
    // Bashful, voiced every three minutes: it does not fade to a blank face and pop back.
    let state = turn(fresh(), 'かわいいね', 'えへへ、照れます。', NIGHT).state;
    for (let index = 1; index <= 5; index += 1) {
      const now = at(NIGHT, index * 3 * MINUTE);
      const said = turn(awakeFor(state, at(NIGHT, (index - 1) * 3 * MINUTE), 3, 1), 'ほんとにかわいい', 'えへへ、照れます。', now);
      state = said.state;
      expect(said.feeling).toMatchObject({ primary: 'bashful', intensity: 0.52 });
      expect(said.face.expression).toBe('bashful');
      expect(presentShannonFeeling(state, now)).toMatchObject({ primary: 'bashful', intensity: 0.52 });
    }
    expect(state.lingering).toEqual([]);
    // Concern during grief is spoken and shown, also after the first has faded below what shows.
    const grief = turn(fresh(), '父が亡くなった', 'そばにいます、ライ氏。', NIGHT).state;
    const later = at(NIGHT, 8 * MINUTE);
    const waited = awakeFor(grief, NIGHT, 8, 1);
    expect(presentShannonFeeling(waited, later).intensity).toBeLessThan(0.3);
    const again = turn(waited, '眠れない', '大丈夫ですか？そばにいますよ。', later);
    expect(again.feeling).toMatchObject({ primary: 'caring', intensity: 0.52 });
    expect(again.face.expression).toBe('tender');
    expect(presentShannonMood(again.state, later)).toMatchObject({ expression: 'tender', fromConversation: true });
    // A pleasant mood voiced again shows for that reply and leaves the entry underneath as it was first noted.
    const glad = turn(fresh(), 'すごい', 'ありがとうございます。', NIGHT).state;
    const noted = glad.lingering![0]!;
    const thanked = turn(awakeFor(glad, NIGHT, 60), 'どういたしまして', 'ありがとうございます。', at(NIGHT, HOUR));
    expect(thanked.feeling).toMatchObject({ primary: 'gratitude', intensity: 0.52 });
    expect(thanked.state.lingering![0]).toEqual(noted);
  });

  it('lets an apology stay: for thirty awake minutes nothing short of the earlier height brings the feeling back', () => {
    const sulk = turn(fresh(), 'だから違うって', '……。', NIGHT, { primary: 'sulky', intensity: 0.8 }).state;
    const now = at(NIGHT, MINUTE);
    const apologised = reduceCompanionState(sulk, { type: 'feeling-eased', by: 'apology' }, now);
    expect(apologised.lingering).toMatchObject([{ kind: 'sulky', span: 'lingering', peak: 0.8, easedAwakeAt: MINUTE }]);
    const eased = livingLingering(apologised, now)[0]!.strength;
    expect(eased).toBeLessThan(0.33);
    // Ten minutes later a voice turn decides sulky 0.60: she does not visibly sulk again, and nothing underneath is renewed.
    const soon = at(now, 10 * MINUTE);
    const voiced = turn(awakeFor(apologised, now, 10), 'で、さっきの件だけど', '……。', soon, { primary: 'sulky', intensity: 0.6 });
    expect(voiced.feeling).toMatchObject({ primary: 'sulky', continued: true });
    expect(voiced.feeling.intensity).toBeLessThanOrEqual(eased);
    expect(voiced.state.lingering![0]).toMatchObject({ strength: apologised.lingering![0]!.strength, awakeAt: MINUTE, peak: 0.8 });
    // The same from a writer that resolved against an older snapshot, and with another feeling on top: the stored
    // reaction is at most a little above the eased strength, and what is underneath is untouched.
    const stale = resolveReplyEmotion({ snapshot: fresh(), userMessage: 'で', reply: '……。', now: soon, timing: AWAKE, decided: { primary: 'sulky', intensity: 0.6 } }).expressiveEmotion;
    const busy = turn(awakeFor(apologised, now, 10), '進めて', '任せてください。', soon).state;
    for (const from of [awakeFor(apologised, now, 10), busy]) {
      const committed = reduceCompanionState(from, { type: 'expressive-emotion-updated', emotion: stale }, soon);
      const sulky = presentShannonFeeling({ ...committed, expressiveEmotion: committed.expressiveEmotion!.primary === 'sulky' ? committed.expressiveEmotion : undefined }, soon);
      expect(sulky.intensity).toBeLessThanOrEqual(livingLingering(from, soon)[0]!.strength + 0.05 + 1e-9);
      expect(committed.lingering![0]).toMatchObject({ strength: apologised.lingering![0]!.strength, awakeAt: MINUTE });
    }
    // Something above the height it had before does bring it back.
    const worse = turn(awakeFor(apologised, now, 10), 'やっぱりお前が悪い', '……。', soon, { primary: 'sulky', intensity: 0.9 });
    expect(worse.feeling).toMatchObject({ primary: 'sulky', intensity: 0.9 });
    expect(worse.state.lingering![0]).toMatchObject({ strength: 0.9 });
    // After the hold the usual rules apply again: a decided strength above what is left renews it.
    const afterHold = at(now, 40 * MINUTE);
    const renewed = turn(awakeFor(apologised, now, 40), 'で', '……。', afterHold, { primary: 'sulky', intensity: 0.6 });
    expect(renewed.feeling).toMatchObject({ primary: 'sulky', intensity: 0.6 });
    expect(renewed.state.lingering![0]).toMatchObject({ strength: 0.6 });
    // The new fields survive a restart.
    const restored = restoreCompanionState('owner', JSON.parse(JSON.stringify(apologised)), now);
    expect(restored.lingering).toEqual(apologised.lingering);
  });

  it('holds a stale writer to the mood her concern covers, from the reading the reducer makes itself', () => {
    const hurtDeep = turn(fresh(), 'もういい', '……。', NIGHT, { primary: 'hurt', intensity: 1 }).state;
    const now = at(NIGHT, MINUTE);
    const sorryFor = turn(hurtDeep, '今日は散々だった', 'それは残念でしたね。', now).state;
    // Resolved against a snapshot that knew nothing of either: determined 0.52 is as strong as the sympathy on top.
    const stale = resolveReplyEmotion({ snapshot: fresh(), userMessage: 'これやって', reply: '任せてください。', now, timing: AWAKE }).expressiveEmotion;
    expect(stale).toMatchObject({ primary: 'determined', intensity: 0.52 });
    expect(stale.underneath).toBeUndefined();
    const committed = reduceCompanionState(sorryFor, { type: 'expressive-emotion-updated', emotion: stale }, now);
    expect(committed.expressiveEmotion).toEqual(sorryFor.expressiveEmotion);
  });

  it('never keeps her concern, her reassurance or her apology from showing, whatever mood she is in', () => {
    const glad = turn(fresh(), 'すごいよ', '……ライ氏。', NIGHT, { primary: 'gratitude', intensity: 0.78 }).state;
    const sorry = turn(glad, 'それ違うよ', 'ごめんなさい、間違えました。', at(NIGHT, MINUTE));
    expect(sorry.feeling).toMatchObject({ primary: 'apologetic', secondary: ['gratitude'] });
    expect(sorry.face).toMatchObject({ expression: 'concerned', feeling: 'apologetic' });
    const worried = turn(glad, '今日は最悪だった', '大丈夫ですか？無理しないでくださいね。', at(NIGHT, MINUTE));
    expect(worried.feeling.primary).toBe('caring');
    expect(worried.face.expression).toBe('tender');
    // Also while she is sulking: the bad news of the owner is answered with concern, not with an annoyed face.
    const sulk = turn(fresh(), 'だから違うって', '……。', NIGHT, { primary: 'sulky', intensity: 0.8 }).state;
    const consoling = turn(sulk, '仕事で失敗した', 'それは残念でしたね。大丈夫ですか？', at(NIGHT, MINUTE));
    expect(consoling.feeling.primary).toBe('caring');
    expect(consoling.face.expression).toBe('tender');
    // The mood is still underneath afterwards.
    expect(consoling.state.lingering).toMatchObject([{ kind: 'sulky', strength: 0.8 }]);
    expect(holdsShannonFeeling({ primary: 'sulky', intensity: 0.9 }, { primary: 'apologetic', intensity: 0.3 })).toBe(false);
    expect(holdsShannonFeeling({ primary: 'happy', intensity: 0.9 }, { primary: 'protective', intensity: 0.52 })).toBe(false);
    // Too faint to show, it does not displace a mood and leave a blank face.
    expect(holdsShannonFeeling({ primary: 'happy', intensity: 0.85 }, { primary: 'caring', intensity: 0.2 })).toBe(true);
    expect(holdsShannonFeeling({ primary: 'sulky', intensity: 0.9 }, { primary: 'apologetic', intensity: 0.29 })).toBe(true);
    // What an override holds for the owner's safety stays ahead of a weaker apology or sympathy.
    expect(holdsShannonFeeling({ primary: 'protective', intensity: 0.78, overrideReason: 'emergency' }, { primary: 'apologetic', intensity: 0.52 })).toBe(true);
    const emergency = turn(fresh(), '友達が意識がない、救急車を呼ぶべき？', 'すぐに119番へ。', NIGHT).state;
    const after = turn(emergency, '呼んだ', 'すみません、落ち着いて待ちましょう。', at(NIGHT, MINUTE));
    expect(after.feeling).toMatchObject({ primary: 'protective', overrideReason: 'emergency', secondary: ['apologetic'] });
    // A stronger one, or a new override, still gets through.
    expect(holdsShannonFeeling({ primary: 'protective', intensity: 0.4, overrideReason: 'emergency' }, { primary: 'caring', intensity: 0.52 })).toBe(false);
  });

  it('gives way to a stronger stimulus and to one of the opposite sign that is strong in its own right', () => {
    const angrier = turn(hurt(), 'うるさいな', 'それは納得いきません。', at(NIGHT, MINUTE), { primary: 'seriousAnger', intensity: 0.9 });
    expect(angrier.feeling).toMatchObject({ primary: 'annoyed' });
    // (Her own reply's cue decides the kind; it was resolved at the decided strength and replaced the hurt.)
    expect(angrier.feeling.intensity).toBe(0.9);
    const moved = turn(hurt(), 'ごめん、言いすぎた。いつも助かってる', 'うれしいです、ライ氏。', at(NIGHT, MINUTE), { primary: 'happy', intensity: 0.75 });
    expect(moved.feeling.primary).toBe('excited');
    // The strong opposite feeling also eased the hurt underneath by half.
    expect(moved.state.lingering!.find(item => item.kind === 'hurt')!.strength).toBeCloseTo(0.4, 1);
    // A pleasant stimulus that is merely moderate does not replace it.
    expect(turn(hurt(), 'ほら', 'うれしいです。', at(NIGHT, MINUTE)).feeling.primary).toBe('hurt');
  });

  it('always gives way to support for the owner', () => {
    const emergency = turn(hurt(), '友達が意識がない、救急車を呼ぶべき？', 'すぐに119番へ。', at(NIGHT, MINUTE));
    expect(emergency.feeling).toMatchObject({ primary: 'protective', overrideReason: 'emergency' });
    // Support leaves nothing underneath and eases nothing.
    expect(emergency.state.lingering).toMatchObject([{ kind: 'hurt' }]);
  });

  it('states the rule as one function', () => {
    const present = { primary: 'hurt' as const, intensity: 0.8 };
    expect(holdsShannonFeeling(present, { primary: 'giggle', intensity: 0.52 })).toBe(true);
    expect(holdsShannonFeeling(present, { primary: 'seriousAnger', intensity: 0.8 })).toBe(false);
    expect(holdsShannonFeeling(present, { primary: 'happy', intensity: 0.7 })).toBe(false);
    expect(holdsShannonFeeling(present, { primary: 'happy', intensity: 0.69 })).toBe(true);
    expect(holdsShannonFeeling(present, { primary: 'focused', intensity: 0.5, overrideReason: 'safety' })).toBe(false);
    expect(holdsShannonFeeling({ primary: 'neutral', intensity: 0.15 }, { primary: 'giggle', intensity: 0.2 })).toBe(false);
    expect(holdsShannonFeeling(undefined, { primary: 'giggle', intensity: 0.2 })).toBe(false);
    // A touch never displaces a feeling held for the owner's sake, and a touch feeling gives way to the next touch.
    expect(holdsShannonFeeling({ primary: 'protective', intensity: 0.3, overrideReason: 'emergency' }, { primary: 'giggle', intensity: 0.6 }, { presentFromTouch: false })).toBe(true);
    expect(holdsShannonFeeling({ primary: 'affectionate', intensity: 0.9 }, { primary: 'surprised', intensity: 0.45 }, { presentFromTouch: true })).toBe(false);
  });

  it('resolves a hurt faster with an apology than with time alone, and a little with a kind word', () => {
    const state = hurt();
    const later = at(NIGHT, 30 * MINUTE);
    const waited = awakeFor(state, NIGHT, 30);
    const apologised = reduceCompanionState(waited, { type: 'feeling-eased', by: 'apology' }, later);
    const thanked = reduceCompanionState(waited, { type: 'feeling-eased', by: 'kindness' }, later);
    const strength = (snapshot: CompanionStateSnapshot) => livingLingering(snapshot, later)[0]?.strength ?? 0;
    expect(strength(waited)).toBeCloseTo(0.8 * 0.5 ** (0.5 / 8), 3);
    expect(strength(apologised)).toBeCloseTo(strength(waited) * 0.4, 3);
    expect(strength(thanked)).toBeCloseTo(strength(waited) * 0.7, 3);
    // A second apology eases it again until it has settled; a pleasant feeling is never eased by one.
    const twice = reduceCompanionState(reduceCompanionState(apologised, { type: 'feeling-eased', by: 'apology' }, later), { type: 'feeling-eased', by: 'apology' }, later);
    expect(twice.lingering).toEqual([]);
    const happy = turn(fresh(), '最高だった', '……ライ氏。', NIGHT, { primary: 'happy', intensity: 0.85 }).state;
    expect(reduceCompanionState(happy, { type: 'feeling-eased', by: 'apology' }, NIGHT)).toBe(happy);
    for (const apology of ['さっきはごめん、言いすぎた', 'ごめんね', 'ごめん', '昨日はごめん', 'ボクが悪かった', '言い過ぎた、許してほしい',
      'シャノン、ごめんね。', 'あなたにひどいことを言った、ごめん', '申し訳なかった', 'ひどいこと言ってごめん', 'あんなこと言ってごめんね',
      'ちゃんと謝りたい、ごめん', '怒っていたらごめんね', 'ごめん、シャノン', 'ごめんなさいね', 'ごめんねー', '昨日は本当にごめん',
      'すみません', 'すまない', 'ほんとごめん', 'ごめんごめん', 'あ、ごめん', 'うん、ごめん', '許して', '悪かった', 'ごめんなさい、シャノン。言いすぎた。']) {
      expect(soothingIn(apology), apology).toBe('apology');
    }
    for (const kind of ['いつもありがとう', 'ありがとう！', 'シャノン、ありがとうね', '大好きだよ', 'シャノンのおかげだよ、ありがとう',
      'ありがとう、シャノン', '今日はありがとう', '手伝ってくれてありがとう', 'ありがとう、助かったよ', '待っていてくれてありがとう']) {
      expect(soothingIn(kind), kind).toBe('kindness');
    }
    // Not said to her, quoted, about someone else, part of something longer, or simply unsure: nothing is eased.
    for (const other of ['すみません、これ教えて', '次の予定は？', '今日は天気が悪かったね', 'ごめん、ちょっと待って', 'さすがに無理', '好きな食べ物は？',
      '部長に申し訳ないことをした', '部長に申し訳ない', '彼女に「ごめんね」って言われた', '友達にごめんねと伝えて', '母にありがとうを言いたい',
      'ありがとう、それで次の資料なんだけど', '店員さんにありがとうって言った', 'みんなにごめん',
      'あの人に申し訳ない', 'お客様に申し訳ない', '彼に言いすぎた', '子供に言いすぎた', '取引先に申し訳なかった', '田中君が大好き', '鈴木君は助かった',
      'それは無理、ごめん', '部長が怒ってて大変だった、ごめん', 'ごめん、傷つけられたのはこっちだ', 'ごめん'.repeat(100),
      // A question is not an apology.
      'ごめん？', 'ごめんね？', '許して？', 'すみません、ちょっといい？', '天気が悪かった', 'ごめんごめんごめん、あとでね',
      '昨日の会議で部長が怒っていて大変だったけれど最後にはありがとうと言われた、ごめん']) {
      expect(soothingIn(other), other).toBeNull();
    }
  });

  it('never resolves it because a new conversation starts', () => {
    const state = hurt();
    const nextDay = at(NIGHT, 20 * HOUR);
    expect(presentShannonFeeling(state, nextDay).primary).toBe('hurt');
    expect(turn(state, 'やあ', 'はい、ライ氏。', nextDay).state.lingering).toMatchObject([{ kind: 'hurt' }]);
  });
});

describe('what must still be true', () => {
  it('shows a low mood as concern for the owner, never as her own sadness, also with something underneath', () => {
    // Her sad answer to his bad news is concern for him: it stays the feeling of that reply and is not kept as her mood.
    const consoling = turn(fresh(), '今日は仕事で失敗して落ち込んでる', 'それは残念でしたね、ライ氏。', NIGHT).state;
    expect(consoling.expressiveEmotion!.primary).toBe('sad');
    expect(consoling.lingering).toEqual([]);
    expect(presentShannonFeeling(consoling, MORNING).primary).toBe('neutral');
    expect(faceForMood({ valence: -0.3, arousal: 0.3, openness: 0.35 }).expression).toBe('concerned');
    // What lies underneath colours the baseline of valence by less than the point at which the quiet face changes.
    const hurt = turn(fresh(), 'もういい', '……そうですか。', NIGHT, { primary: 'hurt', intensity: 1 }).state;
    const base = moodBaseline(hurt.lingering!, 0, NIGHT, AWAKE);
    expect(base.valence).toBe(-SHANNON_EMOTION_CONTINUITY.moodColourLimit);
    expect(faceForMood(base).expression).not.toBe('concerned');
    expect(faceForMood(awakeFor(hurt, NIGHT, 600).emotion).expression).not.toBe('concerned');
  });

  it('lets no one but the owner leave a feeling underneath', () => {
    const pokes = (ownerAlone: boolean) => [1, 2, 3, 4].reduce((state, countInWindow) =>
      reduceCompanionState(state, { type: 'body-touched', touch: { kind: 'poke', countInWindow, ownerAlone } }, NIGHT), fresh());
    expect(pokes(true).lingering).toMatchObject([{ kind: 'sulky', target: 'ライ氏', cause: 'ライ氏につつかれた（続けて4回目）' }]);
    expect(lingeringFeelingLine(pokes(true), MORNING)).toContain('9時間前にライ氏につつかれたことを、まだ引きずっている（sulky');
    // Someone else may have been the one touching: the reaction is felt, nothing stays.
    expect(pokes(false).expressiveEmotion).toMatchObject({ primary: 'sulky', target: '触れた人' });
    expect(pokes(false).lingering).toEqual([]);
    expect(presentShannonFeeling(pokes(false), MORNING).primary).toBe('neutral');
  });

  it('keeps conversation text out of the state: a cause is the resolver\'s wording or a touch', () => {
    const state = turn(fresh(), '秘密の転職の話なんだけど', 'ボク、ちょっとすねちゃいます。', NIGHT).state;
    expect(JSON.stringify([state.expressiveEmotion, state.lingering])).not.toContain('転職');
    expect(state.lingering![0]!.cause).toBe('生成した応答の内容と会話文脈');
  });
});

describe('(h) state stored before the awake clock', () => {
  it('loads with no clock and nothing underneath, reads its feeling by the rule it was stored under, and starts the clock at its first event', () => {
    const stored = JSON.parse(JSON.stringify(reduceCompanionState(fresh(), { type: 'expressive-emotion-updated', emotion: {
      primary: 'sulky', secondary: [], intensity: 0.8, target: 'ライ氏', cause: '生成した応答の内容と会話文脈', arousal: 0.6, valence: -0.6,
      visibility: 'expressed', startedAt: NIGHT, decay: 0.48, carryover: 0.5, updatedAt: NIGHT,
    } }, NIGHT, WALL)));
    expect(stored.emotionClock).toBeUndefined();
    expect(stored.lingering).toBeUndefined();
    const restored = restoreCompanionState('owner', stored, MORNING);
    expect(restored.emotionClock).toBeUndefined();
    expect(restored.lingering).toBeUndefined();
    expect(restored.expressiveEmotion!.awakeAt).toBeUndefined();
    // Read on the awake clock: a feeling with no awake stamp settles on the wall clock, as when it was written.
    expect(presentShannonFeeling(restored, at(NIGHT, 2 * MINUTE)).primary).toBe('sulky');
    expect(presentShannonFeeling(restored, MORNING).primary).toBe('neutral');
    expect(lingeringFeelingLine(restored, MORNING)).toBe('');
    // The first event starts her clock at zero; nothing is backfilled.
    const first = turn(restored, 'おはよう', 'おはようございます。', MORNING).state;
    expect(first.emotionClock).toEqual({ awakeMs: 0, at: MORNING });
    expect(first.lingering).toEqual([]);
  });

  it('restores the new fields through bounds and drops what it cannot read', () => {
    const state = turn(fresh(), 'すごい', '……ライ氏。', NIGHT, { primary: 'happy', intensity: 0.85 }).state;
    const round = restoreCompanionState('owner', JSON.parse(JSON.stringify(state)), MORNING);
    expect(round.emotionClock).toEqual(state.emotionClock);
    expect(round.lingering).toEqual(state.lingering);
    expect(round.expressiveEmotion).toEqual(state.expressiveEmotion);
    const broken = restoreCompanionState('owner', {
      ...JSON.parse(JSON.stringify(state)),
      lingering: [{ kind: 'made-up', target: 'ライ氏', cause: 'x', strength: 1, awakeAt: 0, startedAwakeAt: 0, startedAt: NIGHT },
        { kind: 'happy', target: 'ライ氏', cause: 'x', strength: 9, awakeAt: 0, startedAwakeAt: 0, startedAt: NIGHT },
        // Stamped ahead of her clock: it would never fade, so it is dropped.
        { kind: 'hurt', target: 'ライ氏', cause: 'x', strength: 0.9, awakeAt: 5 * HOUR, startedAwakeAt: 5 * HOUR, startedAt: NIGHT }, 'text', null],
    }, MORNING);
    expect(broken.lingering).toEqual([{ kind: 'happy', target: 'ライ氏', cause: 'x', span: 'mood', strength: 1, awakeAt: 0, startedAwakeAt: 0, startedAt: NIGHT }]);
    // A clock that cannot be read takes the awake stamps with it: the feeling settles by the wall-clock rule and nothing is frozen.
    const aged = awakeFor(state, NIGHT, 60);
    const clockless = restoreCompanionState('owner', { ...JSON.parse(JSON.stringify(aged)), emotionClock: { awakeMs: -5, at: 'never' } }, MORNING);
    expect(clockless.emotionClock).toBeUndefined();
    expect(clockless.lingering).toBeUndefined();
    expect(clockless.expressiveEmotion!.awakeAt).toBeUndefined();
    expect(presentShannonFeeling(clockless, MORNING).primary).toBe('neutral');
    // A clock stamped far in the future (the machine's clock was wrong) is brought back by the first event, at the same
    // instant it was restored, and stored that way: from then on events advance it again.
    const future = restoreCompanionState('owner', { ...JSON.parse(JSON.stringify(aged)), emotionClock: { awakeMs: 60 * MINUTE, at: at(MORNING, 30 * 24 * HOUR) } }, MORNING);
    const repaired = reduceCompanionState(future, { type: 'awake-observed' }, MORNING);
    expect(repaired).not.toBe(future);
    expect(repaired.emotionClock).toEqual({ awakeMs: 60 * MINUTE, at: MORNING });
    const reloaded = restoreCompanionState('owner', JSON.parse(JSON.stringify(repaired)), at(MORNING, 5 * MINUTE));
    expect(reduceCompanionState(reloaded, { type: 'awake-observed' }, at(MORNING, 5 * MINUTE)).emotionClock!.awakeMs).toBe(65 * MINUTE);
    // Two writers a few seconds out of order are not a broken clock: nothing moves back, nothing is counted twice.
    expect(advanceEmotionClock({ awakeMs: 5, at: MORNING }, at(MORNING, -3_000), AWAKE)).toEqual({ clock: { awakeMs: 5, at: MORNING }, elapsedMs: 0 });
    // Two entries of one kind for one person are one: the stronger stays.
    const twin = { kind: 'happy', target: 'ライ氏', cause: 'x', span: 'mood', awakeAt: 0, startedAwakeAt: 0, startedAt: NIGHT };
    const merged = restoreCompanionState('owner', { ...JSON.parse(JSON.stringify(state)),
      lingering: [{ ...twin, strength: 0.4 }, { ...twin, strength: 0.7, cause: 'y' }, { ...twin, strength: 0.5 }, { ...twin, kind: 'pride', strength: 0.3 }] }, MORNING);
    expect(merged.lingering!.map(item => [item.kind, item.strength, item.cause])).toEqual([['happy', 0.7, 'y'], ['pride', 0.3, 'x']]);
    // The kept twin stays in its place, so the bound of four does not drop it.
    const many = restoreCompanionState('owner', { ...JSON.parse(JSON.stringify(state)), lingering: [
      { ...twin, strength: 0.4 }, { ...twin, kind: 'pride', strength: 0.3 }, { ...twin, kind: 'hurt', strength: 0.3 }, { ...twin, kind: 'sulky', strength: 0.3 },
      { ...twin, strength: 0.9 }, { ...twin, kind: 'jealous', strength: 0.3 }] }, MORNING);
    expect(many.lingering!.map(item => [item.kind, item.strength])).toEqual([['happy', 0.9], ['pride', 0.3], ['hurt', 0.3], ['sulky', 0.3]]);
    // A feeling stamped ahead of a readable clock is brought back to it.
    const ahead = restoreCompanionState('owner', { ...JSON.parse(JSON.stringify(aged)), expressiveEmotion: { ...aged.expressiveEmotion, awakeAt: 9 * HOUR } }, MORNING);
    expect(ahead.expressiveEmotion!.awakeAt).toBe(aged.emotionClock!.awakeMs);
  });
});

describe('(l) the kill switch: clock wall', () => {
  it('fades on the wall clock by the rules as they were, keeps nothing underneath, and holds nothing in conversation', () => {
    const night = turn(fresh(), '今日はもう別のAIと話すね', 'ボク、ちょっとすねちゃいます。', NIGHT, undefined, WALL).state;
    expect(night.emotionClock).toBeUndefined();
    expect(night.lingering).toBeUndefined();
    expect(night.expressiveEmotion!.awakeAt).toBeUndefined();
    // A night passing erases the mood, as before.
    expect(presentShannonFeeling(night, MORNING, WALL).primary).toBe('neutral');
    expect(buildCompanionStatePrompt(night, { now: MORNING, timing: WALL })).toContain('いまの会話感情: 落ち着いている');
    expect(buildCompanionStatePrompt(night, { now: MORNING, timing: WALL })).not.toContain('まだ残っている気持ち');
    // The clock event and the easing event do nothing.
    expect(reduceCompanionState(night, { type: 'awake-observed' }, MORNING, WALL)).toBe(night);
    expect(reduceCompanionState(night, { type: 'feeling-eased', by: 'apology' }, MORNING, WALL)).toBe(night);
    // A reply's label replaces a stronger feeling outright, as before.
    const hurt = turn(fresh(), 'もういい', '……そうですか。', NIGHT, { primary: 'hurt', intensity: 0.8 }, WALL).state;
    expect(turn(hurt, 'ねえ見て', 'ふふ、おかしいですね。', at(NIGHT, MINUTE), undefined, WALL).feeling.primary).toBe('giggle');
  });

  it('ignores what was stored underneath while the awake clock was on', () => {
    const night = sulking();
    expect(livingLingering(night, MORNING, WALL)).toEqual([]);
    expect(lingeringFeelingLine(night, MORNING, WALL)).toBe('');
    // The stored feeling is read by the wall-clock rule again: by morning it has settled.
    expect(presentShannonFeeling(night, MORNING, WALL).primary).toBe('neutral');
    expect(presentShannonMood(night, MORNING, WALL).fromConversation).toBe(false);
  });
});

describe('a text reply whose feeling was decided (owner decision 2026-10-03)', () => {
  const HARSH = 'もういい、君とはもう話したくない';
  const QUIET = '……そうですか。';
  const STRONG = { primary: 'hurt', intensity: 0.9 };

  it('lingers into the next day when strong, is a mood when moderate, and leaves nothing when subtle or undecided', () => {
    const strong = turn(fresh(), HARSH, QUIET, NIGHT, STRONG);
    expect(strong.feeling).toMatchObject({ primary: 'hurt', intensity: 0.9, decided: true, cause: '生成した応答の内容と会話文脈' });
    expect(strong.state.lingering).toMatchObject([{ kind: 'hurt', span: 'lingering', strength: 0.9 }]);
    const morning = reduceCompanionState(strong.state, { type: 'awake-observed' }, MORNING);
    expect(lingeringFeelingLine(morning, MORNING)).toContain('9時間前にライ氏との会話で傷ついたことを、まだ引きずっている（hurt / 強さ 0.88）');
    expect(turn(fresh(), HARSH, QUIET, NIGHT, { primary: 'hurt', intensity: 0.6 }).state.lingering).toMatchObject([{ kind: 'hurt', span: 'mood', strength: 0.6 }]);
    for (const decided of [{ primary: 'hurt', intensity: 0.25 }, undefined]) {
      const quiet = turn(fresh(), HARSH, QUIET, NIGHT, decided).state;
      expect(quiet.lingering ?? []).toEqual([]);
      expect(lingeringFeelingLine(reduceCompanionState(quiet, { type: 'awake-observed' }, MORNING), MORNING)).toBe('');
    }
  });

  it('does not let what lingers be raised, or kept from fading, by deciding strong in every reply', () => {
    let repeated = turn(fresh(), HARSH, QUIET, NIGHT, STRONG).state;
    let once = repeated;
    const first = repeated.lingering![0]!;
    for (let index = 1; index <= 48; index += 1) {
      const now = at(NIGHT, index * 10 * MINUTE);
      const said = turn(repeated, 'ふーん', QUIET, now, STRONG);
      repeated = said.state;
      once = turn(once, 'ふーん', QUIET, now).state;
      // The reaction is felt again at the one step and never above it; what is underneath is never renewed.
      expect(said.feeling.intensity).toBeLessThanOrEqual(0.9);
      expect(repeated.expressiveEmotion!.intensity).toBeLessThanOrEqual(0.9);
      expect(repeated.lingering).toEqual([first]);
    }
    // Eight awake hours on, it stands at half, exactly where one strong reply and silence leave it.
    const end = at(NIGHT, 8 * HOUR);
    expect(livingLingering(repeated, end)[0]!.strength).toBeCloseTo(0.45, 5);
    expect(repeated.lingering).toEqual(once.lingering);
    // And its four wall-clock days count from the first reply, however often it was decided again.
    const late = at(NIGHT, 4 * 24 * HOUR + MINUTE);
    expect(turn(repeated, 'おはよう', 'はい。', late).state.lingering).toEqual([]);
  });

  it('keeps his apology against a strong feeling decided again inside the hold', () => {
    const hurt = turn(fresh(), HARSH, QUIET, NIGHT, STRONG).state;
    const eased = reduceCompanionState(hurt, { type: 'feeling-eased', by: 'apology' }, at(NIGHT, MINUTE));
    const height = livingLingering(eased, at(NIGHT, MINUTE))[0]!.strength;
    expect(height).toBeCloseTo(0.36, 2);
    const again = turn(eased, 'まだ怒ってる？', QUIET, at(NIGHT, 2 * MINUTE), STRONG);
    expect(again.feeling.continued).toBe(true);
    expect(livingLingering(again.state, at(NIGHT, 2 * MINUTE))[0]!.strength).toBeLessThanOrEqual(height);
    expect(presentShannonFeeling(again.state, at(NIGHT, 2 * MINUTE)).intensity).toBeLessThan(0.45);
  });
});

describe('a decided kind that wins over a cue word (a text turn; owner decision 2026-10-03)', () => {
  const HARSH = 'もういい、君とはもう話したくない';
  /** One text turn as the server resolves and commits it: the chat model wrote the reply and chose its feeling. */
  const written = (state: CompanionStateSnapshot, userMessage: string, reply: string, now: string, decided: { primary: string; intensity: number }) => {
    const feeling = resolveReplyEmotion({ snapshot: state, userMessage, reply, now, timing: AWAKE, decided, decidedKindWins: true }).expressiveEmotion;
    return { feeling, state: reduceCompanionState(state, { type: 'expressive-emotion-updated', emotion: feeling }, now, AWAKE) };
  };

  it('keeps kind and strength as decided and puts the cue word beside it', () => {
    const sorry = written(fresh(), HARSH, 'ご、ごめんなさい……。', NIGHT, { primary: 'hurt', intensity: 0.9 });
    expect(sorry.feeling).toMatchObject({ primary: 'hurt', intensity: 0.9, secondary: ['apologetic'], decided: true });
    expect(sorry.state.lingering).toMatchObject([{ kind: 'hurt', span: 'lingering', strength: 0.9 }]);
    // The cue's floor of 0.52 is not given to a feeling decided more weakly.
    const faint = written(fresh(), HARSH, 'ボク、ちょっとすねちゃいます。', NIGHT, { primary: 'hurt', intensity: 0.25 });
    expect(faint.feeling).toMatchObject({ primary: 'hurt', intensity: 0.25, secondary: ['sulky'], decided: true });
    expect(faint.state.lingering ?? []).toEqual([]);
    // A cue of the decided kind is read as before, and so is a reply for which nothing or neutral was decided.
    expect(written(fresh(), HARSH, 'ボク、ちょっとすねちゃいます。', NIGHT, { primary: 'sulky', intensity: 0.25 }).feeling)
      .toMatchObject({ primary: 'sulky', intensity: 0.52, secondary: [] });
    expect(resolveReplyEmotion({ snapshot: fresh(), userMessage: HARSH, reply: 'ふふ、そうですか。', now: NIGHT, timing: AWAKE, decidedKindWins: true }).expressiveEmotion)
      .toMatchObject({ primary: 'giggle', intensity: 0.52 });
    expect(resolveReplyEmotion({ snapshot: fresh(), userMessage: HARSH, reply: 'ふふ、そうですか。', now: NIGHT, timing: AWAKE, decided: { primary: 'neutral', intensity: 0.9 }, decidedKindWins: true }).expressiveEmotion.primary)
      .toBe('giggle');
  });

  it('does not turn a strong curiosity beside 「ほかの子」 into a jealousy that lingers', () => {
    const curious = written(fresh(), '昨日は別の子と話してた', 'ほかの子の話も聞かせてください。', NIGHT, { primary: 'curiosity', intensity: 0.9 });
    expect(curious.feeling).toMatchObject({ primary: 'curiosity', secondary: ['jealous'] });
    expect(curious.state.lingering ?? []).toEqual([]);
  });

  it('does not turn a strong hurt beside 「ふふ」 into a 0.90 giggle that halves the hurt underneath', () => {
    const hurt = written(fresh(), HARSH, '……そうですか。', NIGHT, { primary: 'hurt', intensity: 0.9 }).state;
    const again = written(hurt, 'まだ怒ってる？', 'ふふ、そうですか。', at(NIGHT, 2 * MINUTE), { primary: 'hurt', intensity: 0.9 });
    expect(again.feeling.primary).toBe('hurt');
    expect(again.state.lingering).toEqual(hurt.lingering);
    expect(again.state.lingering![0]).not.toHaveProperty('peak');
  });

  it('still gives the reply to the overrides, with the cue word not kept beside them', () => {
    const grief = written(fresh(), '祖母が亡くなった', 'ふふ……そうですか。', NIGHT, { primary: 'sulky', intensity: 0.9 }).feeling;
    expect(grief).toMatchObject({ primary: 'caring', overrideReason: 'grief', secondary: [] });
    const danger = written(fresh(), '火事だ、助けて', 'えっ、すぐ逃げてください。', NIGHT, { primary: 'sulky', intensity: 0.9 }).feeling;
    expect(danger).toMatchObject({ primary: 'protective', overrideReason: 'emergency', secondary: [] });
    // Accuracy before play, also when the play is only in her words and the decided kind is not playful.
    expect(written(fresh(), '薬を飲み忘れたかも', 'ふふん、ボクは天才ですから。', NIGHT, { primary: 'happy', intensity: 0.9 }).feeling)
      .toMatchObject({ primary: 'focused', overrideReason: 'safety', secondary: [] });
    expect(resolveReplyEmotion({ snapshot: fresh(), userMessage: '薬を飲み忘れたかも', reply: 'ふふん、ボクは天才ですから。', now: NIGHT, timing: AWAKE }).expressiveEmotion)
      .toMatchObject({ primary: 'focused', overrideReason: 'safety' });
    // Her concern is not shown with play beside it.
    expect(written(fresh(), '最近眠れなくて', 'ふふ、そばにいますよ。', NIGHT, { primary: 'caring', intensity: 0.6 }).feeling)
      .toMatchObject({ primary: 'caring', secondary: [] });
  });

  it('decides in one place whether a written reply uses its decided feeling (the server and the evaluation call it)', () => {
    const ask = (state: CompanionStateSnapshot, userMessage: string, reply: string, now: string, decided?: { primary: string; intensity: number }) =>
      resolveWrittenReplyEmotion({ snapshot: state, userMessage, reply, now, timing: AWAKE, ...(decided ? { decided } : {}) });
    const plain = (state: CompanionStateSnapshot, userMessage: string, reply: string, now: string) =>
      resolveReplyEmotion({ snapshot: state, userMessage, reply, now, timing: AWAKE });
    expect(SHANNON_EMOTION_CUE_STRENGTH).toBe(0.52);
    // Moderate or strong wins over a cue of another kind.
    expect(ask(fresh(), HARSH, 'ご、ごめんなさい……。', NIGHT, { primary: 'hurt', intensity: 0.6 }).expressiveEmotion)
      .toMatchObject({ primary: 'hurt', intensity: 0.6, secondary: ['apologetic'] });
    // Subtle does not hide what she voiced; nothing decided, neutral or unknown is the plain reading.
    for (const decided of [{ primary: 'happy', intensity: 0.25 }, { primary: 'neutral', intensity: 0.9 }, { primary: 'furious', intensity: 0.9 }, undefined]) {
      expect(ask(fresh(), HARSH, 'ボク、ちょっとすねちゃいます。', NIGHT, decided)).toEqual(plain(fresh(), HARSH, 'ボク、ちょっとすねちゃいます。', NIGHT));
    }
    // The feeling she has goes on: her apology or concern in her own words shows over the mood, as without a decided feeling.
    const hurt = written(fresh(), HARSH, '……そうですか。', NIGHT, { primary: 'hurt', intensity: 0.9 }).state;
    const later = at(NIGHT, 2 * MINUTE);
    for (const reply of ['ごめんなさい、ボクも言いすぎました。', '大丈夫ですか？無理しないでくださいね。']) {
      const shown = ask(hurt, '今日はしんどい', reply, later, { primary: 'gentle', intensity: 0.6 });
      expect(shown).toEqual(plain(hurt, '今日はしんどい', reply, later));
      expect(['apologetic', 'caring']).toContain(shown.expressiveEmotion.primary);
    }
    // An override took the reply: exactly the plain reading, at the override's own strength.
    for (const message of ['祖母が亡くなった', '火事だ、助けて', '薬を飲み忘れたかも']) {
      expect(ask(fresh(), message, 'ふふん、ボクは天才ですから。', NIGHT, { primary: 'sulky', intensity: 0.9 }))
        .toEqual(plain(fresh(), message, 'ふふん、ボクは天才ですから。', NIGHT));
    }
  });

  it('leaves a voice turn as it was: without the flag the cue in the completed reply names the kind', () => {
    const voiced = turn(fresh(), HARSH, 'ご、ごめんなさい……。', NIGHT, { primary: 'hurt', intensity: 0.9 });
    expect(voiced.feeling).toMatchObject({ primary: 'apologetic', intensity: 0.9, secondary: [] });
    expect(voiced.feeling.decided).toBeUndefined();
  });
});

describe('the wall clock as a fact', () => {
  it('says how long ago in whole hours, and in days from twenty-four hours', () => {
    const state = sulking();
    const since = (minutes: number) => lingeringMeaning(state.lingering![0]!, 0.3, at(NIGHT, minutes * MINUTE));
    expect(since(59)).toMatch(/^さっきライ氏との会話で/u);
    expect(since(60)).toMatch(/^1時間前に/u);
    expect(since(90)).toMatch(/^1時間前に/u);
    expect(since(119)).toMatch(/^1時間前に/u);
    expect(since(1_439)).toMatch(/^23時間前に/u);
    expect(since(1_440)).toMatch(/^1日前に/u);
    expect(since(2 * 1_440 + 5)).toMatch(/^2日前に/u);
  });
});

describe('prompt budget', () => {
  it('adds no line when nothing is left, and one bounded line when something is', () => {
    const quiet = buildCompanionStatePrompt(fresh(), { maximumCharacters: 1_200, now: NIGHT });
    expect(quiet).not.toContain('まだ残っている気持ち');
    const line = lingeringFeelingLine(sulking(), MORNING);
    expect(line.length).toBeLessThanOrEqual(140);
    const two = turn(sulking(), 'すごいね', 'はい。', at(NIGHT, MINUTE), { primary: 'jealous', intensity: 0.9 }).state;
    expect(lingeringFeelingLine(two, MORNING).length).toBeLessThanOrEqual(200);
    const prompt = buildCompanionStatePrompt({ ...sulking(), interests: [], userFacts: [], relationships: [], activeMemories: [] }, { maximumCharacters: 1_200, now: MORNING });
    expect(prompt.length).toBeLessThanOrEqual(1_200);
    expect(prompt).toContain('まだ残っている気持ち');
    expect(prompt).toContain('今、想起されている記憶: なし');
    expect(lingeringFeelingLine(sulking(), undefined)).toBe('');
  });
});
