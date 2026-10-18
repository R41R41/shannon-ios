import { describe, expect, it, vi } from 'vitest';
import { estimatedAnthropicTokens } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { renderedRequest } from '../src/infra/models/anthropic/anthropicFcaTransient.js';
import { transientRequest } from '../src/infra/models/anthropic/anthropicFcaTransientRequest.js';
import { FCA_BODY_HISTORY_POLICY } from '../src/mind/action/fca/fcaHistory.js';
import { withoutCacheMarkers } from './support/anthropicFixtures.js';
import { BASE_CATALOG, definition, quiet, scenario } from './fcaCoreToolsHarness.js';

/**
 * The transient state at production size (observation redesign P3, third-review rework): a 25k-token core, a catalog of 80 tools whose
 * descriptions run 300 to 1,090 characters, a 25-line skill index, and a big live state. The request as sent never passes 95,000 estimated
 * tokens; a cut takes catalog descriptions first, then long state texts, then the live state, and never a tool name or the skill index; a
 * catalog change is stated for its tool only; the metrics say which stage cut.
 */
type Body = Record<string, unknown>;
type Row = Record<string, unknown> & { stateUpdate: string; catalog?: Array<{ name: string; description: string }>;
  catalogChanges?: { added?: unknown[]; changed?: Array<{ name: string; description: string }>; removed?: string[] };
  cappedCatalog?: Record<string, string>; skillIndex?: string };
type Msg = { role: string; content: unknown };
const stateTexts = (body: Body) => withoutCacheMarkers(body.messages as Msg[]).flatMap(entry => entry.role === 'user' && Array.isArray(entry.content)
  ? (entry.content as Array<{ type: string; text?: string }>).flatMap(block => block.type === 'text' && block.text?.startsWith('{"stateUpdate"') ? [block.text] : []) : []);
const events = (name: string) => vi.mocked(console.info).mock.calls.flatMap(([line]) => {
  try { const value = JSON.parse(String(line)) as Record<string, unknown>; return value.event === name ? [value] : []; } catch { return []; }
});

const TEXTS = { ja: '指定した位置の近くで作業をして、結果を新しい観測で確かめる。足りない材料は先に集める。', ascii: 'Works near the given position and checks the result against a fresh observation; gathers missing materials first. ' };
type Kind = keyof typeof TEXTS;
const text = (kind: Kind, length: number) => TEXTS[kind].repeat(Math.ceil(length / TEXTS[kind].length)).slice(0, length);
const LAZY_COUNT = 80;
/** 80 tools, descriptions of 300 to 1,090 characters; `change` appends to one description. */
const lazy = (kind: Kind, change?: number) => Array.from({ length: LAZY_COUNT }, (_, index) =>
  definition(`mc_tool_${index}`, 'host_folder', `${text(kind, 300 + (index * 10) % 800)}${index === change ? ' (changed)' : ''}`));
/** The core as the Minecraft body's (24 skills of about 850 characters: over 20,000 estimated tokens), and the harness's other tools. */
const core = Array.from({ length: 24 }, (_, index) => definition(`mc.skill-${index + 1}`, 'minecraft_body', '身体スキルの説明。'.repeat(95)));
const rest = BASE_CATALOG.filter(tool => tool.domain !== 'minecraft_body');
const skillIndex = ['[ボクのスキル 25/25]', ...Array.from({ length: 25 }, (_, index) => `- skill-${index}: ${text('ja', 70)}`)].join('\n');
const ORIGINAL = (kind: Kind) => new Map(lazy(kind).map(tool => [tool.name, tool.description]));

async function production(kind: Kind, live: (decision: number) => string, steps = 16) {
  quiet();
  const run = scenario({ mode: () => 'transient', policy: FCA_BODY_HISTORY_POLICY, skillIndex, appendOnly: true, steps,
    catalogAt: decision => [...core, ...rest, ...lazy(kind, decision >= 9 ? 3 : undefined)],
    body: decision => ({ observation: { text: live(decision) }, pace: { elapsedMinutes: decision } }) });
  const phase = await run.settle();
  if (phase !== 'completed') throw new Error(`${phase}: ${vi.mocked(console.warn).mock.calls.map(call => String(call[0]).slice(0, 200)).slice(-4).join(' | ')}`);
  expect(run.violations).toEqual([]);
  const rows = [...new Set(run.bodies.flatMap(stateTexts))].map(line => JSON.parse(line) as Row);
  const sizes = run.bodies.map(body => estimatedAnthropicTokens(renderedRequest(body as never)));
  return { run, rows, sizes, firsts: rows.filter(row => row.stateUpdate === 'full') };
}
const toolNames = (row: Row) => (row.catalog ?? []).map(item => item.name).filter(name => name.startsWith('mc_tool_'));
const ALL_NAMES = Array.from({ length: LAZY_COUNT }, (_, index) => `mc_tool_${index}`);

