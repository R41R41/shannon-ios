import {
  applyPlanUpdate, emptyPlanTree, flatPlan, orderedPlan, planDisplay, planPath, planText, readPlanTree, PLAN_LIMITS,
  type PlanPathView, type PlanTree, type PlanUpdate,
} from '@shannon/mind';
import type { FcaExternalTools, FcaToolDefinition } from './fcaPorts.js';
import { toolFailure, toolOk } from '../../tools/toolRegistryPorts.js';

/**
 * `plan.update` (design mb-llm-centric 2.7): a core tool of the FCA, for a task that keeps a plan tree (`@shannon/mind` planTree). The
 * tree is the task's, in its checkpoint (`fcaPlanTree`), written in the same transaction as the step; the flat copy goes to
 * `agent_tasks.plan_json` and the change is an event (`fca_plan_updated`) when the step commits (`TaskCommit.plan`). Each decision reads
 * the path to the current node (`FcaModelInput.plan`); the whole tree only in this tool's result.
 */
export const PLAN_UPDATE_TOOL = 'plan.update';
const nodeDraft = { type: 'object', additionalProperties: false, required: ['title'], properties: {
  id: { type: 'string', maxLength: 32 }, title: { type: 'string', minLength: 1, maxLength: PLAN_LIMITS.title },
  where: { type: 'string', maxLength: PLAN_LIMITS.text }, doneWhen: { type: 'string', maxLength: PLAN_LIMITS.text },
  note: { type: 'string', maxLength: PLAN_LIMITS.text }, state: { type: 'string', enum: ['done', 'blocked', 'continue', 'wait'] },
} };
export const PLAN_UPDATE_DEFINITION: FcaToolDefinition = {
  name: PLAN_UPDATE_TOOL, domain: 'task_runtime', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'],
  input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  description: [
    '自分の計画ツリーを直す（節は64まで・深さ4まで）。毎判断の live の plan に、今の節までの道・今・次の3つ・止まっている節が出る。結果は木の全体。',
    'ops は順に全部当てるか、1つでも合わなければ何も変えない: add（parent・after・title・where・doneWhen・note）、split（id の下に into の節を足す）、',
    'set（id の state=done|blocked|continue|wait・title・where・doneWhen・note・reason）、move（id を parent・after へ）、drop（id とその下を消す）。',
    'current で今の節を決める。今の節を done にして current を書かなければ、次の済んでいない節が今になる。子が全部 done の親は done になる。',
    '計画が変わった時・節が済んだ時・止まった時に出す（毎回は要らない）。体の手と同じ応答で出してよい。',
  ].join(''),
  nativeInputSchema: { type: 'object', additionalProperties: false, required: [], properties: {
    ops: { type: 'array', maxItems: PLAN_LIMITS.ops, items: { type: 'object', additionalProperties: false, required: ['op'], properties: {
      op: { type: 'string', enum: ['add', 'split', 'set', 'move', 'drop'] }, id: { type: 'string', maxLength: 32 },
      parent: { type: ['string', 'null'], maxLength: 32 }, after: { type: ['string', 'null'], maxLength: 32 },
      title: { type: 'string', maxLength: PLAN_LIMITS.title }, where: { type: 'string', maxLength: PLAN_LIMITS.text },
      doneWhen: { type: 'string', maxLength: PLAN_LIMITS.text }, note: { type: 'string', maxLength: PLAN_LIMITS.text },
      reason: { type: 'string', maxLength: PLAN_LIMITS.reason }, state: { type: 'string', enum: ['done', 'blocked', 'continue', 'wait'] },
      into: { type: 'array', minItems: 1, maxItems: PLAN_LIMITS.split, items: nodeDraft },
    } } },
    current: { type: ['string', 'null'], maxLength: 32 },
  } },
};

/**
 * mb-llmc r4 (SHANNON_MINECRAFT_LLMC_PROBE; owner 2026-10-22): the same tool with each node's forbid and caution (arch-check 23: of what a
 * supervisor wrote, those held longest and worked). The ops `forbid` / `caution` add a line to a node (the current one when `id` is absent),
 * `lift` takes one off; `add` and `split` may carry them. The words and the schema are fixed (part of the cached prefix).
 */
