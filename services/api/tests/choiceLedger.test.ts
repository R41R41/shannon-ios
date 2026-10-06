import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ROOT_VALUE } from '@shannon/learning';
import type { ReachOutFacts } from '../src/autonomyLoopObservations.js';
import { ChoiceLedger, choiceLedgerEnabled } from '../src/mind/learning/choiceLedger.js';
import { PredictionLedger } from '../src/mind/learning/predictionLedger.js';
import { ledgerPredictionTap, presenceOf, stepChoice, storyReacted, studyPieceOf, toolCallChoice } from '../src/mind/learning/predictionLedgerTaps.js';
import { valueSleep } from '../src/mind/sleep/valueSleep.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';
import { toolSessionMemory } from '../src/shannonToolTypes.js';
import { loopHarness, scope } from './autonomyLoopHarness.js';

/**
 * The choice ledger and reward settlement (Syzygy ADR-0008 stage 1, `docs/cognition-ledger-contract.md`): a choice per step the
 * gate allowed, settled once by its three instincts with cost recorded and not subtracted, delayed credit for a showing and the
 * draft it came from, the nightly pass, and tool calls in conversations as data.
 */
const directory = mkdtempSync(join(tmpdir(), 'shannon-choice-ledger-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const DAY = 24 * 60 * 60_000;
const START = Date.parse('2026-10-07T03:00:00.000Z');
const at = (minutes: number) => new Date(START + minutes * 60_000).toISOString();
let files = 0;

function harness() {
  const database = new DatabaseSync(join(directory, `choices-${files += 1}.sqlite`));
  const defer = (task: () => void) => task();
  const predictions = new PredictionLedger({ database, createsSchema: true, defer, log: () => undefined });
  const choices = new ChoiceLedger({ database, createsSchema: true, defer });
  const shadow = { reachOut: vi.fn() };
  const tap = ledgerPredictionTap(predictions, shadow, { ledger: choices, presence: () => 'alone' });
  const choice = (stepId: string) => choices.rows('owner').find(row => row.sourceId === stepId)!;
  return { database, predictions, choices, tap, shadow, choice };
}

const facts = (overrides: Partial<ReachOutFacts>): ReachOutFacts => ({
  id: 'm1', reason: 'wonder', sentAt: at(0), waitedSeconds: 60, replied: true, repliedAfterSeconds: 30, delivery: 'shown', windowVisible: true, owner: 'returned', others: false, ...overrides,
});

describe('a choice of hers', () => {
  it('is named from closed values only, and planning and resting are not choices', () => {
    expect(stepChoice({ kind: 'reach_out', reason: 'wonder' })).toBe('reach_out.wonder');
    expect(stepChoice({ kind: 'reach_out', reason: 'share', call: true })).toBe('call.share');
    expect(stepChoice({ kind: 'reach_out', reason: 'follow_up' })).toBe('follow_up');
    expect(stepChoice({ kind: 'tool', tool: 'study.search' })).toBe('tool.study.search');
    expect(stepChoice({ kind: 'tool', tool: 'ひみつ' })).toBe('tool.unknown');
    expect(stepChoice({ kind: 'think' })).toBeNull();
    expect(stepChoice({ kind: 'rest' })).toBeNull();
    expect(studyPieceOf('shannon-study://piece-1')).toBe('piece-1');
    expect(studyPieceOf('https://example.org')).toBeUndefined();
    expect(presenceOf({ others: true, owner: 'returned', windowVisible: true })).toBe('others');
    expect(presenceOf({ others: false, owner: 'away', windowVisible: true })).toBe('away');
    expect(presenceOf({ others: false, owner: 'unknown', windowVisible: true })).toBe('alone');
    expect(presenceOf({ others: false, owner: 'unknown', windowVisible: false })).toBe('unknown');
  });

  it('is recorded with the value she held then, linked to its predictions, and settled by them with cost recorded, not subtracted', () => {
    const { tap, choice, predictions } = harness();
    tap.chose('owner', { stepId: 'step-1', kind: 'reach_out', reason: 'wonder' }, at(0));
    tap.sent('owner', { id: 'm1', reason: 'wonder', others: false }, at(1));
    tap.reachOut('owner', facts({ id: 'm1', replied: true }), at(3));
    tap.reported('owner', { stepId: 'step-1', outcome: 'done', costYen: 12 }, at(3));
    const row = choice('step-1');
    expect(row).toMatchObject({
      surface: 'autonomy', choice: 'reach_out.wonder', context: 'afternoon.alone', valueVersion: 'initial', expected: 0, expectedLevel: 'root',
      status: 'settled', success: 1, serve: 1, costYen: 12, settleCode: 'reply',
    });
    expect(row.expectedSd).toBeCloseTo(Math.sqrt(ROOT_VALUE.variance), 5);
    // Both of its predictions belong to it: whether the step succeeds and whether he answers.
    expect(predictions.rows('owner').map(item => [item.domain, item.choiceId === row.choiceId, item.status])).toEqual([['step_success', true, 'matched'], ['reply', true, 'matched']]);
    expect(row.world).toBeGreaterThan(0);
    expect(row.reward).toBeCloseTo((row.world! + row.serve! + row.growth!) / 3, 6);
    expect(row.delta).toBeCloseTo(row.reward! - 0, 6);
    expect(row.unexpected).toBeGreaterThan(0);
  });

  it('is void when the owner could not have seen her message, and when its report was lost', () => {
    const { tap, choice, choices } = harness();
    tap.chose('owner', { stepId: 'away', kind: 'reach_out', reason: 'share' }, at(0));
    tap.sent('owner', { id: 'm-away', reason: 'share', others: false }, at(1));
    tap.reachOut('owner', facts({ id: 'm-away', delivery: 'away', replied: false }), at(2));
    tap.reported('owner', { stepId: 'away', outcome: 'done', costYen: 3 }, at(2));
    expect(choice('away')).toMatchObject({ status: 'void', settleCode: 'void', reward: null });
    tap.chose('owner', { stepId: 'other-runner', kind: 'note' }, at(5));
    tap.reported('owner', { stepId: 'other-runner', outcome: 'void', costYen: 0 }, at(6));
    expect(choice('other-runner')).toMatchObject({ status: 'void' });
    tap.chose('owner', { stepId: 'crashed', kind: 'read' }, at(10));
    expect(choices.sleep('owner', at(20))).toMatchObject({ settled: 0 });
    expect(choices.sleep('owner', new Date(START + 2 * DAY).toISOString())).toMatchObject({ settled: 1 });
    expect(choice('crashed')).toMatchObject({ status: 'void', settleCode: 'lost' });
    // A step that is reported for another step's id changes nothing.
    tap.chose('owner', { stepId: 'mine', kind: 'note' }, at(30));
    tap.reported('owner', { stepId: 'not-mine', outcome: 'done', costYen: 0 }, at(31));
    expect(choice('mine')).toMatchObject({ status: 'pending', success: null });
  });

  it('credits a showing when the owner reacts, and the last draft before it inherits that credit; an earlier draft is superseded', () => {
    const { tap, choice, predictions, choices } = harness();
    const step = (stepId: string, kind: string, minute: number, pieceId = 'piece-1') => {
      tap.chose('owner', { stepId, kind }, at(minute));
      if (kind === 'show') tap.shown('owner', { id: pieceId, revised: false }, at(minute));
      tap.reported('owner', { stepId, outcome: 'done', costYen: 5, pieceId }, at(minute + 1));
    };
    step('draft', 'draft', 0);
    step('revise', 'revise', 10);
    step('show', 'show', 20);
    step('revise-after', 'revise', 30);
    expect(choice('draft')).toMatchObject({ status: 'settled', serve: 0, settleCode: 'superseded' });
    expect(choice('revise')).toMatchObject({ status: 'pending' });
    expect(choice('show')).toMatchObject({ status: 'pending' });
    storyReacted(predictions, 'owner', 'piece-1', 'more', at(60), choices);
    expect(choice('show')).toMatchObject({ status: 'settled', serve: 0.5, settleCode: 'story' });
    expect(choice('revise')).toMatchObject({ status: 'settled', serve: 0.5, settleCode: 'inherited' });
    // The revision after the showing waits for a showing of its own, and is stale after 14 days without one.
    expect(choice('revise-after')).toMatchObject({ status: 'pending' });
    choices.sleep('owner', new Date(START + 15 * DAY).toISOString());
    expect(choice('revise-after')).toMatchObject({ status: 'settled', serve: 0, settleCode: 'stale' });
  });

  it('credits a showing nobody reacted to with 0 after 14 days, through the nightly pass', () => {
    const { tap, choice, predictions, choices } = harness();
    tap.chose('owner', { stepId: 'show', kind: 'show' }, at(0));
    tap.shown('owner', { id: 'piece-2', revised: true }, at(0));
    tap.reported('owner', { stepId: 'show', outcome: 'done', costYen: 0, pieceId: 'piece-2' }, at(1));
    const lines: string[] = [];
    const night = valueSleep({ predictions, choices, log: line => lines.push(line) });
    night('owner', new Date(START + 2 * DAY).toISOString());
    expect(choice('show')).toMatchObject({ status: 'pending' });
    night('owner', new Date(START + 15 * DAY).toISOString());
    expect(choice('show')).toMatchObject({ status: 'settled', serve: 0, settleCode: 'story_expired' });
    expect(lines.at(-1)).toMatch(/^Shannon value sleep: expired=2 predictions_pruned=0 settled=1 choices_pruned=0 version=none versions_pruned=0$/u);
    night('owner', new Date(START + 200 * DAY).toISOString());
    expect(choices.rows('owner')).toEqual([]);
    // A pass that fails is logged and never thrown at the sleep batch.
    const failed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => valueSleep({ predictions: { maintain: () => { throw new Error('x'); } }, choices })('owner', at(0))).not.toThrow();
    expect(failed).toHaveBeenCalledOnce();
    failed.mockRestore();
  });

  it('records her tool calls in conversations as choices made and ended at once', () => {
    const { choices } = harness();
    const sink = toolCallChoice(choices);
    sink('owner', { tool: 'study.search', surface: 'text', audience: 'owner_alone', ok: true }, at(0));
    sink('owner', { tool: 'aether.read', surface: 'voice', audience: 'others', ok: false }, at(1));
    expect(choices.rows('owner').map(row => [row.surface, row.choice, row.context, row.sourceKind, row.status, row.world, row.serve, row.growth])).toEqual([
      ['text', 'tool.study.search', 'afternoon.alone', 'tool_call', 'settled', 0, 0, 1],
      ['voice', 'tool.aether.read', 'afternoon.others', 'tool_call', 'settled', 0, 0, 0],
    ]);
  });

  it('is told by the tool runner of conversation calls that ran, and not of one the gate refused', async () => {
    const harnessed = loopHarness();
    const seen: unknown[] = [];
    harnessed.service.tools.observeChoices((scopeKey, call, when) => { seen.push([scopeKey, call, when]); }, () => at(0));
    const memory = toolSessionMemory();
    await harnessed.service.tools.call('study.list', '{}', { scopeKey: scope, surface: 'text', audience: 'owner_alone', memory });
    await harnessed.service.tools.call('study.list', '{}', { scopeKey: scope, surface: 'voice', audience: 'others', memory });
    await harnessed.service.tools.call('no.such.tool', '{}', { scopeKey: scope, surface: 'text', audience: 'owner_alone', memory });
    expect(seen).toEqual([[scope, { tool: 'study.list', surface: 'text', audience: 'owner_alone', ok: true }, at(0)]]);
    harnessed.store.close();
  });

  it('records nothing with the switch off', () => {
    expect(choiceLedgerEnabled({ SHANNON_CHOICE_LEDGER: 'off' })).toBe(false);
    expect(choiceLedgerEnabled({ SHANNON_ADR8_STAGE1: 'off' })).toBe(false);
    const path = join(directory, 'off.sqlite');
    const store = new SQLiteShannonStore({ path, now: () => at(0), choiceLedger: false });
    expect(store.choiceLedger()).toBeNull();
    store.close();
    const database = new DatabaseSync(path);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name IN ('shannon_choices', 'shannon_choice_ledger_seq')").all()).toEqual([]);
    database.close();
    const predictions = { open: vi.fn(), settle: vi.fn(), settleSource: vi.fn() };
    const tap = ledgerPredictionTap(predictions as never, { reachOut: () => undefined });
    tap.chose('owner', { stepId: 's', kind: 'note' }, at(0));
    tap.reported('owner', { stepId: 's', outcome: 'done', costYen: 0 }, at(1));
    expect(predictions.open).not.toHaveBeenCalled();
    expect(predictions.settleSource).not.toHaveBeenCalled();
  });
});
