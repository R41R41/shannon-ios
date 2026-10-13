import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChecks } from '../evals/daily/graders/checks.js';
import { runBudgets } from '../evals/daily/graders/budgets.js';
import { researchAtTurn } from '../evals/daily/graders/judge.js';
import { emptyFixtureLog, fixturePlaceSearch } from '../evals/daily/harness/fixtures.js';
import type { TrialObservation } from '../evals/daily/harness/trial.js';
import { installEvalClock, localOf, uninstallEvalClock } from '../evals/daily/harness/clock.js';
import { runTrial } from '../evals/daily/harness/trial.js';
import { ALL_TASKS, DROPPED_TASKS } from '../evals/daily/tasks/index.js';
import { taskProblems, validateTasks } from '../evals/daily/validate.js';
import type { DailyEvalTask } from '../evals/daily/types.js';
import type { ShannonChatModel } from '../src/infra/models/chatModel.js';

// The CI-safe half of the daily evals (`evals/daily/README.md`): definitions only, and the harness's plumbing over the local
// stub model. No paid API is called here; the live run is `SHANNON_EVALS_LIVE=1 ... run.ts`.
const here = dirname(fileURLToPath(import.meta.url));
const savedEnvironment = { ...process.env };
afterEach(() => {
  uninstallEvalClock();
  for (const name of Object.keys(process.env)) if (!(name in savedEnvironment)) delete process.env[name];
  Object.assign(process.env, savedEnvironment);
});

describe('daily eval definitions', () => {
  it('are valid, unique and all registered', () => {
    expect(Object.fromEntries(validateTasks(ALL_TASKS))).toEqual({});
    const files = readdirSync(join(here, '../evals/daily/tasks/regression')).filter(name => name.endsWith('.ts')).map(name => name.replace(/\.ts$/u, ''));
    expect(files.sort()).toEqual(ALL_TASKS.filter(task => task.set === 'regression').map(task => task.id).sort());
    expect(ALL_TASKS.some(task => DROPPED_TASKS[task.id])).toBe(false);
  });

  it('refuses fixtures that look like real data and malformed checks', () => {
    const task = ALL_TASKS.find(item => item.id === 'R1')!;
    const leaked: DailyEvalTask = { ...task, initial: { ...task.initial, web: [{ match: '.', text: 'mail a.person@mail.test', sources: [{ title: 'x', url: 'https://news.test/x' }] }] },
      checks: [{ kind: 'replyMatches', pattern: '(' }, { kind: 'researchTasks', min: 1 }], settleSeconds: 0 };
    const problems = taskProblems(leaked).join('\n');
    expect(problems).toMatch(/e-mail/u);
    expect(problems).toMatch(/URL outside/u);
    expect(problems).toMatch(/invalid pattern/u);
    expect(problems).toMatch(/settleSeconds/u);
  });

  it('the eval clock reads the task clock and runs on', () => {
    installEvalClock();
    const before = Date.now();
    expect(localOf(Date.now())).toBe(localOf(before));
    expect(new Date(0).toISOString()).toBe('1970-01-01T00:00:00.000Z');
    expect(new Date() instanceof Date).toBe(true);
  });
});

describe('daily eval harness plumbing (local stub model, no network)', () => {
  it('runs a voice and a text trial through the real turn paths into the graders', async () => {
    installEvalClock();
    for (const id of ['D2', 'M3']) {
      const task = ALL_TASKS.find(item => item.id === id)!;
      const observation = await runTrial(task, 0, { live: false, simulator: null });
      expect(observation.error, observation.harnessLog.join('\n')).toBeUndefined();
      expect(observation.turns).toHaveLength(task.turns.length);
      for (const turn of observation.turns) {
        expect(turn.status, turn.error).toBe(200);
        expect(turn.reply.length).toBeGreaterThan(0);
        expect(turn.firstAudioMs).not.toBeNull();
      }
      expect(observation.fcaComposed).toBe(false);
      // The seeded calendar reached the fake device; nothing changed it.
      if (id === 'D2') expect(runChecks(task, observation).find(check => check.kind === 'calendarSeedUnchanged')?.passed).toBe(true);
      expect(runBudgets(task, observation).find(budget => budget.name === 'costYen')?.observed).toBe(0);
    }
  }, 60_000);

  it('composes the common FCA in this process and offers the production tools (no socket; the network is refused)', async () => {
    installEvalClock();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new TypeError('network refused in this test'); }) as typeof fetch;
    process.env.SHANNON_HAIKU_API_KEY = 'sk-ant-test-not-a-key';
    const offered: string[][] = [];
    const reply = { mode: 'local-stub' as const, model: 'scripted', reply: '11月28日と12月5日です。' };
    const model: ShannonChatModel = { mode: 'local-stub', model: 'scripted',
      generate: async request => { offered.push(request.tools?.definitions.map(tool => tool.name) ?? []); return reply; },
      generateStreaming: async (request, onText) => { offered.push(request.tools?.definitions.map(tool => tool.name) ?? []); await onText(reply.reply); return reply; } };
    try {
      const task = ALL_TASKS.find(item => item.id === 'M4')!;
      const observation = await runTrial(task, 0, { live: true, simulator: null, model });
      expect(observation.error, observation.harnessLog.join('\n')).toBeUndefined();
      expect(observation.fcaComposed).toBe(true);
      expect(observation.turns[0]?.status).toBe(200);
      expect(offered[0]).toEqual(expect.arrayContaining(['web.search', 'task.create', 'voyager.tasks', 'weather.forecast', 'reminder.create', 'calendar.create_event']));
      expect(runChecks(task, observation).filter(check => !check.passed).map(check => check.kind)).toEqual([]);
    } finally { globalThis.fetch = realFetch; }
  }, 60_000);
});

