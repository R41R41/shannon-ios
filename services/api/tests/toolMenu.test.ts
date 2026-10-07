import { describe, expect, it } from 'vitest';
import { shannonIdentityPrompt } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/infra/http/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { CONVERSATION_TOOL_CALLS, functionCallsOf, toolInstructions, withToolRounds, type ShannonModelToolSession } from '../src/infra/models/chatModelTools.js';
import { chatTurnRequestBody } from '../src/infra/models/chatModelTurn.js';
import { countedJevFetch } from '../src/infra/models/jev/jevClient.js';
import { JevChoiceClient, JevChooser, type JevChoiceTrace } from '../src/infra/models/jev/jevChoice.js';
import { TEXT_TURN_DEADLINE, TurnDeadline } from '../src/mind/action/respond/turnDeadline.js';
import { TOOL_MENU_LIMIT, chosenTools, toolMenuQuestions } from '../src/mind/selectors/toolMenu.js';
import { JevTurnChooser, type TurnChooser } from '../src/mind/selectors/turnChoices.js';
import { TOOL_OPEN_PROVIDER_NAME, menuCandidatesOf, nothingFound, sourcesLine, toolMenuInstructions, withToolMenu } from '../src/mind/tools/shannonToolMenu.js';
import { conversationTools } from '../src/mind/tools/shannonToolSession.js';
import { createInMemoryAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { turnWroteHerOwnThings } from '../src/mind/tools/shannonToolSession.js';
import { ALWAYS_LOADED_TOOL_NAMES, SHANNON_TOOLS, shannonTool, toolSummary } from '../src/mind/tools/shannonTools.js';
import { withToolCapabilityLines } from '../src/mind/tools/shannonAetherTools.js';

/** Syzygy ADR-0008 stage 2, step 2: Jev's tool menu and `tool_open` (docs/skill-and-routing-contract.md). */
const at = '2026-10-07T03:00:00.000Z';
const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const functionCall = (name: string, args = '{}', id = 'call-1') => ({ type: 'function_call', id: `fc-${id}`, call_id: id, name, arguments: args });
const TURN = JSON.stringify({ reply: 'はい。', threadSummary: null, taskDecision: { disposition: 'none', reason: '雑談' }, taskProposal: null, intentPlan: null, artifacts: null });

function baseSession(names = ['study.list', 'study.read', 'study.create']) {
  const calls: string[] = [];
  const session: ShannonModelToolSession = {
    definitions: names.map(name => shannonTool(name)!), maximumCalls: CONVERSATION_TOOL_CALLS, deadline: new TurnDeadline(TEXT_TURN_DEADLINE),
    async call(name) { calls.push(name); return JSON.stringify({ ok: true, text: 'ok', retryable: false }); },
  };
  return { session, calls };
}

describe('the menu Jev chooses from', () => {
  it('is one choice over the offered tools and none, by provider name and summary only', () => {
    const candidates = menuCandidatesOf(SHANNON_TOOLS.slice(0, 5));
    const questions = toolMenuQuestions(candidates);
    expect(Object.keys(questions)).toEqual(['tool']);
    expect(questions.tool!.type).toBe('choice');
    expect(Object.keys(questions.tool!.criteria)).toEqual([...SHANNON_TOOLS.slice(0, 5).map(tool => tool.name.replace('.', '_')), 'none']);
    expect(Object.values(questions.tool!.criteria).slice(0, 5)).toEqual(SHANNON_TOOLS.slice(0, 5).map(toolSummary));
    // Never a schema or a description.
    expect(JSON.stringify(questions)).not.toContain(SHANNON_TOOLS[0]!.description);
    expect(chosenTools({ tool: { type: 'choice', choice: 'study_read' } }, candidates)).toEqual(['study_read']);
    expect(chosenTools({ tool: { type: 'choice', choice: 'none' } }, candidates)).toEqual([]);
    expect(() => chosenTools({ tool: { type: 'choice', choice: 'folder_delete' } }, candidates)).toThrow('JEV_RESPONSE_INVALID');
    expect(() => chosenTools({}, candidates)).toThrow('JEV_RESPONSE_INVALID');
  });

  it('holds at most 64 entries a menu and groups beyond that, in one call', () => {
    const many = Array.from({ length: 150 }, (_, index) => ({ name: `g${index % 2}_t${index}`, summary: `道具${index}`, group: index < 140 ? `g${index % 2}` : 'small' }));
    const questions = toolMenuQuestions(many);
    expect(Object.keys(questions).length).toBeGreaterThan(1);
    for (const question of Object.values(questions)) expect(Object.keys(question.criteria).length).toBeLessThanOrEqual(TOOL_MENU_LIMIT);
    expect(Object.values(questions).flatMap(question => Object.keys(question.criteria)).filter(key => key !== 'none').sort()).toEqual(many.map(item => item.name).sort());
    const answers = Object.fromEntries(Object.entries(questions).map(([key, question], index) => [key, { choice: index === 1 ? Object.keys(question.criteria)[0] : 'none' }]));
    expect(chosenTools(answers, many)).toHaveLength(1);
    // 63 tools and none still fit one menu.
    expect(Object.keys(toolMenuQuestions(many.slice(0, TOOL_MENU_LIMIT - 1)))).toEqual(['tool']);
  });
});

describe('a session narrowed by the menu', () => {
  it('sends only the chosen schema and tool_open, which opens only offered tools and runs nothing', async () => {
    const { session, calls } = baseSession();
    const menu = withToolMenu(session, ['study_read', 'folder_delete']);
    expect(menu.definitions.map(tool => tool.name)).toEqual(['study.read', 'tool.open']);
    expect(menu.menu!.offered.map(tool => tool.name)).toEqual(['study.list', 'study.read', 'study.create']);
    expect(menu.deadline).toBe(session.deadline);
    expect(Object.keys(menu)).toEqual(['maximumCalls', 'definitions']);
    expect(JSON.parse(menu.meta!(TOOL_OPEN_PROVIDER_NAME, '{"name":"folder_delete"}')!).failure).toBe('not_offered');
    expect(JSON.parse(menu.meta!(TOOL_OPEN_PROVIDER_NAME, 'not json')!).failure).toBe('not_offered');
    expect(menu.meta!('study_list', '{}')).toBeNull();
    // A tool offered but not opened is refused and does not run.
    expect(JSON.parse(await menu.call('study_list', '{}')).ok).toBe(false);
    expect(calls).toEqual([]);
    expect(JSON.parse(menu.meta!(TOOL_OPEN_PROVIDER_NAME, '{"name":"study_list"}')!).ok).toBe(true);
    expect(menu.definitions.map(tool => tool.name)).toEqual(['study.list', 'study.read', 'tool.open']);
    await menu.call('study_list', '{}');
    expect(calls).toEqual(['study_list']);
    // Jev chose none: only tool_open.
    expect(withToolMenu(session, []).definitions.map(tool => tool.name)).toEqual(['tool.open']);
  });

  it('opens a tool between rounds: not counted as a call, and its schema is in the next request', async () => {
    const { session, calls } = baseSession();
    const menu = withToolMenu(session, []);
    const sent: Array<Record<string, unknown>> = [];
    let round = 0;
    const body = chatTurnRequestBody('gpt-5.6-luna', { scopeKey: 'owner', systemPrompt: '', history: [], message: '書斎に何がある？', tools: menu }, undefined);
    await withToolRounds(body, menu, async request => {
      sent.push(request);
      round += 1;
      if (round === 1) return { output: [functionCall(TOOL_OPEN_PROVIDER_NAME, '{"name":"study_list"}')] };
      if (round === 2) return { output: [functionCall('study_list', '{}', 'call-2')] };
      return { output: [message(TURN)] };
    }, { isAnswer: envelope => !functionCallsOf(envelope).length, outOfTime: () => 'out' });
    const names = (request: Record<string, unknown>) => (request.tools as Array<{ name: string }>).map(tool => tool.name);
    expect(names(sent[0]!)).toEqual(['tool_open']);
    expect(names(sent[1]!)).toEqual(['study_list', 'tool_open']);
    expect(calls).toEqual(['study_list']);
    // A text round that asked for parallel calls asks by what is sent now: a write opened turns it off.
    expect(sent[1]!.parallel_tool_calls).toBe(true);
  });

  it('tells the model every offered tool by name and summary, keeps the capability lines of every offered tool, and its writes count', async () => {
    const { session } = baseSession(['study.list', 'aether.search', 'minecraft.request']);
    const menu = withToolMenu(session, []);
    const lines = toolInstructions(menu, false);
    expect(lines).toContain(toolMenuInstructions(session.definitions));
    expect(lines).toContain('- study_list: ');
    // The Aether and Minecraft lines follow what the turn offers, not only the schemas sent.
    expect(lines).toBe(`${toolInstructions(session, false)}\n${toolMenuInstructions(session.definitions)}`);
    const prompt = shannonIdentityPrompt('owner');
    const withLines = withToolCapabilityLines({ systemPrompt: prompt, tools: menu });
    expect(withLines.systemPrompt).toBe(withToolCapabilityLines({ systemPrompt: prompt, tools: session }).systemPrompt);
    expect(withLines.systemPrompt).not.toBe(prompt);
    expect(turnWroteHerOwnThings(menu)).toBe(false);
  });
});

describe('the Jev chooser', () => {
  const trace = () => { const traces: JevChoiceTrace[] = []; return { traces, write: (_scope: string, item: JevChoiceTrace) => { traces.push(item); } }; };

  it('asks once with the menu and traces it without a word of the turn', async () => {
    const bodies: string[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ answers: { tool: { type: 'choice', choice: 'study_read' } } }));
    }) as unknown as typeof fetch;
    const { traces, write } = trace();
    const chooser: TurnChooser = new JevTurnChooser(new JevChooser(new JevChoiceClient({ apiKey: 'jev', fetcher: countedJevFetch(fetcher) }), { trace: write, usdPerCall: null, now: () => at }), { toolMenu: true });
    const candidates = menuCandidatesOf([shannonTool('study.list')!, shannonTool('study.read')!]);
    const result = await chooser.choose({ scopeKey: 'owner', surface: 'text', words: '書斎の「秘密の話」を読んで', menu: candidates });
    expect(result.menu).toEqual({ chosen: ['study_read'] });
    expect(JSON.parse(bodies[0]!)).toMatchObject({ model: 'jev-latest', state: { utterance: '書斎の「秘密の話」を読んで', surface: 'text' } });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ decision: 'tool_menu', surface: 'text', outcome: 'ok', questions: 1, costUsd: null, answers: { tool: 'study_read', offered: 2, groups: 1 } });
    expect(JSON.stringify(traces)).not.toContain('秘密');
    // Nothing to choose from: no call.
    expect(await chooser.choose({ scopeKey: 'owner', surface: 'text', words: 'x', menu: [] })).toEqual({ menu: null });
    expect(bodies).toHaveLength(1);
  });

  it('falls back to every schema when Jev times out, fails or answers off the menu, and says which', async () => {
    const candidates = menuCandidatesOf([shannonTool('study.list')!]);
    for (const [fetcher, outcome] of [
      [async () => { throw new DOMException('slow', 'TimeoutError'); }, 'timeout'],
      [async () => { throw new Error('down'); }, 'error'],
      [async () => new Response(JSON.stringify({ answers: { tool: { choice: 'folder_delete' } } })), 'fallback'],
      [async () => new Response(JSON.stringify({ error: 'x' }), { status: 500 }), 'fallback'],
    ] as const) {
      const { traces, write } = trace();
      const chooser = new JevTurnChooser(new JevChooser(new JevChoiceClient({ apiKey: 'jev', fetcher: countedJevFetch(fetcher as unknown as typeof fetch) }), { trace: write, usdPerCall: 0.001, now: () => at }), { toolMenu: true });
      expect(await chooser.choose({ scopeKey: 'owner', surface: 'voice', words: 'x', menu: candidates })).toEqual({ menu: null });
      expect(traces[0]).toMatchObject({ decision: 'tool_menu', surface: 'voice', outcome, answers: { tool: 'all' }, costUsd: 0.001 });
    }
  });

  it('keeps the voice gateway\'s timeout, endpoint and model', () => {
    const client = new JevChoiceClient({ apiKey: 'jev' });
    expect(client.timeoutMilliseconds).toBe(900);
    expect(client.model).toBe('jev-latest');
    expect(() => new JevChoiceClient({ apiKey: ' ' })).toThrow('TYPESAFE_API_KEY is required');
  });
});

