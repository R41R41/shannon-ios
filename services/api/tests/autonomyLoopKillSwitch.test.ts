import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownerPrivateRule, type AutonomyOwnerContext } from '../src/autonomyLoopOwnerContext.js';
import { draftPrompt, reachOutPrompt, revisePrompt, thinkingPrompt } from '../src/autonomyLoopPrompts.js';
import { OwnerInformedMarks } from '../src/mind/inhibition/store/ownerInformedMarks.js';
import { agenticDay, builderDigests, plainDay } from './autonomyLoopKillSwitchScenario.js';
import { loopHarness, runUntilIdle, scope } from './autonomyLoopHarness.js';

/**
 * The kill switches restore what was there before (owner decisions 2026-10-02, Syzygy ADR-0003):
 * `SHANNON_AUTONOMY_PACING=cycles` the fixed cycles, `SHANNON_AUTONOMY_OWNER_CONTEXT=off` prompts without the owner's context.
 *
 * The digests below were produced by running `autonomyLoopKillSwitchScenario.ts` on commit 78c3493, the last one before
 * sessions and the owner's context existed. Since then the owner raised the default of the day's budget to 2,000 yen, which
 * a thinking prompt of the old loop prints: with the cap configured as it was (1,000) every prompt equals that commit's, and
 * with the new default the prompts equal that commit's with the default changed and nothing else. They are sha-256 prefixes of each prompt as sent (system, then prompt) with
 * random identifiers replaced. A changed byte in any prompt of the old loop changes a digest here.
 */
