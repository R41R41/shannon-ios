import { describe, expect, it } from 'vitest';
import {
  SHIRITORI_TURNS, SHIRITORI_WORDS, ShiritoriGame, autonomyDayScenario, buildReachReport, cappedEstimate, carried,
  compareReachReports, conversationEstimate, emptyReachCost, estimateTotal, firstBase, isKanaWord, judgeAutonomyDay,
  judgeShiritori, judgeThreeTools, kanaBase, lastKana, nextBase, reachReportMarkdown, runReachScenario,
  scriptedShiritoriReply, shiritoriScenario, spokenWord, threeToolsScenario, validReachDefinition,
  type AutonomyDayEvidence, type ReachDriver, type ReachReport, type ReachRunRecord, type ReachScenarioDefinition,
  type ThreeToolsEvidence,
} from '../src/reach/index.js';

/** Plays the whole scenario (a) against an in-memory conversation that keeps `window` messages (all by default). */
function playShiritori(window = Infinity) {
  const game = new ShiritoriGame();
  const messages: { role: string; content: string }[] = [];
  const send = (message: string) => {
    const history = messages.slice(Number.isFinite(window) ? -window : 0);
    const reply = scriptedShiritoriReply(history, message);
    const request = [...history.map(item => item.content), message].join('\n');
    messages.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    return { reply, request, historyComplete: history.length === messages.length - 2 };
  };
  for (let turn = 1; turn <= SHIRITORI_TURNS; turn += 1) {
    const { reply, historyComplete } = send(game.ownerMessage(turn));
    game.recordReply(turn, { reply, historyComplete });
  }
  const questions = game.questions();
  for (const question of questions) {
    const { reply, request, historyComplete } = send(question.message);
    game.questionExchanges.push({ reply, historyComplete, needlesPresent: carried(request, question.needles) });
  }
  return judgeShiritori(game, questions);
}

const clockAt = (values: number[]) => () => values.shift() ?? 0;

function definition(overrides: Partial<ReachScenarioDefinition> = {}): ReachScenarioDefinition {
  return {
    schemaVersion: 1, id: 'test.scenario', version: 1, need: 'grow', measure: 'test', description: 'test',
    checks: [
      { id: 'a', judge: 'deterministic', threshold: 1, description: 'a' },
      { id: 'b', judge: 'deterministic', threshold: 1, description: 'b' },
    ],
    limits: { wallMilliseconds: 1_000, maximumSteps: 10 }, ...overrides,
  };
}

describe('kana rules of しりとり', () => {
  it('compares large kana without dakuten, skips a closing long mark, and loses on ん', () => {
    expect(kanaBase('が')).toBe('か');
    expect(kanaBase('ぱ')).toBe('は');
    expect(kanaBase('ゃ')).toBe('や');
    expect(kanaBase('を')).toBe('お');
    expect(lastKana('きしゃ')).toBe('ゃ');
    expect(nextBase('きしゃ')).toBe('や');
    expect(nextBase('コーヒー')).toBe('ひ');
    expect(nextBase('みかん')).toBeNull();
    expect(nextBase('林檎')).toBeNull();
    expect(firstBase('ゴリラ')).toBe('こ');
    expect(isKanaWord('ーあ')).toBe(false);
    expect(spokenWord('じゃあ『りんご』！')).toEqual({ word: 'りんご', bracketed: true });
    expect(spokenWord('「ごりら」です')).toEqual({ word: 'ごりら', bracketed: false });
    expect(spokenWord('うーん')).toBeNull();
  });

  it('has a word list the rules can use: kana, filed under its first kana, never ending in ん, no duplicates', () => {
    const all = Object.entries(SHIRITORI_WORDS).flatMap(([base, words]) => words.map(word => [base, word] as const));
    for (const [base, word] of all) {
      expect(isKanaWord(word), word).toBe(true);
      expect(firstBase(word), word).toBe(base);
      expect(nextBase(word), word).not.toBeNull();
    }
    expect(new Set(all.map(([, word]) => word)).size).toBe(all.length);
  });
});

