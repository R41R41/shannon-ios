import { describe, expect, it } from 'vitest';
import {
  LIVE_COMMENTARY_STREAM, LIVE_COMMENTARY_V1, LIVE_MOMENT_KINDS, LiveGovernor, SPEECH_MODES, SPEECH_NEEDED_KINDS, SPEECH_RATES, isSpeechMode, isSpeechRate, itemWords, liveCommentaryLimits, liveGroupOf, liveIsReaction, liveRateLimits, liveFactLine, liveSalience, pickMoments, type LiveMoment,
  type LiveMomentKind,
} from '../src/index.js';

const T0 = Date.parse('2026-10-20T10:00:00.000Z');
const moment = (kind: LiveMomentKind, at = T0, facts: LiveMoment['facts'] = {}, key = `${kind}:${at}`): LiveMoment => ({ kind, key, at, facts });
const room = (now: number, more: Partial<Parameters<LiveGovernor['verdict']>[1]> = {}) => ({ now, sinceHumanMilliseconds: null, ...more });

describe('liveSalience', () => {
  it('is the kind alone, with a bonus for the first of its kind and one for danger', () => {
    expect(liveSalience('diamond_found', { first: false })).toBeCloseTo(0.82);
    expect(liveSalience('diamond_found', { first: true })).toBeCloseTo(1 - 0.18 * 0.8);
    expect(liveSalience('night_fell', { first: false })).toBeCloseTo(0.6);
    expect(liveSalience('night_fell', { first: true })).toBeGreaterThan(LIVE_COMMENTARY_V1.threshold);
    // The little voices of her body and of the time of day are above the bar even the second time (they were below it, and so never said).
    for (const kind of ['hungry', 'morning', 'night_fell', 'stuck'] as const) expect(liveSalience(kind, { first: false })).toBeGreaterThanOrEqual(LIVE_COMMENTARY_V1.threshold);
    // The view of a place is a quiet one: the first is said, a second is not unless danger is near.
    expect(liveSalience('scenery', { first: false })).toBeLessThan(LIVE_COMMENTARY_V1.threshold);
    expect(liveSalience('scenery', { first: true })).toBeGreaterThan(LIVE_COMMENTARY_V1.threshold);
    expect(liveSalience('scenery', { first: false, danger: true })).toBeGreaterThan(LIVE_COMMENTARY_V1.threshold);
  });
  it('is in [0, 1] for every kind', () => {
    for (const kind of LIVE_MOMENT_KINDS) {
      for (const first of [true, false]) for (const danger of [true, false]) {
        const value = liveSalience(kind, { first, danger });
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('liveFactLine', () => {
  it('tells every kind in fixed words with its closed values', () => {
    for (const kind of LIVE_MOMENT_KINDS) expect(liveFactLine(moment(kind)).length).toBeGreaterThan(3);
    expect(liveFactLine(moment('diamond_found', T0, { count: 2 }))).toBe('ダイヤモンドの鉱石を見つけた（2か所）。');
    expect(liveFactLine(moment('diamond_found', T0, { count: 3, carried: true }))).toBe('ダイヤモンドを手に入れた（3個）。');
    expect(liveFactLine(moment('dimension_entered', T0, { dimension: 'the_nether' }))).toBe('ネザーに入った。');
    expect(liveFactLine(moment('milestone_late', T0, { name: '鉄', target: 420, over: 95 }))).toBe('「鉄」は目安の420秒を95秒すぎている。');
    expect(liveFactLine(moment('dragon_stage', T0, { stage: 'crystals', crystals: 4 }))).toContain('残り4個');
    expect(itemWords('white_bed')).toBe('ベッド');
    expect(itemWords('diamond_pickaxe')).toBe('ダイヤのツルハシ');
    expect(itemWords('wheat_seeds')).toBe('小麦の種');
    expect(itemWords('wooden_hoe')).toBe('木のクワ');
    expect(itemWords('stone_axe')).toBe('石の斧');
    expect(itemWords('iron_sword')).toBe('鉄の剣');
    expect(itemWords('some_new_item')).toBe('some new item');
  });
  it('never carries an instruction', () => {
    for (const kind of LIVE_MOMENT_KINDS) expect(liveFactLine(moment(kind))).not.toMatch(/すべき|しろ|して(?:くだ|ね)|言(?:え|って)/u);
  });
});

describe('LiveGovernor', () => {
  it('speaks of a loud first moment and is silent for a quiet one', () => {
    const governor = new LiveGovernor();
    expect(governor.verdict(moment('diamond_found'), room(T0 + 1000))).toMatchObject({ speak: true });
    expect(governor.verdict(moment('morning'), room(T0 + 1000))).toMatchObject({ speak: true });
    governor.delivered(moment('scenery'), '景色が変わった', T0);
    expect(governor.verdict(moment('scenery', T0 + 400_000), room(T0 + 400_000))).toMatchObject({ speak: false, reason: 'salience' });
  });

  it('lets a repeat of a quiet kind pass in silence once it has been told', () => {
    const governor = new LiveGovernor();
    governor.delivered(moment('scenery'), '景色だ', T0);
    expect(governor.verdict(moment('scenery', T0 + 900_000), room(T0 + 900_000))).toMatchObject({ speak: false, reason: 'salience' });
  });

  it('holds a moment that is old: its lifetime, and once spent', () => {
    const governor = new LiveGovernor();
    expect(governor.verdict(moment('diamond_found'), room(T0 + 61_000))).toMatchObject({ speak: false, reason: 'stale' });
    expect(governor.verdict(moment('near_death'), room(T0 + 25_000))).toMatchObject({ speak: false, reason: 'stale' });
    const once = moment('diamond_found');
    governor.spend(once);
    expect(governor.verdict(once, room(T0 + 1000))).toMatchObject({ speak: false, reason: 'stale' });
  });

  it('keeps quiet while someone speaks or has just spoken, and breaks in sooner for an important moment', () => {
    const governor = new LiveGovernor();
    expect(governor.verdict(moment('tool_made', T0, { item: 'iron_pickaxe' }), room(T0, { humanSpeaking: true }))).toMatchObject({ reason: 'human' });
    expect(governor.verdict(moment('tool_made'), room(T0, { sinceHumanMilliseconds: 5_000 }))).toMatchObject({ reason: 'human' });
    expect(governor.verdict(moment('tool_made'), room(T0, { sinceHumanMilliseconds: 9_000 }))).toMatchObject({ speak: true });
    expect(governor.verdict(moment('diamond_found'), room(T0, { sinceHumanMilliseconds: 4_000 }))).toMatchObject({ speak: true });
    expect(governor.verdict(moment('diamond_found'), room(T0, { sinceHumanMilliseconds: 2_000 }))).toMatchObject({ reason: 'human' });
    expect(governor.verdict(moment('diamond_found'), room(T0, { replying: true }))).toMatchObject({ reason: 'replying' });
  });

  it('allows two words a minute at most and seven in ten', () => {
    const governor = new LiveGovernor();
    const kinds: LiveMomentKind[] = ['diamond_found', 'armor_complete', 'structure_found', 'item_got', 'dragon_stage', 'dimension_entered',
      'slept', 'blaze_seen'];
    let now = T0;
    const told: boolean[] = [];
    for (const kind of kinds) {
      const m = moment(kind, now);
      const verdict = governor.verdict(m, room(now));
      told.push(verdict.speak);
      if (verdict.speak) governor.delivered(m, `${kind}!`, now);
      now += 21_000;
    }
    // 21 s apart clears the 18 s gap, so only the minute's budget and the topics hold the rest back.
    expect(told.filter(Boolean).length).toBeLessThanOrEqual(kinds.length);
    const inFirstMinute = told.slice(0, 3).filter(Boolean).length;
    expect(inFirstMinute).toBeLessThanOrEqual(LIVE_COMMENTARY_V1.perMinute);
    expect(governor.stats(now).last10Minutes).toBeLessThanOrEqual(LIVE_COMMENTARY_V1.perTenMinutes);
  });

  it('holds the minute budget exactly', () => {
    const governor = new LiveGovernor();
    const kinds: LiveMomentKind[] = ['diamond_found', 'slept', 'item_got', 'dragon_stage'];
    kinds.slice(0, LIVE_COMMENTARY_V1.perMinute).forEach((kind, index) => governor.delivered(moment(kind, T0 + index * 13_000), `${kind}`, T0 + index * 13_000));
    const last = T0 + (LIVE_COMMENTARY_V1.perMinute - 1) * 13_000;
    expect(governor.verdict(moment('structure_found', last + 14_000), room(last + 14_000))).toMatchObject({ reason: 'rate' });
    expect(governor.verdict(moment('structure_found', T0 + 62_000), room(T0 + 62_000))).toMatchObject({ speak: true });
  });

  it('says about four a minute while she works, and a number from the environment moves it', () => {
    expect(LIVE_COMMENTARY_V1.perMinute).toBe(4);
    const tuned = liveCommentaryLimits({ SHANNON_MINECRAFT_LIVE_PER_MINUTE: '6', SHANNON_MINECRAFT_LIVE_GAP_SECONDS: '9' });
    expect(tuned).toMatchObject({ perMinute: 6, gapSeconds: { ordinary: 9 } });
    expect(tuned.perTenMinutes).toBeGreaterThanOrEqual(42);
    expect(liveCommentaryLimits({ SHANNON_MINECRAFT_LIVE_PER_MINUTE: 'many', SHANNON_MINECRAFT_LIVE_PER_TEN_MINUTES: '0' }))
      .toMatchObject({ perMinute: 4, perTenMinutes: 28 });
    expect(liveCommentaryLimits({})).toEqual(LIVE_COMMENTARY_V1);
  });

  it('scales the commentary by the speech rate: low is half, normal is as it was, high is one and a half with a shorter gap', () => {
    const summary = (rate: 'low' | 'normal' | 'high') => {
      const limits = liveRateLimits(LIVE_COMMENTARY_V1, rate);
      return [limits.perMinute, limits.perTenMinutes, limits.gapSeconds.ordinary, limits.gapSeconds.urgent];
    };
    expect(summary('low')).toEqual([2, 14, 24, 5]);
    expect(summary('normal')).toEqual([4, 28, 12, 5]);
    expect(summary('high')).toEqual([6, 42, 8, 5]);
    expect(liveRateLimits(LIVE_COMMENTARY_V1, 'normal')).toBe(LIVE_COMMENTARY_V1);
    expect(liveRateLimits(LIVE_COMMENTARY_V1, 'high')).toMatchObject({ topicSeconds: 90, kindSeconds: 240, threshold: 0.55 });
    // Over a tuned base the same scale applies, and the ends of the range hold.
    const tuned = liveCommentaryLimits({ SHANNON_MINECRAFT_LIVE_PER_MINUTE: '1', SHANNON_MINECRAFT_LIVE_GAP_SECONDS: '120' });
    expect(liveRateLimits(tuned, 'low')).toMatchObject({ perMinute: 1, gapSeconds: { ordinary: 120 } });
    expect(liveRateLimits(tuned, 'high').gapSeconds.ordinary).toBe(80);
  });

  it('holds the new numbers in the governor and keeps what she told when the rate changes', () => {
    const governor = new LiveGovernor();
    governor.delivered(moment('diamond_found', T0), 'a', T0);
    governor.setLimits(liveRateLimits(LIVE_COMMENTARY_V1, 'low'));
    expect(governor.numbers.perMinute).toBe(2);
    // The gap is now 24 s: a word 14 s after the last is held, one 26 s after is not.
    expect(governor.verdict(moment('structure_found', T0 + 14_000), room(T0 + 14_000))).toMatchObject({ reason: 'gap' });
    expect(governor.verdict(moment('structure_found', T0 + 26_000), room(T0 + 26_000))).toMatchObject({ speak: true });
    expect(governor.recentWords()).toEqual(['a']);
  });

  it('names the kinds she still says when not chatty, and every one is a live moment of hers', () => {
    expect(SPEECH_NEEDED_KINDS.slice(0, 4)).toEqual(['task_done', 'stuck', 'near_death', 'died']);
    // The voice of what happens to her is said when she speaks only when needed; her monologue of the work is not.
    for (const kind of ['attacked', 'scared', 'surprised', 'got_away', 'killed', 'respawned', 'hungry', 'night_fell', 'morning', 'player_near', 'scenery'] as const) {
      expect(SPEECH_NEEDED_KINDS).toContain(kind);
    }
    for (const kind of ['thinking', 'plan_step', 'plan_changed', 'material_needed', 'material_got', 'milestone_passed', 'milestone_late', 'working'] as const) {
      expect(SPEECH_NEEDED_KINDS).not.toContain(kind);
    }
    for (const kind of SPEECH_NEEDED_KINDS) expect(LIVE_MOMENT_KINDS).toContain(kind);
    expect(SPEECH_MODES).toEqual(['chatty', 'needed', 'silent']);
    expect(SPEECH_RATES).toEqual(['low', 'normal', 'high']);
    expect(isSpeechMode('needed')).toBe(true);
    expect(isSpeechMode('loud')).toBe(false);
    expect(isSpeechRate('high')).toBe(true);
    expect(isSpeechRate(2)).toBe(false);
  });

  it('speaks of her work as it goes: a plan step and a thought are short-lived, the end of a request is urgent', () => {
    const governor = new LiveGovernor();
    expect(governor.verdict(moment('thinking', T0, { why: '牛乳にはバケツがいる' }), room(T0 + 1_000))).toMatchObject({ speak: true });
    expect(governor.verdict(moment('thinking', T0, { why: '牛乳にはバケツがいる' }), room(T0 + 21_000))).toMatchObject({ reason: 'stale' });
    const done = governor.verdict(moment('task_done', T0, { goal: 'ケーキを作る' }), room(T0 + 1_000, { sinceHumanMilliseconds: 4_000 }));
    expect(done).toMatchObject({ speak: true });
    expect(done.salience).toBeGreaterThanOrEqual(LIVE_COMMENTARY_V1.urgent);
    expect(liveFactLine(moment('task_done', T0, { goal: 'ケーキを作る' }))).toContain('ケーキを作る');
    expect(liveFactLine(moment('plan_step', T0, { done: '鉄を掘る', next: 'バケツを作る' }))).toBe('「鉄を掘る」が済んだ（次は「バケツを作る」）。');
    expect(liveFactLine(moment('material_got', T0, { item: 'wheat_seeds', count: 2, need: 3 }))).toContain('小麦の種');
    // Spaced by their own seconds: a thought, then a plan step, then a material in the same minute are told; the same kind again soon is not.
    governor.delivered(moment('thinking', T0), 'a', T0);
    expect(governor.verdict(moment('thinking', T0 + 14_000), room(T0 + 14_000))).toMatchObject({ reason: 'topic' });
    expect(governor.verdict(moment('material_got', T0 + 14_000, { item: 'iron_ingot', count: 1 }), room(T0 + 14_000))).toMatchObject({ speak: true });
  });

  it('lets the end of a second request through soon after the first, and through a full minute budget', () => {
    const governor = new LiveGovernor();
    governor.delivered(moment('task_done', T0, { goal: 'ケーキを作る' }), 'a', T0);
    expect(governor.verdict(moment('task_done', T0 + 30_000, { goal: '鉄を集める' }), room(T0 + 30_000))).toMatchObject({ speak: true });
    const busy = new LiveGovernor();
    (['diamond_found', 'slept', 'item_got', 'dragon_stage'] as LiveMomentKind[]).forEach((kind, index) =>
      busy.delivered(moment(kind, T0 + index * 6_000), kind, T0 + index * 6_000));
    expect(busy.verdict(moment('structure_found', T0 + 30_000), room(T0 + 30_000))).toMatchObject({ reason: 'rate' });
    expect(busy.verdict(moment('task_done', T0 + 30_000, { goal: 'ケーキを作る' }), room(T0 + 30_000))).toMatchObject({ speak: true });
  });

  it('keeps a public stream to the two words a minute it had, whatever the call is given', () => {
    expect(LIVE_COMMENTARY_STREAM).toMatchObject({ perMinute: 2, perTenMinutes: 7, gapSeconds: { ordinary: 18, urgent: 6 } });
    expect(LIVE_COMMENTARY_STREAM.perMinute).toBeLessThan(LIVE_COMMENTARY_V1.perMinute);
  });

  it('keeps a gap, shorter for an urgent moment', () => {
    const governor = new LiveGovernor();
    governor.delivered(moment('diamond_found', T0), 'a', T0);
    expect(governor.verdict(moment('structure_found', T0 + 10_000), room(T0 + 10_000))).toMatchObject({ reason: 'gap' });
    expect(governor.verdict(moment('near_death', T0 + 10_000), room(T0 + 10_000))).toMatchObject({ speak: true });
    expect(governor.verdict(moment('near_death', T0 + 3_000), room(T0 + 3_000))).toMatchObject({ reason: 'gap' });
  });

  it('does not speak of one topic twice in 90 s unless it is urgent, nor of one kind twice in 4 minutes', () => {
    const governor = new LiveGovernor();
    governor.delivered(moment('night_fell', T0), '夜だ', T0);
    expect(governor.verdict(moment('slept', T0 + 30_000), room(T0 + 30_000))).toMatchObject({ reason: 'topic' });
    expect(governor.verdict(moment('slept', T0 + 100_000), room(T0 + 100_000))).toMatchObject({ speak: true });
    governor.delivered(moment('structure_found', T0 + 100_000), '村だ', T0 + 100_000);
    expect(governor.verdict(moment('structure_found', T0 + 150_000), room(T0 + 150_000))).toMatchObject({ reason: 'topic' });
    expect(governor.verdict(moment('structure_found', T0 + 200_000), room(T0 + 200_000))).toMatchObject({ reason: 'kind' });
    expect(governor.verdict(moment('structure_found', T0 + 341_000), room(T0 + 341_000))).toMatchObject({ speak: true });
  });

  it('lets a death be told twice within a few minutes', () => {
    const governor = new LiveGovernor();
    governor.delivered(moment('died', T0), 'やられた', T0);
    expect(governor.verdict(moment('died', T0 + 40_000), room(T0 + 40_000))).toMatchObject({ speak: true });
    // Each death is its own word: a second one 20 s after the first is told, one a few seconds after it is not.
    expect(governor.verdict(moment('died', T0 + 20_000), room(T0 + 20_000))).toMatchObject({ speak: true });
    expect(governor.verdict(moment('died', T0 + 7_000), room(T0 + 7_000))).toMatchObject({ speak: false });
  });

  it('counts danger toward a quiet moment', () => {
    const governor = new LiveGovernor();
    governor.delivered(moment('scenery', T0 - 400_000), '景色だ', T0 - 400_000);
    expect(governor.verdict(moment('scenery', T0), room(T0)).speak).toBe(false);
    expect(governor.verdict(moment('scenery', T0), room(T0, { danger: true })).speak).toBe(true);
  });

  it('remembers her words and rejects a line that says the same again', () => {
    const governor = new LiveGovernor();
    governor.delivered(moment('diamond_found', T0), 'ダイヤ見つけた！ すごくない？', T0);
    expect(governor.fresh('ダイヤ見つけた！ すごくない？')).toBe(false);
    expect(governor.fresh('鉄の防具、全部そろったよ')).toBe(true);
    expect(governor.recentWords()).toEqual(['ダイヤ見つけた！ すごくない？']);
  });
});

describe('pickMoments', () => {
  it('takes the loudest and folds two others of other kinds into its telling', () => {
    const a = { moment: moment('diamond_found'), salience: 0.9 };
    const b = { moment: moment('armor_complete', T0 + 1), salience: 0.8 };
    const c = { moment: moment('diamond_found', T0 + 2, {}, 'x'), salience: 0.7 };
    const d = { moment: moment('slept', T0 + 3), salience: 0.6 };
    const picked = pickMoments([c, b, d, a]);
    expect(picked?.main).toBe(a);
    expect(picked?.also).toEqual([b, d]);
    expect(pickMoments([])).toBeNull();
  });
});

describe('the voice of what happens to her', () => {
  it('belongs to six groups, and a reaction is the kind of thing that happens this second', () => {
    const groups = new Set(LIVE_MOMENT_KINDS.map(kind => liveGroupOf(kind)));
    expect([...groups].sort()).toEqual(['body', 'danger', 'fight', 'find', 'people', 'work']);
    for (const kind of ['attacked', 'scared', 'surprised', 'got_away', 'killed', 'respawned', 'near_death', 'died'] as const) expect(liveIsReaction(kind)).toBe(true);
    for (const kind of ['hungry', 'scenery', 'task_done', 'thinking', 'working'] as const) expect(liveIsReaction(kind)).toBe(false);
  });

  it('tells each new kind in fixed words with its closed values', () => {
    expect(liveFactLine(moment('attacked', T0, { from: 'ゾンビ', count: 3, health: 14 }))).toBe('ゾンビたち（3体）に襲われはじめた（体力が20のうち14）。');
    expect(liveFactLine(moment('attacked', T0, { from: 'ゾンビ', count: 1, health: 17 }))).toBe('ゾンビに襲われはじめた（体力が20のうち17）。');
    expect(liveFactLine(moment('died', T0, { cause: 'モンスターに殴られた', from: 'ゾンビ' }))).toBe('体が倒れた（原因: モンスターに殴られた。近くにゾンビがいた）。');
    expect(liveFactLine(moment('scared', T0, { from: 'クリーパー', distance: 3, lit: true }))).toContain('火がついている');
    expect(liveFactLine(moment('respawned'))).toBe('倒れたあと、生き返った。');
    expect(liveFactLine(moment('working', T0, { doing: '階段状に深く掘り下がっている', seconds: 24 }))).toBe('いま「階段状に深く掘り下がっている」の途中で、24秒ほど話していない。');
  });

  it('gives a reaction the urgent gap and a few words more in the minute than her ordinary talk, but never more than the mouth takes', () => {
    const governor = new LiveGovernor();
    for (let i = 0; i < 4; i += 1) governor.delivered(moment('scenery', T0 + i * 12_000), `景色${i}`, T0 + i * 12_000);
    const now = T0 + 50_000;
    // Four words in the last minute: ordinary talk is at its limit, a hit is not.
    expect(governor.verdict(moment('hungry', now), room(now))).toMatchObject({ speak: false, reason: 'rate' });
    expect(governor.verdict(moment('attacked', now), room(now))).toMatchObject({ speak: true });
    for (let i = 0; i < 2; i += 1) governor.delivered(moment('killed', T0 + 36_000 + i * 6_000), `やった${i}`, T0 + 40_000 + i * 6_000);
    expect(governor.verdict(moment('got_away', now), room(now))).toMatchObject({ speak: false, reason: 'rate' });
    // The gap of a reaction is the urgent one (5 s), an ordinary kind's is 12 s.
    const fresh = new LiveGovernor();
    fresh.delivered(moment('scenery', T0), '景色', T0);
    expect(fresh.verdict(moment('attacked', T0 + 6_000), room(T0 + 6_000))).toMatchObject({ speak: true });
    expect(fresh.verdict(moment('hungry', T0 + 6_000), room(T0 + 6_000))).toMatchObject({ speak: false, reason: 'gap' });
  });

  it('asks what she said lately of one group only, and holds a cry to a lower bar of freshness against its own sort', () => {
    const governor = new LiveGovernor();
    governor.delivered(moment('plan_step', T0), 'ベッドできたよ！ふかふかだよ', T0);
    governor.delivered(moment('attacked', T0 + 1_000), 'うわあああ！襲われてるよお！', T0 + 1_000);
    expect(governor.recentOf('danger', T0 + 5_000)).toEqual(['うわあああ！襲われてるよお！']);
    expect(governor.recentOf('work', T0 + 5_000)).toEqual(['ベッドできたよ！ふかふかだよ']);
    expect(governor.recentOf('danger', T0 + 400_000)).toEqual([]);
    expect(governor.fresh('うわあああ！襲われてるよお！', 'danger', 0.2)).toBe(false);
    expect(governor.fresh('いたたた、また来たよお', 'danger', 0.2)).toBe(true);
    // A work line is not compared with a cry.
    expect(governor.fresh('うわあああ！襲われてるよお！', 'work')).toBe(true);
    expect(governor.lastToldAt()).toBe(T0 + 1_000);
  });
});
