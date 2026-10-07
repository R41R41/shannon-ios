import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SKILL_LINEAGE, chosenBase, parentBaseline, rankedNodes, scoredLineage, type LineageNode } from '../src/mind/memory/skillLineage.js';
import { SkillMemory } from '../src/mind/memory/skillMemory.js';
import type { SkillDocument } from '../src/mind/memory/skillDocument.js';

/** Syzygy ADR-0008 §14 (after the Darwin Gödel Machine): a skill's versions as a tree, and the base of its next patch. */
const node = (version: number, parent: number | null, uses: number, successes: number, extra: Partial<LineageNode> = {}): LineageNode => ({
  revisionId: `s:v${version}`, version, parentRevisionId: parent === null ? null : `s:v${parent}`, variantOf: null, madeBy: 'sleep', uses, successes, ...extra,
});
const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

describe('the lineage', () => {
  it('scores each node with an informed prior from its parent, and weighs it by σ(10(s − 0.5)) / (1 + children)', () => {
    const nodes = [node(1, null, 4, 2), node(2, 1, 9, 9), node(3, 2, 4, 3), node(4, 3, 3, 0)];
    const scored = new Map(scoredLineage(nodes).map(item => [item.node.version, item]));
    const pooled = (1 + 14) / (2 + 20);
    const s1 = (2 + 3 * pooled) / 7;
    const s2 = (9 + 3 * s1) / 12;
    expect(scored.get(1)!.s).toBeCloseTo(s1, 10);
    expect(scored.get(2)!.s).toBeCloseTo(s2, 10);
    expect(scored.get(2)!.children).toBe(1);
    expect(scored.get(2)!.weight).toBeCloseTo(sigmoid(10 * (s2 - 0.5)) / 2, 10);
    expect(scored.get(4)!.children).toBe(0);
    // A node that has never been used starts from its parent's s, not from nothing.
    expect(scoredLineage([node(1, null, 10, 9), node(2, 1, 0, 0)]).find(item => item.node.version === 2)!.s)
      .toBeCloseTo(scoredLineage([node(1, null, 10, 9)])[0]!.s, 10);
    expect(SKILL_LINEAGE).toEqual({ sharpness: 10, midpoint: 0.5, priorStrength: 3 });
  });

  it('ranks best first (DGM sorted it the wrong way), never offers the owner\'s version, and folds a restored version into the node it restores', () => {
    const nodes = [node(1, null, 4, 2), node(2, 1, 9, 9), node(3, 2, 4, 3), node(4, 3, 3, 0),
      node(5, 3, 0, 0, { variantOf: 's:v3' }), node(6, 3, 2, 2, { madeBy: 'owner_edit' })];
    const ranked = rankedNodes(nodes);
    expect(ranked.map(item => item.node.version)).not.toContain(5);
    expect(ranked.map(item => item.node.version)).not.toContain(6);
    for (let index = 1; index < ranked.length; index += 1) expect(ranked[index - 1]!.weight).toBeGreaterThanOrEqual(ranked[index]!.weight);
    // The restored version is not a child of the version it restores; the owner's version is (it was derived from it).
    expect(scoredLineage(nodes).find(item => item.node.version === 3)!.children).toBe(2);
  });

  it('draws a node with p ∝ weight, and none from an empty lineage', () => {
    const nodes = [node(1, null, 4, 2), node(2, 1, 9, 9), node(3, 2, 4, 3), node(4, 3, 3, 0)];
    const ranked = rankedNodes(nodes);
    const total = ranked.reduce((sum, item) => sum + item.weight, 0);
    expect(chosenBase(nodes, () => 0)!.node.version).toBe(ranked[0]!.node.version);
    expect(chosenBase(nodes, () => (ranked[0]!.weight + 1e-9) / total)!.node.version).toBe(ranked[1]!.node.version);
    expect(chosenBase(nodes, () => 0.999999)!.node.version).toBe(ranked.at(-1)!.node.version);
    const counts = new Map<number, number>();
    let seed = 7;
    const random = () => { seed = (seed * 48_271) % 2_147_483_647; return seed / 2_147_483_647; };
    for (let draw = 0; draw < 4_000; draw += 1) { const version = chosenBase(nodes, random)!.node.version; counts.set(version, (counts.get(version) ?? 0) + 1); }
    for (const item of ranked) expect(counts.get(item.node.version)! / 4_000).toBeCloseTo(item.weight / total, 1);
    expect(chosenBase([], () => 0)).toBeNull();
  });

  it('judges a trial against its parent\'s own rate (never the first version\'s): ⅔ until the parent has three uses', () => {
    expect(parentBaseline({ uses: 9, successes: 9 })).toBe(1);
    expect(parentBaseline({ uses: 4, successes: 3 })).toBe(0.75);
    expect(parentBaseline({ uses: 2, successes: 2 })).toBeCloseTo(2 / 3, 10);
  });
});

