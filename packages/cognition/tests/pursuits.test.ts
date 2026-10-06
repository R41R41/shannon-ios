import { describe, expect, it } from 'vitest';
import {
  SHANNON_AUTONOMY_DOMAINS,
  SHANNON_CURRENT_GOAL,
  SHANNON_MOTIVE,
  SHANNON_SEED_PURSUITS,
  autonomyDomain,
  autonomyDomainLabel,
  buildShannonOwnWorkPrompt,
  buildShannonPursuitsPrompt,
  shannonAutonomyRuleLines,
  shannonCapabilityPrompt,
  shannonIdentityPrompt,
  withAutonomyRunning,
  isSeedPursuitId,
  seedPursuits,
  shannonPersonaPrompt,
  type ShannonPursuit,
  withoutUnshownTitles,
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
    expect(byRule('free')).toEqual(['host_folder', 'vm_workspace', 'aether_study', 'voyager_list', 'public_read', 'notion_read', 'room_look', 'thinking', 'owner_message', 'owner_call', 'owner_documents_read']);
    expect(byRule('approval')).toEqual(['core', 'suite_app_code', 'owner_content', 'outreach']);
    expect(byRule('forbidden')).toEqual(['spending', 'self_replication', 'impersonation', 'private_content_in_work']);
    expect(new Set(SHANNON_AUTONOMY_DOMAINS.map(domain => domain.id)).size).toBe(SHANNON_AUTONOMY_DOMAINS.length);
  });

  it('never resolves an unknown domain', () => {
    expect(autonomyDomain('aether_study')?.rule).toBe('free');
    // Owner decision 2026-10-06 (ADR-0007): reading his documents in her own time is a free domain of its own, not her study's.
    expect(autonomyDomain('owner_documents_read')).toMatchObject({ rule: 'free', label: '持ち主の文書を読む' });
    expect(autonomyDomain('anything_else')).toBeNull();
    expect(autonomyDomain(undefined)).toBeNull();
    expect(autonomyDomainLabel('anything_else')).toBe('不明な範囲');
    expect(autonomyDomainLabel('system')).toBe('設定と承認');
  });

  it('labels a step taken inside a conversation without making it a domain the gate knows', () => {
    expect(autonomyDomainLabel('conversation')).toBe('会話の中で');
    expect(autonomyDomain('conversation')).toBeNull();
  });
});

describe('her own work in an owner prompt', () => {
  it('is absent when she has done and made nothing', () => {
    expect(buildShannonOwnWorkPrompt(null)).toBe('');
    expect(buildShannonOwnWorkPrompt(undefined)).toBe('');
    expect(buildShannonOwnWorkPrompt({ today: [], pieces: [] })).toBe('');
  });

  it('says what she did today and what she is making, without the title of a piece she has not shown', () => {
    const prompt = buildShannonOwnWorkPrompt({
      today: ['次にすることを考えた', '公開ページを2つ読んだ', 'メモを2つ書いた'],
      pieces: [{ stage: '下書き・第2稿' }, { title: '傘のある駅', stage: '第1稿・見せた' }],
    });
    expect(prompt.split('\n')).toEqual([
      '[ボクがひとりの時間にしていること]（記録にある事実。何をしていたか聞かれたら自分の言葉で話す）',
      '- 今日したこと: 次にすることを考えた、公開ページを2つ読んだ、メモを2つ書いた',
      '- 作っている物語: 下書き・第2稿（まだ見せていない。題名と中身は、見せる時まで言わなくてよい）',
      '- 物語「傘のある駅」: 第1稿・見せた',
    ]);
  });

  it('adds what followed a message she started on her own, with room of its own, and is unchanged without it', () => {
    const work = { today: ['次にすることを考えた', '自分から1回話しかけた'], pieces: [{ title: '傘のある駅', stage: '第1稿・見せた' }] };
    const line = '10:02に話しかけた（きっかけ: いま何をしているか気になった）。3分待ったが返事はなかった。';
    expect(buildShannonOwnWorkPrompt({ ...work, reachOuts: [line] }).split('\n')).toEqual([
      '[ボクがひとりの時間にしていること]（記録にある事実。何をしていたか聞かれたら自分の言葉で話す）',
      '- 今日したこと: 次にすることを考えた、自分から1回話しかけた',
      `- 自分から話しかけた時のこと（気になるなら自分から触れてよい）: ${line}`,
      '- 物語「傘のある駅」: 第1稿・見せた',
    ]);
    expect(buildShannonOwnWorkPrompt({ ...work, reachOuts: [] })).toBe(buildShannonOwnWorkPrompt(work));
    // At most two, each cut at 200 characters, and the pieces still fit after them.
    const many = buildShannonOwnWorkPrompt({ ...work, reachOuts: Array.from({ length: 5 }, (_, index) => `${index}${'あ'.repeat(400)}`) });
    expect(many.split('\n').filter(item => item.includes('話しかけた時のこと'))).toHaveLength(2);
    expect(many).toContain('- 物語「傘のある駅」: 第1稿・見せた');
    expect(many.length).toBeLessThanOrEqual(320 + 2 * 240);
  });

  it('stays bounded', () => {
    const long = buildShannonOwnWorkPrompt({
      today: Array.from({ length: 20 }, (_, index) => `とても長い説明${'あ'.repeat(40)}${index}`),
      pieces: Array.from({ length: 9 }, (_, index) => ({ title: `題${'い'.repeat(100)}${index}`, stage: '第1稿・見せた' })),
    });
    expect(long.length).toBeLessThanOrEqual(320);
    expect(buildShannonOwnWorkPrompt({ today: ['考えた'], pieces: [] }, { maximumCharacters: 20 })).toBe('');
  });
});

