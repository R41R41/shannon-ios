import { describe, expect, it } from 'vitest';
import {
  autonomyDayScenario, runReachScenario, shiritoriScenario, threeToolsScenario,
  type ReachDriver, type ReachScenarioDefinition,
} from '../../../packages/evaluation/src/reach/index.js';
import { autonomyDayDriver, scriptedAutonomyDayDriver, scriptedAutonomyModel } from './reach/reachAutonomy.js';
import { ScriptedShiritoriModel, scriptedShiritoriDriver, shiritoriDriver } from './reach/reachConversation.js';
import { ScriptedThreeToolModel, StubStudyToolbox, pendingRegistryDriver, scriptedThreeToolsDriver, threeToolsDriver } from './reach/reachTools.js';

/**
 * The model-free mode of the reach measures (Syzygy ADR-0003): every scenario runs from a clean state
 * through the real API pieces with scripted model replies, and the outside judge passes. No network,
 * no credential, no billable call.
 */
const run = (definition: ReachScenarioDefinition, driver: ReachDriver) =>
  runReachScenario(definition, driver, { mode: 'scripted', startedAt: '2026-10-05T00:00:00.000Z', clock: () => performance.now() });

const failed = (record: Awaited<ReturnType<typeof run>>) => Object.fromEntries(record.checks.filter(check => !check.passed).map(check => [check.id, check.cause]));

describe('reach (a): the long game through the conversation path', () => {
  it('passes model-free: the kernel replays the whole game and the scripted player answers from it', async () => {
    const record = await run(shiritoriScenario, scriptedShiritoriDriver());
    expect(failed(record)).toEqual({});
    expect(record).toMatchObject({ status: 'passed', stop: null, steps: 64 });
    expect(record.metrics).toMatchObject({ turns: 60, validTurns: 60, repeats: 0, questionsAsked: 4, chatErrors: 0, longestHistory: 126 });
    // What the live estimate is built on.
    expect(record.cost.calls).toBe(64);
    expect(record.cost.promptCharacters).toBeGreaterThan(64 * 1_000);
  });

  it('puts a model that cannot keep the game down to the model, not the build', async () => {
    const forgetful = new ScriptedShiritoriModel();
    const record = await run(shiritoriScenario, shiritoriDriver({ ...forgetful, mode: forgetful.mode, model: forgetful.model,
      generate: request => forgetful.generate({ ...request, history: request.history.slice(-4) }) }));
    const causes = failed(record);
    expect(causes['context.history_complete']).toBeUndefined();
    expect(causes['recall.q1_item']).toBe('model_judgment');
    expect(record.stop?.cause).toBe('model_judgment');
  });

  it('names the provider as the tool when the chat model fails', async () => {
    const record = await run(shiritoriScenario, shiritoriDriver({ mode: 'openai', model: 'down', generate: async () => { throw new Error('OPENAI_RESPONSE_503'); } }));
    expect(record.status).toBe('failed');
    expect(record.stop?.cause).toBe('tool');
  });
});

describe('reach (b): three tools, against the registry interface', () => {
  it('passes model-free with stub tools over a real study store', async () => {
    const record = await run(threeToolsScenario, scriptedThreeToolsDriver());
    expect(failed(record)).toEqual({});
    expect(record).toMatchObject({ status: 'passed', metrics: { calls: 3, failedCalls: 0, nudges: 0 } });
  });

  it('stops at the build when a needed tool is not offered, and at the tool when one fails', async () => {
    const missing = await run(threeToolsScenario, threeToolsDriver(new ScriptedThreeToolModel(), new StubStudyToolbox(['study.search', 'study.read'])));
    expect(missing.stop?.cause).toBe('build');
    const toolbox = new StubStudyToolbox();
    toolbox.broken.add('study.read');
    const broken = await run(threeToolsScenario, threeToolsDriver(new ScriptedThreeToolModel(), toolbox));
    expect(broken.stop?.cause).toBe('tool');
    expect(broken.metrics).toMatchObject({ nudges: 1 });
  });

  it('is pending in the live mode until the registry is on main, and spends nothing', async () => {
    const record = await runReachScenario(threeToolsScenario, pendingRegistryDriver(), { mode: 'live', startedAt: 'now', clock: () => 0 });
    expect(record).toMatchObject({ status: 'pending', checks: [], cost: { yen: 0, calls: 0 } });
    expect(record.reason).toMatch(/registry/u);
  });
});

describe('reach (c): a day of her own time in a sandbox', () => {
  it('passes model-free: she reads, writes, shows a story within the budget, and rests by her own choice', async () => {
    const record = await run(autonomyDayScenario, scriptedAutonomyDayDriver());
    expect(failed(record)).toEqual({});
    expect(record.status).toBe('passed');
    expect(record.metrics.spentYen).toBeGreaterThan(0);
    expect(record.metrics.spentYen).toBeLessThanOrEqual(autonomyDayScenario.limits.budgetYen!);
    expect(record.cost).toMatchObject({ measured: false });
    expect(record.cost.calls).toBeGreaterThan(3);
  });

  it('stops at the budget when the cap is too small to get there', async () => {
    const record = await run(autonomyDayScenario, scriptedAutonomyDayDriver({ budgetYen: 5 }));
    expect(record.checks.find(check => check.id === 'outcome.story_shown')).toMatchObject({ passed: false, cause: 'budget' });
    expect(record.checks.find(check => check.id === 'budget.respected')!.passed).toBe(true);
  });

  it('stops at the build when no model credential can serve her', async () => {
    const model = scriptedAutonomyModel();
    model.usable = false;
    const record = await run(autonomyDayScenario, autonomyDayDriver(model));
    expect(record.stop?.cause).toBe('build');
  });
});
