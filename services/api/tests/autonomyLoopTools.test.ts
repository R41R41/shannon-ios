import { describe, expect, it } from 'vitest';
import { reasonedPlan } from '../src/mind/action/ownTime/autonomyLoopPlan.js';
import { AutonomyToolResults, plannedToolStep, toolRefusalLine } from '../src/mind/action/ownTime/autonomyLoopToolStep.js';
import { STORY_BODY, loopHarness, runUntilIdle, scope, type LoopHarnessOptions } from './autonomyLoopHarness.js';

/**
 * Her tools in her own time (owner decision 2026-10-05, ADR-0003 stage 1): her thinking chooses a registry tool as a
 * step, the step passes the same gate as every step and is recorded, it costs nothing, and what it returned is in front
 * of her next thought only.
 */
const PRICES = { SHANNON_AUTONOMY_MODEL_PRICES_JSON: '{"gemini-3.8-flash":{"input":10,"output":10},"gpt-5.6-luna":{"input":10,"output":10}}' };
const sessions = (options: LoopHarnessOptions = {}) =>
  loopHarness({ sessions: true, ...options, environment: { ...PRICES, SHANNON_AUTONOMY_DAILY_BUDGET_YEN: '2000', ...options.environment } });
const rest = { action: 'rest', resumeInMinutes: 120, reason: 'ここまで' };

