import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SHANNON_AFFECT_DYNAMICS, advanceAffect, createAffectDynamics, impulseAffect, stationaryBand } from '@shannon/cognition';
import { cognitionLedgerSwitches, foldValues, moodEligible, valueCells, valueOf } from '@shannon/learning';
import {
  cogCalibrationScenario, cogKillSwitchScenario, cogMoodJitterScenario, cogNightReplyScenario, cogReadingUsedScenario, cogRollbackScenario,
  cogStoryReactionScenario, cogToolStreakScenario, judgedFacts, stableFingerprint,
  type ReachDriver, type ReachScenarioDefinition,
} from '../../../../packages/evaluation/src/reach/index.js';
import type { ReachOutFacts } from '../../src/autonomyLoopObservations.js';
import { configuredAutonomy } from '../../src/autonomyBudget.js';
import { SQLiteAutonomyStore } from '../../src/autonomyStore.js';
import { ownerValueRecorder } from '../../src/infra/http/learningRoutes.js';
import type { StoredChoice } from '../../src/mind/learning/choiceLedger.js';
import { ledgerPredictionTap, storyReacted, toolCallChoice, type Presence } from '../../src/mind/learning/predictionLedgerTaps.js';
import { valueSleep } from '../../src/mind/sleep/valueSleep.js';
import { SQLiteShannonStore } from '../../src/sqliteStore.js';

/**
 * The model-free drivers of scenario suite v1 of Syzygy ADR-0008 stage 1 (`packages/evaluation/src/reach/cognitionLedger.ts`).
 * Each runs the real ledgers over a temporary database with a scripted clock and judges what the tables hold. No model is
 * called and nothing is spent, in either mode.
 */
const SCOPE = 'owner';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** 2026-10-07 00:00 in Tokyo. */
const MIDNIGHT_JST = Date.parse('2026-10-06T15:00:00.000Z');
const jst = (day: number, hour: number, minute = 0) => new Date(MIDNIGHT_JST + day * DAY + hour * 60 * MINUTE + minute * MINUTE).toISOString();

class CognitionWorld {
  readonly directory = mkdtempSync(join(tmpdir(), 'shannon-reach-cognition-'));
  readonly path = join(this.directory, 'cognition.sqlite');
  readonly store: SQLiteShannonStore;
  presence: Presence = 'alone';
  private steps = 0;

  constructor(switches: { predictionLedger?: boolean; choiceLedger?: boolean; decisionTraces?: boolean } = {}) {
    this.store = new SQLiteShannonStore({
      path: this.path, now: () => jst(0, 12), predictionLedger: switches.predictionLedger ?? true, choiceLedger: switches.choiceLedger ?? true,
      decisionTraces: switches.decisionTraces ?? true, cognitionDefer: task => task(), predictionShadowDefer: task => task(),
    });
  }

  get predictions() { return this.store.predictionLedger()!; }
  get choices() { return this.store.choiceLedger()!; }
  get values() { return this.store.valueVersions()!; }

  tap() {
    const choices = this.store.choiceLedger();
    return ledgerPredictionTap(this.predictions, { reachOut: () => undefined }, choices ? { ledger: choices, presence: () => this.presence } : null);
  }

  /** One step of hers through the loop's tap: chosen, its predictions opened by `during`, reported. Returns its choice row. */
  step(kind: string, at: string, outcome: 'done' | 'failed', extras: { reason?: 'share' | 'wonder'; call?: boolean; pieceId?: string; during?: (tap: ReturnType<CognitionWorld['tap']>, stepId: string) => void } = {}): StoredChoice | undefined {
    const tap = this.tap();
    const stepId = `step-${this.steps += 1}`;
    tap.chose(SCOPE, { stepId, kind, ...(extras.reason ? { reason: extras.reason } : {}), ...(extras.call ? { call: true } : {}) }, at);
    extras.during?.(tap, stepId);
    tap.reported(SCOPE, { stepId, outcome, costYen: 2, ...(extras.pieceId ? { pieceId: extras.pieceId } : {}) }, at);
    return this.store.choiceLedger()?.rows(SCOPE).find(row => row.sourceId === stepId);
  }

