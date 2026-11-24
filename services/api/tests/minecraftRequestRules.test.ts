import { describe, expect, it } from 'vitest';
import { adviceIsRequestRule, KEEP_CONDITIONS_RULE, noPromiseRule, toolRequestGuide } from '../src/contracts/minecraftRequestRules.js';
import { minecraftQueueGuide } from '../src/contracts/minecraftQueuePrompt.js';
import { SHANNON_TOOLS } from '../src/mind/tools/shannonTools.js';

// The same wish reaches her Minecraft body by the intent field (anyone in a channel) or by the tool (the owner alone):
// the rules are written once, so neither way reads stronger than the other.
describe('rules for handing a wish to her Minecraft body', () => {
  const guide = minecraftQueueGuide({ queueLines: [], running: null, who: 'ミナト' }).join('\n');
  const tool = SHANNON_TOOLS.find(item => item.name === 'minecraft.request')!;
  const toolBlock = toolRequestGuide('ライ氏').join('\n');

  it('keeps the conditions of the wish in the goal, on both ways', () => {
    expect(guide).toContain(KEEP_CONDITIONS_RULE);
    expect(tool.description).toContain(KEEP_CONDITIONS_RULE);
    expect(toolBlock).toContain(KEEP_CONDITIONS_RULE);
  });

  it('takes advice and suggestions as requests, with the speaker named as the one who asks', () => {
    expect(guide).toContain(adviceIsRequestRule('ミナト', 'kind=task にする'));
    expect(tool.description).toContain(adviceIsRequestRule('ライ氏', 'この道具で頼む'));
    expect(toolBlock).toContain(adviceIsRequestRule('ライ氏', '道具 minecraft.request で頼む'));
    expect(toolBlock).toContain('先にベッド作った方がいいよ');
    expect(toolBlock).toContain('寝ずに');
  });

  it('promises nothing when nothing is handed over, and says why', () => {
    expect(guide).toContain(noPromiseRule('kind=none にする時'));
    expect(tool.description).toContain(noPromiseRule('この道具を使わない返事にする時'));
    expect(toolBlock).toContain(noPromiseRule('道具を使わない返事にする時'));
    expect(noPromiseRule('x')).toContain('理由:');
  });

  it('names no listener in the rules: the same words for the owner and for a guest', () => {
    expect(adviceIsRequestRule('ミナト', 'a').replaceAll('ミナト', '')).toBe(adviceIsRequestRule('ライ氏', 'a').replaceAll('ライ氏', ''));
  });
});