describe('transient state at production size: a catalog that fits is stated whole, and a change is stated for its tool only', () => {
  it('sends the whole catalog and the skill index verbatim, cuts nothing under 95k, and states the changed tool alone (descriptions in ASCII)', async () => {
    const { run, rows, sizes, firsts } = await production('ascii', () => 'x');
    expect(estimatedAnthropicTokens(run.bodies[0]!.tools)).toBeGreaterThan(20_000);
    expect(Math.max(...sizes)).toBeLessThan(95_000);
    const cuts = events('fca_request_compacted').filter(event => event.transient === true);
    expect(cuts, JSON.stringify(cuts)).toEqual([]);
    expect(events('fca_decision_metrics').filter(line => 'cut' in line)).toEqual([]);
    expect(toolNames(firsts[0]!)).toEqual(ALL_NAMES);
    for (const item of firsts[0]!.catalog!.filter(entry => entry.name.startsWith('mc_tool_'))) expect(item.description).toBe(ORIGINAL('ascii').get(item.name));
    expect(firsts[0]!.skillIndex).toBe(skillIndex);
    expect(firsts[0]!.cappedCatalog).toBeUndefined();
    // The change at decision 9: a state with the one changed entry, not the catalog again.
    const changed = rows.filter(row => row.catalogChanges?.changed?.some(item => item.name === 'mc_tool_3'));
    expect(changed).toHaveLength(1);
    expect(changed[0]!.catalogChanges!.changed).toHaveLength(1);
    expect(changed[0]!.catalogChanges!.changed![0]!.description).toContain('(changed)');
    expect(JSON.stringify(changed[0]).length).toBeLessThan(2_000);
    expect(rows.filter(row => row.stateUpdate === 'changed' && 'catalog' in row)).toEqual([]);
    expect(run.summaries()).toBeLessThanOrEqual(5);
  }, 240_000);

  it('keeps the replay able to take another step when the catalog alone would not fit beside the core (descriptions in Japanese)', async () => {
    // 56,000 Japanese characters are about 62,000 estimated tokens: the request would fit under 95,000, the replay beside a 25k core would not.
    const { run, sizes, firsts } = await production('ja', () => 'x');
    expect(Math.max(...sizes)).toBeLessThan(95_000);
    const compacted = events('fca_request_compacted').filter(event => event.transient === true);
    expect(compacted.length).toBeGreaterThan(0);
    expect(compacted[0]).toMatchObject({ catalog: expect.any(Number), state: null, live: null, over: false, replayRelaxed: false });
    expect(toolNames(firsts[0]!)).toEqual(ALL_NAMES);
    expect(firsts[0]!.skillIndex).toBe(skillIndex);
    expect(Object.keys(firsts[0]!.cappedCatalog ?? {}).length).toBeGreaterThan(0);
    // No summary at every step: an epoch holds several decisions (the first state alone does not fill the replay).
    expect(run.summaries()).toBeLessThanOrEqual(5);
    expect(events('fca_core_tools_stale').filter(event => event.reason === 'state_cut')).toEqual([]);
  }, 240_000);
});