describe('a patch from an older branch', () => {
  const doc = (steps: string): SkillDocument => ({ name: 'weekly-review', description: '週のふりかえりをする時', steps, aids: '- なし', references: '- 会話から' });
  const at = (minute: number) => new Date(Date.parse('2026-10-07T00:00:00.000Z') + minute * 60_000).toISOString();

  it('starts from that version\'s body, records it as the parent, keeps the current version to return to, and refuses a base that is not hers', () => {
    const memory = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
    const ok = { carries: () => false };
    const { skillId } = memory.create('owner', { draft: doc('1. 三つ挙げる'), evidence: [] }, ok, at(0)) as { skillId: string };
    memory.store.setStatus('owner', skillId, 'active', 'test', at(1));
    const page = (title: string) => (memory.createPattern('owner', { kind: 'strategy', title, body: `${title}。` }, [], ok, at(1)) as { patternId: string }).patternId;
    expect(memory.revise('owner', skillId, 1, { replacements: [{ find: '三つ', replace: '五つ' }], evidence: [], purposePatternIds: [page('a')] }, ok, at(2))).toEqual({ version: 2 });
    memory.store.setStatus('owner', skillId, 'active', 'test', at(3));
    for (const index of [0, 1, 2]) memory.used('owner', 'weekly-review', { talk: `t${index}`, growth: 1 }, at(4));
    const pending = memory.store.get('owner', skillId)!.uses;
    pending.forEach((use, index) => memory.nextTurn('owner', use.talk, index < 2 ? 1 : 0, at(5)));
    const v1 = `${skillId}:v1`;
    // v1 has no use: its baseline is ⅔ (its parent's own rate), never v2's.
    expect(memory.revise('owner', skillId, 2, { replacements: [{ find: '三つ', replace: '四つ' }], evidence: [], purposePatternIds: [page('b')], baseRevisionId: v1 }, ok, at(6))).toEqual({ version: 3 });
    const v3 = memory.store.revisions('owner', skillId).find(item => item.version === 3)!;
    expect(v3).toMatchObject({ parentRevisionId: v1, reason: 'branched' });
    expect(v3.body).toContain('四つ');
    const skill = memory.store.get('owner', skillId)!;
    expect(skill).toMatchObject({ status: 'trial', trialBaseVersion: 2 });
    expect(memory.store.audits('owner').at(-1)).toMatchObject({ fromVersion: 1, baselineRate: 2 / 3 });
    expect(memory.lineage('owner', skillId).find(item => item.version === 2)).toMatchObject({ uses: 3, successes: 2, parentRevisionId: v1 });
    memory.store.setStatus('owner', skillId, 'active', 'test', at(7));
    expect(memory.revise('owner', skillId, 3, { replacements: [{ find: '四つ', replace: '六つ' }], evidence: [], purposePatternIds: [page('c')], baseRevisionId: `${skillId}:s1` }, ok, at(8)))
      .toEqual({ rejected: 'not_found' });
    expect(memory.revise('owner', skillId, 3, { replacements: [{ find: '四つ', replace: '六つ' }], evidence: [], purposePatternIds: [page('d')], baseRevisionId: 'other:v1' }, ok, at(8)))
      .toEqual({ rejected: 'not_found' });
  });
});
