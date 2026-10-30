import {
  applyPlanUpdate, emptyPlanTree, flatPlan, orderedPlan, planDisplay, planPath, planText, readPlanTreeWith, PLAN_KINDS, PLAN_LIMITS, PREP_STATES,
  type PlanPathView, type PlanTree, type PlanUpdate,
} from '@shannon/mind';
import type { FcaExternalTools, FcaToolDefinition } from './fcaPorts.js';
import { toolFailure, toolOk } from '../../tools/toolRegistryPorts.js';
import { parseCondition } from '../../../contracts/minecraftActCondition.js';
import { applyLedger, readLedgerSeen, type LedgerAdded, type LedgerInput, type LedgerSeen } from '../../../surfaces/minecraft/minecraftLlmcPromises.js';
import { offer, withdraw } from '../../../surfaces/minecraft/minecraftLlmcOnceFacts.js';
import { noteKindRaw } from '../../../infra/decisionRecords/decisionRecordNotes.js';

/**
 * `plan.update` (design mb-llm-centric 2.7): a core tool of the FCA, for a task that keeps a plan tree
 * (`@shannon/mind` planTree). The
 * tree is the task's, in its checkpoint (`fcaPlanTree`), written in the same transaction as the step; the flat copy goes to
 * `agent_tasks.plan_json` and the change is an event (`fca_plan_updated`) when the step commits
 * (`TaskCommit.plan`). Each decision reads
 * the path to the current node (`FcaModelInput.plan`); the whole tree only in this tool's result.
 */
export const PLAN_UPDATE_TOOL = 'plan.update';
/**
 * The continue contract (chapters 3 and 7): a node's `kind` and `prep` (what the model says of the node; the
 * head's code reads these
 * and never the title), and the ops
 * `promise` and `release` (what to keep, for what). A kind outside the list is taken as `other`.
 * `until.condition` and `instead` are
 * texts (`have:crafting_table>=1`) the
 * tool reads into conditions; one that does not read is said, not guessed.
 */
const kindField = { type: 'string', enum: [...PLAN_KINDS], description: '節の種類（頭のコードは題でなくこれで見る）' };
const prepField = { type: 'object', additionalProperties: false, required: ['state'], properties: {
  state: { type: 'string', enum: [...PREP_STATES] }, why: { type: 'string', maxLength: PLAN_LIMITS.text } },
  description: '準備の節の状態: met（満たした）・skipped（承知で省いた）・unmet_now（今は足りない）' };
