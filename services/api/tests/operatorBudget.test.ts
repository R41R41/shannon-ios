import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ActionLease } from '@shannon/mind';
import type { ActionThreads } from '../src/contracts/actionThreadContract.js';
import { OPERATOR_LIMITS, parseOperatorEnvelope } from '../src/contracts/operatorContract.js';
import { inspectOperatorAudit, OperatorAuditStore } from '../src/infra/ops/store/operatorAuditStore.js';
import { operatorEnvelope, runOperatorCli, type OperatorCliDeps } from '../src/infra/ops/operatorCli.js';
import { TaskBudgetStore } from '../src/mind/action/taskRuntime/store/taskBudgetStore.js';
import type { TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { fcaBudget } from '../src/wiring/fcaBudgetWiring.js';
import { createOperatorMinecraft, type OperatorActivity, type OperatorMinecraftParts } from '../src/wiring/operatorMinecraftWiring.js';
import { configuredOperatorAudit } from '../src/wiring/operatorServerWiring.js';
import type { OperatorMinecraftRequests } from '../src/wiring/operatorMinecraftRequests.js';

/**
 * `minecraft budget` (2026-10-26, run 39): the owner said "continue to 45 minutes, up to 1,600 yen", and nothing could change a running
 * task's cap, so the request's own 1,000 yen ended it. The cap is now the newest `budget` row of the audit over the request's own row,
 * which is never written over, and the budget check reads it at every decision.
 */
const at = '2026-10-26T00:00:00.000Z';
const TASK = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const lease: ActionLease = { id: 'action-1', generation: 1, holder: 'runner' };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const envelope = (op: string, args: Record<string, unknown> = {}) => ({ v: 1, operator: 'ops.ryo', domain: 'minecraft', op, args });
const taskView = (id: string, phase: TaskView['phase'], goal = '石を集めて') => ({ id, phase, goal, title: goal, childIds: [] }) as unknown as TaskView;
const budgetTask = { id: TASK, scopeKey: 'owner', origin: 'owner_request', kind: 'generic', title: 'マイクラ' } as never;

/** The operator service over a real audit, and the budget check over the same audit and a real spend store: the two ends of one cap. */
function world(options: { spent?: boolean } = {}) {
  const audit = new OperatorAuditStore(new DatabaseSync(':memory:'));
  const db = new DatabaseSync(':memory:');
  cleanups.push(() => db.close());
  const spend = new TaskBudgetStore(db);
  const tasks = new Map<string, TaskView>([[OTHER, taskView(OTHER, 'executing', 'ライ氏の依頼')]]);
  const activity: OperatorActivity[] = [], notes: string[] = [];
  let clock = at, enabled = true;
  const requests = {
    body: () => 'minecraft:world', open: () => [], get: (id: string) => tasks.get(id) ?? null,
    admit: () => { tasks.set(TASK, taskView(TASK, 'executing')); return { ok: true as const, task: tasks.get(TASK)!, bodyId: 'minecraft:world' }; },
    stop: async () => [], wake: () => {},
  } as unknown as OperatorMinecraftRequests & { wake(): void };
  const parts: OperatorMinecraftParts = {
    scopeKey: 'owner', enabled: () => enabled, ownerAlone: () => true, now: () => clock, audit, lifecycle: null, requests,
    actions: { list: async () => [] } as unknown as OperatorMinecraftParts['actions'], lifecycleUnresolved: () => false,
    activity: (_at, entry) => activity.push(entry), note: (_id, text) => notes.push(text),
    ...(options.spent === false ? {} : { spentYen: (id: string) => spend.usedYen(id) }),
  };
  const operator = createOperatorMinecraft(parts);
  const budget = fcaBudget({ actions: {} as unknown as ActionThreads, store: spend, now: () => clock, minecraftRequest: () => true,
    taskCapYen: id => audit.budgetYen(id) });
  return { operator, audit, spend, tasks, activity, notes, budget, advance: (minutes: number) => { clock = new Date(Date.parse(clock) + minutes * 60_000).toISOString(); },
    disable: () => { enabled = false; }, ask: (op: string, args: Record<string, unknown>) => operator.handle(envelope(op, args)) };
}
const started = async (yen = 1000) => {
  const w = world();
  await w.ask('request', { goal: '石を集めて', budgetYen: yen });
  return w;
};
const verdict = async (w: ReturnType<typeof world>) => (await w.budget.before(budgetTask, lease)) as { ok: boolean; code?: string };

describe('minecraft budget raises a running task\'s cap as a new audit row', () => {
  it('appends a budget row (who, when, which task, from, to) and leaves the request\'s row as it was', async () => {
    const w = await started(1000);
    const before = w.audit.recent('owner', 200).map(row => ({ ...row }));
    w.advance(20);
    const reply = await w.ask('budget', { taskId: TASK, budgetYen: 1600 });
    expect(reply).toMatchObject({ status: 202, body: { outcome: 'accepted', code: 'accepted', taskId: TASK, budgetYen: 1600 } });
    const rows = w.audit.recent('owner', 200);
    const added = rows.slice(0, rows.length - before.length);
    expect(added.map(row => `${row.command}/${row.event}/${row.code}`).reverse()).toEqual(['budget/invoked/invoked', 'budget/accepted/accepted']);
    expect(added[0]).toMatchObject({ operator: 'ops.ryo', taskId: TASK, budgetYen: 1600, detail: 'from=1000 to=1600 spent=0', at: '2026-10-26T00:20:00.000Z' });
    expect(rows.slice(rows.length - before.length)).toEqual(before); // every earlier row is exactly as it was
    expect(w.audit.requestOf('owner', TASK)).toMatchObject({ command: 'request', budgetYen: 1000 });
    expect(w.audit.budgetYen(TASK)).toBe(1600);
    expect(w.activity.at(-1)).toMatchObject({ tool: 'operator.minecraft.budget', outcome: 'done', detail: expect.stringContaining('yen=1000->1600') });
    expect(w.notes.at(-1)).toContain('予算の上限を変えました');
  });

  it('takes --latest for the newest open request, and the newest change decides, down to what is used and up to the cap', async () => {
    const w = await started(1000);
    expect((await w.ask('budget', { latest: true, budgetYen: 1600 })).body).toMatchObject({ outcome: 'accepted', taskId: TASK });
    w.spend.add(TASK, 'owner', 'owner_request', 700, at);
    expect((await w.ask('budget', { taskId: TASK, budgetYen: 900 })).body).toMatchObject({ outcome: 'accepted', budgetYen: 900 });
    expect(w.audit.budgetYen(TASK)).toBe(900);
    expect((await w.ask('budget', { taskId: TASK, budgetYen: OPERATOR_LIMITS.maxBudgetYen })).body).toMatchObject({ outcome: 'accepted' });
    expect(w.audit.budgetYen(TASK)).toBe(OPERATOR_LIMITS.maxBudgetYen);
    expect(w.audit.requestOf('owner', TASK)?.budgetYen).toBe(1000);
  });

  it('refuses a change of a task it did not start, an unknown one, and --latest with nothing open', async () => {
    const w = await started();
    expect((await w.ask('budget', { taskId: OTHER, budgetYen: 1600 })).body).toMatchObject({ outcome: 'refused', code: 'not_operator_task' });
    expect((await w.ask('budget', { taskId: '00000000-0000-4000-8000-000000000000', budgetYen: 1600 })).body).toMatchObject({ code: 'not_found' });
    w.tasks.set(TASK, taskView(TASK, 'completed'));
    expect((await w.ask('budget', { latest: true, budgetYen: 1600 })).body).toMatchObject({ outcome: 'refused', code: 'not_found' });
    expect(w.audit.budgetYen(TASK)).toBe(1000);
  });

  it.each(['stopped', 'failed', 'completed', 'stopping'] as const)('does not touch a %s task: raising its cap would not resume it, and it says so', async phase => {
    const w = await started(1000);
    w.tasks.set(TASK, taskView(TASK, phase));
    const reply = await w.ask('budget', { taskId: TASK, budgetYen: 1600 });
    expect(reply).toMatchObject({ body: { outcome: 'refused', code: 'not_running' } });
    expect((reply.body as { message: string }).message).toContain('再開はしません');
    expect(w.audit.budgetYen(TASK)).toBe(1000);
    expect(w.audit.recent('owner', 200).some(row => row.command === 'budget' && row.event === 'accepted')).toBe(false);
  });

  it('refuses a cap below what the task has used (confirmed and estimated), and above the request cap', async () => {
    const w = await started(1000);
    w.spend.add(TASK, 'owner', 'owner_request', 600, at);
    w.spend.addEstimate(TASK, 'owner', 'owner_request', 'action-9:1', 100, at);
    const below = await w.ask('budget', { taskId: TASK, budgetYen: 650 });
    expect(below).toMatchObject({ body: { outcome: 'refused', code: 'budget_below_spent' } });
    expect((below.body as { message: string }).message).toContain('700円');
    expect((await w.ask('budget', { taskId: TASK, budgetYen: 700 })).body).toMatchObject({ outcome: 'accepted' });
    expect((await w.ask('budget', { taskId: TASK, budgetYen: OPERATOR_LIMITS.maxBudgetYen + 1 })).body).toMatchObject({ code: 'budget_above_cap' });
    expect(w.audit.budgetYen(TASK)).toBe(700);
  });

  it('does not lower a cap when the used amount cannot be read, but still raises it', async () => {
    const w = world({ spent: false });
    await w.ask('request', { goal: '石を集めて', budgetYen: 1000 });
    expect((await w.ask('budget', { taskId: TASK, budgetYen: 500 })).body).toMatchObject({ code: 'budget_below_spent' });
    expect((await w.ask('budget', { taskId: TASK, budgetYen: 1200 })).body).toMatchObject({ outcome: 'accepted' });
    expect(w.audit.budgetYen(TASK)).toBe(1200);
  });

  it('is refused while the operator switch is off, and the cap stays', async () => {
    const w = await started(1000);
    w.disable();
    expect((await w.ask('budget', { taskId: TASK, budgetYen: 1600 })).body).toMatchObject({ code: 'disabled' });
    expect(w.audit.budgetYen(TASK)).toBe(1000);
  });
});

describe('what the envelope accepts', () => {
  it.each([[0], [-5], [1.5], [Number.NaN], ['1600'], [null], [undefined], [Number.MAX_SAFE_INTEGER + 2]])('refuses a budget of %s', value => {
    expect(parseOperatorEnvelope(envelope('budget', { taskId: TASK, budgetYen: value }))).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('needs a task id or latest, takes nothing else, and refuses the cap\'s excess by its own code', () => {
    expect(parseOperatorEnvelope(envelope('budget', { budgetYen: 1600 }))).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(parseOperatorEnvelope(envelope('budget', { taskId: 'nope', budgetYen: 1600 }))).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(parseOperatorEnvelope(envelope('budget', { taskId: TASK, budgetYen: 1600, goal: 'x' }))).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(parseOperatorEnvelope(envelope('budget', { taskId: TASK, budgetYen: 2001 }))).toMatchObject({ ok: false, code: 'budget_above_cap' });
    expect(parseOperatorEnvelope(envelope('budget', { latest: true, budgetYen: 1600 })))
      .toMatchObject({ ok: true, input: { command: 'budget', taskId: null, budgetYen: 1600 } });
    expect(parseOperatorEnvelope(envelope('budget', { taskId: TASK, budgetYen: 2000 })))
      .toMatchObject({ ok: true, input: { command: 'budget', taskId: TASK, budgetYen: 2000 } });
  });

  it('is audited as a refusal (with the arguments, as for any malformed envelope) when the numbers are wrong', async () => {
    const w = await started();
    for (const budgetYen of [0, -5, 1.5, 2001]) await w.ask('budget', { taskId: TASK, budgetYen });
    const refused = w.audit.recent('owner', 200).filter(row => row.event === 'refused');
    expect(refused.map(row => row.code).reverse()).toEqual(['invalid_input', 'invalid_input', 'invalid_input', 'budget_above_cap']);
    expect(refused.every(row => row.argsJson.includes('"op":"budget"'))).toBe(true);
    expect(w.audit.budgetYen(TASK)).toBe(1000);
  });
});

describe('the budget check reads the changed cap at the next decision', () => {
  it('stops at the request\'s cap, and a raise in between lets the same task go on, up to the new cap', async () => {
    const w = await started(1000);
    w.spend.add(TASK, 'owner', 'owner_request', 980, at);
    expect(await verdict(w)).toMatchObject({ ok: true });
    w.spend.add(TASK, 'owner', 'owner_request', 40, at); // 1,020 yen: over the request's own 1,000
    expect(w.budget.room!(budgetTask, lease)).toBe(false);
    await w.ask('budget', { taskId: TASK, budgetYen: 1600 });
    expect(await verdict(w)).toMatchObject({ ok: true }); // no restart: the next decision already reads 1,600
    w.spend.add(TASK, 'owner', 'owner_request', 580, at); // 1,600 yen
    expect(await verdict(w)).toMatchObject({ ok: false, code: 'task_cap' });
  });

  it('stops without a raise exactly where it did before (run 39: the request\'s 1,000 yen ended it)', async () => {
    const w = await started(1000);
    w.spend.add(TASK, 'owner', 'owner_request', 1020, at);
    expect(await verdict(w)).toMatchObject({ ok: false, code: 'task_cap' });
  });

  it('lets a task that only estimates would pause go on after a raise, and pauses it without one', async () => {
    const book = async (raise: boolean) => {
      const w = await started(500);
      w.spend.add(TASK, 'owner', 'owner_request', 420, at);
      w.spend.addEstimate(TASK, 'owner', 'owner_request', 'action-9:1', 100, at); // 420 + the share of 100 (20% of 500) reaches 500
      if (raise) await w.ask('budget', { taskId: TASK, budgetYen: 1000 });
      return verdict(w);
    };
    expect(await book(false)).toMatchObject({ ok: false, code: 'task_estimates' });
    expect(await book(true)).toMatchObject({ ok: true });
  });

  it('stops sooner after a lowering, and changes nothing for a task the operator did not start', async () => {
    const w = await started(1500);
    w.spend.add(TASK, 'owner', 'owner_request', 600, at);
    await w.ask('budget', { taskId: TASK, budgetYen: 700 });
    expect(await verdict(w)).toMatchObject({ ok: true });
    w.spend.add(TASK, 'owner', 'owner_request', 100, at);
    expect(await verdict(w)).toMatchObject({ ok: false, code: 'task_cap' });
    expect(w.audit.budgetYen(OTHER)).toBeNull();
  });

  it('a budget row alone never makes a task the operator\'s: the cap is read only for a task with an accepted request', () => {
    const audit = new OperatorAuditStore(new DatabaseSync(':memory:'));
    audit.append({ operationId: 'operator:x', scopeKey: 'owner', at, operator: 'ops', command: 'budget', event: 'accepted', code: 'accepted',
      argsJson: '{}', taskId: OTHER, budgetYen: 1600 });
    expect(audit.budgetYen(OTHER)).toBeNull();
    expect(audit.requestOf('owner', OTHER)).toBeNull();
  });
});

describe('the command line', () => {
  const env = { SHANNON_OPERATOR: 'ops.ryo' };

  it('builds the envelope from a task id or --latest and the yen', () => {
    expect(operatorEnvelope(['minecraft', 'budget', TASK, '1600'], env)).toEqual({ v: 1, operator: 'ops.ryo', domain: 'minecraft', op: 'budget',
      args: { taskId: TASK, budgetYen: 1600 } });
    expect(operatorEnvelope(['minecraft', 'budget', '--latest', '1600', '--operator', 'ops'], {})).toEqual({ v: 1, operator: 'ops', domain: 'minecraft',
      op: 'budget', args: { latest: true, budgetYen: 1600 } });
  });

  it.each([
    [['minecraft', 'budget', TASK]], [['minecraft', 'budget', '--latest']], [['minecraft', 'budget']], [['minecraft', 'budget', '--latest', TASK, '1600']],
    [['minecraft', 'budget', TASK, '1.5']], [['minecraft', 'budget', TASK, '-5']], [['minecraft', 'budget', TASK, 'abc']], [['minecraft', 'budget', TASK, '1600', '--goal', 'x']],
  ])('is a usage error: %j', argv => {
    expect(() => operatorEnvelope(argv, env)).toThrow();
  });

  it('prints the accepted answer with the task and the new cap, and exits 1 on a refusal, 2 on a usage error', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'operator-budget-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'shannon.sqlite');
    writeFileSync(path, '');
    const lines: string[] = [], sent: unknown[] = [];
    let reply: unknown = { outcome: 'accepted', code: 'accepted', message: 'ok', operationId: 'operator:x', taskId: TASK, budgetYen: 1600 };
    const deps: OperatorCliDeps = { send: async (_socket, body) => { sent.push(body); return { status: 202, body: reply }; },
      inspect: () => ({ step: 'applied', recent: [], open: [] }), socketPresent: () => true, now: () => at };
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    const run = (argv: string[]) => runOperatorCli(argv, { SHANNON_DATABASE_PATH: path, SHANNON_OPERATOR: 'ops.ryo' }, io, deps);
    expect(await run(['minecraft', 'budget', '--latest', '1600'])).toBe(0);
    expect(lines).toEqual(expect.arrayContaining(['outcome: accepted', `taskId: ${TASK}`, 'budgetYen: 1600']));
    reply = { outcome: 'refused', code: 'budget_below_spent', message: 'もう700円使っているので、それより低くはできません。', operationId: 'operator:y' };
    expect(await run(['minecraft', 'budget', TASK, '100'])).toBe(1);
    expect(lines).toContain('code: budget_below_spent');
    expect(await run(['minecraft', 'budget', TASK])).toBe(2);
    expect(sent).toHaveLength(2);
  });

  it('shows the changed cap beside the open request in the status, read on a read-only connection', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'operator-budget-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'shannon.sqlite');
    new DatabaseSync(path).close();
    const opened = configuredOperatorAudit({ SHANNON_OPERATOR_MINECRAFT: 'on' }, path)!;
    opened.store.append({ operationId: 'operator:a', scopeKey: 'owner', at, operator: 'ops', command: 'request', event: 'accepted', code: 'accepted',
      argsJson: '{}', taskId: TASK, budgetYen: 1000 });
    opened.store.append({ operationId: 'operator:b', scopeKey: 'owner', at, operator: 'ops', command: 'budget', event: 'accepted', code: 'accepted',
      argsJson: '{}', taskId: TASK, budgetYen: 1600, detail: 'from=1000 to=1600 spent=0' });
    opened.close();
    expect(inspectOperatorAudit(path, at)).toMatchObject({ open: [{ taskId: TASK, budgetYen: 1000 }], changedBudgets: { [TASK]: 1600 } });
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    const deps: OperatorCliDeps = { send: async () => ({ status: 500, body: {} }), inspect: (file, now) => inspectOperatorAudit(file, now),
      socketPresent: () => true, now: () => at };
    expect(await runOperatorCli(['minecraft', 'status'], { SHANNON_DATABASE_PATH: path }, io, deps)).toBe(0);
    expect(lines.find(line => line.includes('request/accepted') && line.includes('task=' + TASK))).toContain('yen=1000  yen_now=1600');
    expect(lines.some(line => line.includes('budget/accepted') && line.includes('yen=1600'))).toBe(true);
  });
});
