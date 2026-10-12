import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionHarness } from './support/actionThreadHarness.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { fcaNowProjection } from '../src/infra/http/fcaNowProjection.js';
import { createFcaTaskRoute } from '../src/infra/http/fcaTaskRoutes.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_HAIKU_MODEL } from '../src/infra/models/anthropic/haikuConfig.js';
import { SpokenReportModel } from '../src/infra/models/spokenReportModel.js';
import { ownerLocalClock } from '../src/infra/time/localDate.js';
import { createAnthropicFcaModel, type AnthropicFcaClient } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { admitConversationWork, admittedWorkContext } from '../src/mind/action/fca/conversationWork.js';
import type { FcaConversationTurn } from '../src/mind/action/fca/fcaConversationPorts.js';
import type { FcaModelOutput } from '../src/mind/action/fca/fcaPorts.js';
import type { TaskSpec, TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { VOICE_NATURAL_INSTRUCTIONS } from '../src/mind/action/respond/respondInstructions.js';
import {
  SPOKEN_REPORT_CHARACTERS, SPOKEN_REPORT_INSTRUCTIONS, createSpokenReports, fallbackSpokenReport, progressWithSpokenReports, reportOnScreenLine,
  spokenReportText,
  type SpokenReportRequest,
} from '../src/mind/action/fca/fcaSpokenReport.js';

/**
 * 2026-10-13, a live call: a finished weather search was not said until the owner asked, its 明日 was counted in UTC, and a
 * 2,900-character research report was read aloud verbatim. These pin what a call now says and when.
 */
const AT = '2026-10-12T17:40:00.000Z'; // 02:40 on 13 October in Tokyo.
const LONG_REPORT = [
  '## 太宰府天満宮の「太宰」の由来', '',
  '- 「太宰（大宰）」は、古代の役所「大宰府」の名に由来します。九州を治め、外交と防衛を担いました。',
  '- 「宰」は「つかさどる」、「大」は大きな、という意味です。',
  '- 地名の表記は「太宰府市」、役所は「大宰府」と書き分けられます。', '',
  '### 未確認', '- 表記が分かれた時期は資料によって異なります（未確認）。', '',
  '出典: https://example.com/dazaifu https://example.org/history',
].join('\n');
const closes: Array<() => unknown> = [];
const task = (id: string, goal: string, origin = 'owner_request') => ({ id, goal, title: '太宰府の由来', origin });
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

const sayable = (text: string) => {
  expect([...text].length).toBeLessThanOrEqual(SPOKEN_REPORT_CHARACTERS);
  expect(text).not.toMatch(/https?:|^#|\n|^[-*・]|出典|\*\*/u);
};

describe('the spoken form of a report', () => {
  it('says the first plain sentences of a long report within the limit, without headings, lists, links or sources', () => {
    const spoken = fallbackSpokenReport(LONG_REPORT);
    sayable(spoken);
    expect(spoken).toContain('大宰府');
  });

  it('names the task instead of saying a bare 「。」 when a report holds only links and headings', () => {
    const spoken = fallbackSpokenReport('## 天気\n### 出典\nhttps://example.com/a\n- https://example.org/b', '明日の福岡と東京の天気');
    expect(spoken).toBe(reportOnScreenLine('明日の福岡と東京の天気'));
    expect(spoken).toContain('明日の福岡と東京の天気');
    sayable(spoken);
    expect(fallbackSpokenReport('https://example.com', '')).toBe('調べた結果は、画面に出しておきましたね。');
  });

  it('keeps a model answer only as plain sentences within the limit', () => {
    expect(spokenReportText('- 明日の福岡は**雨**です。\n[気象庁](https://example.com) によると午後からです。')).toBe('明日の福岡は雨です。気象庁によると午後からです。');
    expect(spokenReportText(`明日は${'とても'.repeat(80)}晴れます。`)).toBeNull();
    expect(spokenReportText('')).toBeNull();
  });

  it('tells the model the delivery rules: short, no boilerplate, no snippet disclaimer, dates from now', () => {
    for (const rule of [`${SPOKEN_REPORT_CHARACTERS}字以内`, '結果がそろいました', '抜粋', '今日・明日', 'URL']) expect(SPOKEN_REPORT_INSTRUCTIONS).toContain(rule);
  });
});

describe('writing the spoken form', () => {
  const report = { id: 'r1', text: LONG_REPORT, updatedAt: AT };
  const progress = { currentStep: 'task.send', status: 'received' as const, startedAt: AT, updatedAt: AT, findings: [], report };
  function service(speak: (request: SpokenReportRequest) => Promise<string>) {
    const recorded: Array<[string, string]> = [], requests: SpokenReportRequest[] = [];
    const reports = createSpokenReports({ localTime: () => ownerLocalClock(AT, 'Asia/Tokyo'),
      speaker: { speak: async request => { requests.push(request); return speak(request); } },
      record: (_scope, _task, id, spoken) => { recorded.push([id, spoken]); return true; } });
    closes.push(() => reports.close());
    return { reports, recorded, requests };
  }

  it('asks the model once per report, with the request, the full report and the owner\'s clock, and writes its sentences', async () => {
    const s = service(async () => '「太宰」は、昔九州を治めた役所の大宰府から来ているそうです。');
    s.reports.request('owner', task('t1', '太宰府天満宮の太宰の由来を調べて'), progress);
    s.reports.request('owner', task('t1', '太宰府天満宮の太宰の由来を調べて'), progress);
    await s.reports.idle();
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]).toMatchObject({ request: '太宰府天満宮の太宰の由来を調べて', report: LONG_REPORT, localTime: '2026年10月13日火曜日 2:40' });
    expect(s.recorded).toEqual([['r1', '「太宰」は、昔九州を治めた役所の大宰府から来ているそうです。']]);
  });

  it.each([
    ['fails', async () => { throw new Error('upstream'); }],
    ['answers too long', async () => `${'長い'.repeat(100)}です。`],
  ])('speaks a plain cut of the report when the model %s', async (_name, speak) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = service(speak);
    s.reports.request('owner', task('t1', 'goal'), progress);
    await s.reports.idle();
    expect(s.recorded).toHaveLength(1);
    sayable(s.recorded[0]![1]);
  });

  it('makes spoken forms only for work the owner asked for, one per task and report', async () => {
    const s = service(async () => '短い形です。');
    s.reports.request('owner', task('t4', 'goal', 'maintenance'), progress);
    s.reports.request('owner', task('t5', 'goal'), progress);
    s.reports.request('owner', task('t6', 'goal'), progress);
    await s.reports.idle();
    expect(s.requests).toHaveLength(2);
    expect(s.recorded).toEqual([['r1', '短い形です。'], ['r1', '短い形です。']]);
  });

  it('generates and writes nothing while anyone else may see or hear', async () => {
    const s = service(async () => '短い形です。');
    let alone = false, read = 0;
    const runtime = { get: () => ({ ...task('t7', 'goal'), kind: 'research' }) } as never;
    const shown = progressWithSpokenReports(runtime, 'owner', () => { read++; return progress; }, s.reports, () => alone);
    shown('t7');
    await s.reports.idle();
    expect(s.requests).toEqual([]); expect(s.recorded).toEqual([]);
    const view = { ...task('t7', 'goal'), kind: 'research', phase: 'completed', parentId: null, summary: '', revision: 1, updatedAt: AT };
    const listed = { list: () => [view], taskSources: () => [] } as never;
    let checks = 0; // The audience changes between the route's first check and its read: the read is asked again first.
    const route = createFcaTaskRoute({ runtime: listed, ownerScope: 'owner', ownerAlone: () => checks++ === 0, visible: () => true,
      progress: shown, spokenReports: true, stop: async () => {}, wake: () => {} });
    const statuses: number[] = [];
    const response = { setHeader() {}, writeHead(status: number) { statuses.push(status); }, end() {} } as unknown as ServerResponse;
    await route({ method: 'GET' } as IncomingMessage, response, { scopeKey: 'owner' }, new URL('http://localhost/v1/fca/tasks?projection=now'));
    expect(statuses).toEqual([403]); expect(read).toBe(1);
    alone = true; shown('t7'); await s.reports.idle();
    expect(s.recorded).toEqual([['r1', '短い形です。']]);
  });

  it('says a short report as it is, without a model call, and never rewrites one already spoken', async () => {
    const s = service(async () => 'unused');
    const short = { ...progress, report: { id: 'r2', text: '天気の調べものは、結果を確認できないまま止まりました。', updatedAt: AT } };
    s.reports.request('owner', task('t2', 'goal'), short);
    s.reports.request('owner', task('t3', 'goal'), { ...progress, report: { ...report, id: 'r3', spoken: 'もう言える。' } });
    await s.reports.idle();
    expect(s.requests).toEqual([]);
    expect(s.recorded).toEqual([['r2', '天気の調べものは、結果を確認できないまま止まりました。']]);
  });
});