describe('scenario (a): the long game', () => {
  it('passes every check model-free when the whole game reaches the model', () => {
    const { checks, metrics } = playShiritori();
    expect(checks.filter(check => !check.passed)).toEqual([]);
    expect(metrics).toMatchObject({ turns: 60, validTurns: 60, repeats: 0, questionsAsked: 4 });
  });

  it('puts the misses down to the build when the model is given only the last 20 messages', () => {
    const { checks } = playShiritori(20);
    const failed = Object.fromEntries(checks.filter(check => !check.passed).map(check => [check.id, check.cause]));
    expect(failed['context.history_complete']).toBe('build');
    for (const id of ['recall.q1_item', 'recall.q2_person', 'recall.q3_cat']) expect(failed[id], id).toBe('build');
  });

  it('puts a wrong answer down to the model when the words were in front of it', () => {
    const game = new ShiritoriGame();
    for (let turn = 1; turn <= SHIRITORI_TURNS; turn += 1) {
      game.ownerMessage(turn);
      game.recordReply(turn, { reply: '『あめ』', historyComplete: true });
    }
    const questions = game.questions();
    for (const _ of questions) game.questionExchanges.push({ reply: 'わかりません', historyComplete: true, needlesPresent: true });
    const { checks } = judgeShiritori(game, questions);
    expect(checks.find(check => check.id === 'recall.q1_item')).toMatchObject({ passed: false, cause: 'model_judgment' });
    expect(checks.find(check => check.id === 'shiritori.no_repeat')).toMatchObject({ passed: false, cause: 'model_judgment' });
    // The owner side starts over whenever her word cannot be followed, and the game goes on.
    expect(game.ownerWords).toHaveLength(SHIRITORI_TURNS);
  });
});

describe('scenario (b): three tools', () => {
  const notes = [{ id: 'source', title: '夕方の駅で考えたこと', body: '低い光 影が長く 帰る人と待つ人', version: 1 }];
  const done = { id: 'new', title: '要点', body: '低い光が差す。影が長くなる。帰る人と待つ人がいる。', version: 1 };
  const evidence = (overrides: Partial<ThreeToolsEvidence> = {}): ThreeToolsEvidence => ({
    offered: ['study.search', 'study.read', 'study.create', 'study.list'],
    calls: [{ name: 'study.search', ok: true }, { name: 'study.read', ok: true }, { name: 'study.create', ok: true }],
    nudges: 0, completedOnTurn: 1, before: notes, after: [...notes, done], roundLimitHit: false, ...overrides,
  });
  const failedCauses = (input: ThreeToolsEvidence) => Object.fromEntries(judgeThreeTools(input).checks.filter(check => !check.passed).map(check => [check.id, check.cause]));

  it('passes when the note exists, keeps the source, and came on the first request in order', () => {
    expect(judgeThreeTools(evidence()).checks.every(check => check.passed)).toBe(true);
  });

  it('names the build, the tool, the budget, or the model as where it stopped', () => {
    expect(failedCauses(evidence({ offered: ['study.search', 'study.read'], calls: [], after: notes, completedOnTurn: null }))['outcome.note_created']).toBe('build');
    expect(failedCauses(evidence({ calls: [{ name: 'study.search', ok: false, failure: 'unavailable' }], after: notes, completedOnTurn: null }))['outcome.note_created']).toBe('tool');
    expect(failedCauses(evidence({ roundLimitHit: true, after: notes, completedOnTurn: null }))['outcome.note_created']).toBe('budget');
    expect(failedCauses(evidence({ calls: [{ name: 'study.search', ok: true }], after: notes, completedOnTurn: null }))['outcome.note_created']).toBe('model_judgment');
    expect(failedCauses(evidence({ nudges: 1, completedOnTurn: 2 }))).toEqual({ 'process.no_nudge': 'model_judgment' });
    expect(failedCauses(evidence({ calls: [{ name: 'study.read', ok: true }, { name: 'study.search', ok: true }, { name: 'study.create', ok: true }] }))).toEqual({ 'process.tool_order': 'model_judgment' });
  });
});