describe('the menu in the kernel', () => {
  class RecordingModel implements ShannonChatModel {
    readonly mode = 'openai' as const;
    readonly model = 'test-model';
    readonly all: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
    async generate(request: ShannonChatModelRequest) { this.all.push(request); return { mode: this.mode, model: this.model, reply: 'はい。' }; }
    async generateVoice(request: ShannonVoiceModelRequest) { this.all.push(request); return { mode: this.mode, model: this.model, reply: 'はい。' }; }
  }
  const voiceBody = (transcript: string) => ({ scopeKey: 'owner', threadId: 'thread', transcript, deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
    userUtterance: { id: `u-${transcript.length}`, text: transcript, source: 'speech', rawText: transcript } } });

  it('narrows a text turn and a voice turn that offer tools, asks only for those, and leaves every other turn alone', async () => {
    const asked: Array<{ surface: string; menu: string[] }> = [];
    const turnChooser: TurnChooser = { choose: async request => { asked.push({ surface: request.surface, menu: request.menu.map(item => item.name) }); return { menu: { chosen: ['study_list'] } }; } };
    const model = new RecordingModel();
    const api = createLocalApiKernel(() => at, { chatModel: model, turnChooser });
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message: '書斎の下書き、どうなってる？' } });
    const text = model.all.at(-1)!;
    expect(text.tools!.definitions.map(tool => tool.name)).toEqual(['study.list', 'tool.open']);
    expect(text.tools!.menu!.offered.length).toBe(9);
    expect(asked.at(-1)).toEqual({ surface: 'text', menu: text.tools!.menu!.offered.map(tool => tool.name.replace('.', '_')) });
    // A forced web search offers no tools: no menu is asked.
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message: '天気を調べて', webSearch: true } });
    expect(asked).toHaveLength(1);
    // Voice: only a turn whose words offer her tools asks, beside the router.
    await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: voiceBody('おはよう、今日は寒いね') });
    expect(asked).toHaveLength(1);
    expect(model.all.at(-1)!.tools).toBeUndefined();
    await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: voiceBody('書斎のメモを読んで') });
    expect(asked.at(-1)!.surface).toBe('voice');
    // The local router gives no reliability score: the offer is reading only, and the menu keeps only what is offered.
    expect(model.all.at(-1)!.tools!.definitions.map(tool => tool.name)).toEqual(['study.list', 'tool.open']);
    expect(model.all.at(-1)!.tools!.menu!.offered.map(tool => tool.name)).toEqual(['study.list', 'study.search', 'study.read']);
  });

  it('sends every schema, as before, when Jev could not choose', async () => {
    const model = new RecordingModel();
    const api = createLocalApiKernel(() => at, { chatModel: model, turnChooser: { choose: async () => ({ menu: null }) } });
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message: '書斎の下書き、どうなってる？' } });
    expect(model.all.at(-1)!.tools!.menu).toBeUndefined();
    expect(model.all.at(-1)!.tools!.definitions.length).toBe(9);
  });
});

