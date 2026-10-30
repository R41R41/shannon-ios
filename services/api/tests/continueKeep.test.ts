import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { emptyPlanTree, PLAN_LIMITS } from '@shannon/mind';
import {
  ACT_INPUT_SCHEMA, actProblem, KEEP_FORM, KEEP_MAX, keepProblem, MC_ACT_TOOL, type ActInput,
} from '../src/contracts/minecraftActContract.js';
import {
  actToShort, expandShortAct, SHORT_ACT_DESCRIPTION, SHORT_ACT_INPUT_SCHEMA, shortHandProblem, shortToAct,
} from '../src/contracts/minecraftActShortContract.js';
import { createFcaPlanTools } from '../src/mind/action/fca/fcaPlanTools.js';
import { llmcInputProblem, llmcPrepare } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { llmcTokens } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { promiseKeptWords } from '../src/surfaces/minecraft/minecraftLlmcResultWords.js';
import { candidateInput } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { V2_ALWAYS } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { minecraftV2System } from '../src/infra/models/anthropic/anthropicFcaMinecraftSystem.js';
import { validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { sendItem } from '../src/wiring/fcaMinecraftActItem.js';
import { lineToHand } from '../src/contracts/minecraftActShortHands.js';

/**
 * Amendment A-7 (the head only), from the short run of Sonnet: 1 `keep` (an act says what to keep, the head makes the promise), 2 vertical's `liquid` and limits told with the
 * mend, 3 the quotes round a `stopIf`. The words of the model's own forms (`keep=spruce_planks:4:作業台`) are read and written both ways; the promise is made through the
 * plan's `keepPromise` (the same handling as `plan.update`'s promise op); `uses` is never touched.
 */
const WAIT = { do: 'wait', seconds: 1 } as const;
const stamp = () => '2026-10-29T00:00:00.000Z';

describe('keep: the short form and the json form are the same entries', () => {
  it('reads "品目:数:用途" as a list of strings, as one string joined by commas or new lines, and keeps the json form', () => {
    const list = shortToAct({ hands: ['jump'], keep: ['spruce_planks:4:作業台', 'cobblestone:8:かまど'] });
    expect(list.errors).toEqual([]);
    expect(list.act.keep).toEqual([{ item: 'spruce_planks', count: 4, use: '作業台' }, { item: 'cobblestone', count: 8, use: 'かまど' }]);
    expect(shortToAct({ hands: ['jump'], keep: 'spruce_planks:4:作業台,cobblestone:8:かまど' }).act.keep).toEqual(list.act.keep);
    expect(shortToAct({ hands: ['jump'], keep: 'spruce_planks:4:作業台\ncobblestone:8:かまど' }).act.keep).toEqual(list.act.keep);
    expect(shortToAct({ hands: ['jump'], keep: [{ item: 'food', count: 20, use: '帰り道' }] }).act.keep).toEqual([{ item: 'food', count: 20, use: '帰り道' }]);
    // The use may hold a colon, and spaces round the parts are not part of them.
    expect(shortToAct({ hands: ['jump'], keep: [' oak_planks : 4 : 作業台: 家の ' ] }).act.keep).toEqual([{ item: 'oak_planks', count: 4, use: '作業台: 家の' }]);
  });
  it('writes the entries back in the same form (a round trip, more than one)', () => {
    const act: ActInput = { hands: [WAIT], why: 'w', keep: [{ item: 'spruce_planks', count: 4, use: '作業台' }, { item: 'food', count: 12, use: '下りる前' }, { item: 'cobblestone', count: 8, use: 'かまど' }] };
    const short = actToShort(act);
    expect(short.keep).toEqual(['spruce_planks:4:作業台', 'food:12:下りる前', 'cobblestone:8:かまど']);
    const back = shortToAct(short);
    expect(back.errors).toEqual([]);
    expect(back.act.keep).toEqual(act.keep);
    expect(actToShort({ hands: [WAIT] })).not.toHaveProperty('keep');
  });
  it('reads keep of an act whose hands are json too (the model may write only the queue fields in text)', () => {
    const read = expandShortAct({ hands: [{ do: 'wait', seconds: 1 }], keep: ['spruce_planks:4:作業台'] });
    expect(read.errors).toEqual([]);
    expect((read.input as ActInput).keep).toEqual([{ item: 'spruce_planks', count: 4, use: '作業台' }]);
  });
  it('is a field of both schemas, and an act with keep passes the whole check of the head', () => {
    expect(Object.keys(SHORT_ACT_INPUT_SCHEMA.properties)).toContain('keep');
    expect(Object.keys(ACT_INPUT_SCHEMA.properties)).toContain('keep');
    const prepared = llmcPrepare(MC_ACT_TOOL, candidateInput(MC_ACT_TOOL, { hands: ['wait 1'], why: 'x', keep: ['spruce_planks:4:作業台', 'cobblestone:8:かまど'] }));
    expect(prepared.problem).toBeNull();
    expect((prepared.input as ActInput).keep).toHaveLength(2);
    expect(validSkillInput(prepared.input, ACT_INPUT_SCHEMA)).toBe(true);
    expect(validSkillInput(candidateInput(MC_ACT_TOOL, { hands: ['wait 1'], keep: ['a_b:1:x'] }), ACT_INPUT_SCHEMA)).toBe(true);
  });
});

describe('keep: a refusal shows the form to write', () => {
  const refusal = (keep: unknown): string => {
    const read = expandShortAct({ hands: ['wait 1'], keep });
    return shortHandProblem(read.input) ?? llmcInputProblem(MC_ACT_TOOL, read.input) ?? '';
  };
  it('names the form (with the example) for a string that is not item:count:use', () => {
    for (const keep of [['spruce_planks 4 作業台'], ['spruce_planks:四:作業台'], ['spruce_planks:4'], 'spruce_planks:4:'] as const) {
      const text = refusal(keep);
      expect(text, JSON.stringify(keep)).toContain('keep の書き方の誤り');
      expect(text).toContain('keep=spruce_planks:4:作業台');
    }
  });
  it('refuses an item that is not a name, a count out of range, a use that is too long and more than four, each with the form', () => {
    const entry = (change: Record<string, unknown>) => ({ item: 'spruce_planks', count: 4, use: '作業台', ...change });
    expect(keepProblem([entry({ item: 'Spruce Planks' })])).toContain('keep の品目は物の名前');
    expect(keepProblem([entry({ count: 0 })])).toContain(`keep の数は 1〜${PLAN_LIMITS.promiseCount}`);
    expect(keepProblem([entry({ count: PLAN_LIMITS.promiseCount + 1 })])).toContain('keep の数は');
    expect(keepProblem([entry({ count: 1.5 })])).toContain('keep の数は');
    expect(keepProblem([entry({ use: 'あ'.repeat(PLAN_LIMITS.promiseUse + 1) })])).toContain(`keep の用途は ${PLAN_LIMITS.promiseUse} 字まで`);
    expect(keepProblem([entry({ use: ' ' })])).toContain('keep の用途は');
    expect(keepProblem(Array.from({ length: KEEP_MAX + 1 }, () => entry({})))).toContain(`keep は ${KEEP_MAX} つまで`);
    expect(keepProblem([entry({}), entry({ item: 'food', use: '食べる' })])).toBeNull();
    expect(keepProblem(undefined)).toBeNull();
    for (const keep of [[entry({ item: 'Spruce Planks' })], [entry({ count: 0 })], [entry({ use: 'あ'.repeat(41) })]]) expect(keepProblem(keep)).toContain('keep=spruce_planks:4:作業台');
    expect(KEEP_FORM).toContain('keep=spruce_planks:4:作業台');
    // the same checks as the act's (`actProblem`) and as the whole check (`llmcInputProblem`)
    expect(actProblem({ hands: [{ do: 'wait', seconds: 1 }], keep: [entry({ item: 'Spruce Planks' })] })).toContain('keep の品目は物の名前');
    expect(refusal([entry({ item: 'Spruce Planks' })])).toContain('keep の品目は物の名前');
    expect(refusal(Array.from({ length: 5 }, () => 'a_b:1:x'))).toContain('0〜4 個');
  });
});

describe('keep: sending the act makes the promise (a revision when the same item and use is open)', () => {
  const signal = new AbortController().signal;
  const plan = () => {
    const lines: string[] = [];
    const made = createFcaPlanTools({ taskId: 'keep-t', checkpoint: null, rules: true, log: line => lines.push(line), now: stamp });
    return { ...made, lines };
  };
  const call = (input: ActInput) => ({ scopeKey: 's', taskId: 'keep-t', operationId: 'op', name: 'mc.act', input, signal });
  const harness = (made: ReturnType<typeof plan>, accept = true) => {
    const specs: Array<Record<string, any>> = [];
    const queue = { open: () => false, async add(spec: Record<string, unknown>) { specs.push(spec); return accept ? { ok: true as const, item: `q${specs.length}`, after: null, startInMs: 1000 } : { ok: false as const, text: '列がいっぱい' }; } };
    const send = (input: ActInput) => sendItem({ queue: queue as never, control: { observe: () => null } as never, bodyId: 'b', call: call(input) as never, skill: 'act', fixes: [], node: null, frame: null,
      keep: entry => made.port.keepPromise!(entry) });
    return { specs, send };
  };

  it('makes a new promise with the item, count and use, and says so in one fact line', async () => {
    const made = plan(), { send } = harness(made);
    const sent = await send({ hands: [WAIT], keep: [{ item: 'spruce_planks', count: 4, use: '作業台' }] });
    expect(sent.ok).toBe(true);
    expect(sent.text.split('\n')).toHaveLength(2);
    expect(sent.text).toContain('列に入れた q1');
    expect(sent.text).toContain('約束 #1 を作った: spruce_planks 4（作業台）');
    const promises = made.port.tree().promises;
    expect(promises).toHaveLength(1);
    expect(promises[0]).toMatchObject({ id: 1, rev: 1, item: 'spruce_planks', count: 4, use: '作業台', state: 'open' });
    expect(promises[0]!.ledger[0]).toMatchObject({ kind: 'made', count: 4 });
    expect(made.port.committed()).not.toBeNull();
    expect(made.lines.some(line => line.includes('plan kept') && line.includes('how=made'))).toBe(true);
  });
  it('makes several in order, and the checkpoint carries them (a plan with no node yet too)', async () => {
    const made = plan(), { send } = harness(made);
    const sent = await send({ hands: [WAIT], keep: [{ item: 'spruce_planks', count: 4, use: '作業台' }, { item: 'cobblestone', count: 8, use: 'かまど' }] });
    expect(sent.text).toContain('約束 #1 を作った: spruce_planks 4（作業台）');
    expect(sent.text).toContain('約束 #2 を作った: cobblestone 8（かまど）');
    const checkpoint = made.tools.checkpoint?.() as { fcaPlanTree?: { promises: unknown[] } };
    expect(checkpoint.fcaPlanTree?.promises).toHaveLength(2);
    const reread = createFcaPlanTools({ taskId: 'keep-t', checkpoint, rules: true, now: stamp });
    expect(reread.port.tree().promises.map(item => item.id)).toEqual([1, 2]);
  });
  it('revises the open promise of the same item and use: its id, rev up one, the count changed; until and instead stay', async () => {
    const made = plan(), { send } = harness(made);
    await made.tools.execute({ scopeKey: 's', taskId: 'keep-t', operationId: 'p', name: 'plan.update', signal, input: { ops: [
      { op: 'add', title: '準備' }, { op: 'promise', item: 'spruce_planks', count: 4, use: '作業台', until: { node: 'p1' }, instead: 'have:crafting_table>=1' }] } } as never);
    const before = made.port.tree().promises[0]!;
    expect(before).toMatchObject({ id: 1, rev: 1, count: 4 });
    const sent = await send({ hands: [WAIT], keep: [{ item: 'spruce_planks', count: 6, use: '作業台' }] });
    expect(sent.text).toContain('約束 #1 を改訂した（rev 2）: spruce_planks 6（作業台）。前は 4');
    const after = made.port.tree().promises;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: 1, rev: 2, count: 6, item: 'spruce_planks', use: '作業台', until: before.until, instead: before.instead });
    expect(after[0]!.ledger.at(-1)).toMatchObject({ kind: 'revised', count: 6 });
  });
  it('changes nothing when the same entry is written again (no new rev), and makes a new one for another use or item', async () => {
    const made = plan(), { send } = harness(made);
    await send({ hands: [WAIT], keep: [{ item: 'spruce_planks', count: 4, use: '作業台' }] });
    const revision = made.port.tree().revision;
    const again = await send({ hands: [WAIT, WAIT], keep: [{ item: 'spruce_planks', count: 4, use: '作業台' }] });
    expect(again.text).toContain('約束 #1 は既に同じ数である: spruce_planks 4（作業台）');
    expect(made.port.tree().revision).toBe(revision);
    expect(made.port.tree().promises[0]!.rev).toBe(1);
    const other = await send({ hands: [WAIT, WAIT, WAIT], keep: [{ item: 'spruce_planks', count: 4, use: '家' }, { item: 'oak_planks', count: 4, use: '作業台' }] });
    expect(other.text).toContain('約束 #2 を作った: spruce_planks 4（家）');
    expect(other.text).toContain('約束 #3 を作った: oak_planks 4（作業台）');
    expect(made.port.tree().promises.map(item => item.id)).toEqual([1, 2, 3]);
  });
  it('does not revise a released promise: it makes a new one', async () => {
    const made = plan(), { send } = harness(made);
    await send({ hands: [WAIT], keep: [{ item: 'spruce_planks', count: 4, use: '作業台' }] });
    await made.tools.execute({ scopeKey: 's', taskId: 'keep-t', operationId: 'r', name: 'plan.update', signal, input: { ops: [{ op: 'release', id: 1, why: '要らない' }] } } as never);
    const sent = await send({ hands: [WAIT, WAIT], keep: [{ item: 'spruce_planks', count: 4, use: '作業台' }] });
    expect(sent.text).toContain('約束 #2 を作った');
    expect(made.port.tree().promises.map(item => [item.id, item.state])).toEqual([[1, 'closed'], [2, 'open']]);
  });
  it('does not put the promise into the act\'s uses, and keep is not in what is sent to the body', async () => {
    const made = plan(), { send, specs } = harness(made);
    await send({ hands: [WAIT], uses: [7], dependsOn: ['q1'], keep: [{ item: 'spruce_planks', count: 4, use: '作業台' }] });
    expect(specs).toHaveLength(1);
    expect(specs[0]!.input.uses).toEqual([7]);
    expect(specs[0]!.arguments).not.toHaveProperty('keep');
    expect(specs[0]!.arguments).not.toHaveProperty('uses');
    expect(specs[0]!.arguments).not.toHaveProperty('dependsOn');
    expect(specs[0]!.arguments.hands).toEqual([WAIT]);
    // an act with keep and no uses has no uses afterwards either
    await send({ hands: [WAIT, WAIT], keep: [{ item: 'oak_planks', count: 2, use: '棒' }] });
    expect(specs[1]!.input.uses).toBeUndefined();
  });
  it('makes nothing when the queue does not take the act', async () => {
    const made = plan(), { send } = harness(made, false);
    const sent = await send({ hands: [WAIT], keep: [{ item: 'spruce_planks', count: 4, use: '作業台' }] });
    expect(sent.ok).toBe(false);
    expect(sent.text).not.toContain('約束');
    expect(made.port.tree().promises).toEqual([]);
    expect(made.port.committed()).toBeNull();
  });
  it('says what the plan refused (the promises are full of open ones) and still sends the act', async () => {
    const made = plan(), { send } = harness(made);
    for (let index = 0; index < PLAN_LIMITS.promises; index += 1) made.port.keepPromise!({ item: 'cobblestone', count: index + 1, use: `用途${index}` });
    expect(made.port.tree().promises).toHaveLength(PLAN_LIMITS.promises);
    const sent = await send({ hands: [WAIT], keep: [{ item: 'spruce_planks', count: 4, use: '作業台' }] });
    expect(sent.ok).toBe(true);
    expect(sent.text).toContain('列に入れた');
    expect(sent.text).toContain('約束にできなかった（keep spruce_planks 4（作業台））');
    expect(made.port.tree().promises).toHaveLength(PLAN_LIMITS.promises);
  });
  it('says so when the step has no plan port to take it, and an act with no keep gets the one line as before', async () => {
    const queue = { open: () => false, async add() { return { ok: true as const, item: 'q1', after: null, startInMs: 1000 }; } };
    const parts = { queue: queue as never, control: { observe: () => null } as never, bodyId: 'b', skill: 'act', fixes: [], node: null, frame: null };
    const none = await sendItem({ ...parts, call: call({ hands: [WAIT], keep: [{ item: 'spruce_planks', count: 4, use: '作業台' }] }) as never });
    expect(none.text).toContain('約束にできなかった');
    const plain = await sendItem({ ...parts, call: call({ hands: [WAIT] }) as never });
    expect(plain.text.split('\n')).toHaveLength(1);
  });
  it('tells a plan made whole from the empty tree: the revision moves like plan.update\'s', () => {
    const made = plan();
    expect(made.port.tree()).toEqual(emptyPlanTree());
    made.port.keepPromise!({ item: 'spruce_planks', count: 4, use: '作業台' });
    expect(made.port.tree().revision).toBe(1);
  });
  it('words: a fact for made, revised, same and refused (none tells what to do)', () => {
    const entry = { item: 'spruce_planks', count: 4, use: '作業台' };
    const words = [promiseKeptWords(entry, { how: 'made', id: 3, rev: 1 }), promiseKeptWords(entry, { how: 'revised', id: 3, rev: 2, was: 2 }),
      promiseKeptWords(entry, { how: 'same', id: 3, rev: 1 }), promiseKeptWords(entry, { problem: '約束は 32 つまで（release で閉じてから）' })];
    expect(words[0]).toBe('約束 #3 を作った: spruce_planks 4（作業台）');
    expect(words[1]).toBe('約束 #3 を改訂した（rev 2）: spruce_planks 4（作業台）。前は 2');
    for (const text of words) expect(text).not.toMatch(/すること|しなさい|してください|べき|出し直/u);
  });
});