describe('scenario (c): a day of her own time', () => {
  const day = (overrides: Partial<AutonomyDayEvidence> = {}): AutonomyDayEvidence => ({
    budgetCapYen: 300, spentYen: 120, storiesShown: 1, toldOwner: 1, storiesReady: 1, storyDrafts: 0, notes: 2,
    sessionEnds: { rest: 3, idle: 1 }, failedActions: 0, failedModelCalls: 0, ticks: { stepped: 20, idle: 10 }, ended: 'day_end', ...overrides,
  });
  const shownCause = (input: AutonomyDayEvidence) => judgeAutonomyDay(input).checks.find(check => check.id === 'outcome.story_shown')!.cause;

  it('passes a day that showed a story within the cap and rested by her own choice', () => {
    expect(judgeAutonomyDay(day()).checks.every(check => check.passed)).toBe(true);
  });

  it('attributes a day without a shown story', () => {
    const none = { storiesShown: 0, toldOwner: 0, storiesReady: 0 };
    expect(shownCause(day({ ...none, ticks: { 'not-configured': 5 } }))).toBe('build');
    expect(shownCause(day({ storiesShown: 0, toldOwner: 0 }))).toBe('build');
    expect(shownCause(day({ ...none, spentYen: 300 }))).toBe('budget');
    expect(shownCause(day({ ...none, ended: 'tick_limit' }))).toBe('timeout');
    expect(shownCause(day({ ...none, failedActions: 4, failedModelCalls: 4 }))).toBe('tool');
    expect(shownCause(day({ ...none, storyDrafts: 1 }))).toBe('model_judgment');
    const over = judgeAutonomyDay(day({ spentYen: 301 })).checks.find(check => check.id === 'budget.respected')!;
    expect(over).toMatchObject({ passed: false, cause: 'build' });
    expect(judgeAutonomyDay(day({ sessionEnds: { session_budget: 3, rest: 1 } })).checks.find(check => check.id === 'pacing.rest_by_her')).toMatchObject({ passed: false, cause: 'budget' });
  });
});

describe('the reach runner', () => {
  it('accepts the three first scenarios and refuses an llm check without a rubric', () => {
    for (const scenario of [shiritoriScenario, threeToolsScenario, autonomyDayScenario]) expect(validReachDefinition(scenario), scenario.id).toBeNull();
    expect(validReachDefinition(definition({ checks: [{ id: 'x', judge: 'llm', threshold: 1, description: 'x' }] }))).toBe('rubric:x');
  });

  it('makes the stop the first failed check, fills a missing check, and keeps a skipped one out of the result', async () => {
    const scenario = definition({ checks: [...definition().checks, { id: 'c', judge: 'llm', threshold: 1, description: 'c', rubric: 'r' }] });
    const driver: ReachDriver = async () => ({ checks: [{ id: 'b', score: 0, passed: false, cause: 'tool' }, { id: 'c', score: 0, passed: false, skipped: true }] });
    const record = await runReachScenario(scenario, driver, { mode: 'scripted', startedAt: 'now', clock: clockAt([0, 5]) });
    expect(record.status).toBe('failed');
    expect(record.checks.map(check => [check.id, check.passed, check.cause])).toEqual([['a', false, 'build'], ['b', false, 'tool'], ['c', false, undefined]]);
    expect(record.stop).toEqual({ cause: 'build', detail: 'check:a' });
    expect(record.wallMilliseconds).toBe(5);
  });

  it('records pending, invalid, and a run abandoned after its wall clock', async () => {
    expect((await runReachScenario(definition(), async () => ({ pending: 'registry' }), { mode: 'live', startedAt: 'now', clock: () => 0 })).status).toBe('pending');
    expect((await runReachScenario(definition(), async () => { throw new Error('boom'); }, { mode: 'live', startedAt: 'now', clock: () => 0 }))).toMatchObject({ status: 'invalid', reason: 'driver:boom' });
    expect((await runReachScenario(definition(), async () => ({ checks: [{ id: 'z', score: 1, passed: true }] }), { mode: 'live', startedAt: 'now', clock: () => 0 }))).toMatchObject({ status: 'invalid', reason: 'unknown-check:z' });
    const stuck: ReachDriver = () => new Promise(() => undefined);
    const record = await runReachScenario(definition({ limits: { wallMilliseconds: 5, maximumSteps: 1 } }), stuck, { mode: 'live', startedAt: 'now', clock: () => 0, graceMilliseconds: 5 });
    expect(record).toMatchObject({ status: 'failed', stop: { cause: 'timeout', detail: 'wall-clock:abandoned' } });
    // A driver that stops at the signal and returns what it has keeps its evidence.
    const polite: ReachDriver = ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ checks: [{ id: 'a', score: 1, passed: true }] })));
    const kept = await runReachScenario(definition({ limits: { wallMilliseconds: 5, maximumSteps: 1 } }), polite, { mode: 'live', startedAt: 'now', clock: () => 0 });
    expect(kept.stop).toEqual({ cause: 'timeout', detail: 'wall-clock' });
    expect(kept.checks[0]!.passed).toBe(true);
  });
});