const rules = { type: 'array', maxItems: PLAN_LIMITS.rules, items: { type: 'string', maxLength: PLAN_LIMITS.rule } };
const nodeDraftWithRules = { ...nodeDraft, properties: { ...nodeDraft.properties, forbid: rules, caution: rules } };
export const PLAN_UPDATE_RULES_DEFINITION: FcaToolDefinition = {
  ...PLAN_UPDATE_DEFINITION,
  description: [
    PLAN_UPDATE_DEFINITION.description,
    `禁止と注意: forbid（id の節で、してはいけない事を 1 行足す）・caution（気をつける事を 1 行足す）・lift（text の行を消す）。id が無ければ今の節。`,
    `1 行 ${PLAN_LIMITS.rule}字まで、各 ${PLAN_LIMITS.rules} 行まで（超えると古い行から消える）。add・split の節にも forbid・caution の配列を書ける。`,
    'live の plan.rules に、今の節と親の道の禁止・注意が出る（その節を離れると出ない）。驚きの後に原因が分かったら書き、要らなくなったら lift する。',
    '済み（r9）: doneWhen が観測の形の節は、頭のコードがその節自身の条件で済みにする。親が済みでも子は済みにならない（子は自分の条件か set state=done で）。',
    '場所・次元の条件（dim:・at:）の親は、子が済むまで済みにならない。済み扱いの子（消費して無くなった板・棒など）は set state=done で自分で閉じる。',
  ].join(''),
  nativeInputSchema: { type: 'object', additionalProperties: false, required: [], properties: {
    ops: { type: 'array', maxItems: PLAN_LIMITS.ops, items: { type: 'object', additionalProperties: false, required: ['op'], properties: {
      op: { type: 'string', enum: ['add', 'split', 'set', 'move', 'drop', 'forbid', 'caution', 'lift'] }, id: { type: 'string', maxLength: 32 },
      parent: { type: ['string', 'null'], maxLength: 32 }, after: { type: ['string', 'null'], maxLength: 32 },
      title: { type: 'string', maxLength: PLAN_LIMITS.title }, where: { type: 'string', maxLength: PLAN_LIMITS.text },
      doneWhen: { type: 'string', maxLength: PLAN_LIMITS.text }, note: { type: 'string', maxLength: PLAN_LIMITS.text },
      reason: { type: 'string', maxLength: PLAN_LIMITS.reason }, state: { type: 'string', enum: ['done', 'blocked', 'continue', 'wait'] },
      into: { type: 'array', minItems: 1, maxItems: PLAN_LIMITS.split, items: nodeDraftWithRules },
      text: { type: 'string', maxLength: PLAN_LIMITS.rule, description: 'forbid・caution・lift の 1 行' },
      forbid: rules, caution: rules,
    } } },
    current: { type: ['string', 'null'], maxLength: 32 },
  } },
};

/** A tree handed to the task from outside its decisions (the first plan, `minecraftFirstPlan.ts`): taken at the next read, once. */
export interface FcaPlanInbox { take(taskId: string, tree: PlanTree): { tree: PlanTree; note: string } | null }

/** One step's plan: the tool, what a decision and a body read of it, and what the step commits. */
export interface FcaPlanPort {
  /** The path to the current node (live), or null when the task holds no plan yet. */
  view(): (PlanPathView & { revision: number; note?: string }) | null;
  /**
   * mb-llmc r8: what a decision's live state shows of the plan when the body says the current node itself (`planNow`, with the path above
   * it): the view without its `path` and `now`, which `planNow` repeats. Absent: `view()`.
   */
  liveView?(): Record<string, unknown> | null;
  /** What a body shows (`BodyTaskContext.plan`), or undefined. */
  display(): ReturnType<typeof planDisplay> | undefined;
  /** The flat copy, when the tree changed in this step (the commit writes `plan_json` and the event then). */
  committed(): ReturnType<typeof flatPlan> | null;
  tree(): PlanTree;
  /**
   * mb-llmc r5: a change the head's code makes to the plan (a node seen done, a fact noted as a caution), all or nothing, said in the log by
   * `why` (closed words). True when the tree changed. Absent: only the model changes the plan.
   */
  amend?(update: PlanUpdate, why: string): boolean;
}

/** The plan part of a decision's input (`FcaModelInput.plan`), when the task keeps a plan. */
export function planInput(plan: FcaPlanPort | undefined): { plan?: Record<string, unknown> } {
  const view = plan?.liveView ? plan.liveView() : plan?.view();
  return view ? { plan: { ...view } } : {};
}

/** r9: the held set last said for each task (`Shannon FCA plan held`), so a step that finds the same set says nothing. */
const heldSaid = new Map<string, string>();

