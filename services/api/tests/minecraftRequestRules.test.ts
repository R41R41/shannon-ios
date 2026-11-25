import { describe, expect, it } from 'vitest';
import { adviceForRunningRule, adviceIsRequestRule, KEEP_CONDITIONS_RULE, noPromiseRule, toolRequestGuide } from '../src/contracts/minecraftRequestRules.js';
import { minecraftQueueGuide } from '../src/contracts/minecraftQueuePrompt.js';
import { SHANNON_TOOLS } from '../src/mind/tools/shannonTools.js';

// The same wish reaches her Minecraft body by the intent field (anyone in a channel) or by the tool (the owner alone):
// the rules are written once, so neither way reads stronger than the other.
describe('rules for handing a wish to her Minecraft body', () => {
  const guide = minecraftQueueGuide({ queueLines: [], running: null, who: 'ミナト' }).join('\n');
  const tool = SHANNON_TOOLS.find(item => item.name === 'minecraft.request')!;
  const toolBlock = toolRequestGuide('ライ').join('\n');

  it('keeps the conditions of the wish in the goal, on both ways', () => {
    expect(guide).toContain(KEEP_CONDITIONS_RULE);
    expect(tool.description).toContain(KEEP_CONDITIONS_RULE);
    expect(toolBlock).toContain(KEEP_CONDITIONS_RULE);
  });

  it('takes advice and suggestions as requests, with the speaker named as the one who asks', () => {
    expect(guide).toContain(adviceIsRequestRule('ミナト', 'kind=task にする'));
    expect(tool.description).toContain(adviceIsRequestRule('ライ', 'この道具で頼む'));
    expect(toolBlock).toContain(adviceIsRequestRule('ライ', '道具 minecraft.request で頼む'));
    expect(toolBlock).toContain('先にベッド作った方がいいよ');
    expect(toolBlock).toContain('寝ずに');
  });

  // 2026-11-26 shoot: "kill skeletons for bone meal to grow the wheat" was queued four times as a request of its own behind the cake it was for.
  it('takes what helps the running request as words for it (message), not as a new request, and says why; only while something runs', () => {
    const running = minecraftQueueGuide({ queueLines: ['#16 実行中 「ケーキを1個作る」'], running: 'ケーキを1個作る', who: 'ミナト',
      planLines: ['目的: ケーキを1個作る', 'いま: 小麦を育てる（待ち）'] }).join('\n');
    expect(running).toContain(adviceForRunningRule('ミナト'));
    expect(running).toContain('[いまの依頼の計画]\n目的: ケーキを1個作る\nいま: 小麦を育てる（待ち）\n[依頼の列]');
    expect(adviceForRunningRule('ミナト')).toContain('kind=message');
    expect(adviceForRunningRule('ミナト')).toContain('理由:');
    expect(adviceForRunningRule('ミナト')).toContain('別にほしい物');
    // The owner's own words (2026-11-26): a request FORM (「〜してほしい」) for the running request's own purpose is message too, ahead of 'a separate wish is a task'.
    expect(adviceForRunningRule('ミナト')).toContain('ケーキ作るために、スケルトンを狩って骨粉を集めてきてほしいな');
    expect(adviceForRunningRule('ミナト')).toContain('この規則を先にする');
    expect(running).toContain('頼む形でも下の規則');
    expect(running).toContain('いまの作業の目的のためではない、別にしてほしいこと');
    const idle = minecraftQueueGuide({ queueLines: [], running: null, planLines: ['目的: x'] }).join('\n');
    expect(idle).not.toContain('いまの依頼の計画');
    expect(idle).not.toContain('成し遂げるための手段');
    expect(idle).not.toContain('頼む形でも下の規則');
    expect(guide).not.toContain('いまの依頼の計画]');
  });

  // 2026-11-26 night (the owner's 「ついでにスケルトンも倒して骨粉も」): "ついでに" is a way of speaking, not a mark of a separate job. The placement rule used to
  // list it as a sign of "end of the queue", and nothing said a means whose purpose the plan knows (bone meal for the wheat) may come without the purpose said.
  it('reads 「ついでに」 and a purpose left unsaid by the plan, not by the phrase; a thing the plan does not use stays a task; only while something runs', () => {
    const rule = adviceForRunningRule('ミナト');
    expect(rule).toContain('言い方でなく中身');
    expect(rule).toContain('「ついでに」と付いていても、計画で使う物を手に入れる話なら message');
    expect(rule).toContain('計画に使わない別の物を作る・集める・建てる話なら task');
    expect(rule).toContain('その材料の材料も含む');
    expect(rule).toContain('計画のどの節にも使わない物には、目的を考えて足さない');
    expect(rule).toContain('goal に「ついでに」「あとで」は入れない');
    // The examples are of another domain than the owner's night (no copy of his sentence), and carry a task as well as a message.
    expect(rule).toContain('ツルハシを作っている時の「ついでに棒も作っておこう」→ message');
    expect(rule).toContain('「ついでに家も建てておいて」→ task');
    expect(rule).not.toContain('ついでにスケルトン');
    const running = minecraftQueueGuide({ queueLines: ['#16 実行中 「ケーキを1個作る」'], running: 'ケーキを1個作る', who: 'ミナト' }).join('\n');
    expect(running).toContain('「ついでに」と付いていても、いま実行中の依頼のための物なら task にせず message にする');
    const idle = minecraftQueueGuide({ queueLines: [], running: null }).join('\n');
    expect(idle).not.toContain('いま実行中の依頼のための物なら task にせず message');
  });

  it('no longer teaches the bone-meal-for-the-crop sentence as a request of its own, on either way', () => {
    expect(adviceIsRequestRule('ライ', 'kind=task にする')).not.toContain('骨粉');
    expect(tool.description).not.toContain('その骨粉で種の成長を早めよう');
    expect(toolBlock).not.toContain('その骨粉で種の成長を早めよう');
  });

  it('promises nothing when nothing is handed over, and says why', () => {
    expect(guide).toContain(noPromiseRule('kind=none にする時'));
    expect(tool.description).toContain(noPromiseRule('この道具を使わない返事にする時'));
    expect(toolBlock).toContain(noPromiseRule('道具を使わない返事にする時'));
    expect(noPromiseRule('x')).toContain('理由:');
  });

  it('names no listener in the rules: the same words for the owner and for a guest', () => {
    expect(adviceIsRequestRule('ミナト', 'a').replaceAll('ミナト', '')).toBe(adviceIsRequestRule('ライ', 'a').replaceAll('ライ', ''));
  });
});