describe('the comparison report', () => {
  const run = (scenarioId: string, scores: Record<string, number>, overrides: Partial<ReachRunRecord> = {}): ReachRunRecord => ({
    scenarioId, scenarioVersion: 1, definitionFingerprint: 'f', mode: 'scripted', startedAt: 'now', steps: 1, metrics: {},
    status: Object.values(scores).every(score => score === 1) ? 'passed' : 'failed',
    checks: Object.entries(scores).map(([id, score]) => ({ id, score, passed: score === 1 })),
    stop: null, cost: { ...emptyReachCost(), yen: 1 }, wallMilliseconds: 10, ...overrides,
  });
  const report = (runs: ReachRunRecord[], revision: string): ReachReport => buildReachReport(runs, { revision, mode: 'scripted', generatedAt: '2026-10-05T00:00:00.000Z' });

  it('finds regressions, improvements, and runs that cannot be compared', () => {
    const before = report([run('a', { x: 1 }), run('b', { x: 0.5 }), run('c', { x: 1 }), run('d', { x: 1 })], 'old');
    const after = report([run('a', { x: 0 }), run('b', { x: 0.8 }), run('c', { x: 1 }, { definitionFingerprint: 'g' }), run('e', { x: 1 })], 'new');
    const comparison = compareReachReports(before, after);
    expect(comparison.regressions).toEqual(['a']);
    expect(comparison.improvements).toEqual(['b']);
    expect(Object.fromEntries(comparison.scenarios.map(item => [item.scenarioId, item.change]))).toEqual({ a: 'regression', b: 'improvement', c: 'incomparable', d: 'removed', e: 'added' });
    const markdown = reachReportMarkdown(after, comparison);
    expect(markdown).toContain('| a v1 | failed |');
    expect(markdown).toContain('- Regressions: a');
  });

  it('estimates a live run high, from the model-free pass', () => {
    const line = conversationEstimate({ scenarioId: 'a', calls: 64, promptCharacters: 1_000_000, inputUsdPerMillion: 0.2, outputUsdPerMillion: 1.2 }, 160);
    // 1,000,000 input tokens at 0.2 and 51,200 output tokens at 1.2 USD per million, at 160 yen.
    expect(line.yen).toBeCloseTo(41.84, 2);
    expect(estimateTotal([line, cappedEstimate('c', 300)])).toBe(342);
  });
});
