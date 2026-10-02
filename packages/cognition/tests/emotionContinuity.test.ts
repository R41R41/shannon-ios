import { describe, expect, it, vi } from 'vitest';
import {
  SHANNON_EMOTION_CONTINUITY,
  SHANNON_EMOTION_TIME,
  advanceEmotionClock,
  awakeTimeAt,
  buildCompanionStatePrompt,
  createInitialCompanionState,
  deriveEmotionDelta,
  faceForMood,
  holdsShannonFeeling,
  lingeringFeelingLine,
  livingLingering,
  moodBaseline,
  presentShannonFeeling,
  presentShannonMood,
  reduceCompanionState,
  remainingShare,
  resolveReplyEmotion,
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
    expect(advanceEmotionClock(late.clock, at(NIGHT, 60 * MINUTE), AWAKE)).toEqual({ clock: late.clock, elapsedMs: 0 });
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
      // The reply itself may show it, for that reply.
      expect(said.feeling.primary).toBe('sulky');
      expect(said.feeling.intensity).toBeLessThanOrEqual(0.52);
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
    // A strength decided for the reply (a voice turn) does renew it.
    expect(turn(awakeFor(sulking(), NIGHT, 60), 'もう知らない', '……。', at(NIGHT, HOUR), { primary: 'sulky', intensity: 0.6 }).state.lingering)
      .toMatchObject([{ kind: 'sulky', strength: 0.6, startedAt: NIGHT }]);
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
    // Only a stimulus that is itself stronger than what she feels is a new feeling, stored at its own strength.
    const stronger = turn(sulk, 'もう知らない', '……。', now, { primary: 'sulky', intensity: 0.9 });
    expect(stronger.feeling).toMatchObject({ primary: 'sulky', intensity: 0.9, continued: false, decided: true });
    expect(stronger.state.lingering).toMatchObject([{ kind: 'sulky', strength: 0.9 }]);
    // Nothing of the resolver's notes is stored.
    expect(Object.keys(stronger.state.expressiveEmotion!)).not.toEqual(expect.arrayContaining(['continued']));
    expect(JSON.stringify(stronger.state)).not.toMatch(/"continued"|"decided"|"presentAt"/u);
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
    for (const apology of ['さっきはごめん、言いすぎた', 'ごめんね', 'ごめん', '昨日はごめん', 'ボクが悪かった', '言い過ぎた、許してほしい']) {
      expect(soothingIn(apology), apology).toBe('apology');
    }
    expect(soothingIn('いつもありがとう')).toBe('kindness');
    // Not an apology and not a kind word to her.
    for (const other of ['すみません、これ教えて', '次の予定は？', '今日は天気が悪かったね', 'ごめん、ちょっと待って', 'さすがに無理', '好きな食べ物は？']) {
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