const directory = mkdtempSync(join(tmpdir(), 'shannon-autonomy-kill-switch-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const AGENTIC_DAY_AT_78C3493 = [
  ['think', '1ac1d5d9cdd5e9d7'], ['reach_out', '0ee3d0600b349738'], ['think', 'cf9ff59a90d2de12'], ['think', 'd0a2e4417e1c13f2'], ['follow_up', '516aa0c49c1b329e'],
  ['think', '2b3be94aa6101952'], ['note', '2977210b0f7b5e1c'], ['reach_out', 'd99aaf1008918710'], ['think', '19bfd5c40ee0cad0'], ['think', '6dfe837ac4a0a529'],
  ['note', '81264d2ee7bde300'], ['draft', '73d45990e026d56b'], ['think', 'b14ee2ccae29aacf'], ['think', 'c573f62e246587cd'], ['revise', '550384af7d8f856d'],
  ['reach_out', 'dc7ea65dbc2f2977'], ['think', '1479f8d14555668d'], ['think', '765457454c05b3f8'], ['reach_out', 'f675aa9fb5535f58'], ['think', '7fdb457bfea50eed'],
  ['think', 'f57db961db246070'], ['reach_out', '78bc54ed4d10c8da'], ['think', '86ea8a16f3d80719'], ['think', '69a19c6639403507'],
];
/**
 * The same scenario on 78c3493 with four strings changed and nothing else (owner decisions 2026-10-02): the default of the
 * day's budget in `packages/cognition/src/autonomy.ts` (1_000 → 2_000), the forbidden item of the identity prompt and the
 * label of `private_content_in_work` there, and the refusal sentence of that domain in `autonomyPolicy.ts`. Only the
 * thinking prompts differ from the unchanged commit, and only by the budget they print (「予算 約…円」); the persona and
 * the forbidden item are not part of any prompt of the loop.
 */
const AGENTIC_DAY_AT_78C3493_WITH_2000_YEN = [
  ['think', '0816a524af4da9aa'], ['reach_out', '0ee3d0600b349738'], ['think', 'e67e41543c170db5'], ['think', '13131a69ad57996f'], ['follow_up', '516aa0c49c1b329e'],
  ['think', 'c649dcaa8616c3ff'], ['note', '2977210b0f7b5e1c'], ['reach_out', 'd99aaf1008918710'], ['think', '4533092569973f86'], ['think', '6c4d45e8156c21e6'],
  ['note', '81264d2ee7bde300'], ['draft', '73d45990e026d56b'], ['think', '6216c1acbc13f9f6'], ['think', '16392261e20ce824'], ['revise', '550384af7d8f856d'],
  ['reach_out', 'dc7ea65dbc2f2977'], ['think', 'e24c687f096fe8cb'], ['think', 'be27eb2d8bdcea40'], ['reach_out', 'f675aa9fb5535f58'], ['think', 'f966e2d0e0d1717a'],
  ['think', '90dd6ffdefcb7232'], ['reach_out', '78bc54ed4d10c8da'], ['think', '582fd809da318164'], ['think', '88e1ac8b511fcfd1'],
];
const PLAIN_DAY_AT_78C3493_WITH_2000_YEN = [
  ['think', 'f6d2e644587c294d'], ['note', '2977210b0f7b5e1c'], ['draft', '3162903bd56a2e60'], ['reach_out', '74f4ae102cb062ba'], ['think', '820127755247f5a8'],
  ['reach_out', '2ca5da4023801847'],
];
/**
 * On 78c3493 a day held three messages of hers by default, and its thinking prompt said how many were left. Since the owner's
 * decision of 2026-10-03 there is no count unless one is set; with that commit's count configured the prompts are that commit's.
 */
const COUNT_OF_78C3493 = { SHANNON_AUTONOMY_MAX_REACH_OUTS: '3' };
/** The day's cap as it was by default on 78c3493: with it configured, every prompt is that commit's, unchanged. */
const CAP_OF_78C3493 = { environment: { SHANNON_AUTONOMY_DAILY_BUDGET_YEN: '1000' } };
/** The plain day ran with the default count; the agentic day sets its own (six). */
const PLAIN_OF_78C3493 = { environment: { ...CAP_OF_78C3493.environment, ...COUNT_OF_78C3493 } };
const PLAIN_DAY_AT_78C3493 = [
  ['think', '60cf87edbe87f21d'], ['note', '2977210b0f7b5e1c'], ['draft', '3162903bd56a2e60'], ['reach_out', '74f4ae102cb062ba'], ['think', '95c8b348a7144662'],
  ['reach_out', '2ca5da4023801847'],
];
const BUILDERS_AT_78C3493 = {
  thinking: 'b2ca037238a693b6', thinkingBare: '9dc6b337f74dace9', thinkingNull: 'b2ca037238a693b6', thinkingAgain: '50799eeab2250749', note: 'b85e222e8406f5f2',
  draft: '92f52353f37aa157', draftBare: '91fe7ec8b8db78a2', revise: '7763f685ff1f0d26', look: '89979d30f67610b2', share: '6c457fd449ab31f6', wonder: '2c5172666ac8442e',
  upcoming: '927e3a29ab3fc461', saw: '35587157e98838f5', followUp: '47c28ee18c48828a',
};

/**
 * The day reads a shared Notion page (cycle 3). Since the owner's decisions of 2026-10-06 (Syzygy ADR-0007: a note written after
 * a Notion page is marked, option a) the note and the story of that cycle are not given to the prompts of later cycles, which are
 * not marked. With that mark set aside (nothing reported as marked, `OwnerInformedMarks.any`), every prompt of the day is the
 * commit before's, byte for byte: the tests below hold that. The day as it runs with the mark is pinned on its own below: it
 * differs only in the prompts after cycle 3 that gave that note or story.
 */
const AGENTIC_DAY_WITH_THE_NOTION_MARK = [
  ['think', '1ac1d5d9cdd5e9d7'], ['reach_out', '0ee3d0600b349738'], ['think', 'cf9ff59a90d2de12'], ['think', 'd0a2e4417e1c13f2'], ['follow_up', '516aa0c49c1b329e'],
  ['think', '2b3be94aa6101952'], ['note', '2977210b0f7b5e1c'], ['reach_out', 'd99aaf1008918710'], ['think', '19bfd5c40ee0cad0'], ['think', '6dfe837ac4a0a529'],
  ['note', '81264d2ee7bde300'], ['draft', '73d45990e026d56b'], ['think', 'f3fc1a6f560856c6'], ['think', 'f3fc1a6f560856c6'], ['revise', '842015897394f7d8'],
  ['reach_out', 'dc7ea65dbc2f2977'], ['think', '1479f8d14555668d'], ['think', '7177e9609a8a1ac2'], ['reach_out', 'f675aa9fb5535f58'], ['think', '51262c09dc3eb5af'],
  ['think', '2cdc354eb105e6a8'], ['reach_out', '78bc54ed4d10c8da'], ['think', '42102454cfd9173d'], ['think', '8efe23ab4202ff51'],
];

describe('with the Notion mark of the day, the prompts after it leave out what it marked, and nothing else changes', () => {
  it('pins the day as it runs, which differs from the commit before only in later prompts that gave the marked note or story', async () => {
    const other = mkdtempSync(join(tmpdir(), 'shannon-autonomy-kill-switch-marked-'));
    try {
      const day = (await agenticDay(other, CAP_OF_78C3493)).map(call => [call.kind, call.digest]);
      expect(day).toEqual(AGENTIC_DAY_WITH_THE_NOTION_MARK);
      const moved = day.flatMap(([kind], index) => (day[index]![1] === AGENTIC_DAY_AT_78C3493[index]![1] ? [] : [`${index}:${kind}`]));
      expect(moved).toEqual(['12:think', '13:think', '14:revise', '17:think', '19:think', '20:think', '22:think', '23:think']);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
});

describe('with pacing and the owner\'s context switched off, the loop is what it was', () => {
  // The Notion mark of the day set aside (see above): with it, every prompt is the commit before's.
  beforeEach(() => { vi.spyOn(OwnerInformedMarks.prototype, 'any').mockReturnValue(false); });
  afterEach(() => { vi.restoreAllMocks(); });
  it('sends byte for byte the prompts of the commit before, through a whole day with every step kind, when the day\'s cap is that commit\'s', async () => {
    expect((await agenticDay(directory, CAP_OF_78C3493)).map(call => [call.kind, call.digest])).toEqual(AGENTIC_DAY_AT_78C3493);
    expect((await plainDay(directory, PLAIN_OF_78C3493)).map(call => [call.kind, call.digest])).toEqual(PLAIN_DAY_AT_78C3493);
  });

  it('differs from the commit before, with the default cap of 2,000 yen, only in the budget a thinking prompt prints', async () => {
    const other = mkdtempSync(join(tmpdir(), 'shannon-autonomy-kill-switch-default-'));
    try {
      const agentic = (await agenticDay(other)).map(call => [call.kind, call.digest]);
      const plain = (await plainDay(other, { environment: COUNT_OF_78C3493 })).map(call => [call.kind, call.digest]);
      expect(agentic).toEqual(AGENTIC_DAY_AT_78C3493_WITH_2000_YEN);
      expect(plain).toEqual(PLAIN_DAY_AT_78C3493_WITH_2000_YEN);
      // Every prompt that is not a thinking prompt is the unchanged commit's.
      for (const [now, before] of [[agentic, AGENTIC_DAY_AT_78C3493], [plain, PLAIN_DAY_AT_78C3493]] as const) {
        expect(now.filter(([kind]) => kind !== 'think')).toEqual(before.filter(([kind]) => kind !== 'think'));
        expect(now.filter(([kind], index) => kind === 'think' && before[index]![1] === now[index]![1])).toEqual([]);
      }
    } finally { rmSync(other, { recursive: true, force: true }); }
  });

  it('sends the same prompts when the owner\'s context is wired but switched off, and other prompts when it is on', async () => {
    const wired: AutonomyOwnerContext = {
      forThinking: () => ({ section: '[ライ氏のこと・最近のふたりのこと]\n- 例', secrets: [] }),
      forMessage: () => ({ section: '[ライ氏のこと・最近のふたりのこと]\n- 例', secrets: [] }),
      forWriting: () => ({ section: '[ライ氏のこと・最近のふたりのこと]\n- 例', secrets: [] }),
    };
    const off = mkdtempSync(join(tmpdir(), 'shannon-autonomy-kill-switch-off-'));
    const on = mkdtempSync(join(tmpdir(), 'shannon-autonomy-kill-switch-on-'));
    try {
      expect((await agenticDay(off, { ...CAP_OF_78C3493, ownerContext: wired, loop: { ownerContext: false } })).map(call => [call.kind, call.digest])).toEqual(AGENTIC_DAY_AT_78C3493);
      // The fixed cycles alone do not restore the old prompts: the two switches are independent.
      const withContext = await agenticDay(on, { ...CAP_OF_78C3493, ownerContext: wired, loop: { ownerContext: true } });
      expect(withContext.filter(call => call.kind === 'think').every(call => !AGENTIC_DAY_AT_78C3493.some(([, digest]) => digest === call.digest))).toBe(true);
    } finally {
      rmSync(off, { recursive: true, force: true });
      rmSync(on, { recursive: true, force: true });
    }
  });

  it('builds byte for byte the prompts of the commit before from every prompt builder', () => {
    expect(builderDigests()).toEqual(BUILDERS_AT_78C3493);
  });

  it('opens no session, writes no session row, and shows the owner no session under the fixed cycles', async () => {
    const { loop, store, service, model, loopConfig } = loopHarness();
    expect(loopConfig.pacing).toBe('cycles');
    model.plans = [{ thought: '休みます。', steps: [{ action: 'rest', resumeInMinutes: 30, reason: '休みたい' }] }];
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'cycle-ended']);
    // `rest` is what it was: the end of the plan, not a step, and it schedules nothing.
    expect(service.activityDays(scope, 1)[0]!.entries.some(entry => entry.tool === 'study.rest')).toBe(false);
    expect(store.loop.sessions.latestClosed(scope)).toBeNull();
    expect(store.loop.sessions.startedOn(scope, '2026-10-02')).toBe(0);
    expect('session' in service.overview(scope)).toBe(false);
    expect(model.calls[0]!.system).toContain('rest（今回はここまで）');
    expect(model.calls[0]!.prompt).toContain('[今日の残り] 予算 約');
  });

  it('adds the output rule of owner-private material only where such material is, and nothing where it is not', () => {
    const bare = { localTime: 'x', remainingYen: 0, remainingReads: 0, maximumSteps: 1, pursuits: [], stories: [], notes: [], unnotedReadings: [], feedback: [], places: [], notionAvailable: false };
    for (const kind of ['thinking', 'story', 'note', 'message'] as const) expect(ownerPrivateRule(kind, false)).toBeNull();
    const block = '[ライ氏のこと・最近のふたりのこと]\n- 例';
    const extras = { actions: '', examples: '', rules: [], sections: [], ownerContext: block };
    // Thinking: the block, the line that names it among her materials, and its output rule.
    const thinking = thinkingPrompt(bare, extras);
    expect(thinking.system).toContain(ownerPrivateRule('thinking', true)!);
    expect(thinking.system).toContain('そして「ライ氏のこと・最近のふたりのこと」。そこにないことを、思い出したふりをして書かない。');
    expect(thinking.system).not.toContain('ここには渡されていない');
    expect(thinking.prompt).toContain(block);
    expect(thinkingPrompt(bare).system).not.toContain('ライ氏のこと・最近のふたりのこと');
    expect(thinkingPrompt(bare).system).toContain('ここには渡されていない');
    // A story: the block when there is one, and the rule that she may write about him whenever the owner's context is switched on.
    const seen = [{ title: '見たこと（10月2日 10時）', excerpt: '机に本が積んである。', seen: true as const }];
    for (const prompt of [draftPrompt({ idea: '傘', pursuit: null, notes: seen, ownerInformed: true, ownerContext: block }), revisePrompt({ aim: '終わり', piece: { title: '傘', body: '本文', version: 1 }, feedback: [], notes: seen, ownerInformed: true, ownerContext: block })]) {
      expect(prompt.system).toContain(ownerPrivateRule('story', true)!);
      expect(prompt.system.indexOf(ownerPrivateRule('story', true)!)).toBeLessThan(prompt.system.lastIndexOf('JSONだけを返す'));
      expect(prompt.prompt.endsWith(block)).toBe(true);
      // The lines that forbade it are gone, and what she saw of the room may be written as she saw it; other people and text on screens may not.
      expect(prompt.system).not.toMatch(/実在の個人の事情|実在の個人をモデルにしない|見たままを物語に書かない|持ち主やその部屋だと分かる描写を入れない/u);
      expect(prompt.system).toContain('見たとおりに物語に書いてよい。写っていたほかの人のことと、画面や書類の文字は書かない。');
    }
    expect(draftPrompt({ idea: '傘', pursuit: null, notes: [], ownerInformed: true }).prompt).not.toContain('ライ氏のこと・最近のふたりのこと');
    // With the switch off the story rules are the old ones, the look rule included, and a block handed in by mistake is not used.
    const old = draftPrompt({ idea: '傘', pursuit: null, notes: seen, ownerContext: block });
    expect(old.system).toContain('実在の個人をモデルにしない。');
    expect(old.system).toContain('着想にしてよいが、見たままを物語に書かない。持ち主やその部屋だと分かる描写を入れない。');
    expect(old.system).not.toContain('そのまま書いてよい');
    expect(old.prompt).not.toContain(block);
    expect(thinkingPrompt({ ...bare, notes: seen }, extras).system).toContain('物語やメモに書いてもよい。');
    expect(thinkingPrompt({ ...bare, notes: seen }).system).toContain('物語には見たままを書かない。');
    // A message: the block and its rule, and no longer the line that says no conversation is given.
    const message = reachOutPrompt({ reason: 'wonder', localTime: 'x', ownerContext: block });
    expect(message.system).toContain(ownerPrivateRule('message', true)!);
    expect(message.system).not.toContain('会話は渡されていない');
    expect(message.prompt.endsWith(block)).toBe(true);
    expect(reachOutPrompt({ reason: 'wonder', localTime: 'x' }).system).toContain('ライ氏との会話は渡されていないので、思い出したふりをしない。');
  });
});