describe('stopIf: one layer of quotes round the value is taken off (amendment A-7 3)', () => {
  const expected = { hostileWithin: 8, hpBelow: 10 };
  const read = (stopIf: unknown) => shortToAct({ hands: ['jump'], stopIf });
  it('reads the value written as the json text "\\"hostileWithin=8 hpBelow=10\\"" (quotes inside the string)', () => {
    const value = JSON.parse('"\\"hostileWithin=8 hpBelow=10\\""') as string;
    expect(value).toBe('"hostileWithin=8 hpBelow=10"');
    const result = read(value);
    expect(result.errors).toEqual([]);
    expect(result.act.stopIf).toEqual(expected);
  });
  it('reads the value whose inner quotes are escaped (\\"…\\"), single quotes and spaces round it, and the plain value as before', () => {
    for (const value of ['\\"hostileWithin=8 hpBelow=10\\"', "'hostileWithin=8 hpBelow=10'", '  "hostileWithin=8 hpBelow=10"  ', 'hostileWithin=8 hpBelow=10']) {
      const result = read(value);
      expect([value, result.errors]).toEqual([value, []]);
      expect(result.act.stopIf).toEqual(expected);
    }
    expect(read('"blockChanged=1,2,3/4,5,6"').act.stopIf).toEqual({ blockChanged: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }] });
  });
  it('goes through the whole check of the head as the act the body takes', () => {
    const prepared = llmcPrepare(MC_ACT_TOOL, candidateInput(MC_ACT_TOOL, { hands: ['wait 1'], stopIf: '"hostileWithin=8 hpBelow=10"' }));
    expect(prepared.problem).toBeNull();
    expect((prepared.input as ActInput).stopIf).toEqual(expected);
  });
  it('shows the right form when it still does not read (and an unbalanced quote is not mended)', () => {
    for (const value of ['"hostileWithin=eight"', '"hostileWithin=8 hpBelow=10', 'fear=3']) {
      const problem = shortHandProblem(expandShortAct({ hands: ['wait 1'], stopIf: value }).input);
      expect(problem, value).toContain('stopIf が読めない');
      expect(problem).toContain('stopIf=hostileWithin=8 hpBelow=10');
      expect(problem).toContain('引用符で包まない');
    }
  });
});