describe('autonomy wording while the loop runs', () => {
  it('replaces only the line that says the mechanism is being prepared', () => {
    const preparing = shannonAutonomyRuleLines('owner');
    const running = shannonAutonomyRuleLines('owner', { running: true });
    expect(preparing[0]).toContain('仕組みは準備中');
    expect(running[0]).toBe('自分から動く時の約束（いまは調べて、書斎にメモと物語を書き、見せている。記録に残り、ライ氏が止められる）:');
    expect(running.slice(1)).toEqual(preparing.slice(1));
    // A guest hears neither.
    expect(shannonAutonomyRuleLines('guest', { running: true })).toEqual(shannonAutonomyRuleLines('guest'));
    expect(shannonAutonomyRuleLines('guest').join('')).not.toMatch(/準備中|ひとりの時間/u);
  });

  it('gives the same result on an assembled prompt and leaves other prompts alone', () => {
    const identity = shannonIdentityPrompt('owner');
    const running = withAutonomyRunning(identity);
    expect(running).not.toContain('仕組みは準備中');
    expect(running).toContain(shannonAutonomyRuleLines('owner', { running: true }).join('\n'));
    expect(running.replace(shannonAutonomyRuleLines('owner', { running: true })[0]!, shannonAutonomyRuleLines('owner')[0]!)).toBe(identity);
    expect(withAutonomyRunning(shannonIdentityPrompt('guest'))).toBe(shannonIdentityPrompt('guest'));
    expect(withAutonomyRunning('関係のない文')).toBe('関係のない文');
    // The running wording still fits the response-path budget of the capability block (2026-10-05: +154, her tools; +109, where a memo goes; +124, no going along with a false premise about her own actions).
    // 2026-10-06: +22, her body line (Syzygy ADR-0005, owner answer 7); +33, her folder on the PC or the Mac (A18); 2,498 before.
    // +62 the same day, her temperament (SHANNON_TEMPERAMENT, owner decision "a"; 2,553 before).
    expect(withAutonomyRunning(shannonCapabilityPrompt('owner')).length).toBeLessThanOrEqual(2_615);
    expect(running.length).toBeLessThanOrEqual(3_551); // +22 and +33 the same day (3,434 before); +62 her temperament (3,489 before).
  });
});

describe('her unshown titles stay on the server', () => {
  it('takes out every unshown title, whatever the stage says and whatever the title holds', () => {
    const prompt = buildShannonOwnWorkPrompt({ today: [], pieces: [
      { title: '駅」: 下書き・罠', stage: '第3稿・直している途中', unshown: true },
      { title: '見せた話', stage: '第1稿・見せた' },
    ] }, { maximumCharacters: 1_000 });
    expect(prompt).toContain('「駅」: 下書き・罠」');
    const stripped = withoutUnshownTitles(prompt);
    expect(stripped).not.toContain('罠');
    expect(stripped).toContain('- まだ見せていない下書き: 第3稿・直している途中（題名と中身は、見せる時まで言わなくてよい）');
    expect(stripped).toContain('- 物語「見せた話」: 第1稿・見せた');
  });
});