describe('transient state at production size: a live state too big for the request', () => {
  // Decisions 1 to 3 see a 60,000-character observation (about 66,000 tokens beside the 25k core); the rest see a small one.
  const bigThenSmall = (decision: number) => decision <= 3 ? text('ja', 60_000) : 'x';

  it('takes a live spike in the live state itself: the catalog is not cut, nothing is named as cut, and every request stays within 95k (M3)', async () => {
    const { rows, sizes, firsts, run } = await production('ascii', bigThenSmall);
    expect(Math.max(...sizes)).toBeLessThan(95_000);
    const compacted = events('fca_request_compacted').filter(event => event.transient === true);
    expect(compacted.length).toBeGreaterThan(0);
    // The three spike decisions cut the live state's long text and nothing stored: no part, no description, no restatement later.
    for (const event of compacted) {
      expect(event).toMatchObject({ catalog: null, state: null, trim: null, over: false, deferred: false, parts: 0, items: 0 });
      expect(event.live).toEqual(expect.any(Number));
    }
    expect(toolNames(firsts[0]!)).toEqual(ALL_NAMES);
    for (const item of firsts[0]!.catalog!.filter(entry => entry.name.startsWith('mc_tool_'))) expect(item.description).toBe(ORIGINAL('ascii').get(item.name));
    expect(firsts[0]!.skillIndex).toBe(skillIndex);
    for (const row of rows) expect(row.cappedCatalog).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain('長いため後略');
    // No catalog is stated again after the spike: the cache of the first state is read by the later steps.
    expect(rows.filter(row => row.catalogChanges?.changed?.some(item => item.name !== 'mc_tool_3'))).toEqual([]);
    expect(run.summaries()).toBeLessThanOrEqual(5);
  }, 240_000);

  it('names the stage that cut in the metrics of the decision, content-free, and only for the decisions that were cut', async () => {
    await production('ascii', bigThenSmall, 20);
    const lines = events('fca_decision_metrics');
    const cut = lines.filter(line => 'cut' in line) as Array<{ cut: Record<string, unknown> }>;
    expect(cut.length).toBeGreaterThan(0);
    expect(cut[0]!.cut).toMatchObject({ catalog: null, state: null, trim: null, live: expect.any(Number), over: false, replayRelaxed: false, deferred: false, parts: 0, items: 0 });
    expect(Object.keys(cut[0]!.cut).sort()).toEqual(['catalog', 'deferred', 'items', 'live', 'over', 'parts', 'replayRelaxed', 'state', 'trim']);
    expect(lines.length).toBeGreaterThan(cut.length);
    expect(JSON.stringify(cut)).not.toContain('mc_tool');
  }, 240_000);
});
describe('transient state at production size: a cut state is worth a new epoch only if a new epoch could state it whole', () => {
  const task = { id: 't1', title: '原木を集める', goal: '原木を16個集める', completionCriteria: '原木16個を新しい観測で確かめる。' };
  const call = (kind: Kind, history: unknown[], live: string, limit: number | undefined) => transientRequest({ model: 'claude-sonnet-5-5', maximumOutputTokens: 4_000,
    compactAboveTokens: 95_000, systemText: 'instructions', input: { task, messages: [], history: [], tools: [], transient: { observation: { text: live } },
      ...(limit === undefined ? {} : { replayTokenLimit: limit }) } as never,
    supplied: { task, children: [], messages: [], skillIndex, catalog: lazy(kind).map(tool => ({ name: tool.name, description: tool.description })) },
    history: history as never, menu: { tools: [], appended: [] } });
  const filler = (tokens: number) => [{ role: 'assistant', content: [{ type: 'text', text: text('ascii', Math.round(tokens * 2.2)) }] },
    { role: 'user', content: [{ type: 'text', text: 'ok' }] }];
  const afterCut = (kind: Kind, limit: number | undefined, space: number) => {
    // The first request states the catalog beside a history that leaves no room for it: the descriptions are cut and stored so (a live
    // spike alone no longer cuts them, M3). The second request's history is the cut state and its own filler.
    const first = call(kind, filler(84_000), 'x', limit);
    expect(first.built.sent.stages?.catalog).toEqual(expect.any(Number));
    const stored = [...first.turn, { role: 'assistant', content: [{ type: 'text', text: 'a' }] }, { role: 'user', content: [{ type: 'text', text: 'b' }] }];
    return call(kind, [...stored, ...filler(space)], 'x', limit);
  };

  it('asks for the new epoch when the whole state does not fit beside the cut one but would fit alone', () => {
    quiet();
    const second = afterCut('ascii', 52_000, 60_000);
    expect(second.built.sent.stages).toMatchObject({ deferred: true, over: false });
    expect(second.built.sent.cut).toBe(true);
  });

  it('does not ask for it when even a new epoch\'s first state would not fit whole (the cut is inherent)', () => {
    quiet();
    const second = afterCut('ja', 52_000, 20_000);
    expect(second.built.sent.cut).toBe(false);
    // The catalog stays cut so that the replay can take another step; the names are all there.
    expect(second.built.sent.stages?.replayRelaxed).toBe(false);
  });

  it('restates the whole state at once when it fits beside the cut one', () => {
    quiet();
    const second = afterCut('ascii', 52_000, 5_000);
    expect(second.built.sent.stages).toBeUndefined();
    expect(second.built.sent.cut).toBe(false);
    const state = JSON.parse(((second.turn[0]!.content as Array<{ text: string }>)[0]!).text) as Row;
    expect(state.stateUpdate).toBe('changed');
    expect(state.catalogChanges!.changed!.length).toBeGreaterThan(70);
    expect(state.catalogChanges!.changed![0]!.description).toBe(ORIGINAL('ascii').get(state.catalogChanges!.changed![0]!.name));
  });
});