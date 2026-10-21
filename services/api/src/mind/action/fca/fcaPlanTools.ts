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

/** A tree handed to the task from outside its decisions (the first plan, `minecraftFirstPlan.ts`): taken at the next read, once. */
export interface FcaPlanInbox { take(taskId: string, tree: PlanTree): { tree: PlanTree; note: string } | null }

/** One step's plan: the tool, what a decision and a body read of it, and what the step commits. */
export interface FcaPlanPort {
  /** The path to the current node (live), or null when the task holds no plan yet. */
  view(): (PlanPathView & { revision: number; note?: string }) | null;
  /** What a body shows (`BodyTaskContext.plan`), or undefined. */
  display(): ReturnType<typeof planDisplay> | undefined;
  /** The flat copy, when the tree changed in this step (the commit writes `plan_json` and the event then). */
  committed(): ReturnType<typeof flatPlan> | null;
  tree(): PlanTree;
}

/** The plan part of a decision's input (`FcaModelInput.plan`), when the task keeps a plan. */
export function planInput(plan: FcaPlanPort | undefined): { plan?: Record<string, unknown> } {
  const view = plan?.view();
  return view ? { plan: { ...view } } : {};
}

export function createFcaPlanTools(parts: { taskId: string; checkpoint: unknown; inbox?: FcaPlanInbox; log?(line: string): void }):
  { tools: FcaExternalTools; port: FcaPlanPort } {
  const kept = readPlanTree((parts.checkpoint as { fcaPlanTree?: unknown } | null)?.fcaPlanTree);
  let tree = kept ?? emptyPlanTree(), changed = false, note: string | undefined;
  const say = (line: string) => { try { parts.log?.(line); } catch { /* logging never fails a step */ } };
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
      return tree.nodes.length ? { revision: tree.revision, ...planPath(tree), ...(note ? { note } : {}) } : null;
    },
    display: () => tree.nodes.length ? planDisplay(tree) : undefined,
    committed: () => changed ? flatPlan(tree) : null,
    tree: () => tree,
  };
  const tools: FcaExternalTools = {
    definitions: [PLAN_UPDATE_DEFINITION],
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
