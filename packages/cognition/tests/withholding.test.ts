import { describe, expect, it } from 'vitest';
import {
  createInitialCompanionState,
  memoryKeyTerms,
  memoryWithholdingRules,
  reduceCompanionState,
  restatesWithheldMemory,
  ruleWithholdsText,
  type CompanionStateSnapshot,
  type MemoryControl,
} from '../src/index.js';

const at = '2026-09-20T00:00:00.000Z';
const later = '2026-09-21T00:00:00.000Z';
const base = (controls: readonly MemoryControl[], extra: Partial<CompanionStateSnapshot> = {}): CompanionStateSnapshot =>
  ({ ...createInitialCompanionState('owner', at), ...extra, memoryControls: controls });
const control = (extra: Partial<MemoryControl>): MemoryControl => ({
  memoryId: 'fact-1', kind: 'user-fact', status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'synthetic', ...extra,
});
const terms = (text: string) => memoryKeyTerms(text).map(group => group[0]);

describe('key terms of a withheld memory', () => {
  it('keeps topics and drops speaker, time and inflection', () => {
    expect(terms('私は紅茶が好き。')).toEqual(['紅茶']);
    expect(terms('ユーザーは猫を飼っている')).toEqual(['猫']);
    expect(terms('明日プレゼンの練習をしよう')).toEqual(['プレゼン', '練習']);
    expect(terms('誕生日は5月1日')).toEqual(['誕生日', '5月', '1日']);
    expect(terms('Shannon Deskを配信したい')).toEqual(['shannon', 'desk', '配信']);
    expect(terms('うどんがすきです')).toEqual(['うどん']);
    expect(terms('あれはそれです')).toEqual([]);
  });

  it('matches a long compound by its parts', () => {
    const [group] = memoryKeyTerms('東京都港区在住');
    expect(group).toEqual(expect.arrayContaining(['東京都港区在住', '東京', '港区']));
  });
});

describe('withholding rules', () => {
  it('has no rule for an active, uncorrected or restored item', () => {
    expect(memoryWithholdingRules(base([control({ status: 'active', pinned: true, contextInvalidatedAt: at })]))).toEqual([]);
  });

  it('withholds an earlier text that restates the item, and nothing written after the boundary', () => {
    const [rule] = memoryWithholdingRules(base([control({ sourceEvidence: '私は紅茶が好き', contextInvalidatedAt: at })]));
    expect(rule).toMatchObject({ memoryId: 'fact-1', boundary: at, needed: 1, wide: false });
    expect(ruleWithholdsText(rule!, 'ライ氏は紅茶が好きですよね。', at)).toBe(true);
    expect(ruleWithholdsText(rule!, '署名設定を確認しましょう。', at)).toBe(false);
    expect(ruleWithholdsText(rule!, '紅茶は3分蒸らします。', later)).toBe(false);
  });

  it('falls back to the wide boundary only when no key term can be derived', () => {
    const [rule] = memoryWithholdingRules(base([control({ sourceEvidence: 'あれはそれです' })]));
    expect(rule).toMatchObject({ wide: true, terms: [] });
    expect(ruleWithholdsText(rule!, '署名設定を確認しましょう。', at)).toBe(true);
    expect(ruleWithholdsText(rule!, '署名設定を確認しましょう。', later)).toBe(false);
  });

  it('requires more than one key term when the source is a long utterance', () => {
    const [rule] = memoryWithholdingRules(base([control({ kind: 'experience',
      sourceEvidence: '週末は箱根の温泉旅館に泊まって、美術館と湖の遊覧船と寄木細工の工房を回る予定で、新幹線と登山鉄道の切符も買った' })]));
    expect(rule!.needed).toBe(2);
    expect(restatesWithheldMemory(rule!, '美術館は平日が空いています。')).toBe(false);
    expect(restatesWithheldMemory(rule!, '箱根なら美術館と温泉を組み合わせられます。')).toBe(true);
  });

  it('a correction withholds only what it no longer says; a forgotten correction withholds both wordings', () => {
    const fact = { id: 'fact-1', statement: 'ユーザーは横浜で紅茶の店を営む', evidence: '私は横浜で紅茶の店を営んでいる', confidence: 0.8, observedAt: at };
    const corrected = control({ status: 'active', overrideText: 'ユーザーは横浜でコーヒーの店を営む' });
    const [rule] = memoryWithholdingRules(base([corrected], { userFacts: [fact] }));
    expect(rule!.terms.map(group => group[0])).toEqual(['紅茶']);
    expect(rule!.wide).toBe(false);
    const [forgotten] = memoryWithholdingRules(base([{ ...corrected, status: 'forgotten' }], { userFacts: [fact] }));
    expect(forgotten!.terms.map(group => group[0])).toEqual(expect.arrayContaining(['横浜', '紅茶', 'コーヒー']));
  });

  it('keeps the rule after the item leaves the bounded state, and the new control fields survive the reducer', () => {
    const saved = reduceCompanionState(createInitialCompanionState('owner', at), { type: 'memory-control-upserted', control: control({
      withheldText: 'ユーザーは紅茶が好き', causedBy: 'promise-9', commitmentStatusBefore: 'completed',
    }) }, later);
    expect(saved.memoryControls[0]).toMatchObject({ withheldText: 'ユーザーは紅茶が好き', causedBy: 'promise-9', commitmentStatusBefore: 'completed' });
    expect(memoryWithholdingRules(saved)[0]!.terms.map(group => group[0])).toEqual(['紅茶']);
  });
});
