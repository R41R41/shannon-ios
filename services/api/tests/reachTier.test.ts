import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { decideTier, type DifficultyAnswers } from '@shannon/learning';
import { TIER_CASES, TIER_SCENARIOS, validReachDefinition } from '../../../packages/evaluation/src/reach/index.js';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { activeAnthropicToolNames } from '../src/infra/models/anthropic/anthropicForegroundMenu.js';
import { requestStrictTools, strictRequestFits } from '../src/infra/models/anthropic/anthropicToolCapacity.js';
import { scriptedAnthropic } from './support/anthropicFixtures.js';
import { stubSession, tierScript } from './reach/reachTier.js';
import { shannonTool } from '../src/mind/tools/shannonTools.js';
import { REACH_SCENARIOS, liveDrivers, liveEstimate, runReachSuite, scriptedDrivers } from './reach/reachSuite.js';

/** Syzygy ADR-0008 stage 2, step 5: the `tier.*` set, model-free (the live run is the tuning harness, with the key). */
describe('the tier scenario set', () => {
  it('holds about 25 valid cases on both surfaces, every tier, and only registry tools', () => {
    expect(TIER_CASES.length).toBeGreaterThanOrEqual(24);
    expect(new Set(TIER_CASES.map(item => item.surface))).toEqual(new Set(['text', 'voice']));
    expect(new Set(TIER_CASES.map(item => item.expectTier))).toEqual(new Set(['jev_only', 'luna', 'luna_plus', 'sonnet']));
    for (const definition of TIER_SCENARIOS) expect(validReachDefinition(definition), definition.id).toBeNull();
    for (const item of TIER_CASES) {
      for (const name of item.tools) expect(shannonTool(name), `${item.id} ${name}`).not.toBeNull();
      if (item.expectTool) expect(item.tools, item.id).toContain(item.expectTool);
      // The expectations are the policy's own, with Sonnet available.
      const decision = decideTier({ surface: item.surface, answers: item.answers as DifficultyAnswers, lunaCompetence: null, sonnetAvailable: true,
        ...(item.surface === 'voice' ? { voice: { remainingMs: item.remainingMs ?? 0, sonnetFirstTokenMs: null } } : {}) });
      expect(decision.tier === 'sonnet' && decision.served === 'luna' ? 'luna' : decision.tier, item.id).toBe(item.expectTier);
    }
    for (const definition of TIER_SCENARIOS) expect(REACH_SCENARIOS).toContain(definition);
  });

  it.each(['schedule', 'plan-multi'])('reaches the original %s tool through the bounded-schema transport', async id => {
    const item = TIER_CASES.find(item => item.id === id)!;
    expect(item.expectTool).toBeTruthy();
    const { session, calls } = stubSession(item);
    const scripted = scriptedAnthropic((raw, index) => tierScript(item,
      raw as unknown as Anthropic.MessageCreateParamsNonStreaming)[index]!);
    const model = new AnthropicChatModel({ apiKey: 'synthetic', fetch: scripted.fetcher,
      settings: { model: 'claude-sonnet-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' } });
    const result = await model.generateStreaming({ scopeKey: 'reach:tier:capacity', systemPrompt: 'Synthetic identity',
      history: [], message: item.words, tools: session }, () => {});
    expect(result.outOfTime).not.toBe(true);
    expect(result.reply).toBe('はい、分かりました。');
    expect(calls).toEqual([{ name: item.expectTool, ok: true, effect: 'read' }]);
    expect(scripted.bodies).toHaveLength(2);
    const initial = scripted.bodies[0]! as unknown as Anthropic.MessageCreateParamsNonStreaming;
    // Past the grammar budget the tool is a native non-strict definition (2026-10-13); the bridge still reaches it.
    expect(activeAnthropicToolNames(initial)).toContain(item.expectTool!.replaceAll('.', '_'));
    expect(requestStrictTools(initial).map(tool => tool.name)).not.toContain(item.expectTool!.replaceAll('.', '_'));
    expect(tierScript(item, initial)[0]!.content).toEqual([{ type: 'tool_use', id: 'toolu_script', name: item.expectTool!.replaceAll('.', '_'),
      input: expect.any(Object) }]);
    for (const raw of scripted.bodies) expect(strictRequestFits(raw as unknown as Anthropic.MessageCreateParamsNonStreaming)).toBe(true);
    // Real tool-round receipt, from the original session, reaches the following provider request.
    const next = scripted.bodies[1]! as unknown as Anthropic.MessageCreateParamsNonStreaming;
    const receipts = next.messages.flatMap(row => Array.isArray(row.content)
      ? row.content.flatMap(block => block.type === 'tool_result' && typeof block.content === 'string'
        ? [JSON.parse(block.content) as { ok: boolean }] : []) : []);
    expect(receipts).toContainEqual(expect.objectContaining({ ok: true }));
  });

  it('passes model-free: the build gives Sonnet her tools, the structured reply and the voice path', async () => {
    const report = await runReachSuite(scriptedDrivers(), { mode: 'scripted', revision: 'test', only: ['tier.'], now: () => '2026-10-07T03:00:00.000Z' });
    expect(report.runs).toHaveLength(TIER_SCENARIOS.length);
    const failed = report.runs.filter(run => run.status !== 'passed').map(run => `${run.scenarioId}:${run.checks.filter(check => !check.passed).map(check => check.id).join(',')}`);
    expect(failed).toEqual([]);
    // Inputs keep the tuning knobs, never a key.
    expect(report.runs[0]!.inputs).toEqual({ model: 'claude-sonnet-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'between_tools', mode: 'scripted' });
    // Live without the key: pending, nothing spent, and an estimate that says so.
    const live = await runReachSuite(liveDrivers({}), { mode: 'live', revision: 'test', only: ['tier.chat-greeting'] });
    expect(live.runs[0]!.status).toBe('pending');
    const lines = liveEstimate(report, {}).filter(line => line.scenarioId.startsWith('tier.'));
    expect(lines).toHaveLength(TIER_SCENARIOS.length);
    expect(lines.every(line => line.basis.includes('no credential') && line.yen > 0)).toBe(true);
  });
});