export function createFcaPlanTools(parts: { taskId: string; checkpoint: unknown; inbox?: FcaPlanInbox; log?(line: string): void;
  /** mb-llmc r4: offer the tool with forbid and caution (`PLAN_UPDATE_RULES_DEFINITION`). Absent: as before. */
  rules?: boolean;
  /** mb-llmc r8: the live state shows the plan without the path and the now that the body's `planNow` says (`FcaPlanPort.liveView`). Absent: whole. */
  compact?: boolean;
  /**
   * mb-llmc r5: at each read of the plan, the change the body's frame shows (the nodes seen done, `minecraftPlanDone.ts`), applied before
   * the decision reads the path. Absent: none.
   */
  seen?(tree: PlanTree): { update: PlanUpdate; ids: readonly string[];
    /** r9: nodes whose place or dimension holds while a child is open, so are not done (`p2←p2.1,p2.3`): said in the log when the set changes. */
    held?: readonly string[] } | null }):
  { tools: FcaExternalTools; port: FcaPlanPort } {
  const kept = readPlanTree((parts.checkpoint as { fcaPlanTree?: unknown } | null)?.fcaPlanTree);
  let tree = kept ?? emptyPlanTree(), changed = false, note: string | undefined;
  const say = (line: string) => { try { parts.log?.(line); } catch { /* logging never fails a step */ } };
  /** r5: a change of the head's own, all or nothing; logged with what is done now and the current node. */
  const amend = (update: PlanUpdate, why: string, detail = ''): boolean => {
    const result = applyPlanUpdate(tree, update);
    if (result.problem || !result.changed) return false;
    tree = result.tree;
    changed = true;
    const done = orderedPlan(tree.nodes).filter(node => node.state === 'done').length;
    say(`Shannon FCA plan ${/^[a-z_]{1,16}$/u.test(why) ? why : 'amended'} task=${parts.taskId} revision=${tree.revision} done=${done}${detail} `
      + `current=${tree.current ?? '-'}`);
    return true;
  };
  /** r5: the nodes the frame shows done, marked so before the path is read. */
  const settle = () => {
    let seen: ReturnType<NonNullable<typeof parts.seen>> = null;
    try { seen = tree.nodes.length ? parts.seen?.(tree) ?? null : null; } catch { seen = null; }
    if (seen?.ids.length) amend(seen.update, 'settled', ` seen=${seen.ids.slice(0, 8).join(',')}`);
    // r9: a node whose place holds with children open is not done; said once per change, so the log shows what the code left open.
    const held = (seen?.held ?? []).join(' ');
    if (held !== (heldSaid.get(parts.taskId) ?? '')) {
      heldSaid.delete(parts.taskId);
      heldSaid.set(parts.taskId, held);
      if (heldSaid.size > 32) heldSaid.delete(heldSaid.keys().next().value as string);
      if (held) say(`Shannon FCA plan held task=${parts.taskId} revision=${tree.revision} held=${held}`);
    }
  };
  /** A tree handed in (the first plan) replaces the one held, its done nodes carried over (`inbox.take`). */
  const adopt = () => {
    const handed = parts.inbox?.take(parts.taskId, tree);
    if (!handed) return;
    tree = handed.tree;
    changed = true;
    note = handed.note;
    say(`Shannon FCA plan adopted task=${parts.taskId} revision=${tree.revision} nodes=${tree.nodes.length} current=${tree.current ?? '-'}`);
  };
  const port: FcaPlanPort = {
    view() {
      adopt();
      settle();
      return tree.nodes.length ? { revision: tree.revision, ...planPath(tree), ...(note ? { note } : {}) } : null;
    },
    ...(parts.compact ? { liveView() {
      const view = port.view();
      if (!view) return null;
      // The now is repeated by `planNow` only where it has one; a tree with no current node keeps its view whole.
      if (!view.now) return { ...view };
      const { path: _path, now: _now, ...rest } = view;
      return rest;
    } } : {}),
    display: () => tree.nodes.length ? planDisplay(tree) : undefined,
    committed: () => changed ? flatPlan(tree) : null,
    tree: () => tree,
    amend(update, why) {
      adopt();
      return amend(update, why);
    },
  };
  const tools: FcaExternalTools = {
    definitions: [parts.rules ? PLAN_UPDATE_RULES_DEFINITION : PLAN_UPDATE_DEFINITION],
    checkpoint: () => tree.nodes.length || kept ? { fcaPlanTree: tree } : {},
    async execute(call) {
      call.signal.throwIfAborted();
      if (call.name !== PLAN_UPDATE_TOOL) throw new Error('FCA_TOOL_NOT_OFFERED');
      const input = call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input as PlanUpdate : null;
      if (!input || Object.keys(input).some(key => key !== 'ops' && key !== 'current')) {
        return toolFailure('invalid_input', 'plan.update は ops と current だけを取る。', { retryable: false });
      }
      adopt();
      const result = applyPlanUpdate(tree, input);
      if (result.problem) return toolFailure('invalid_input', `計画は変えていない: ${result.problem}\n${planText(tree)}`, { retryable: false });
      if (result.changed) {
        tree = result.tree;
        changed = true;
        note = undefined;
        const done = orderedPlan(tree.nodes).filter(node => node.state === 'done').length;
        say(`Shannon FCA plan updated task=${parts.taskId} revision=${tree.revision} nodes=${tree.nodes.length} done=${done} current=${tree.current ?? '-'}`);
      }
      return toolOk(result.changed ? planText(tree) : `変化なし\n${planText(tree)}`);
    },
  };
  return { tools, port };
}