describe('vertical: the refusal says how to mend it, and the examples all write liquid (amendment A-7 2)', () => {
  const problemOf = (...lines: string[]): string => {
    const read = expandShortAct({ hands: lines });
    return shortHandProblem(read.input) ?? llmcInputProblem(MC_ACT_TOOL, read.input) ?? '';
  };
  it('a vertical with no liquid is refused with the three values and an example', () => {
    const text = problemOf('vertical down stairs south y=10 dig=stone,dirt');
    expect(text).toContain('手1（vertical）');
    expect(text).toContain('liquid が要る');
    expect(text).toContain('liquid=stop|seal|seal_water');
    expect(text).toContain('例: vertical down stairs south y=10 dig=stone,dirt liquid=stop');
    expect(problemOf('vertical down stairs south y=10 dig=stone,dirt liquid=stop')).toBe('');
  });
  it('a liquid that is not one of the three is refused with the three', () => {
    expect(problemOf('vertical down stairs south y=10 dig=stone liquid=seal-water')).toContain('stop・seal・seal_water');
  });
  it('maxDig above 200 (and maxPlace above 100) is refused with the top and the default, before the schema\'s plain range', () => {
    const dig = problemOf('vertical down stairs south y=10 dig=stone liquid=stop maxDig=250');
    expect(dig).toContain('手1（vertical）: maxDig は 0〜200 の整数（200 まで。今は 250。書かなければ既定の 200）');
    expect(problemOf('vertical down shaft y=-50 dig=stone liquid=stop maxPlace=101')).toContain('maxPlace は 0〜100 の整数（100 まで。今は 101。書かなければ既定の 100）');
    expect(problemOf('vertical down stairs south y=10 dig=stone liquid=stop maxDig=200 maxPlace=100')).toBe('');
    // a go keeps its own bounds (the schema's, 0 to 200): it is not told the vertical's default
    expect(problemOf('go 1,2,3 maxDig=250')).not.toContain('書かなければ既定の 200');
    // a json hand is told the same
    expect(llmcInputProblem(MC_ACT_TOOL, { hands: [{ do: 'vertical', dir: 'down', shape: 'shaft', toY: 10, canDig: ['stone'], liquid: 'stop', maxDig: 250 }] })).toContain('書かなければ既定の 200');
  });
  it('the lines of the fixture short-hands.json that are refused are still refused, now with the mend in the words', () => {
    const sheet = JSON.parse(fs.readFileSync(new URL('./fixtures/continue/vertical/short-hands.json', import.meta.url), 'utf8')) as { expected: { refused: Array<{ line: string }> } };
    expect(sheet.expected.refused).toHaveLength(5);
    for (const { line } of sheet.expected.refused) expect([line, problemOf(line) !== '']).toEqual([line, true]);
  });
  it('every vertical example of the tool\'s description writes liquid=, and the limits and the keep example are shown', () => {
    const examples = (SHORT_ACT_DESCRIPTION.match(/vertical (?:down|up) (?:stairs|shaft|pillar)[^\n]*/gu) ?? []).flatMap(line => line.split(/ {2,}(?=vertical )/u));
    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const example of examples) expect(example, example).toContain('liquid=');
    expect(SHORT_ACT_DESCRIPTION).toContain('maxDig は 200・maxPlace は 100 まで');
    expect(SHORT_ACT_DESCRIPTION).toContain('seconds 5〜120（書かなければ高さから見積もる');
    expect(SHORT_ACT_DESCRIPTION).toContain('keep（["spruce_planks:4:作業台"]）');
    expect(SHORT_ACT_DESCRIPTION).toContain('品目:数:用途');
  });
});

describe('the system text: keep in the order of what to do, within the size', () => {
  it('says keep once, in the deciding lines, and stays within 8,800 tokens', () => {
    expect(V2_ALWAYS).toContain('後で使う物は act の keep に書く（帳簿に載る）');
    expect(V2_ALWAYS.split('act の keep').length).toBe(2);
    expect(llmcTokens(minecraftV2System(V2_ALWAYS))).toBeLessThanOrEqual(8_800);
  });
});

describe('A-8 follow-up: a vertical field written as a word and a value is refused with its form', () => {
  it('"maxDig 200" says maxDig=200 (the head does not read it as that field)', () => {
    const read = lineToHand('vertical down stairs south y=10 dig=stone maxDig 200 liquid=stop');
    expect(read).toHaveProperty('error');
    expect((read as { error: string }).error).toContain('maxDig 200');
    expect((read as { error: string }).error).toContain('maxDig=200 の形');
    expect(lineToHand('vertical down stairs south y=10 dig=stone maxDig=200 liquid=stop')).toMatchObject({ do: 'vertical', maxDig: 200 });
  });
});
