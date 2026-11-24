import { describe, expect, it } from 'vitest';
import type { BodyTaskContext } from '../src/contracts/bodyControlContract.js';
import { ACT_THOUGHT_DESCRIPTION, ACT_THOUGHT_MAX, type ActInput } from '../src/contracts/minecraftActContract.js';
import { actToShort, SHORT_ACT_DESCRIPTION, SHORT_ACT_INPUT_SCHEMA, shortToAct } from '../src/contracts/minecraftActShortContract.js';
import { validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { llmcInputProblem } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { normalizeActInput } from '../src/surfaces/minecraft/minecraftLlmcShape.js';
import { withThought } from '../src/surfaces/minecraft/minecraftMadeIn.js';
import { createLlmcQueue } from '../src/surfaces/minecraft/minecraftLlmcQueue.js';
import { sendItem } from '../src/wiring/fcaMinecraftActItem.js';
import { V2_ALWAYS } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

/**
 * An act's `thought` (the task tab's line of what the model thinks): a field the model may write, a head-only one: it never goes to the body in
 * the act's arguments (the body's act takes none and refuses an unknown one), it goes in the command's context as `taskState.thought`.
 */
const WAIT = { do: 'wait' as const, seconds: 5 };
const context = (): BodyTaskContext => ({ scopeKey: 's', taskId: 't', taskRevision: 1, bodyId: 'b', sessionId: 'x', generation: 1, goal: 'g', completionCondition: 'c',
  taskState: { phase: 'executing', progress: '', recentResults: [] } });

describe('the field the model writes', () => {
  it('is in the short schema the model sees, with a length and a reason in its description', () => {
    const thought = (SHORT_ACT_INPUT_SCHEMA.properties as Record<string, { type: string; maxLength: number; description: string }>).thought!;
    expect(thought.type).toBe('string');
    expect(thought.maxLength).toBe(ACT_THOUGHT_MAX);
    expect(thought.description).toContain('画面');
    expect(SHORT_ACT_DESCRIPTION).not.toContain('thought');
  });
  it('is read and written back like why, and an act that has none is unchanged', () => {
    const act: ActInput = { hands: [WAIT], why: '[p2.1] 夜の骸骨待ち', thought: '夜まであと少し。骸骨が来るまで盾の準備をして待つ。' };
    const short = actToShort(act);
    expect(short.thought).toBe(act.thought);
    const back = shortToAct(short);
    expect(back.errors).toEqual([]);
    expect(back.act.thought).toBe(act.thought);
    expect(actToShort({ hands: [WAIT], why: 'w' })).not.toHaveProperty('thought');
    expect(shortToAct({ hands: ['wait 5'], why: 'w' }).act).not.toHaveProperty('thought');
  });
  it('is taken by the act\'s own schema (an act with a thought is not refused), and one that runs long is cut with a word, not refused', () => {
    const ok = { hands: [{ do: 'wait', seconds: 5 }], why: 'w', thought: '考え' };
    expect(llmcInputProblem('mc.act', ok)).toBeNull();
    const long = 'あ'.repeat(ACT_THOUGHT_MAX + 30);
    const { input, fixes } = normalizeActInput({ ...ok, thought: long });
    expect((input as { thought: string }).thought).toHaveLength(ACT_THOUGHT_MAX);
    expect(fixes).toEqual([`thought を ${ACT_THOUGHT_MAX} 字に切った`]);
    expect(llmcInputProblem('mc.act', input)).toBeNull();
  });
  it('says in the field own words what it is for: display only, plain facts, no names or voices, and that it may be left out', () => {
    const description = (SHORT_ACT_INPUT_SCHEMA.properties as Record<string, { description: string }>).thought!.description;
    for (const word of ['表示だけ', '事実', '口調はつけない', 'Discord', '省いてよい']) expect(description).toContain(word);
    expect(description).toBe(ACT_THOUGHT_DESCRIPTION);
  });
  it('costs the always-on instructions next to nothing (its words are in the field, not in the system text)', () => {
    expect(V2_ALWAYS).not.toContain('thought');
  });
  it('the body\'s own act schema would refuse it as an argument (so it must not be sent there)', () => {
    const bodyAct = { type: 'object', additionalProperties: false, required: ['hands'], properties: { hands: { type: 'array', items: { type: 'string' } }, why: { type: 'string' } } };
    expect(validSkillInput({ hands: ['wait 5'], why: 'w' }, bodyAct as never)).toBe(true);
    expect(validSkillInput({ hands: ['wait 5'], why: 'w', thought: 't' }, bodyAct as never)).toBe(false);
  });
});

describe('what goes to the body', () => {
  it('sendItem keeps the thought out of the act\'s arguments and gives it to the queue as its own field', async () => {
    const specs: Array<Record<string, any>> = [];
    const queue = { open: () => false, async add(spec: Record<string, unknown>) { specs.push(spec); return { ok: true as const, item: 'q1', after: null, startInMs: 1000 }; } };
    const input: ActInput = { hands: [WAIT, { do: 'jump' }], why: '[p1] 待つ', thought: 'かまどが焼けるまで木を集める。' };
    const call = { scopeKey: 's', taskId: 't', operationId: 'op', name: 'mc.act', input, signal: new AbortController().signal };
    const sent = await sendItem({ queue: queue as never, control: { observe: () => null } as never, bodyId: 'b', call: call as never, skill: 'act', fixes: [], node: 'p1', frame: null });
    expect(sent.ok).toBe(true);
    expect(specs[0]!.thought).toBe('かまどが焼けるまで木を集める。');
    expect(specs[0]!.arguments).not.toHaveProperty('thought');
    expect(specs[0]!.arguments).toMatchObject({ why: '[p1] 待つ' });
    expect(specs[0]!.why).toBe('[p1] 待つ');
  });
  it('an act with no thought gives the queue no thought field', async () => {
    const specs: Array<Record<string, any>> = [];
    const queue = { open: () => false, async add(spec: Record<string, unknown>) { specs.push(spec); return { ok: true as const, item: 'q1', after: null, startInMs: 1000 }; } };
    const call = { scopeKey: 's', taskId: 't', operationId: 'op', name: 'mc.act', input: { hands: [WAIT], why: 'w' }, signal: new AbortController().signal };
    await sendItem({ queue: queue as never, control: { observe: () => null } as never, bodyId: 'b', call: call as never, skill: 'act', fixes: [], node: null, frame: null });
    expect(specs[0]).not.toHaveProperty('thought');
  });
  it('the command\'s context carries it as taskState.thought: one line, cut, and nothing when empty', () => {
    expect(withThought(context(), '考え').taskState?.thought).toBe('考え');
    expect(withThought(context(), ' 前の\n手が\t止まった。 ').taskState?.thought).toBe('前の 手が 止まった。');
    expect(withThought(context(), 'あ'.repeat(200)).taskState?.thought).toHaveLength(ACT_THOUGHT_MAX);
    expect(withThought(context(), '   ').taskState).not.toHaveProperty('thought');
    expect(withThought(context(), undefined)).toEqual(context());
    // The rest of the context is left as it was.
    expect(withThought(context(), 't')).toEqual({ ...context(), taskState: { ...context().taskState!, thought: 't' } });
  });
});

describe('the queue puts the thought on the command it makes', () => {
  it('the command\'s context has taskState.thought and its arguments do not', async () => {
    const handed: Array<Record<string, any>> = [];
    // A control that has the listener sets the queue hangs on and answers every other question with nothing.
    const listeners = new Map<string, Set<unknown>>();
    const base: Record<string, unknown> = {
      observe: () => null, headBoot: () => 'hb', store: { command: () => undefined, body: () => 'b' },
      enqueue(command: Record<string, any>) { handed.push(command); return { id: command.id, receipt: new Promise(() => undefined) }; },
    };
    const control = new Proxy(base, { get: (target, key: string) => key in target ? target[key]
      : key.endsWith('Listeners') ? (listeners.get(key) ?? listeners.set(key, new Set()).get(key)) : () => null });
    const queue = createLlmcQueue({ control: control as never, taskId: 't1', lease: { id: 'lease-1', generation: 1, holder: 'test' }, bodyId: () => 'b', observe: () => null,
      log: () => undefined, record: () => undefined, context: () => context() });
    try {
      const input = { hands: [WAIT], why: '[p1] 待つ' };
      const spec = (extra: Record<string, unknown>) => ({ call: { id: 'c1', name: 'mc.act', input }, operationId: 'step:c1', input, arguments: input as unknown as Record<string, unknown>,
        skill: 'act', node: 'p1', why: input.why, fixes: [] as string[], maxMs: 20_000, ...extra });
      expect(await queue.add(spec({ thought: '夜まで待つ。' }) as never)).toMatchObject({ ok: true });
      expect(handed[0]!.context.taskState.thought).toBe('夜まで待つ。');
      expect(handed[0]!.arguments).not.toHaveProperty('thought');
    } finally {
      queue.stop();
    }
  });
});
