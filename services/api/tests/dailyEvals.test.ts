import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChecks } from '../evals/daily/graders/checks.js';
import { runBudgets } from '../evals/daily/graders/budgets.js';
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