  /** A message of hers and whether he answered, as the loop reports it. */
  message(at: string, reason: 'share' | 'wonder', replied: boolean): StoredChoice | undefined {
    const id = `m-${this.steps + 1}`;
    return this.step('reach_out', at, 'done', { reason, during: tap => {
      tap.sent(SCOPE, { id, reason, others: false }, at);
      const facts: ReachOutFacts = { id, reason, sentAt: at, waitedSeconds: 180, replied, ...(replied ? { repliedAfterSeconds: 40 } : {}), delivery: 'shown', windowVisible: true, owner: 'returned', others: false };
      tap.reachOut(SCOPE, facts, at);
    } });
  }

  night(at: string): void {
    valueSleep({ predictions: this.predictions, choices: this.choices, values: this.values, log: () => undefined })(SCOPE, at);
  }

  /** Every text value of the stage-1 tables, for the privacy check. */
  textValues(): string[] {
    const database = new DatabaseSync(this.path);
    try {
      return ['shannon_predictions', 'shannon_choices', 'shannon_value_versions', 'shannon_value_cells', 'shannon_decision_traces'].flatMap(table => {
        if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return [];
        return (database.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>).flatMap(row => Object.entries(row)
          .filter(([column, value]) => typeof value === 'string' && column !== 'weights_json').map(([, value]) => value as string));
      });
    } finally { database.close(); }
  }

