import { describe, expect, it } from 'vitest';
import {
  LIVE_COMMENTARY_V1, LIVE_MOMENT_KINDS, LiveGovernor, itemWords, liveFactLine, liveSalience, pickMoments, type LiveMoment, type LiveMomentKind,
} from '../src/index.js';

const T0 = Date.parse('2026-10-20T10:00:00.000Z');
const moment = (kind: LiveMomentKind, at = T0, facts: LiveMoment['facts'] = {}, key = `${kind}:${at}`): LiveMoment => ({ kind, key, at, facts });
const room = (now: number, more: Partial<Parameters<LiveGovernor['verdict']>[1]> = {}) => ({ now, sinceHumanMilliseconds: null, ...more });

describe('liveSalience', () => {
  it('is the kind alone, with a bonus for the first of its kind and one for danger', () => {
    expect(liveSalience('diamond_found', { first: false })).toBeCloseTo(0.82);
    expect(liveSalience('diamond_found', { first: true })).toBeCloseTo(1 - 0.18 * 0.8);
    expect(liveSalience('night_fell', { first: false })).toBeCloseTo(0.45);
    expect(liveSalience('night_fell', { first: true })).toBeGreaterThan(LIVE_COMMENTARY_V1.threshold);
    expect(liveSalience('morning', { first: true })).toBeLessThan(LIVE_COMMENTARY_V1.threshold);
    expect(liveSalience('morning', { first: true, danger: true })).toBeGreaterThan(LIVE_COMMENTARY_V1.threshold);
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
  });
  it('never carries an instruction', () => {
    for (const kind of LIVE_MOMENT_KINDS) expect(liveFactLine(moment(kind))).not.toMatch(/すべき|しろ|して(?:くだ|ね)|言(?:え|って)/u);
  });
});

describe('LiveGovernor', () => {
  it('speaks of a loud first moment and is silent for a quiet one', () => {
    const governor = new LiveGovernor();
    expect(governor.verdict(moment('diamond_found'), room(T0 + 1000))).toMatchObject({ speak: true });
    expect(governor.verdict(moment('morning'), room(T0 + 1000))).toMatchObject({ speak: false, reason: 'salience' });
    expect(governor.verdict(moment('night_fell'), room(T0 + 1000))).toMatchObject({ speak: true });
  });

  it('lets a repeat of a quiet kind pass in silence once it has been told', () => {
    const governor = new LiveGovernor();
    governor.delivered(moment('night_fell'), '夜だ', T0);
    expect(governor.verdict(moment('night_fell', T0 + 900_000), room(T0 + 900_000))).toMatchObject({ speak: false, reason: 'salience' });
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
    governor.delivered(moment('diamond_found', T0), 'a', T0);
    governor.delivered(moment('slept', T0 + 20_000), 'b', T0 + 20_000);
    expect(governor.verdict(moment('structure_found', T0 + 40_000), room(T0 + 40_000))).toMatchObject({ reason: 'rate' });
    expect(governor.verdict(moment('structure_found', T0 + 62_000), room(T0 + 62_000))).toMatchObject({ speak: true });
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
    expect(governor.verdict(moment('died', T0 + 20_000), room(T0 + 20_000))).toMatchObject({ speak: false });
  });

  it('counts danger toward a quiet moment', () => {
    const governor = new LiveGovernor();
    expect(governor.verdict(moment('hungry', T0, { food: 4 }), room(T0)).speak).toBe(false);
    expect(governor.verdict(moment('hungry', T0, { food: 4 }), room(T0, { danger: true })).speak).toBe(true);
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