const promiseFields = {
  item: { type: 'string', maxLength: 64, description: 'promise: 物の名前（oak_planks。planks は全部の板）か food（食料の点）' },
  count: { type: 'integer', minimum: 1, maximum: PLAN_LIMITS.promiseCount },
  use: { type: 'string', maxLength: PLAN_LIMITS.promiseUse, description: 'promise: 用途' },
  until: { type: 'object', additionalProperties: false, properties: { node: { type: 'string', maxLength: 32 }, condition: { type: 'string', maxLength: 160 } },
    description: 'promise の期間: 節が済むまで・条件を満たすまで' },
  instead: { type: 'string', maxLength: 160, description: 'promise: 代わりにこれを満たせば足りる条件（have:crafting_table>=1）' },
  why: { type: 'string', maxLength: PLAN_LIMITS.reason, description: 'release の理由' },
};
const nodeDraft = { type: 'object', additionalProperties: false, required: ['title'], properties: {
  id: { type: 'string', maxLength: 32 }, title: { type: 'string', minLength: 1, maxLength: PLAN_LIMITS.title },
  where: { type: 'string', maxLength: PLAN_LIMITS.text }, doneWhen: { type: 'string', maxLength: PLAN_LIMITS.text },
  note: { type: 'string', maxLength: PLAN_LIMITS.text }, state: { type: 'string', enum: ['done', 'blocked', 'continue', 'wait'] },
  kind: kindField, prep: prepField,
} };
/** The id of an op: a node's (a word) or a promise's (its number). */
const opId = { type: ['string', 'integer'] };
export const PLAN_UPDATE_DEFINITION: FcaToolDefinition = {
  name: PLAN_UPDATE_TOOL, domain: 'task_runtime', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'],
  input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  description: [
    '自分の計画ツリーを直す（節は64まで・深さ4まで）。毎判断の live の plan に、今の節までの道・今・次の3つ・止まっている節が出る。結果は木の全体。',
    'ops は順に全部当てるか、1つでも合わなければ何も変えない: add（parent・after・title・where・doneWhen・note）、split（id の下に into の節を足す）、',
    ("set（id の state=done|blocked|continue|wait・title・where・doneWhen・note・reason）、move（id を parent・after " +
"へ）、drop（id とその下を消す）。"),
    'current で今の節を決める。今の節を done にして current を書かなければ、次の済んでいない節が今になる。子が全部 done の親は done になる。',
    '計画が変わった時・節が済んだ時・止まった時に出す（毎回は要らない）。体の手と同じ応答で出してよい。',
    '約束（残す物と用途）: promise（item・count・use。期間は until、代わりに足りる条件は instead。id を書けば改訂）、release（id・why）。約束を書くのは自分だけ。',
    '頭は使われた量と理由を帳簿にして live に出す。条件の文は have:crafting_table>=1 の形。',
    ("節には kind（種類）と prep（準備の節の状態 met|skipped|unmet_now と why）を add・split・set で付けられる。準備を省くと決めた時は、skipped と " +
"why（理由）を自分で書く。"),
  ].join(''),
  nativeInputSchema: { type: 'object', additionalProperties: false, required: [], properties: {
    ops: { type: 'array', maxItems: PLAN_LIMITS.ops, items: { type: 'object', additionalProperties: false, required: ['op'], properties: {
      op: { type: 'string', enum: ['add', 'split', 'set', 'move', 'drop', 'promise', 'release'] }, id: opId,
      parent: { type: ['string', 'null'], maxLength: 32 }, after: { type: ['string', 'null'], maxLength: 32 },
      title: { type: 'string', maxLength: PLAN_LIMITS.title }, where: { type: 'string', maxLength: PLAN_LIMITS.text },
      doneWhen: { type: 'string', maxLength: PLAN_LIMITS.text }, note: { type: 'string', maxLength: PLAN_LIMITS.text },
      reason: { type: 'string', maxLength: PLAN_LIMITS.reason }, state: { type: 'string', enum: ['done', 'blocked', 'continue', 'wait'] },
      into: { type: 'array', minItems: 1, maxItems: PLAN_LIMITS.split, items: nodeDraft },
      kind: kindField, prep: prepField, ...promiseFields,
    } } },
    current: { type: ['string', 'null'], maxLength: 32 },
  } },
};

/**
 * mb-llmc r4 (mb-llmc r4; owner 2026-10-22): the same tool with each node's forbid and caution (arch-check 23: of what a
 * supervisor wrote, those held longest and worked). The ops `forbid` / `caution` add a line to a node (the
 * current one when `id` is absent),
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
      op: { type: 'string', enum: ['add', 'split', 'set', 'move', 'drop', 'promise', 'release', 'forbid', 'caution', 'lift'] }, id: opId,
      parent: { type: ['string', 'null'], maxLength: 32 }, after: { type: ['string', 'null'], maxLength: 32 },
      title: { type: 'string', maxLength: PLAN_LIMITS.title }, where: { type: 'string', maxLength: PLAN_LIMITS.text },
      doneWhen: { type: 'string', maxLength: PLAN_LIMITS.text }, note: { type: 'string', maxLength: PLAN_LIMITS.text },
      reason: { type: 'string', maxLength: PLAN_LIMITS.reason }, state: { type: 'string', enum: ['done', 'blocked', 'continue', 'wait'] },
      into: { type: 'array', minItems: 1, maxItems: PLAN_LIMITS.split, items: nodeDraftWithRules },
      kind: kindField, prep: prepField, ...promiseFields,
      text: { type: 'string', maxLength: PLAN_LIMITS.rule, description: 'forbid・caution・lift の 1 行' },
      forbid: rules, caution: rules,
    } } },
    current: { type: ['string', 'null'], maxLength: 32 },
  } },
};

/** A tree handed to the task from outside its decisions (the first plan, `minecraftFirstPlan.ts`): taken at the
 * next read, once. */
