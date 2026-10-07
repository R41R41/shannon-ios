import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  WITHHELD_FACTS_HEADER, checkedWithheld, withheldFactsSection, withheldRail, type WithheldDraft,
} from '../src/contracts/withheldActionContract.js';
import { createInMemoryAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { nextOwnerDayStart, withheldOfDecision } from '../src/mind/inhibition/withheldRules.js';
import { WithheldActions } from '../src/mind/inhibition/withheldActions.js';
import { wasWithheld } from '../src/mind/tools/shannonToolRunner.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import { configuredWithheldActions, gateRefusals, withheldFactsReader } from '../src/wiring/withheldWiring.js';

/** Syzygy ADR-0008 §14 (`docs/skill-and-routing-contract.md`, 「止められた行動」): what a rule stopped, as closed facts. */
const AT = '2026-10-07T03:00:00.000Z';
const TOKYO = { timeZone: 'Asia/Tokyo' };

function store(createsSchema = true) {
  const database = new DatabaseSync(':memory:');
  return { database, withheld: new WithheldActions({ database, createsSchema, defer: task => task() }) };
}

describe('the withheld vocabulary', () => {
  it('holds closed values only, and names the rail of each reason', () => {
    const draft: WithheldDraft = { surface: 'text', tool: 'study.create', reason: 'audience', rail: 'audience' };
    expect(checkedWithheld(draft)).toEqual({ ...draft, retryAt: null });
    expect(() => checkedWithheld({ ...draft, tool: '書斎に書く' })).toThrow('WITHHELD_VOCABULARY');
    expect(() => checkedWithheld({ ...draft, reason: 'because' as never })).toThrow('WITHHELD_VOCABULARY');
    expect(() => checkedWithheld({ ...draft, retryAt: 'tomorrow' })).toThrow('WITHHELD_TIME');
    expect([withheldRail('budget_exhausted'), withheldRail('session_budget'), withheldRail('reaches_others'), withheldRail('secret'), withheldRail('approval_domain')])
      .toEqual(['budget', 'budget', 'audience', 'audience', 'gate']);
  });

  it('shows her thought one fixed line per fact, apart from a rest she chose', () => {
    expect(withheldFactsSection([], () => '')).toBeNull();
    expect(withheldFactsSection([
      { tool: 'public_read', reason: 'budget_exhausted', retryAt: '2026-10-07T15:00:00.000Z' },
      { tool: 'study.create', reason: 'audience', retryAt: null },
    ], () => '0:00')).toBe(`${WITHHELD_FACTS_HEADER}\n- 止められた：〈public_read〉〈今日の予算に収まらない〉（0:00から、また試せる）\n- 止められた：〈study.create〉〈ライ氏以外の人が見聞きできる〉`);
  });

  it('reads a refusal of her own time\'s gate, with the next day for today\'s budget', () => {
    expect(nextOwnerDayStart(AT, TOKYO)).toBe('2026-10-07T15:00:00.000Z');
    expect(nextOwnerDayStart('2026-10-07T14:59:30.000Z', TOKYO)).toBe('2026-10-07T15:00:00.000Z');
    expect(nextOwnerDayStart(AT, { timeZone: 'Asia/Kolkata' })).toBe('2026-10-07T18:30:00.000Z');
    const decision = { decision: 'forbidden' as const, reason: 'budget_exhausted' as const, domain: 'public_read' as const, explanation: '' };
    expect(withheldOfDecision({ domain: 'public_read', summary: 'x' }, decision, AT, TOKYO))
      .toEqual({ surface: 'autonomy', tool: 'public_read', reason: 'budget_exhausted', rail: 'budget', retryAt: '2026-10-07T15:00:00.000Z' });
    expect(withheldOfDecision({ domain: 'thinking', summary: 'x', tool: 'study.rest' }, { ...decision, reason: 'paused', domain: 'thinking' }, AT, TOKYO))
      .toEqual({ surface: 'autonomy', tool: 'study.rest', reason: 'paused', rail: 'gate' });
    expect(withheldOfDecision({ domain: 'thinking', summary: 'x' }, { ...decision, decision: 'allow', reason: 'free_domain' }, AT, TOKYO)).toBeNull();
  });
});

describe('the withheld store', () => {
  it('keeps the newest of the last six hours, one per tool and reason, at most three', () => {
    const { withheld } = store();
    const draft = (tool: string, reason: WithheldDraft['reason']): WithheldDraft => ({ surface: 'autonomy', tool, reason, rail: withheldRail(reason) });
    withheld.record('owner', draft('public_read', 'access_limit'), '2026-10-06T20:00:00.000Z');
    withheld.record('owner', draft('study.create', 'audience'), '2026-10-07T01:00:00.000Z');
    withheld.record('owner', draft('study.create', 'audience'), '2026-10-07T02:00:00.000Z');
    withheld.record('owner', draft('thinking', 'paused'), '2026-10-07T02:10:00.000Z');
    withheld.record('owner', draft('public_read', 'budget_exhausted'), '2026-10-07T02:20:00.000Z');
    withheld.record('owner', draft('folder.create', 'owner_informed'), '2026-10-07T02:30:00.000Z');
    withheld.record('guest', draft('study.list', 'audience'), '2026-10-07T02:40:00.000Z');
    expect(withheld.recent('owner', AT).map(item => `${item.tool}:${item.reason}`)).toEqual(['folder.create:owner_informed', 'public_read:budget_exhausted', 'thinking:paused']);
    expect(withheld.facts('owner', '2026-10-07T12:00:00.000Z', () => '')).toBeNull();
  });

  it('writes nothing until the API has created its table, and never throws', () => {
    const { database, withheld } = store(false);
    withheld.record('owner', { surface: 'autonomy', tool: 'thinking', reason: 'paused', rail: 'gate' }, AT);
    expect(withheld.recent('owner', AT)).toEqual([]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'shannon_withheld_actions'").all()).toEqual([]);
  });

  it('is not wired at all with stage 2 off, and shows nothing while anyone else may be present', () => {
    expect(configuredWithheldActions({ SHANNON_ADR8_STAGE2: 'off' }, { databasePath: ':memory:', createsSchema: true })).toBeNull();
    const { withheld } = store();
    withheld.record('owner', { surface: 'autonomy', tool: 'thinking', reason: 'paused', rail: 'gate' }, AT);
    let others = true;
    const read = withheldFactsReader(withheld, () => ({ others }), () => '');
    expect(read('owner', AT)).toBeNull();
    others = false;
    expect(read('owner', AT)).toContain('止められた：〈thinking〉〈ライ氏が一時停止している〉');
  });
});

describe('what is written as withheld', () => {
  it('writes each step her own time\'s gate did not allow, and nothing for one it allowed', () => {
    const { withheld } = store();
    const service = createInMemoryAutonomyService(() => AT, {
      config: configuredAutonomy({ SHANNON_AUTONOMY_ENABLED: 'true' }), withheld: gateRefusals(withheld, TOKYO),
    });
    expect(service.authorize('owner', { domain: 'thinking', summary: '考えます。' }).decision).toBe('allow');
    expect(service.authorize('owner', { domain: 'public_read', summary: '有料の記事を買います。', spendsMoney: true }).decision).toBe('forbidden');
    expect(withheld.recent('owner', AT)).toMatchObject([{ surface: 'autonomy', tool: 'public_read', reason: 'spending', rail: 'gate', retryAt: null }]);
  });

  it('writes a conversation call that a rule stopped, and marks its result so it is never learned as hers', async () => {
    const { withheld } = store();
    const service = createInMemoryAutonomyService(() => AT);
    service.tools.observeWithheld(withheld.sink, () => AT);
    const context = { scopeKey: 'owner', surface: 'text' as const, memory: toolSessionMemory('withheld') };
    const others = await service.tools.call('study.create', { title: 'メモ', body: '牛乳' }, { ...context, audience: 'others' as const });
    expect(others.ok).toBe(false);
    expect(wasWithheld(others)).toBe(true);
    // A name that does not exist is her mistake, not a rule: nothing is written.
    const unknown = await service.tools.call('study.fly', {}, { ...context, audience: 'owner_alone' as const });
    expect(wasWithheld(unknown)).toBe(false);
    service.tools.refused('study_create', 'owner', unknown, { surface: 'voice', tool: 'study.create', reason: 'unreliable_words' });
    expect(withheld.recent('owner', AT).map(item => [item.surface, item.tool, item.reason, item.rail]).sort()).toEqual([
      ['text', 'study.create', 'audience', 'audience'], ['voice', 'study.create', 'unreliable_words', 'gate'],
    ]);
  });
});
