import { describe, expect, it } from 'vitest';
import type { ObserverDraft } from '../src/contracts/observerContract.js';
import { installObserverSink, withObserverRun } from '../src/infra/observer/observerContext.js';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { responseModelFetcher } from '../src/infra/models/anthropic/haikuResponses.js';
import { JevChoiceClient, JevChooser } from '../src/infra/models/jev/jevChoice.js';
import { JevTurnChooser } from '../src/mind/selectors/turnChoices.js';
import { createConfiguredVoiceDecisionGateway } from '../src/mind/selectors/voiceDecision.js';
import { TurnDeadline, TEXT_TURN_DEADLINE } from '../src/mind/action/respond/turnDeadline.js';
import { shannonTool } from '../src/mind/tools/shannonTools.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import { wasWithheld } from '../src/mind/tools/shannonToolRunner.js';
import { ShannonAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { anthropicFixture, message, scriptedAnthropic, type AnthropicMessage } from './support/anthropicFixtures.js';

const settings = { model: 'claude-haiku-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' } as const;
const base = { scopeKey: 'owner', systemPrompt: 'PRIVATE_SYSTEM', profilePrompt: 'PRIVATE_RECALL', history: [], message: 'こんにちは', turnContext: 'PRIVATE_CONTEXT' };
const paid = (value: AnthropicMessage): AnthropicMessage => ({ ...value, model: settings.model,
  usage: { ...value.usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 900, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } });
async function observed<T>(work: () => Promise<T>) {
  const events: ObserverDraft[] = [];
  const restore = installObserverSink(event => { events.push(event); });
  try { return { value: await withObserverRun({ scopeKey: 'owner', surface: 'text' }, work), events }; }
  finally { restore(); }
}
const completed = (events: ObserverDraft[], node: string) => events.filter(event => event.node === node && event.kind === 'span.completed');

describe('real provider and tool observation', () => {
  it.each([false, true])('keeps every native request unchanged and observes each actual provider round (stream=%s)', async streaming => {
    const fixture = paid(anthropicFixture('tool-call'));
    fixture.content.unshift({ type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' });
    const script = [fixture, paid(anthropicFixture('structured-answer'))];
    const run = async () => {
      const transport = scriptedAnthropic(script);
      const model = new AnthropicChatModel({ apiKey: 'PRIVATE_API_KEY', settings, fetch: transport.fetcher });
      let calls = 0;
      const request = { ...base, tools: { definitions: [shannonTool('study.list')!], maximumCalls: 3,
        deadline: new TurnDeadline(TEXT_TURN_DEADLINE), call: async () => { calls++; return JSON.stringify({ ok: true, text: 'PRIVATE_UNSHOWN_STORY', retryable: false }); } } };
      const reply = streaming ? await model.generateStreaming(request, () => {}) : await model.generate(request);
      return { bodies: transport.bodies, calls, reply };
    };
    const off = await run();
    const on = await observed(run);
    expect(on.value.bodies).toEqual(off.bodies);
    expect(on.value.calls).toBe(1);
    expect(on.value.reply).toEqual(off.reply);
    expect(completed(on.events, 'llm')).toHaveLength(2);
    expect(on.events.filter(event => event.node === 'llm' && event.kind === 'span.started').map(event => event.input)).toMatchObject([
      { round: 0, offeredTools: ['tool_open', 'study.list'] }, { round: 1, offeredTools: ['tool_open', 'study.list'] },
    ]);
    expect(completed(on.events, 'llm')[0]).toMatchObject({ model: settings.model, output: { selectedTools: ['study.list'], usage: { cacheReadTokens: 900 } } });
    expect(completed(on.events, 'decode')[0]?.output).toEqual({ reply: off.reply.reply });
    const serialized = JSON.stringify(on.events);
    for (const secret of ['PRIVATE_SYSTEM', 'PRIVATE_RECALL', 'PRIVATE_CONTEXT', 'PRIVATE_THINKING', 'PRIVATE_SIGNATURE', 'PRIVATE_API_KEY', 'PRIVATE_UNSHOWN_STORY']) expect(serialized).not.toContain(secret);
  });

  it('observes a Jev cache hit as a decision without inventing another network call', async () => {
    const bodies: string[] = [];
    const client = new JevChoiceClient({ apiKey: 'PRIVATE_API_KEY', model: 'jev-test', fetcher: (async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ answers: { tool: { choice: 'study_list' } } }));
    }) as typeof fetch });
    const chooser = new JevTurnChooser(new JevChooser(client, { usdPerCall: null }), { toolMenu: true });
    const request = { scopeKey: 'owner', surface: 'text' as const, words: 'PRIVATE_UTTERANCE', menu: [{ name: 'study_list', group: 'study', summary: 'PRIVATE_SUMMARY' }] };
    const run = await observed(async () => [await chooser.choose(request), await chooser.choose(request)]);
    expect(run.value[0]).toEqual(run.value[1]);
    expect(bodies).toHaveLength(1);
    expect(completed(run.events, 'llm')).toHaveLength(1);
    expect(completed(run.events, 'jevt').map(event => event.output)).toMatchObject([
      { cached: false, model: 'jev-test', selectedTools: ['study.list'] }, { cached: true, model: 'jev-test', selectedTools: ['study.list'] },
    ]);
    expect(JSON.stringify(run.events)).not.toMatch(/PRIVATE_/u);
  });

  it('keeps the exact thrown provider error and invokes it once even when observation fails', async () => {
    const failure = new Error('PRIVATE_PROVIDER_ERROR');
    let calls = 0;
    const client = new JevChoiceClient({ apiKey: 'test-only', fetcher: (async () => { calls++; throw failure; }) as typeof fetch });
    const restore = installObserverSink(() => { throw new Error('sink unavailable'); });
    try {
      await expect(withObserverRun({ scopeKey: 'owner', surface: 'text' }, () => client.ask({}, {}))).rejects.toBe(failure);
      expect(calls).toBe(1);
    } finally { restore(); }
  });

  it('does not serialize background extraction text through the native Responses adapter', async () => {
    const transport = scriptedAnthropic([paid(message([{ type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' },
      { type: 'text', text: '{"memory":"PRIVATE_EXTRACTED_MEMORY"}' }], 'end_turn'))]);
    const fetcher = responseModelFetcher({ model: settings.model, apiKey: 'PRIVATE_API_KEY', fetcher: transport.fetcher });
    const run = await observed(async () => (await fetcher('https://unused.example', { method: 'POST', body: JSON.stringify({
      model: settings.model, input: 'PRIVATE_MEMORY_INPUT', instructions: 'PRIVATE_SYSTEM', max_output_tokens: 100,
    }) })).json());
    expect(run.value).toMatchObject({ output_text: '{"memory":"PRIVATE_EXTRACTED_MEMORY"}' });
    expect(transport.bodies).toHaveLength(1);
    expect(completed(run.events, 'native')).toHaveLength(1);
    expect(completed(run.events, 'llm')).toHaveLength(1);
    expect(JSON.stringify(run.events)).not.toMatch(/PRIVATE_/u);
  });

  it('observes configured voice decisions as closed output without treating a local fallback as network', async () => {
    const gateway = createConfiguredVoiceDecisionGateway({});
    const run = await observed(() => gateway.decide({ scopeKey: 'owner', transcript: 'PRIVATE_VOICE', participantMode: 'owner', requestedLocation: false, hasFreshLocation: false }));
    expect(completed(run.events, 'jevv')).toHaveLength(1);
    expect(completed(run.events, 'llm')).toHaveLength(0);
    expect(completed(run.events, 'jevv')[0]?.output).toMatchObject({ shouldRespond: run.value.shouldRespond, selectedSkills: run.value.selectedSkills });
    expect(JSON.stringify(run.events)).not.toContain('PRIVATE_VOICE');
  });

  it('retains gate refusals and WeakSet identity without executing, and keeps study text out of events', async () => {
    const store = new SQLiteAutonomyStore(':memory:');
    const service = new ShannonAutonomyService({ store, config: configuredAutonomy({}), now: () => '2026-10-08T00:00:00.000Z' });
    const owner = { scopeKey: 'owner', surface: 'text' as const, audience: 'owner_alone' as const, memory: toolSessionMemory() };
    try {
      const refused = await observed(() => service.tools.call('study.create', JSON.stringify({ kind: 'note', title: 'PRIVATE_TITLE', body: 'PRIVATE_DRAFT' }), { ...owner, audience: 'others' }));
      expect(refused.value.ok).toBe(false);
      expect(wasWithheld(refused.value)).toBe(true);
      expect(completed(refused.events, 'gate')[0]?.output).toMatchObject({ name: 'study.create', ok: false, withheld: true, status: 'not_run' });
      expect(completed(refused.events, 'tools')).toHaveLength(0);
      const allowed = await observed(() => service.tools.call('study.create', JSON.stringify({ kind: 'note', title: 'PRIVATE_TITLE', body: 'PRIVATE_DRAFT' }), owner));
      expect(allowed.value.ok).toBe(true);
      expect(completed(allowed.events, 'tools').map(event => event.output)).toMatchObject([
        { name: 'study.create', ok: true, status: 'awaiting_commit' }, { name: 'study.create', ok: true, status: 'committed' },
      ]);
      expect(JSON.stringify([...refused.events, ...allowed.events])).not.toMatch(/PRIVATE_/u);
    } finally { store.close(); }
  });
});