export interface FcaPlanInbox { take(taskId: string, tree: PlanTree): { tree: PlanTree; note: string } | null }

/** What `FcaPlanPort.keepPromise` did: a promise `made`, `revised` (from `was`, the count before) or `same`
 * (already so, nothing changed). */
export interface KeptPromise { how: 'made' | 'revised' | 'same'; id: number; rev: number; item: string; count: number; use: string; was?: number }

/** One step's plan: the tool, what a decision and a body read of it, and what the step commits. */
export interface FcaPlanPort {
  /** The path to the current node (live), or null when the task holds no plan yet. */
  view(): (PlanPathView & { revision: number; note?: string }) | null;
  /**
   * mb-llmc r8: what a decision's live state shows of the plan when the body says the current node itself
 * (`planNow`, with the path above
   * it): the view without its `path` and `now`, which `planNow` repeats. Absent: `view()`.
   */
  liveView?(): Record<string, unknown> | null;
  /** What a body shows (`BodyTaskContext.plan`), or undefined. */
  display(): ReturnType<typeof planDisplay> | undefined;
  /** The flat copy, when the tree changed in this step (the commit writes `plan_json` and the event then). */
  committed(): ReturnType<typeof flatPlan> | null;
  tree(): PlanTree;
  /**
   * mb-llmc r5: a change the head's code makes to the plan (a node seen done, a fact noted as a caution), all or
 * nothing, said in the log by
   * `why` (closed words). True when the tree changed. Absent: only the model changes the plan.
   */
  amend?(update: PlanUpdate, why: string): boolean;
  /**
   * Amendment A-7 1: an act's `keep` (item, count, use) put to the plan as a promise, by the same handling as
 * `plan.update`'s `promise` op (`applyPlanUpdate`). An open promise
   * (not closed) of the same item and use is revised to the new count (its id, its rev up one, its `until` and
 * `instead` kept); with the same count nothing changes. None
   * of that item and use: a new promise. The act's `uses` is not touched. `problem` when the plan refuses it (the
 * promises are full), the tree then unchanged.
   */
  keepPromise?(entry: { item: string; count: number; use: string }): KeptPromise | { problem: string };
  /**
   * The continue contract, chapter 3, **the one way into the ledger**: the body's inventory events and the newest
 * observation are put to the tree's promises
   * (`minecraftLlmcPromises.ts`, `applyLedger`) and the memory that keeps an event from being put twice
 * (`ledgerSeen`, saved with the tree in the checkpoint).
   * The plan's revision does not move and `committed()` does not change (the flat copy has no ledger); the
 * checkpoint carries it. An `instead` that stopped
   * holding is offered as a fact said once (`minecraftLlmcOnceFacts`). Returns the lines put to the ledgers.
   */
  applyLedger(input: Omit<LedgerInput, 'nodes' | 'at'> & { at?: string }): LedgerAdded[];
  /** The ledger's memory (for a test and for the size measure). */
  ledgerSeen(): LedgerSeen;
  /**
   * The step's commit succeeded: what the checkpoint of this step held (the tree and the ledger's memory) is
 * saved. The runner calls it right after the commit; the owner of the
   * ledger's inputs then marks the receipts that checkpoint holds as processed (amendment A-6 12). Absent: nothing is told.
   */
  afterCommit?(): void;
}

/**
 * The ops of a `plan.update` as the model wrote them, in the form `applyPlanUpdate` takes: a promise's
 * `until.condition` and `instead` are texts read by
 * `parseCondition` (one that does not read is said, with the form to write: nothing is guessed), and the number
 * of a promise or a release may be written as
 * `3` or `#3`.
 */
