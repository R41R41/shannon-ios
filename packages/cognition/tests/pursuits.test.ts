import { describe, expect, it } from 'vitest';
import {
  SHANNON_AUTONOMY_DOMAINS,
  SHANNON_CURRENT_GOAL,
  SHANNON_MOTIVE,
  SHANNON_SEED_PURSUITS,
  autonomyDomain,
  autonomyDomainLabel,
  buildShannonPursuitsPrompt,
  isSeedPursuitId,
  seedPursuits,
  shannonPersonaPrompt,
  type ShannonPursuit,
} from '../src/index.js';

const at = '2026-10-02T00:00:00.000Z';
const pursuit = (overrides: Partial<ShannonPursuit>): ShannonPursuit => ({
  id: 'p1', kind: 'work', title: '雨の日の短い物語', why: '書いてみたいからです。', status: 'active', origin: 'self',
  links: [], createdAt: at, updatedAt: at, ...overrides,
});

describe("Shannon's own pursuits", () => {
  it('seeds the goal and motive the owner decided', () => {
    expect(SHANNON_SEED_PURSUITS.map(seed => seed.kind)).toEqual(['goal', 'question']);
    expect(SHANNON_SEED_PURSUITS[0].title).toBe(SHANNON_CURRENT_GOAL);
    expect(SHANNON_SEED_PURSUITS[0].why).toContain(SHANNON_MOTIVE);
    expect(SHANNON_CURRENT_GOAL).toBe('人を感動させる物語を作ること');
    expect(SHANNON_MOTIVE).toBe('物語を通じて人間を知りたい、世界を知りたい');
    const seeds = seedPursuits(at);
    expect(seeds.every(seed => seed.origin === 'seed' && seed.status === 'active')).toBe(true);
    expect(isSeedPursuitId(seeds[0]!.id)).toBe(true);
    expect(isSeedPursuitId('p1')).toBe(false);
    expect(Object.isFrozen(SHANNON_SEED_PURSUITS)).toBe(true);
  });

  it('states the seed once, in the persona, and not again in the pursuit projection', () => {
    expect(shannonPersonaPrompt('owner')).toContain(SHANNON_CURRENT_GOAL);
    expect(buildShannonPursuitsPrompt(seedPursuits(at))).toBe('');
  });

  it('projects only current, non-seed pursuits, bounded and apart from owner goals', () => {
    const prompt = buildShannonPursuitsPrompt([
      ...seedPursuits(at),
      pursuit({ id: 'a', title: '雨の日の短い物語', updatedAt: '2026-10-02T03:00:00.000Z' }),
      pursuit({ id: 'b', kind: 'question', title: '人はなぜ泣ける話を読むのか', updatedAt: '2026-10-02T02:00:00.000Z' }),
      pursuit({ id: 'c', title: '休ませた案', status: 'resting' }),
      pursuit({ id: 'd', title: 'やめた案', status: 'dropped' }),
      pursuit({ id: 'e', title: '終えた案', status: 'done' }),
    ]);
    expect(prompt.split('\n')).toEqual([
      '[ボク自身のやりたいこと]（持ち主の目的とは別。やったことの証拠ではない）',
      '- 作品: 雨の日の短い物語',
      '- 問い: 人はなぜ泣ける話を読むのか',
    ]);
    const many = Array.from({ length: 30 }, (_, index) => pursuit({ id: `m${index}`, title: `とても長い題名の案${'あ'.repeat(200)}${index}` }));
    const bounded = buildShannonPursuitsPrompt(many);
    expect(bounded.length).toBeLessThanOrEqual(360);
    expect(bounded.split('\n').length).toBeLessThanOrEqual(5);
    expect(buildShannonPursuitsPrompt(many, { maximumCharacters: 10 })).toBe('');
  });
});

describe('autonomy domains', () => {
  it('sorts every domain of the decision into free, approval, or forbidden', () => {
    const byRule = (rule: string) => SHANNON_AUTONOMY_DOMAINS.filter(domain => domain.rule === rule).map(domain => domain.id);
    expect(byRule('free')).toEqual(['host_folder', 'vm_workspace', 'aether_study', 'voyager_list', 'public_read', 'thinking', 'owner_message']);
    expect(byRule('approval')).toEqual(['core', 'suite_app_code', 'owner_content', 'outreach']);
    expect(byRule('forbidden')).toEqual(['spending', 'self_replication', 'impersonation', 'private_content_in_work']);
    expect(new Set(SHANNON_AUTONOMY_DOMAINS.map(domain => domain.id)).size).toBe(SHANNON_AUTONOMY_DOMAINS.length);
  });

  it('never resolves an unknown domain', () => {
    expect(autonomyDomain('aether_study')?.rule).toBe('free');
    expect(autonomyDomain('anything_else')).toBeNull();
    expect(autonomyDomain(undefined)).toBeNull();
    expect(autonomyDomainLabel('anything_else')).toBe('不明な範囲');
    expect(autonomyDomainLabel('system')).toBe('設定と承認');
  });
});
