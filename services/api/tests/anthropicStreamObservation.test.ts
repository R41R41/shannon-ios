import { describe, expect, it } from 'vitest';
import type { ObserverDraft } from '../src/contracts/observerContract.js';
import { installObserverSink, withObserverRun } from '../src/infra/observer/observerContext.js';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { withToolMenu } from '../src/mind/tools/shannonToolMenu.js';
import { shannonTool } from '../src/mind/tools/shannonTools.js';
import { TurnDeadline, TEXT_TURN_DEADLINE } from '../src/mind/action/respond/turnDeadline.js';
import { anthropicFixture, message, scriptedAnthropic } from './support/anthropicFixtures.js';

const request = { scopeKey: 'owner', systemPrompt: 'private-identity', profilePrompt: 'private-profile',
  history: [{ role: 'user' as const, content: 'private-history' }], message: 'private-current-message',
  useWebSearch: false, conversationClass: 'skill_simple' as const };
type Output = { firstVisibleOutputAfterMs?: number; finalUsageAfterMs?: number; usage?: unknown };

describe('native stream timing evidence', () => {
  it.each(['text', 'voice'] as const)('measures visible %s handoff separately per request; tools and thinking are not visible output', async lane => {
    const events: ObserverDraft[] = [];
    const restore = installObserverSink(event => { events.push(event); });
    const signed = message([{ type: 'thinking', thinking: 'private-thinking', signature: 'private-signature' },
      { type: 'tool_use', id: 'tool-1', name: 'study_list', input: {} }], 'tool_use');
    const final = lane === 'text' ? anthropicFixture('structured-answer') : message([{ type: 'text', text: '確認しました。' }], 'end_turn');
    const fixture = scriptedAnthropic([signed, final]);
    let clock = 0;
    const model = new AnthropicChatModel({ apiKey: 'synthetic', fetch: fixture.fetcher, clock: () => { clock += 5; return clock; },
      settings: { model: 'claude-haiku-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' } });
    const tools = withToolMenu({ definitions: [shannonTool('study.list')!], maximumCalls: 3,
      deadline: new TurnDeadline(TEXT_TURN_DEADLINE), call: async () => '{"ok":true,"text":"private-tool-result"}' }, ['study_list']);
    const heard: string[] = [];
    try {
      await withObserverRun({ scopeKey: 'owner', surface: lane, runId: `timing-${lane}` }, () => lane === 'text'
        ? model.generateStreaming({ ...request, tools }, text => { heard.push(text); })
        : model.generateVoiceStreaming({ ...request, tools }, text => { heard.push(text); }));
      expect(heard.join('')).toBeTruthy();
      const rounds = events.filter(event => event.node === 'llm' && event.kind === 'span.completed').map(event => event.output as Output);
      expect(rounds).toHaveLength(2);
      expect(rounds[0]!.firstVisibleOutputAfterMs).toBeUndefined();
      expect(rounds[0]!.finalUsageAfterMs).toBeGreaterThan(0);
      expect(rounds[1]!.firstVisibleOutputAfterMs).toBeGreaterThan(0);
      expect(rounds[1]!.finalUsageAfterMs).toBeGreaterThan(rounds[1]!.firstVisibleOutputAfterMs!);
      expect(rounds.every(round => round.usage)).toBe(true);
      const native = events.find(event => event.node === 'native' && event.kind === 'span.completed');
      expect(native?.output).toMatchObject({ offeredTools: ['tool_open', 'study.list'] });
      const safe = JSON.stringify(events);
      for (const value of ['private-identity', 'private-profile', 'private-history', 'private-current-message', 'private-thinking', 'private-signature', 'private-tool-result']) {
        expect(safe).not.toContain(value);
      }
    } finally { restore(); }
  });

  it('does not invent streaming timing for a nonstreamed response', async () => {
    const events: ObserverDraft[] = [];
    const restore = installObserverSink(event => { events.push(event); });
    const fixture = scriptedAnthropic([anthropicFixture('structured-answer')]);
    const model = new AnthropicChatModel({ apiKey: 'synthetic', fetch: fixture.fetcher,
      settings: { model: 'claude-haiku-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' } });
    try {
      await withObserverRun({ scopeKey: 'owner', surface: 'text' }, () => model.generate(request));
      const result = events.find(event => event.node === 'llm' && event.kind === 'span.completed')!.output as Output;
      expect(result.firstVisibleOutputAfterMs).toBeUndefined();
      expect(result.finalUsageAfterMs).toBeUndefined();
      expect(result.usage).toBeTruthy();
    } finally { restore(); }
  });
});


it.each(['text','voice'] as const)('includes %s callback backpressure in visible handoff timing', async lane => {
  const events:ObserverDraft[]=[],restore=installObserverSink(event=>events.push(event));
  let clock=0;
  const final=lane==='text'?anthropicFixture('structured-answer'):message([{type:'text',text:'確認しました。'}],'end_turn');
  const fixture=scriptedAnthropic([final]);
  const model=new AnthropicChatModel({apiKey:'synthetic',fetch:fixture.fetcher,clock:()=>clock,
    settings:{model:'claude-haiku-5-5',effort:'low',textThinking:'adaptive',voiceThinking:'adaptive'}});
  const accepted=async()=>{await Promise.resolve();clock=125;};
  try {
    await withObserverRun({scopeKey:'owner',surface:lane},()=>lane==='text'?model.generateStreaming(request,accepted):model.generateVoiceStreaming(request,accepted));
    const output=events.find(event=>event.node==='llm'&&event.kind==='span.completed')!.output as Output;
    expect(output.firstVisibleOutputAfterMs).toBe(125);
    expect(output.finalUsageAfterMs).toBeGreaterThanOrEqual(125);
  } finally {restore();}
});