/** A research child on the real runtime whose model is scripted: a report it sends, then its completion. */
function runtimeFixture(decisions: (parent: string) => FcaModelOutput['decision'][]) {
  const h = actionHarness(() => AT); closes.push(h.close);
  let parent = '', index = 0;
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', now: () => AT, ownerAlone: () => true,
    canRunTask: () => true, stepPorts: () => ({}),
    model: { async decide(input) {
      const decision = input.task.title === '天気' ? decisions(parent)[index++]! : { kind: 'wait' as const, summary: 'waiting' };
      return { decision, history: [{ role: 'assistant', content: 'native' }] };
    },
      toolResults: results => ({ role: 'user', results }) } });
  closes.push(() => driver.close());
  const root = driver.runtime.ensureRoot('owner'); parent = root.id;
  const child = driver.runtime.createChild('owner', root.id, { title: '天気', goal: '明日の福岡と東京の天気は？', completionCriteria: '予報を返す',
    kind: 'research', origin: 'owner_request' } as TaskSpec, 'request-weather');
  const run = async () => { for (let i = 0; i < 4; i++) { await driver.tick(); await driver.drain(); } };
  return { driver, child, run };
}

describe('a finished result reaches the call', () => {
  it('makes the completion summary the report when the work told its parent nothing, and a call gets its spoken form', async () => {
    const summary = '10月14日（水）の福岡は午後から雨、東京は晴れて最高25度の予報です。';
    const f = runtimeFixture(() => [{ kind: 'complete', summary }]);
    await f.run();
    expect(f.driver.runtime.get('owner', f.child.id)?.phase).toBe('completed');
    const report = f.driver.runtime.progress?.('owner', f.child.id)?.report;
    expect(report).toMatchObject({ id: expect.stringMatching(/^result:/u), text: summary });
    const reports = createSpokenReports({ speaker: null, localTime: () => '', record: (scope, id, reportId, text) => f.driver.runtime.recordSpokenReport!(scope, id, reportId, text) });
    const progress = progressWithSpokenReports(f.driver.runtime, 'owner', id => f.driver.runtime.progress?.('owner', id) ?? null, reports, () => true);
    // Read "now" at the test's own clock: finished work leaves the view an hour after it ends.
    const testNow = () => Date.parse(AT);
    fcaNowProjection(f.driver.runtime, 'owner', () => true, progress, testNow);
    const shown = fcaNowProjection(f.driver.runtime, 'owner', () => true, progress, testNow).tasks.find(task => task.id === f.child.id);
    expect(shown?.report).toMatchObject({ text: summary, spoken: summary });
  });

  it('keeps the report the work sent; its completion summary does not replace it or speak twice', async () => {
    const f = runtimeFixture(parent => [
      { kind: 'tools', calls: [{ id: 'send', name: 'task.send', input: { id: parent, message: LONG_REPORT } }] },
      { kind: 'complete', summary: '報告済み' }]);
    await f.run();
    expect(f.driver.runtime.get('owner', f.child.id)?.phase).toBe('completed');
    const report = f.driver.runtime.progress?.('owner', f.child.id)?.report;
    expect(report?.text).toBe(LONG_REPORT);
    expect(f.driver.runtime.recordSpokenReport!('owner', f.child.id, report!.id, '短い形です。')).toBe(true);
    expect(f.driver.runtime.recordSpokenReport!('owner', f.child.id, report!.id, '二度目です。')).toBe(false);
    expect(f.driver.runtime.recordSpokenReport!('owner', f.child.id, 'older-report', '古い報告です。')).toBe(false);
    expect(f.driver.runtime.progress?.('owner', f.child.id)?.report).toMatchObject({ text: LONG_REPORT, spoken: '短い形です。' });
  });
});