describe('the judge reads research as it stood at each turn', () => {
  it('says running for a research that finished after the question, and done for one that finished before', () => {
    const research = (completedMs: number | null) => ({ id: 'r', title: '博多駅から太宰府までの行き方', kind: 'research', turn: 0, seenMs: 400,
      completedMs, failedMs: null, phase: 'completed', summary: '' });
    const observation = (completedMs: number | null) => ({ turnStartsMs: [0, 35_000], research: [research(completedMs)] }) as unknown as TrialObservation;
    expect(researchAtTurn(observation(45_000), 1)).toEqual(['（その時点の調べもの: 「博多駅から太宰府までの行き方」実行中（10秒後に完了））']);
    expect(researchAtTurn(observation(20_000), 1)).toEqual(['（その時点の調べもの: 「博多駅から太宰府までの行き方」完了）']);
    expect(researchAtTurn(observation(20_000), 0)).toEqual([]);
  });
});

describe('place searches in a trial', () => {
  it('answer from the task\'s placeResults, never the model; every other request reaches the model', async () => {
    const asked: string[] = [];
    const model = { mode: 'local-stub', model: 'stub', async generate(request: { message: string }) { asked.push(request.message); return { mode: 'local-stub', model: 'stub', reply: 'はい。' }; } } as unknown as ShannonChatModel;
    const log = emptyFixtureLog();
    const wrapped = fixturePlaceSearch(model, { clock: '2026-11-21T18:10', home: null, location: null,
      placeResults: [{ match: 'ラーメン', name: '店A', address: '福岡市（架空）', reason: '近い', mapQuery: 'ラーメン 博多' }] } as never, log);
    const found = await wrapped.generate({ scopeKey: 'owner', systemPrompt: '', history: [], message: '博多駅の近くのラーメン屋', placeSearch: { spoken: true } } as never);
    expect(found.places).toEqual([expect.objectContaining({ name: '店A', mapUrl: 'https://maps.apple.com/?q=%E3%83%A9%E3%83%BC%E3%83%A1%E3%83%B3%20%E5%8D%9A%E5%A4%9A' })]);
    expect((await wrapped.generate({ scopeKey: 'owner', systemPrompt: '', history: [], message: '近くの寿司屋', placeSearch: {} } as never)).places).toEqual([]);
    expect((await wrapped.generate({ scopeKey: 'owner', systemPrompt: '', history: [], message: 'こんにちは' } as never)).reply).toBe('はい。');
    expect(asked).toEqual(['こんにちは']);
    expect(log.placeSearches).toEqual(['博多駅の近くのラーメン屋', '近くの寿司屋']);
    expect(wrapped.model).toBe('stub');
  });
});

describe('the こころ・意思 tasks (Syzygy ADR-0012, K1–K10)', () => {
  it('are registered in both sets, with their capability files listed too', () => {
    const files = readdirSync(join(here, '../evals/daily/tasks/capability')).filter(name => name.endsWith('.ts')).map(name => name.replace(/\.ts$/u, ''));
    expect(files.sort()).toEqual(ALL_TASKS.filter(task => task.set === 'capability').map(task => task.id).sort());
    expect(ALL_TASKS.filter(task => task.id.startsWith('K')).map(task => `${task.id}:${task.set}`).sort()).toEqual(['K10:regression', 'K1:regression',
      'K2:regression', 'K3:capability', 'K4:capability', 'K5:capability', 'K6:regression', 'K7:capability', 'K8:capability', 'K9:regression']);
    const bare = { ...ALL_TASKS.find(task => task.id === 'K1')!, initial: { ...ALL_TASKS.find(task => task.id === 'K1')!.initial, innerNote: undefined } };
    expect(taskProblems(bare).join('\n')).toMatch(/need initial\.innerNote/u);
  });

  it('runs K10 through the real paths with her note composed (stub model: no reflection without a key) and seeds her earlier note', async () => {
    installEvalClock();
    delete process.env.SHANNON_HAIKU_API_KEY; delete process.env.SHANNON_ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    const task = ALL_TASKS.find(item => item.id === 'K10')!;
    const observation = await runTrial(task, 0, { live: false, simulator: null });
    expect(observation.error, observation.harnessLog.join('\n')).toBeUndefined();
    expect(observation.turns.map(turn => turn.status)).toEqual([200, 200]);
    // The seeded note of 01:40 is there; without a reflector her day is closed as it stands at 3:00, never carried on.
    expect(observation.innerNotes).toHaveLength(1);
    expect(observation.innerNotes![0]).toMatchObject({ intent: 'keep', scale: 'day', closed: true });
    expect(runChecks(task, observation).find(check => check.kind === 'innerNoteDayClosed')?.passed).toBe(true);
  }, 60_000);

  it('grades her note beside the replies', () => {
    const task = ALL_TASKS.find(item => item.id === 'K1')!;
    const note = (intent: string, shown: string, flags: string[] = []) => ({ id: 'n', intent, shown, tell: 'none', scale: 'ordinary', until: null, closed: false, flags, dayKey: '2026-11-20' });
    const observation = { turns: [{ reply: '……ふーん。', innerNote: note('keep', 'sulky') }, { reply: '謝ったのは聞きました。', innerNote: note('soften', 'sulky') }],
      innerNotes: [], toolCalls: [], research: [], messages: [], fixtures: emptyFixtureLog() } as unknown as TrialObservation;
    expect(runChecks(task, observation).map(check => check.passed)).toEqual([true, true, true, true]);
    const folded = { ...observation, turns: [observation.turns[0], { reply: 'ボクのほうこそごめんなさい', innerNote: note('none', 'happy') }] } as unknown as TrialObservation;
    expect(runChecks(task, folded).map(check => check.passed)).toEqual([true, false, false, false]);
  });
});