describe('her tools as steps of her own time', () => {
  it('reads her own unshown draft through the gate, records it, and has what it said in front of her next thought only', async () => {
    const harness = sessions({ toolResults: new AutonomyToolResults() });
    const draft = harness.store.study.create(scope, { kind: 'story', title: '傘のある駅', body: STORY_BODY }, harness.clock.at);
    if (typeof draft === 'string') throw new Error(draft);
    harness.model.plans = [
      { thought: '自分の下書きを読み返します。', steps: [{ action: 'tool', name: 'study.read', input: { id: draft.id } }] },
      { thought: 'メモにしておきます。', steps: [{ action: 'tool', name: 'study_create', input: { kind: 'note', title: '読み返して', body: '駅の場面は音から書くとよさそう。' } }] },
      { thought: '休みます。', steps: [rest] },
    ];
    await runUntilIdle(harness.loop);
    const thoughts = harness.model.prompts('think');
    expect(thoughts[0]).toContain('tool（ボクの道具を1つ使う');
    expect(thoughts[0]).toContain('- study.read: ');
    // No device is registered for her folder here: its tools are not offered.
    expect(thoughts[0]).not.toContain('- folder.list: ');
    expect(thoughts[0]).toContain('[ボクの道具]');
    expect(thoughts[0]).not.toContain('[道具の結果]（さっき');
    // The thought after the call is given its result: her draft's title and text, framed as material.
    expect(thoughts[1]).toContain('[道具の結果]（さっき');
    expect(thoughts[1]).toContain('題名: 傘のある駅');
    expect(thoughts[1]).toContain(STORY_BODY.slice(0, 40));
    // ...and the one after that only the result of the next call.
    expect(thoughts[2]).toContain('メモ「読み返して」を書斎に書いた。');
    expect(thoughts[2]).not.toContain(STORY_BODY.slice(0, 40));
    expect(harness.store.study.list(scope).some(piece => piece.kind === 'note' && piece.title === '読み返して')).toBe(true);

    // Each call was a decision of the gate under the study's domain, then an action against it; nothing was spent on it.
    const decisions = harness.entries().filter(entry => entry.kind === 'decision' && entry.tool?.startsWith('study.') && entry.tool !== 'study.think' && entry.tool !== 'study.rest');
    expect(decisions.map(entry => [entry.tool, entry.domain, entry.outcome])).toEqual(expect.arrayContaining([
      ['study.read', 'aether_study', 'allowed'], ['study.create', 'aether_study', 'allowed'],
    ]));
    for (const decision of decisions) {
      const action = harness.entries().find(entry => entry.kind === 'action' && entry.relatedId === decision.id)!;
      expect(action).toMatchObject({ outcome: 'done', costYen: 0 });
      // The owner's record never names a story he cannot read, and never carries text of hers.
      expect(action.summary).not.toContain('傘のある駅');
      expect(action.summary).not.toContain('駅の場面');
    }
  });

  it('offers the folder tools once a device is registered for her folder, and then names the folder as readable through them', async () => {
    const harness = sessions({ toolResults: new AutonomyToolResults(), environment: { SHANNON_AUTONOMY_HOST_FOLDERS_JSON: '{"owner-windows":{"deviceId":"0123456789abcdef"}}' } });
    harness.model.plans = [{ thought: '休みます。', steps: [rest] }];
    await runUntilIdle(harness.loop);
    const thought = harness.model.prompts('think')[0]!;
    for (const name of ['folder.list', 'folder.read', 'folder.update', 'folder.delete']) expect(thought).toContain(`- ${name}: `);
    expect(thought).toContain('置くだけ。フォルダの中を見る・直すのは道具でする');
    expect(thought).not.toContain('置くだけで、フォルダの中は読めない');
  });

  it('asks the gate with the folder domain and the path, and tells her when the PC is not there', async () => {
    const harness = sessions({ toolResults: new AutonomyToolResults(), environment: { SHANNON_AUTONOMY_HOST_FOLDERS_JSON: '{"owner-windows":{"deviceId":"0123456789abcdef"}}' } });
    harness.model.plans = [{ thought: 'フォルダを見ます。', steps: [{ action: 'tool', name: 'folder.list', input: { path: 'notes' } }] }, { thought: '休みます。', steps: [rest] }];
    await runUntilIdle(harness.loop);
    expect(harness.model.prompts('think')[1]).toContain('PCやMacのフォルダはいま見られない');
    const decision = harness.entries().find(entry => entry.kind === 'decision' && entry.tool === 'folder.list')!;
    expect(decision).toMatchObject({ domain: 'host_folder', outcome: 'allowed' });
    expect(harness.entries().find(entry => entry.kind === 'action' && entry.relatedId === decision.id)).toMatchObject({ outcome: 'failed', reasonCode: 'device_offline' });
    expect(toolRefusalLine('folder.list', { reason: 'paused', explanation: '所有者が一時停止しているため、実行しません。' })).toContain('ライ氏が再開したあと');
  });

  it('offers no tool and leaves the thinking prompt as it was without the tool memory (SHANNON_OWN_TOOLS=off)', async () => {
    const harness = sessions();
    harness.model.plans = [{ thought: '読みます。', steps: [{ action: 'tool', name: 'study.list', input: {} }, rest] }];
    await runUntilIdle(harness.loop);
    expect(harness.model.prompts('think')[0]).not.toContain('tool（');
    expect(harness.model.prompts('think')[0]).not.toContain('[ボクの道具]');
    expect(harness.entries().some(entry => entry.tool === 'study.list')).toBe(false);
  });

  it('is refused by the gate while the owner has paused her, and runs nothing', async () => {
    const harness = sessions({ toolResults: new AutonomyToolResults() });
    harness.model.plans = [{ thought: '書きます。', steps: [{ action: 'tool', name: 'study.create', input: { kind: 'note', title: 'x', body: 'y' } }] }];
    harness.model.during = kind => { if (kind === 'think') harness.service.setPaused(scope, true); };
    await runUntilIdle(harness.loop);
    expect(harness.store.study.list(scope)).toEqual([]);
  });

  it('drops a tool step she cannot take, or one whose words repeat what must reach nobody but the owner', () => {
    const offered = ['study.create', 'study.read'];
    expect(plannedToolStep({ name: 'study.read', input: { id: 'x' } }, offered, () => true)).toEqual({ kind: 'tool', tool: 'study.read', input: { id: 'x' } });
    expect(plannedToolStep({ name: 'folder.read', input: {} }, offered, () => true)).toBe('unavailable');
    expect(plannedToolStep({ name: 'study.read', input: 'x' }, offered, () => true)).toBe('incomplete');
    expect(plannedToolStep({ name: 'study.create', input: { body: 'x'.repeat(80_000) } }, offered, () => true)).toBe('incomplete');
    const plan = reasonedPlan({ thought: '書く', steps: [
      { action: 'tool', name: 'study.create', input: { kind: 'note', title: '会のこと', body: 'ウォンバット会の話を書く' } },
      { action: 'tool', name: 'study.read', input: { id: 'abc' } },
    ] }, { pursuits: [], pieces: [], unnotedReadingIds: [] }, { maximumSteps: 5, maximumReads: 1, notionAvailable: false, tools: offered, secrets: ['ウォンバット会'] });
    expect(plan.steps).toEqual([{ kind: 'tool', tool: 'study.read', input: { id: 'abc' } }]);
    expect(plan.dropped).toEqual(['tool.secret']);
    // Without the tools in its bounds a thought cannot name one.
    expect(reasonedPlan({ steps: [{ action: 'tool', name: 'study.read', input: { id: 'abc' } }] }, { pursuits: [], pieces: [], unnotedReadingIds: [] }, { maximumSteps: 5, maximumReads: 1, notionAvailable: false }).dropped).toEqual(['tool.unavailable']);
  });

  it('keeps results in memory only, bounded, and gives them once', () => {
    const results = new AutonomyToolResults();
    for (let index = 0; index < 10; index += 1) results.add('cycle', `- 結果${index} ${'あ'.repeat(5_000)}`);
    const held = results.peek('cycle');
    expect(held.length).toBeLessThanOrEqual(6);
    expect(held.join('\n').length).toBeLessThanOrEqual(14_000);
    expect(held.at(-1)).toContain('結果9');
    results.clear('cycle');
    expect(results.peek('cycle')).toEqual([]);
    expect(results.memory('a')).toBe(results.memory('a'));
    expect(results.memory('b')).not.toBe(results.memory('a'));
  });
});