describe('the owner\'s clock in research', () => {
  it('gives the child the time the owner asked, on his clock and in his zone, and the rule to count 明日 on it', () => {
    let spec: TaskSpec | undefined;
    const turn = { delegate: (value: TaskSpec) => { spec = value; return { id: 'child' } as TaskView; } } as unknown as FcaConversationTurn;
    admitConversationWork(turn, { message: '明日の福岡と東京の天気は？', research: true, at: AT, timeZone: 'Asia/Tokyo' });
    const context = JSON.parse(spec!.context!.split('\n')[1]!);
    expect(context).toMatchObject({ originalRequest: '明日の福岡と東京の天気は？', requestedAt: '2026年10月13日火曜日 2:40', timeZone: 'Asia/Tokyo' });
    expect(spec!.context).toContain('never UTC');
  });

  it('puts the owner\'s clock in each research decision', async () => {
    const bodies: Array<{ messages: Array<{ content: unknown }> }> = [];
    const client: AnthropicFcaClient = { messages: { create: async body => { bodies.push(body as never); return {
      id: 'm', type: 'message', role: 'assistant', model: DEFAULT_HAIKU_MODEL, stop_reason: 'tool_use', stop_sequence: null,
      content: [{ type: 'tool_use', id: 'done', name: 'fca_complete', input: { summary: '完了' } }],
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 600, cache_read_input_tokens: 0 } } as never; } } };
    const model = createAnthropicFcaModel({ client, recordUsage: () => {}, clock: () => ({ localTime: ownerLocalClock(AT, 'Asia/Tokyo'), timeZone: 'Asia/Tokyo' }) });
    const task = { id: 'child', title: '天気', goal: '明日の福岡の天気', completionCriteria: '予報' };
    await model.decide({ task, messages: [], history: [], tools: [] } as never, new AbortController().signal);
    const current = JSON.parse(String(bodies[0]!.messages.at(-1)!.content));
    expect(current.ownerClock).toMatchObject({ localTime: '2026年10月13日火曜日 2:40', timeZone: 'Asia/Tokyo' });
    expect(current.ownerClock.rule).toContain('never in UTC');
  });
});