function readOps(input: PlanUpdate): { update: PlanUpdate } | { problem: string } {
  if (!Array.isArray(input.ops)) return { update: input };
  const ops: unknown[] = [];
  for (const [index, raw] of input.ops.entries()) {
    const op = raw && typeof raw === 'object' ? { ...raw as Record<string, unknown> } : null;
    if (!op || (op.op !== 'promise' && op.op !== 'release')) { ops.push(raw);
      continue; }
    if (typeof op.id === 'string' && /^#?\d{1,6}$/u.test(op.id)) op.id = Number(op.id.replace('#', ''));
    const until = op.until && typeof op.until === 'object' && !Array.isArray(op.until) ? { ...op.until as Record<string, unknown> } : undefined;
    const problem = readPromiseConditions(op, until, index);
    if (problem) return problem;
    if (until) op.until = until;
    ops.push(op);
  }
  return { update: { ...input, ops: ops as PlanUpdate['ops'] } };
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
  /** The clock (ISO) for the times a promise and a preparation state keep. Absent: now. */
  now?(): string;
  /** mb-llmc r8: the live state shows the plan without the path and the now that the body's `planNow` says
 * (`FcaPlanPort.liveView`). Absent: whole. */
  compact?: boolean;
  /** A surface may reject an explicit model update before any of its operations are committed. */
  validateUpdate?(before: PlanTree, after: PlanTree): string | null;
  /**
   * mb-llmc r5: at each read of the plan, the change the body's frame shows (the nodes seen done,
 * `minecraftPlanDone.ts`), applied before
   * the decision reads the path. Absent: none.
   */
  seen?(tree: PlanTree): { update: PlanUpdate; ids: readonly string[]; closed?: readonly string[]; descended?: readonly string[];
    /** r9: nodes whose place or dimension holds while a child is open, so are not done (`p2←p2.1,p2.3`): said in the
 * log when the set changes. */
    held?: readonly string[] } | null;
  /**
   * run 26: after the nodes seen done, the node the model's last acts were tagged for, when it is not the current
 * one: the current node moves to it
   * (`followNode`, `minecraftLlmcNode.ts`) and the plan's note says so once. Absent: the current node moves only
 * by the model's plan.update and by done.
   */
  follow?(tree: PlanTree): { to: string; from: string | null; acts: number; words?: string } | null;
  /**
   * Amendment A-6 12: the checkpoint is being taken (the ledger's memory is read into it now), and the commit that
 * saves it succeeded (`FcaPlanPort.afterCommit`). The owner of the
   * receipts the ledger takes marks them processed only after the second, and only the ones it had taken at the first.
   */
  onCheckpoint?(): void; onCommitted?(): void }):
  { tools: FcaExternalTools; port: FcaPlanPort } {
  const held = readPlanTreeWith((parts.checkpoint as { fcaPlanTree?: unknown } | null)?.fcaPlanTree);
  const kept = held?.tree ?? null;
  let tree = kept ?? emptyPlanTree(), changed = false, note: string | undefined;
  let ledgerSeen = readLedgerSeen((parts.checkpoint as { fcaPlanLedgerSeen?: unknown } | null)?.fcaPlanLedgerSeen);
  const say = (line: string) => { try { parts.log?.(line); } catch { /* logging never fails a step */ } };
  // A v1 tree read back is moved to v2 once (chapter 7); the checkpoint of this step then holds v2, so the line is said once.
  if (held?.migrated) say(`Shannon FCA plan migrated task=${parts.taskId} from=v1 revision=${tree.revision}`);
  const stamp = () => (parts.now ?? (() => new Date().toISOString()))();
  /** r5: a change of the head's own, all or nothing; logged with what is done now and the current node. */
  const amend = (update: PlanUpdate, why: string, detail = ''): boolean => {
    const result = applyPlanUpdate(tree, update, { at: stamp() });
    if (result.problem || !result.changed) return false;
    tree = result.tree;
    changed = true;
    const done = orderedPlan(tree.nodes).filter(node => node.state === 'done').length;
    say(("Shannon FCA plan " +
`${/^[a-z_]{1,16}$/u.test(why) ? why : 'amended'}` +
" task=" +
`${parts.taskId}` +
" revision=" +
`${tree.revision}` +
" done=" +
`${done}` +
"" +
`${detail}` +
" ")
      + `current=${tree.current ?? '-'}`);
    return true;
  };
  /** r5: the nodes the frame shows done, marked so before the path is read. */
  const settle = () => {
    let seen: ReturnType<NonNullable<typeof parts.seen>> = null;
    try { seen = tree.nodes.length ? parts.seen?.(tree) ?? null : null; } catch { seen = null; }
    const closed = (seen?.closed?.length ? ` closed=${seen.closed.join(',')}` : '') + (seen?.descended?.length ? ` descended=${seen.descended.join(',')}` : '');
    if (seen?.ids.length) amend(seen.update, 'settled', ` seen=${seen.ids.slice(0, 8).join(',')}${closed}`);
    // r9: a node whose place holds with children open is not done; said once per change, so the log shows what the code left open.
    const held = (seen?.held ?? []).join(' ');
    if (held !== (heldSaid.get(parts.taskId) ?? '')) {
      heldSaid.delete(parts.taskId);
      heldSaid.set(parts.taskId, held);
      if (heldSaid.size > 32) heldSaid.delete(heldSaid.keys().next().value as string);
      if (held) say(`Shannon FCA plan held task=${parts.taskId} revision=${tree.revision} held=${held}`);
    }
  };
  /** run 26: the current node follows the node the model keeps working on (a change of the head's own, said in the
 * log and once in the plan's note). */
  const followed = () => {
    let to: ReturnType<NonNullable<typeof parts.follow>> = null;
    try { to = tree.nodes.length ? parts.follow?.(tree) ?? null : null; } catch { to = null; }
    if (!to || !amend({ ops: [], current: to.to }, 'followed', ` from=${to.from ?? '-'} to=${to.to} acts=${to.acts}`)) return;
    // Run 41: the words are the follower's when it has them (a move to a preparation node says which and why; a move
// on names the nodes it passed).
    const words = to.words ?? `今の節を [${to.to}] に進めた（体が [${to.to}] の項目を始めたため）。飛ばした節は順のまま残っている`;
    note = note ? `${note} ${words}` : words;
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
      followed();
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
    keepPromise(entry) {
      adopt();
      const use = String(entry.use).trim();
      const old = tree.promises.find(item => item.state !== 'closed' && item.item === entry.item && item.use === use);
      if (old && old.count === entry.count) return { how: 'same', id: old.id, rev: old.rev, item: old.item, count: old.count, use: old.use };
      // A revision writes the promise whole: its `until` and `instead` are carried (the act's keep says only the count).
      const op = { op: 'promise' as const, ...(old ? { id: old.id, ...(old.until ? { until: old.until } : {}), ...(old.instead ? { instead:
         old.instead } : {}) } : {}),
        item: entry.item, count: entry.count, use };
      const result = applyPlanUpdate(tree, { ops: [op] }, { at: stamp() });
      if (result.problem) return { problem: result.problem };
      tree = result.tree;
      changed = true;
      const made = old ? tree.promises.find(item => item.id === old.id) : tree.promises.filter(item => item.item === entry.item && item.use === use).at(-1);
      if (!made) return { problem: '約束を作れなかった' };
      say(`Shannon FCA plan kept task=${parts.taskId} revision=${tree.revision} promise=${made.id} rev=${made.rev} how=${old ? 'revised' :
         'made'} item=${made.item} count=${made.count}`);
      return { how: old ? 'revised' : 'made', id: made.id, rev: made.rev, item: made.item, count: made.count, use: made.use, ...(old ? {
         was: old.count } : {}) };
    },
    applyLedger(input) {
      adopt();
      const result = applyLedger(tree.promises, ledgerSeen, { ...input, at: input.at ?? stamp(), nodes: tree.nodes });
      if (result.promises.some((item, index) => item !== tree.promises[index])) tree = { ...tree, promises: result.promises };
      ledgerSeen = result.ledgerSeen;
      for (const fact of result.facts) offer(parts.taskId, fact.key, fact.text);
      for (const key of result.withdrawn) withdraw(parts.taskId, key);
      if (result.added.length) {
        say(("Shannon FCA plan ledger task=" +
`${parts.taskId}` +
" added=" +
`${result.added.length}` +
" kinds=" +
`${[...new Set(result.added.map(item => item.kind))].join(',')}` +
" ")
          + `open=${tree.promises.filter(item => item.state !== 'closed').length}`);
      }
      return result.added;
    },
    ledgerSeen: () => ledgerSeen,
    afterCommit() { try { parts.onCommitted?.(); } catch { /* the mark is retried by the next commit; a mark never fails a step */ } },
  };
  const tools: FcaExternalTools = {
    definitions: [parts.rules ? PLAN_UPDATE_RULES_DEFINITION : PLAN_UPDATE_DEFINITION],
    checkpoint: () => {
      parts.onCheckpoint?.();
      return tree.nodes.length || tree.promises.length || kept
        ? { fcaPlanTree: tree, ...(ledgerSeen.eventIds.length || ledgerSeen.lastObs ? { fcaPlanLedgerSeen: ledgerSeen } : {}) } : {};
    },
    async execute(call) {
      call.signal.throwIfAborted();
      if (call.name !== PLAN_UPDATE_TOOL) throw new Error('FCA_TOOL_NOT_OFFERED');
      const input = call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input as PlanUpdate : null;
      if (!input || Object.keys(input).some(key => key !== 'ops' && key !== 'current')) {
        return toolFailure('invalid_input', 'plan.update は ops と current だけを取る。', { retryable: false });
      }
      adopt();
      const read = readOps(input);
      if ('problem' in read) return toolFailure('invalid_input', `計画は変えていない: ${read.problem}\n${planText(tree)}`, { retryable: false });
      const result = applyPlanUpdate(tree, read.update, { at: stamp() });
      if (result.problem) return toolFailure('invalid_input', `計画は変えていない: ${result.problem}\n${planText(tree)}`, { retryable: false });
      const problem = parts.validateUpdate?.(tree, result.tree);
      if (problem) return toolFailure('invalid_input', `計画は変えていない: ${problem}\n${planText(tree)}`, { retryable: false });
      if (result.changed) {
        // Continue contract 7 and 8: a kind outside the list was taken as `other`; the word the model wrote goes into
// the decision's record (`kindRaw`).
        const written = new Map(tree.nodes.map(node => [node.id, node.kindRaw]));
        noteKindRaw(result.tree.nodes.filter(node => node.kindRaw && written.get(node.id) !== node.kindRaw).map(node => ({ node: node.id,
           kindRaw: node.kindRaw! })));
        tree = result.tree;
        changed = true;
        note = undefined;
        const done = orderedPlan(tree.nodes).filter(node => node.state === 'done').length;
        say(("Shannon FCA plan updated task=" +
`${parts.taskId}` +
" revision=" +
`${tree.revision}` +
" nodes=" +
`${tree.nodes.length}` +
" done=" +
`${done}` +
" current=" +
`${tree.current ?? '-'}` +
""));
      }
      return toolOk(result.changed ? planText(tree) : `変化なし\n${planText(tree)}`);
    },
  };
  return { tools, port };
}

/** 約束の期限条件と代替条件を、同じ条件パーサーで読む。 */
function readPromiseConditions(op: Record<string, unknown>, until: Record<string, unknown> | undefined, index: number): { problem: string } | null {
    for (const [field, text, label] of [['condition', until?.condition, 'until.condition'], ['instead', op.instead, 'instead']] as const) {
      if (text === undefined) continue;
      const parsed = typeof text === 'string' ? parseCondition(text, label) : { ok: false as const, problem: `${label} は条件の文` };
      if (!parsed.ok) return { problem: `ops[${index}]: ${parsed.problem}` };
      if (field === 'condition') until!.condition = parsed.condition;
      else op.instead = parsed.condition;
    }
  return null;
}
