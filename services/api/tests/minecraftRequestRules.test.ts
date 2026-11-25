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
    const idle = minecraftQueueGuide({ queueLines: [], running: null, planLines: ['目的: x'] }).join('\n');
    expect(idle).not.toContain('いまの依頼の計画');
    expect(idle).not.toContain('成し遂げるための手段');
    expect(guide).not.toContain('いまの依頼の計画]');
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