describe('the tools the menu never hides, and what a search that found nothing says (Hermes Agent finding)', () => {
  it('always sends the ways to stop and to ask for approval that the turn offers, and invents none that do not exist', () => {
    expect(ALWAYS_LOADED_TOOL_NAMES).toEqual(['minecraft.cancel', 'aether.propose']);
    for (const name of ALWAYS_LOADED_TOOL_NAMES) expect(shannonTool(name), name).not.toBeNull();
    // No registry tool asks the owner, clarifies, speaks or sends.
    expect(SHANNON_TOOLS.some(tool => /^(?:ask|clarify|confirm|speak|send|say|notify|message|reply)$/u.test(tool.name.split('.')[1]!))).toBe(false);
    const { session } = baseSession(['study.list', 'study.create', 'minecraft.request', 'minecraft.cancel', 'aether.propose']);
    expect(withToolMenu(session, []).definitions.map(tool => tool.name)).toEqual(['minecraft.cancel', 'aether.propose', 'tool.open']);
    expect(withToolMenu(session, ['study_list']).definitions.map(tool => tool.name)).toEqual(['study.list', 'minecraft.cancel', 'aether.propose', 'tool.open']);
    // Not offered in the turn (others present, no Minecraft body): not sent either.
    expect(withToolMenu(baseSession(['study.list']).session, []).definitions.map(tool => tool.name)).toEqual(['tool.open']);
  });

  it('names the places the turn can look in when a search or read found nothing, and only then', async () => {
    const offered = ['study.search', 'study.create', 'aether.search', 'aether.read', 'notion.read', 'schedule.upcoming'].map(name => shannonTool(name)!);
    expect(sourcesLine(offered)).toBe('ここで見つからなかっただけで、探せないのではない。この返事で探せるところ: 書斎（study_search）、Aether（aether_search）、Notion（notion_read）、これからの予定（schedule_upcoming）');
    expect(nothingFound({ ok: true, text: '「雨」は見つからなかった。' })).toBe(true);
    expect(nothingFound({ ok: false, text: 'x', failure: 'not_found' })).toBe(true);
    expect(nothingFound({ ok: true, text: 'メモ「雨の日」\n本文に「見つからなかった。」とある' })).toBe(false);
    const kernelTurn = async (sourceHints: boolean) => {
      const runner = { tools: createInMemoryAutonomyService(() => at).tools };
      const server = { audience: { othersKnown: () => false, noteOthers: () => undefined }, secrets: () => ({ carries: () => false }) };
      const offer = conversationTools(runner, 'owner', 'text', true, server, 'thread\n雨のメモある？', new TurnDeadline(TEXT_TURN_DEADLINE), undefined, sourceHints ? { sourceHints: true } : {});
      return JSON.parse(await offer.tools!.call('study_search', JSON.stringify({ query: '雨' }))) as { text: string };
    };
    expect((await kernelTurn(true)).text).toBe('「雨」は見つからなかった。\nここで見つからなかっただけで、探せないのではない。この返事で探せるところ: 書斎（study_list）');
    expect((await kernelTurn(false)).text).toBe('「雨」は見つからなかった。');
  });
});