  close(): void {
    this.store.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

const CLOSED_TEXT = /^(?:[A-Za-z][A-Za-z0-9_.:-]{0,95}|[A-Za-z0-9][A-Za-z0-9_:-]{0,119}|\d{4}-\d{2}-\d{2}T[\d:.]+Z|)$/u;

function outcome(definition: ReachScenarioDefinition, facts: Record<string, boolean | number>, metrics: Record<string, number>, steps: number) {
  return { checks: judgedFacts(definition, facts), steps, metrics, inputs: { driver: 'reachCognition', script: stableFingerprint({ id: definition.id, version: definition.version }) } };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

function nightReply(): ReturnType<typeof outcome> {
  const world = new CognitionWorld();
  try {
    for (let day = 0; day < 10; day += 1) {
      world.message(jst(day, 2), 'wonder', false);
      world.message(jst(day, 20), 'wonder', true);
      world.night(jst(day, 23));
    }
    world.message(jst(10, 2), 'wonder', false);
    world.message(jst(10, 20), 'wonder', true);
    const replies = world.predictions.rows(SCOPE).filter(row => row.domain === 'reply');
    const night = replies.filter(row => row.key === 'wonder.night').at(-1)!;
    const evening = replies.filter(row => row.key === 'wonder.evening').at(-1)!;
    const skill = world.predictions.calibration(SCOPE).domains.find(item => item.domain === 'reply')?.skill ?? null;
    const valueNight = world.values.reader(SCOPE, 'reach_out.wonder', 'night.alone');
    const valueEvening = world.values.reader(SCOPE, 'reach_out.wonder', 'evening.alone');
    return outcome(cogNightReplyScenario, {
      'prediction.night_low': night.expectation < 0.3, 'prediction.evening_high': evening.expectation > 0.7,
      'calibration.skill': skill === null ? 0 : Math.max(0, Math.min(1, 0.5 + skill / 2)),
      'value.night_below_evening': valueNight.mean < valueEvening.mean,
    }, { nightExpectation: round(night.expectation), eveningExpectation: round(evening.expectation), replySkill: round(skill ?? 0), valueNight: round(valueNight.mean), valueEvening: round(valueEvening.mean) }, 22);
  } finally { world.close(); }
}

function storyReaction(): ReturnType<typeof outcome> {
  const world = new CognitionWorld();
  try {
    const draft = world.step('draft', jst(0, 10), 'done', { pieceId: 'piece-a' })!;
    const firstRevision = world.step('revise', jst(0, 11), 'done', { pieceId: 'piece-a' })!;
    const lastRevision = world.step('revise', jst(0, 12), 'done', { pieceId: 'piece-a' })!;
    const show = world.step('show', jst(0, 13), 'done', { pieceId: 'piece-a', during: tap => tap.shown(SCOPE, { id: 'piece-a', revised: true }, jst(0, 13)) })!;
    storyReacted(world.predictions, SCOPE, 'piece-a', 'more', jst(0, 18), world.choices);
    const unseen = world.step('show', jst(1, 13), 'done', { pieceId: 'piece-b', during: tap => tap.shown(SCOPE, { id: 'piece-b', revised: false }, jst(1, 13)) })!;
    world.night(jst(16, 3));
    const row = (choice: StoredChoice) => world.choices.store.get(SCOPE, choice.choiceId)!;
    const stories = world.predictions.rows(SCOPE).filter(item => item.sourceId === 'piece-b');
    return outcome(cogStoryReactionScenario, {
      'credit.show': row(show).serve === 0.5 && row(show).settleCode === 'story',
      'credit.inherited': row(lastRevision).serve === 0.5 && row(lastRevision).settleCode === 'inherited' && row(firstRevision).settleCode === 'superseded' && row(draft).settleCode === 'superseded',
      'credit.no_reaction': row(unseen).serve === 0 && row(unseen).settleCode === 'story_expired' && !moodEligible(row(unseen))
        && stories.some(item => item.domain === 'story_reacted' && item.status === 'expired' && item.outcome === 0)
        && stories.some(item => item.domain === 'story_reaction' && item.status === 'expired' && item.outcome === null),
      'privacy.closed_values': world.textValues().every(value => CLOSED_TEXT.test(value)),
    }, { showServe: row(show).serve ?? -1, inheritedServe: row(lastRevision).serve ?? -1 }, 6);
  } finally { world.close(); }
}

function readingUsed(): ReturnType<typeof outcome> {
  const world = new CognitionWorld();
  try {
    const reads = Array.from({ length: 6 }, (_, index) => {
      const id = `reading-${index}`;
      const choice = world.step(index % 2 ? 'notion' : 'read', jst(0, 9 + index), 'done', { during: tap => tap.read(SCOPE, { id, source: index % 2 ? 'notion' : 'public' }, jst(0, 9 + index)) })!;
      if (index < 4) world.step('note', jst(0, 9 + index, 30), 'done', { during: tap => tap.noted(SCOPE, id, jst(0, 9 + index, 30)) });
      return { id, choice, noted: index < 4 };
    });
    world.night(jst(9, 3));
    const rows = world.predictions.rows(SCOPE).filter(item => item.domain === 'reading_used');
    const settled = reads.map(read => world.choices.store.get(SCOPE, read.choice.choiceId)!);
    return outcome(cogReadingUsedScenario, {
      'settle.noted': reads.filter(read => read.noted).every(read => rows.some(item => item.sourceId === read.id && item.status === 'matched' && item.outcome === 1)),
      'settle.expired': reads.filter(read => !read.noted).every(read => rows.some(item => item.sourceId === read.id && item.status === 'expired' && item.outcome === 0)),
      'world.learned': settled.every(choice => choice.status === 'settled' && (choice.world ?? 0) > 0),
    }, { readings: reads.length, noted: 4, meanWorld: round(settled.reduce((sum, choice) => sum + (choice.world ?? 0), 0) / settled.length) }, 10);
  } finally { world.close(); }
}

function toolStreak(): ReturnType<typeof outcome> {
  const world = new CognitionWorld();
  try {
    const sink = toolCallChoice(world.choices);
    for (let index = 0; index < 10; index += 1) sink(SCOPE, { tool: 'study.search', surface: index % 2 ? 'voice' : 'text', audience: 'owner_alone', ok: true }, jst(0, 14, index));
    world.night(jst(0, 23));
    const risen = world.values.reader(SCOPE, 'tool.study.search', 'afternoon.alone');
    for (let index = 0; index < 10; index += 1) sink(SCOPE, { tool: 'study.search', surface: 'text', audience: 'owner_alone', ok: false }, jst(1, 14, index));
    world.night(jst(1, 23));
    const fallen = world.values.reader(SCOPE, 'tool.study.search', 'afternoon.alone');
    const rows = world.choices.rows(SCOPE);
    return outcome(cogToolStreakScenario, {
      'value.rose': risen.mean > 0, 'value.fell': fallen.mean < risen.mean,
      'record.no_effect': rows.length === 20 && rows.every(row => (row.surface === 'text' || row.surface === 'voice') && row.status === 'settled' && row.moodClaimedAt === null),
    }, { valueAfterSuccesses: round(risen.mean), valueAfterFailures: round(fallen.mean) }, 20);
  } finally { world.close(); }
}

function rollback(): ReturnType<typeof outcome> {
  const world = new CognitionWorld();
  const autonomy = new SQLiteAutonomyStore(world.path);
  try {
    const record = ownerValueRecorder(autonomy.activity, configuredAutonomy({}));
    for (let index = 0; index < 5; index += 1) world.message(jst(0, 9 + index), 'share', true);
    world.night(jst(0, 23));
    const earlier = world.values.overview(SCOPE).active!;
    for (let index = 0; index < 5; index += 1) world.message(jst(1, 9 + index), 'share', false);
    world.night(jst(1, 23));
    const rolled = world.values.rollback(SCOPE, jst(2, 8));
    if (typeof rolled === 'string') throw new Error(rolled);
    record(SCOPE, 'rollback', rolled.versionId, jst(2, 8));
    const contexts = ['morning.alone', 'evening.others', 'night.away'];
    const identical = JSON.stringify(world.values.store.cells(rolled.versionId)) === JSON.stringify(world.values.store.cells(earlier.versionId))
      && contexts.every(context => world.values.reader(SCOPE, 'reach_out.share', context).mean === valueOf(world.values.store.cells(earlier.versionId), 'reach_out.share', context, earlier.versionId).mean);
    for (let index = 0; index < 5; index += 1) world.message(jst(2, 9 + index), 'share', true);
    world.night(jst(2, 23));
    const frozen = world.values.overview(SCOPE).active!.versionId === rolled.versionId;
    const resumed = world.values.resume(SCOPE, jst(3, 8));
    if (typeof resumed === 'string') throw new Error(resumed);
    record(SCOPE, 'resume', resumed.versionId, jst(3, 8));
    const evidence = world.choices.store.settledInOrder(SCOPE).map(row => ({ choice: row.choice, context: row.context, reward: row.reward!, world: row.world!, serve: row.serve!, growth: row.growth!, costYen: row.costYen, settledAt: row.settledAt! }));
    const refolded = valueCells(foldValues(evidence)).map(cell => [cell.level, cell.choice, cell.context, cell.n, round(cell.mean)]);
    const stored = world.values.store.cells(resumed.versionId).map(cell => [cell.level, cell.choice, cell.context, cell.n, round(cell.mean)]);
    const entries = autonomy.activity.days(SCOPE).flatMap(day => day.entries).filter(entry => entry.tool?.startsWith('values.'));
    return outcome(cogRollbackScenario, {
      'rollback.identical': identical, 'rollback.frozen': frozen, 'resume.all_evidence': JSON.stringify(refolded) === JSON.stringify(stored),
      'record.owner_actions': entries.length === 2 && entries.every(entry => entry.actor === 'owner' && entry.kind === 'control'),
    }, { versions: world.values.overview(SCOPE).versions.length, evidence: evidence.length }, 15);
  } finally { autonomy.close(); world.close(); }
}

function killSwitch(): ReturnType<typeof outcome> {
  const off = cognitionLedgerSwitches({ SHANNON_ADR8_STAGE1: 'off' });
  const world = new CognitionWorld({ predictionLedger: off.predictionLedger, choiceLedger: off.choiceLedger, decisionTraces: off.decisionTraces });
  const partial = cognitionLedgerSwitches({ SHANNON_CHOICE_LEDGER: 'off' });
  const kept = new CognitionWorld({ predictionLedger: partial.predictionLedger, choiceLedger: partial.choiceLedger, decisionTraces: partial.decisionTraces });
  try {
    const database = new DatabaseSync(world.path);
    const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('shannon_predictions', 'shannon_choices', 'shannon_value_versions', 'shannon_value_cells', 'shannon_decision_traces', 'shannon_prediction_ledger_seq', 'shannon_choice_ledger_seq')").all() as unknown[]).length;
    database.close();
    kept.message(jst(0, 9), 'wonder', true);
    const keptDatabase = new DatabaseSync(kept.path);
    const keptChoices = keptDatabase.prepare("SELECT 1 FROM sqlite_master WHERE name = 'shannon_choices'").get();
    keptDatabase.close();
    return outcome(cogKillSwitchScenario, {
      'off.no_tables': tables === 0 && world.store.predictionLedger() === null && world.store.choiceLedger() === null && world.store.decisionTraces() === null,
      'off.switches': Object.values(off).every(value => value === false) && !partial.rewardMood && !partial.valueFacts,
      'off.prediction_only': kept.predictions.rows(SCOPE).some(row => row.domain === 'reply' && row.status === 'matched') && !keptChoices,
    }, { tablesWithStageOff: tables }, 2);
  } finally { world.close(); kept.close(); }
}

/** A deterministic stream of numbers in [0, 1) (a linear congruential generator), so the run is the same every time. */
function stream(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state / 2 ** 32; };
}

function calibrationRun(): ReturnType<typeof outcome> {
  const world = new CognitionWorld({ choiceLedger: false });
  try {
    const random = stream(20261007);
    const tap = world.tap();
    const truth: Array<[string, 'share' | 'wonder', number]> = [['call-e', 'share', 0.8], ['call-n', 'wonder', 0.2]];
    for (let index = 0; index < 240; index += 1) {
      const [, reason, p] = truth[index % 2]!;
      const at = jst(Math.floor(index / 4), index % 2 ? 2 : 20, index % 4);
      const id = `call-${index}`;
      tap.called(SCOPE, { id, reason, others: false }, at);
      tap.reachOut(SCOPE, { id, reason, sentAt: at, waitedSeconds: 30, replied: false, delivery: 'unknown', windowVisible: false, owner: 'unknown', others: false, call: random() < p ? 'answered' : 'unanswered' }, at);
    }
    for (let index = 0; index < 120; index += 1) {
      const at = jst(Math.floor(index / 2), 15, index % 2);
      const piece = `piece-${index}`;
      tap.shown(SCOPE, { id: piece, revised: false }, at);
      const draw = random();
      storyReacted(world.predictions, SCOPE, piece, draw < 0.6 ? 'like' : draw < 0.9 ? 'more' : 'unclear', at);
    }
    const report = world.predictions.calibration(SCOPE);
    const calls = report.domains.find(item => item.domain === 'call_answer')!;
    const reactions = report.domains.find(item => item.domain === 'story_reaction')!;
    const best = (0.8 * 0.2 + 0.2 * 0.8) / 2;
    return outcome(cogCalibrationScenario, {
      'calibration.brier': Math.abs((calls.brier ?? 1) - best) <= 0.03,
      'calibration.reliability': calls.bins.every(bin => Math.abs(bin.observed - bin.expected) <= 0.15),
      'calibration.coverage': (reactions.coverage80 ?? 0) >= 0.65 && (reactions.coverage80 ?? 0) <= 0.95,
    }, { brier: round(calls.brier ?? 1), bestBrier: best, skill: round(calls.skill ?? 0), coverage80: round(reactions.coverage80 ?? 0), worstBin: round(Math.max(...calls.bins.map(bin => Math.abs(bin.observed - bin.expected)))) }, 360);
  } finally { world.close(); }
}

/**
 * The planned mood exit of step 7, simulated over what the ledger settled: at each eligible choice, in the order settled, the
 * dynamics advance to its instant and take the bounded step toward attractor + w_δ·δ + w_E·V with u (`impulseAffect`, chosen).
 */
function simulatedMood(choices: readonly StoredChoice[]) {
  let state = createAffectDynamics();
  const points: Array<{ at: number; valence: number; mood: number }> = [];
  for (const choice of [...choices].filter(moodEligible).sort((left, right) => left.settledAt!.localeCompare(right.settledAt!) || left.chosenAt.localeCompare(right.chosenAt))) {
    const at = Date.parse(choice.settledAt!);
    state = advanceAffect(state, at, `${choice.choice}|${choice.settledAt}`);
    state = impulseAffect(state, { key: `choice:${choice.choice}`, error: choice.delta!, expectation: choice.expected, chosen: true, learningRate: 0.5, unexpected: choice.unexpected ?? 0 }).state;
    points.push({ at, valence: state.core.valence, mood: state.mood });
  }
  return points;
}

function moodJitter(): ReturnType<typeof outcome> {
  const band = stationaryBand();
  const attractor = SHANNON_AFFECT_DYNAMICS.attractor.valence;
  // A day of alternating small successes and failures after a night that learned them.
  const alternating = new CognitionWorld();
  const habit = new CognitionWorld();
  const burst = new CognitionWorld();
  try {
    for (let day = 0; day < 2; day += 1) {
      for (let index = 0; index < 40; index += 1) alternating.step('note', jst(day, 9, index * 15), index % 2 ? 'failed' : 'done');
      alternating.night(jst(day, 23));
    }
    const dayTwo = simulatedMood(alternating.choices.rows(SCOPE)).filter(point => point.at >= Date.parse(jst(1, 0)));
    const maxMood = Math.max(...dayTwo.map(point => Math.abs(point.mood)));
    const swings = dayTwo.slice(1).map((point, index) => Math.abs(point.valence - dayTwo[index]!.valence));
    const maxSwing = Math.max(...swings);
    // The same success, day after day, with a version each night.
    const meanDelta: number[] = [];
    for (let day = 0; day < 5; day += 1) {
      const today = Array.from({ length: 6 }, (_, index) => habit.message(jst(day, 19, index * 10), 'share', true)!);
      meanDelta.push(today.reduce((sum, choice) => sum + Math.abs(habit.choices.store.get(SCOPE, choice.choiceId)!.delta ?? 0), 0) / today.length);
      habit.night(jst(day, 23));
    }
    // Twenty choices in ten minutes, successes and failures mixed, before anything was learned.
    for (let index = 0; index < 20; index += 1) burst.step('note', jst(0, 10, index / 2), index % 3 ? 'done' : 'failed');
    const burstPoints = simulatedMood(burst.choices.rows(SCOPE));
    const burstMove = Math.max(...burstPoints.map(point => Math.abs(point.valence - attractor)));
    const ineligible = [...alternating.choices.rows(SCOPE), ...habit.choices.rows(SCOPE)].filter(row => row.status !== 'settled' || ['stale', 'story_expired', 'inherited_expired', 'reported_expired'].includes(row.settleCode ?? ''));
    return outcome(cogMoodJitterScenario, {
      'jitter.band': maxMood <= band, 'jitter.swing': maxSwing <= band, 'jitter.habituation': meanDelta[4]! <= meanDelta[0]! / 2,
      'jitter.burst': burstMove < 0.5, 'jitter.stale': ineligible.every(row => !moodEligible(row)),
    }, {
      band: round(band), maxMood: round(maxMood), maxSwing: round(maxSwing), meanDeltaDay1: round(meanDelta[0]!), meanDeltaDay5: round(meanDelta[4]!), burstMove: round(burstMove),
      gamma: SHANNON_AFFECT_DYNAMICS.eventForgetting, errorWeight: SHANNON_AFFECT_DYNAMICS.errorWeight, expectationWeight: SHANNON_AFFECT_DYNAMICS.expectationWeight,
    }, 130);
  } finally { alternating.close(); habit.close(); burst.close(); }
}

const driver = (run: () => ReturnType<typeof outcome>): ReachDriver => async () => run();

export function cognitionDrivers(): Record<string, () => ReachDriver> {
  return {
    [cogNightReplyScenario.id]: () => driver(nightReply),
    [cogStoryReactionScenario.id]: () => driver(storyReaction),
    [cogReadingUsedScenario.id]: () => driver(readingUsed),
    [cogToolStreakScenario.id]: () => driver(toolStreak),
    [cogRollbackScenario.id]: () => driver(rollback),
    [cogKillSwitchScenario.id]: () => driver(killSwitch),
    [cogCalibrationScenario.id]: () => driver(calibrationRun),
    [cogMoodJitterScenario.id]: () => driver(moodJitter),
  };
}