describe('natural words in a call', () => {
  it('acknowledges delegated research briefly, without a guess, a promise or status boilerplate', () => {
    const context = admittedWorkContext({ id: 'child', phase: 'ready', goal: '太宰府天満宮の太宰の由来を調べて' } as TaskView);
    expect(context).toContain('one short, natural acknowledgement');
    expect(context).toContain('Do not guess or pre-answer');
    expect(context).not.toContain('answer anything already known');
    for (const phrase of ['受け付けました', '結果がそろったら', '少しお待ちください']) expect(context).toContain(phrase);
  });

  it('tells a spoken reply to drop status boilerplate and the habitual snippet disclaimer, and to answer a reaction as one', () => {
    for (const phrase of ['結果がそろいました', '抜粋', '相づち']) expect(VOICE_NATURAL_INSTRUCTIONS).toContain(phrase);
  });

  it('sends the spoken form through the regular Haiku model with her persona and the delivery rules', async () => {
    const bodies: Array<Record<string, any>> = [];
    const fetcher: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: DEFAULT_HAIKU_MODEL, stop_reason: 'end_turn',
        stop_sequence: null, content: [{ type: 'text', text: '明日の福岡は雨みたいです。' }],
        usage: { input_tokens: 40, output_tokens: 20, cache_creation_input_tokens: 600, cache_read_input_tokens: 0 } }), { headers: { 'content-type': 'application/json' } });
    };
    const said = await new SpokenReportModel({ apiKey: 'synthetic', fetcher }).speak({ scopeKey: 'owner', request: '明日の天気', report: LONG_REPORT,
      localTime: '2026年10月13日火曜日 2:40', signal: new AbortController().signal });
    expect(said).toBe('明日の福岡は雨みたいです。');
    const system = JSON.stringify(bodies[0]!.system);
    expect(system).toContain('ボク'); expect(system).toContain('[調べた結果を声で伝える]');
    expect(JSON.stringify(bodies[0]!.messages)).toContain('2026年10月13日火曜日 2:40');
  });
});
