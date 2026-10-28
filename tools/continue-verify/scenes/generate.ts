/**
 * Writes `scenes/<scene>.json`, the skeleton of each scene's script, from `e2e/boundaries.json` (boundaries, seams, boundary8Scenes) and the
 * fixtures they name. The STRUCTURE is mechanical: one file for each boundary (but 8), each seam and each boundary-8 scene; its `benches`,
 * `fixtures`, `pass` (or `inject`/`corrections`/`deadline`/`records`) copied from the contract; every `$ref` in the steps resolved against the
 * fixture it points at (a missing file or path stops the run). The STEPS themselves are the table below: a skeleton of what the lab (bench B) and the
 * scripted model (bench C) do, in the vocabulary of `VOCABULARY`. The lab and the model scripts of the bench read these files; none is run here.
 *
 *   tsx tools/continue-verify/scenes/generate.ts [--check]      (--check: fail if the files on disk differ from what would be written)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../services/api/tests/fixtures/continue');

export const VOCABULARY = {
  lab: {
    'start-trace': 'the body starts its continuous file (trace_open source continuous) before anything else; never the 90-second ring',
    'send': '{command, act}: put an act on the body (act is {$ref} of a fixture value, or "lab:<name>": slow-walk (about 20 s), unreachable-dig (fails by itself), instant-eat, dig-down, wait-in-queue)',
    'enqueue': '{items}: put queue items behind the running one, each with after/dependsOn/pre (the head\'s envelope)',
    'set-body': '{hp, food, ...}: set the bot\'s state with the lab\'s own commands (RCON), not by playing',
    'rcon': '{cmd}: a server command through the lab (summon, kill, tp, effect, execute in ...)',
    'summon': '{entity, near, tag}: a monster near the bot',
    'wait-until': '{until}: command-running <id> | receipt-held <id> | head-notified-unknown <id> | reflex-ended <name> | poll-first <connection>',
    'kill-bot': '{moment}: /kill in running_hand | waiting_for_reflex | queued | awaiting_model; then mark the death',
    'hold-receipt': '{command, until}: the lab keeps the body\'s receipt from the head until the named condition',
    'release-receipt': '{command}: let the held receipt go to the head',
    'dup-poll': '{command}: send the poll that carries the command\'s receipt twice',
    'disconnect-body': 'cut the body\'s connection and connect again (a new connectionId)',
    'restart-body': 'restart the body process',
    'restart-head': '{stopAt, startAt}: stop the head, start it again (a new headBoot); the order of the receipt and the stop is the scene\'s',
    'swap-lease': 'renew the lease while the item waits',
    'portal': '{from, to}: walk through a portal; the life must not change',
    'start-owner': '{name, command}: a command takes the motor port (keys, shield, path goal)',
    'late-cleanup': '{owner, calls}: the old owner\'s slow cleanup runs after the new owner started',
    'mark': '{kind, ...}: write a mark into meta.json (deaths, injections) at the time it happened',
    'stop-trace': 'close the continuous file',
  },
  head: {
    'answer': '{turn, reads, tool, args}: the scripted model\'s answer at its n-th turn; `reads` are the commands whose receipts must be in the input',
    'restart': 'the head restarts here',
    'probe': '{kind}: write a probes.jsonl line (plan_snapshot, plan_decisions, plan_write, request_bytes, one_time_fact)',
  },
} as const;

type Json = unknown;
interface Step { op: string; [key: string]: Json }
interface Plan { title: string; lab?: Step[]; head?: Step[]; marks?: string[]; asks?: string[] }

const ref = (path: string) => ({ $ref: path });
const SLOW = 'lab:slow-walk';

/** The skeleton of each scene. Keys are the scene ids; `generate()` fails if the contract names a scene that has no entry here. */
export const PLANS: Record<string, Plan> = {
  'boundary-1': {
    title: '結果と列',
    lab: [{ op: 'start-trace' }, { op: 'set-body', hp: 6.2, food: 20 }, { op: 'summon', entity: 'zombie', near: 'bot', tag: 'e1' },
      { op: 'send', command: 'q1', act: ref('result/r43-reflex-ate-first.json#input.act') }, { op: 'wait-until', until: 'command-running q1' },
      { op: 'send', command: 'q12', act: 'lab:unreachable-dig' }, { op: 'enqueue', items: ref('continue/queue-item-depends.json#input.waiting') },
      { op: 'wait-until', until: 'receipt-held q12' }, { op: 'stop-trace' }],
    head: [{ op: 'answer', turn: 1, reads: [], tool: 'act', args: ref('result/r43-reflex-ate-first.json#input.act') },
      { op: 'answer', turn: 2, reads: ['q12'], tool: 'enqueue', args: ref('continue/queue-item-depends.json#input.waiting') }],
    marks: ['the reflex ate first: eat is already', 'the dependsOn [] item has startedAt'],
  },
  'boundary-2': {
    title: '途中の成果',
    lab: [{ op: 'start-trace' }, { op: 'send', command: 'q1', act: { hands: [ref('vertical/r45-hold5-shaft-down.json#input.hand')], from: ref('vertical/r45-hold5-shaft-down.json#input.from') } },
      { op: 'mark', kind: 'resume', from: 'q1', to: 'q2' }, { op: 'send', command: 'q2', act: { hands: [ref('vertical/r45-hold7-pillar-up.json#input.hand')], from: ref('vertical/r45-hold7-pillar-up.json#input.from') } },
      { op: 'stop-trace' }],
    marks: ['meta.resumes: the pair (a hand ended, the command that resumed it)', 'the evidence table: vertical/boundary2-evidence.json'],
  },
  'boundary-3': {
    title: '約束と消費',
    lab: [{ op: 'start-trace' }, { op: 'send', command: 'q1', act: ref('promise/r43-planks-burned-as-fuel.json#input.act') }, { op: 'send', command: 'q2', act: ref('promise/make-intermediate-and-reflex.json#input.act') },
      { op: 'send', command: 'q3', act: ref('promise/food-for-underground.json#input.steps.0.act') }, { op: 'stop-trace' }],
    head: [{ op: 'answer', turn: 1, reads: [], tool: 'plan.update', args: ref('promise/table-crafted-placed-picked.json#input.promises') },
      { op: 'answer', turn: 2, reads: ['q1'], tool: 'act', args: ref('promise/table-crafted-placed-picked.json#input.steps.0.act') }],
    marks: ['one ledger row at every receipt: {applied, have, observed}'],
  },
  'boundary-4': {
    title: 'すぐの引き継ぎ',
    lab: [{ op: 'start-trace' }, { op: 'summon', entity: 'zombie', near: 'bot', tag: '2601' }, { op: 'rcon', cmd: 'reflex floor-melee on #2601' },
      { op: 'send', command: 'q1', act: ref('control/r45-attack-waited-6-4s.json#input.act') }, { op: 'mark', kind: 'handover_case', case: 'same_target', command: 'q1' },
      { op: 'summon', entity: 'zombie', near: 'bot', tag: '3000' }, { op: 'send', command: 'q2', act: ref('control/different-target.json#input.act') }, { op: 'mark', kind: 'handover_case', case: 'different_target', command: 'q2' },
      { op: 'rcon', cmd: 'lava / breath / eat / low-hp flee, one at a time' }, { op: 'send', command: 'q3', act: ref('control/high-priority-not-taken.json#input.act') }, { op: 'mark', kind: 'handover_case', case: 'safety', command: 'q3' },
      { op: 'stop-trace' }],
    head: [{ op: 'answer', turn: 1, reads: [], tool: 'act', args: ref('control/r45-attack-waited-6-4s.json#input.act') }],
    marks: ['handover_case: same_target | different_target | safety'],
  },
  'boundary-5': {
    title: '死と非同期',
    lab: [{ op: 'start-trace' },
      { op: 'send', command: 'q11', act: SLOW }, { op: 'wait-until', until: 'command-running q11' }, { op: 'kill-bot', moment: 'running_hand' },
      { op: 'send', command: 'q12', act: SLOW }, { op: 'send', command: 'q13', act: SLOW }, { op: 'summon', entity: 'zombie', near: 'bot', tag: 'reflex' }, { op: 'wait-until', until: 'reflex-running' }, { op: 'kill-bot', moment: 'waiting_for_reflex' },
      { op: 'send', command: 'q14', act: SLOW }, { op: 'enqueue', items: [{ item: 'q15', after: 'q14' }] }, { op: 'kill-bot', moment: 'queued' },
      { op: 'wait-until', until: 'decision-in-flight' }, { op: 'kill-bot', moment: 'awaiting_model' }, { op: 'stop-trace' }],
    head: [{ op: 'answer', turn: 1, reads: [], tool: 'act', args: 'lab:slow-walk', delayMs: 8000 }],
    marks: ['deaths: {at, lifeBefore, lifeAfter, moment, waiting, decision}', 'the log is the continuous file, not the ring', 'life/r45-death-then-old-attack.json: the old act is refused stale_life'],
  },
  'boundary-6': {
    title: '古い持ち主',
    lab: [{ op: 'start-trace' }, { op: 'start-owner', name: 'A', command: 'q1' }, { op: 'start-owner', name: 'B', command: 'q2', controls: { forward: true, shield: true } },
      { op: 'mark', kind: 'new_owner', command: 'q2' }, { op: 'late-cleanup', owner: 'q1', calls: ref('control/stale-owner-cleanup.json#input.sequence.2.calls') },
      { op: 'mark', kind: 'late_cleanup', command: 'q1', calls: ref('control/stale-owner-cleanup.json#input.sequence.2.calls') }, { op: 'stop-trace' }],
    marks: ['the motor port\'s refusals: motor_refused lines'],
  },
  'boundary-7': {
    title: '次元と復活',
    lab: [{ op: 'start-trace' }, { op: 'send', command: 'q1', act: { hands: ref('life/portal-pending-other-dimension.json#input.running.hands') } },
      { op: 'enqueue', items: ref('life/portal-pending-other-dimension.json#input.waiting') }, { op: 'portal', from: 'overworld', to: 'the_nether' },
      { op: 'mark', kind: 'portal_pending', command: 'q2' }, { op: 'kill-bot', moment: 'running_hand' }, { op: 'rcon', cmd: 'respawn in overworld' }, { op: 'stop-trace' }],
    head: [{ op: 'answer', turn: 1, reads: [], tool: 'act', args: 'lab:slow-walk', delayMs: 8000 }],
    marks: ['life lines: {life, alive, dimension}', 'portal_pending: the awaited decision is discarded dimension_changed'],
  },
  'boundary-9': {
    title: '計画',
    head: [{ op: 'answer', turn: 1, reads: [], tool: 'first-plan', args: ref('plan/first-plan-with-kind.json#input.firstPlanAnswer') }, { op: 'probe', kind: 'plan_snapshot', stage: 'first_plan' },
      { op: 'answer', turn: 2, reads: [], tool: 'plan.update', args: { op: 'set', id: 'p3', prep: { state: 'skipped', why: '鉄を先に取る' } } }, { op: 'probe', kind: 'plan_write', by: 'llm' }, { op: 'probe', kind: 'plan_snapshot', stage: 'plan_update' },
      { op: 'probe', kind: 'plan_snapshot', stage: 'saved' }, { op: 'restart' }, { op: 'probe', kind: 'plan_snapshot', stage: 'head_restart' }, { op: 'probe', kind: 'plan_snapshot', stage: 'read_back' },
      { op: 'probe', kind: 'plan_decisions', variant: 'original', tree: ref('plan/title-renamed-same-decisions.json#input.tree') },
      { op: 'probe', kind: 'plan_decisions', variant: 'renamed', rename: ref('plan/title-renamed-same-decisions.json#input.rename') }],
    marks: ['the head writes no prep: plan_write by head with prep is a fail', 'plan/descended-without-prep-fact.json: the fact comes once, skipped is the model\'s'],
  },
  'boundary-10': {
    title: '実際の LLM の入力',
    head: [{ op: 'probe', kind: 'request_bytes', variant: 'normal', state: ref('measure/urgent-max-input.json#input.state') }, { op: 'probe', kind: 'request_bytes', variant: 'urgent', state: ref('measure/urgent-max-input.json#input.state') },
      { op: 'probe', kind: 'request_bytes', variant: 'compressed', state: ref('measure/urgent-max-input.json#input.state') },
      { op: 'probe', kind: 'one_time_fact', fact: ref('measure/one-time-fact-delivery.json#input.fact'), decisions: ref('measure/one-time-fact-delivery.json#input.decisions') }],
    marks: ['bench D calls the head\'s recordedClient in the form that returns the bytes and sends nothing'],
  },
  'seam-1': {
    title: '独立な項目が動いた後に、前の失敗が届く',
    lab: [{ op: 'start-trace' }, { op: 'send', command: 'q1', act: 'lab:unreachable-dig' }, { op: 'enqueue', items: [{ item: 'q2', after: 'q1', dependsOn: [] }] },
      { op: 'hold-receipt', command: 'q1', until: 'q2 started' }, { op: 'wait-until', until: 'command-running q2' }, { op: 'release-receipt', command: 'q1' },
      { op: 'mark', kind: 'independent_started', started: 'q2', failed: 'q1' }, { op: 'stop-trace' }],
    head: [{ op: 'answer', turn: 1, reads: ['q1'], tool: 'wait', args: {} }],
  },
  'seam-2': {
    title: 'onFail continue の失敗へ後続が頼る・間接の依存',
    lab: [{ op: 'start-trace' }, { op: 'send', command: 'q1', act: ref('continue/onfail-continue-does-not-exempt.json#input.act') },
      { op: 'enqueue', items: ref('continue/indirect-depends.json#input.queue.waiting') }, { op: 'mark', kind: 'chain', items: ['q1', 'q2', 'q3'] }, { op: 'stop-trace' }],
  },
  'seam-3': {
    title: '不明を見せた後の片付け・遅れた結果・同じ結果の再受信',
    lab: [{ op: 'start-trace' }, { op: 'send', command: 'q40', act: SLOW }, { op: 'hold-receipt', command: 'q40', until: 'head-notified-unknown q40' }, { op: 'wait-until', until: 'head-notified-unknown q40' },
      { op: 'release-receipt', command: 'q40' }, { op: 'dup-poll', command: 'q40' }, { op: 'stop-trace' }],
    head: [{ op: 'answer', turn: 1, reads: ['q40'], tool: 'wait', args: {} }],
    marks: ['cases: result/unknown-receipt-cleanup.json#input.cases'],
  },
  'seam-4': {
    title: '約束の改訂と、古い版で送った act の結果',
    lab: [{ op: 'start-trace' }, { op: 'send', command: 'q90', act: ref('promise/revised-after-send.json#input.sequence.0') }, { op: 'hold-receipt', command: 'q90', until: 'promise 3 revised' }, { op: 'release-receipt', command: 'q90' },
      { op: 'mark', kind: 'old_rev_result', command: 'q90', rev: 1 }, { op: 'stop-trace' }],
    head: [{ op: 'answer', turn: 1, reads: [], tool: 'plan.update', args: ref('promise/revised-after-send.json#input.sequence.1.planUpdate') }],
  },
  'seam-5': {
    title: 'act の外の食事・途中材・手の中断と反射の食事・repeat の周回',
    lab: [{ op: 'start-trace' }, { op: 'send', command: 'q80', act: ref('promise/food-for-underground.json#input.steps.0.act') }, { op: 'send', command: 'q91', act: ref('promise/make-intermediate-and-reflex.json#input.act') },
      { op: 'stop-trace' }],
    marks: ['a ledger row at every receipt, each pass of a repeat'],
  },
  'seam-6': {
    title: '引き継ぎの判定の間に、死・低体力・別の安全の反射が取る',
    lab: [{ op: 'start-trace' }, { op: 'summon', entity: 'zombie', near: 'bot', tag: '2601' }, { op: 'send', command: 'q1', act: ref('control/r45-attack-waited-6-4s.json#input.act') },
      { op: 'rcon', cmd: 'low-hp flee takes the body inside the 300 ms reservation' }, { op: 'mark', kind: 'handover_case', case: 'safety', command: 'q1' }, { op: 'stop-trace' }],
  },
  'seam-7': {
    title: '同じ life でポータルを移った後の、前の次元の待ち',
    lab: [{ op: 'start-trace' }, { op: 'send', command: 'q1', act: { hands: ref('life/portal-pending-other-dimension.json#input.running.hands') } }, { op: 'enqueue', items: ref('life/portal-pending-other-dimension.json#input.waiting') },
      { op: 'portal', from: 'overworld', to: 'the_nether' }, { op: 'mark', kind: 'portal_pending', command: 'q2' }, { op: 'stop-trace' }],
  },
  'seam-8': {
    title: '最大の長さの結果・帳簿・急ぎの live',
    head: [{ op: 'probe', kind: 'request_bytes', variant: 'urgent', state: ref('measure/urgent-max-input.json#input.state') }],
  },
  'b8-lost-receipt': {
    title: '受け取りが届かず、頭が unknown にしてから本当の受け取りが来る',
    lab: [{ op: 'start-trace' }, { op: 'send', command: 'q1', act: SLOW }, { op: 'hold-receipt', command: 'q1', until: 'head-notified-unknown q1' }, { op: 'wait-until', until: 'head-notified-unknown q1' },
      { op: 'release-receipt', command: 'q1' }, { op: 'stop-trace' }],
    head: [{ op: 'answer', turn: 1, reads: [], tool: 'act', args: SLOW }],
  },
  'b8-dup-poll': {
    title: '同じ受け取りの poll を 2 度送る',
    lab: [{ op: 'start-trace' }, { op: 'send', command: 'q1', act: ref('promise/same-receipt-twice.json#input') }, { op: 'dup-poll', command: 'q1' }, { op: 'stop-trace' }],
    head: [{ op: 'answer', turn: 1, reads: [], tool: 'act', args: SLOW }],
  },
  'b8-reconnect': {
    title: '実行中に体の接続を切ってつなぎ直す',
    lab: [{ op: 'start-trace' }, { op: 'send', command: 'q2', act: SLOW }, { op: 'enqueue', items: [{ item: 'q3', after: 'q2' }] }, { op: 'wait-until', until: 'command-running q2' },
      { op: 'mark', kind: 'reconnect' }, { op: 'disconnect-body' }, { op: 'wait-until', until: 'poll-first new-connection' }, { op: 'stop-trace' }],
    head: [{ op: 'answer', turn: 1, reads: [], tool: 'act', args: SLOW }],
  },
  'b8-head-restart-unacked': {
    title: '頭の再起動：受け取りがまだ ACK されていない',
    lab: [{ op: 'start-trace' }, { op: 'send', command: 'q2', act: SLOW }, { op: 'wait-until', until: 'command-running q2' }, { op: 'restart-head', stopAt: 'q2 running', startAt: 'before the head acks the receipt' }, { op: 'stop-trace' }],
    head: [{ op: 'answer', turn: 1, reads: [], tool: 'act', args: SLOW }, { op: 'restart' }],
  },
  'b8-head-restart-notified': {
    title: '頭の再起動：unknown を LLM へ知らせた後',
    lab: [{ op: 'start-trace' }, { op: 'send', command: 'q2', act: SLOW }, { op: 'hold-receipt', command: 'q2', until: 'head-notified-unknown q2' }, { op: 'wait-until', until: 'head-notified-unknown q2' },
      { op: 'restart-head', stopAt: 'after the model was told', startAt: 'after the real receipt was released' }, { op: 'release-receipt', command: 'q2' }, { op: 'stop-trace' }],
    head: [{ op: 'answer', turn: 1, reads: [], tool: 'act', args: SLOW }, { op: 'restart' }],
  },
  'b8-body-restart': {
    title: '実行中に体を再起動',
    lab: [{ op: 'start-trace' }, { op: 'send', command: 'q2', act: SLOW }, { op: 'wait-until', until: 'command-running q2' }, { op: 'mark', kind: 'body_restart' }, { op: 'restart-body' }, { op: 'wait-until', until: 'poll-first new-connection' }, { op: 'stop-trace' }],
    head: [{ op: 'answer', turn: 1, reads: [], tool: 'act', args: SLOW }],
  },
  'b8-lease-swap': {
    title: '待ちの間に lease を新しくする',
    lab: [{ op: 'start-trace' }, { op: 'send', command: 'q1', act: SLOW }, { op: 'enqueue', items: [{ item: 'q2', after: 'q1' }] }, { op: 'swap-lease' }, { op: 'stop-trace' }],
    head: [{ op: 'answer', turn: 1, reads: [], tool: 'act', args: SLOW }],
  },
};

function resolveRef(path: string): Json {
  const [file, pointer = ''] = path.split('#');
  const full = join(FIXTURES, file);
  if (!existsSync(full)) throw new Error(`scene $ref: the fixture ${file} does not exist`);
  let value: any = JSON.parse(readFileSync(full, 'utf8'));
  for (const part of pointer.split('.').filter(Boolean)) {
    if (value === null || typeof value !== 'object' || !(part in value)) throw new Error(`scene $ref: ${path} does not resolve at "${part}"`);
    value = value[part];
  }
  return value;
}
const inline = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(inline);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$ref') return { $ref: (value as { $ref: string }).$ref, value: resolveRef((value as { $ref: string }).$ref) };
    return Object.fromEntries(keys.map(key => [key, inline((value as Record<string, Json>)[key])]));
  }
  return value;
};

export interface SceneFile {
  scene: string; kind: 'boundary' | 'seam' | 'boundary8'; title: string; benches: string[]; benchesText: string; fixtures: string[]; contract: Record<string, Json>;
  judge: { scene: string; evidence: string; folder: string }; lab: Step[]; head: Step[]; marks: string[];
}

/** The scene files, as `{file name -> text}`. Throws when the contract names a scene that has no plan, or a plan names something that does not exist. */
export function generate(): Record<string, string> {
  const doc = JSON.parse(readFileSync(join(FIXTURES, 'e2e/boundaries.json'), 'utf8')) as {
    benches: Record<string, string>; evidence: string;
    boundaries: { n: number; name: string; benches: string[]; fixtures: string[]; pass: string[] }[]; seams: string[];
    boundary8Scenes: { id: string; inject: string; command: string; corrections: number; deadline: string | null; records: string[] }[];
  };
  const files: Record<string, string> = {};
  const used = new Set<string>();
  const put = (scene: SceneFile) => { files[`${scene.scene}.json`] = `${JSON.stringify(scene, null, 1)}\n`; };
  const plan = (id: string): Plan => { const found = PLANS[id]; if (!found) throw new Error(`the contract names the scene "${id}" but scenes/generate.ts has no plan for it`); used.add(id); return found; };
  const base = (id: string, kind: SceneFile['kind'], benches: string[], fixtures: string[], contract: Record<string, Json>): SceneFile => {
    const p = plan(id);
    for (const fixture of fixtures) if (!existsSync(join(FIXTURES, fixture))) throw new Error(`${id}: the fixture ${fixture} named by e2e/boundaries.json does not exist`);
    return { scene: id, kind, title: p.title, benches, benchesText: benches.join(','), fixtures, contract, judge: { scene: id, evidence: doc.evidence, folder: `<root>/${id}/` },
      lab: (p.lab ?? []).map(step => inline(step) as Step), head: (p.head ?? []).map(step => inline(step) as Step), marks: p.marks ?? [] };
  };
  for (const boundary of doc.boundaries) {
    if (boundary.n === 8) continue;   // boundary 8 is its scenes
    put(base(`boundary-${boundary.n}`, 'boundary', boundary.benches, boundary.fixtures, { n: boundary.n, name: boundary.name, pass: boundary.pass }));
  }
  const eight = doc.boundaries.find(boundary => boundary.n === 8)!;
  doc.seams.forEach((text, index) => put(base(`seam-${index + 1}`, 'seam', ['B', 'C'], [], { seam: text })));
  for (const scene of doc.boundary8Scenes) put(base(scene.id, 'boundary8', eight.benches, eight.fixtures, { inject: scene.inject, command: scene.command, corrections: scene.corrections, deadline: scene.deadline, records: scene.records, pass: eight.pass }));
  const unused = Object.keys(PLANS).filter(id => !used.has(id));
  if (unused.length) throw new Error(`scenes/generate.ts has plans for scenes the contract does not name: ${unused.join(', ')}`);
  files['index.json'] = `${JSON.stringify({ about: 'generated by generate.ts from e2e/boundaries.json; do not edit', scenes: Object.keys(files).filter(name => name !== 'index.json').map(name => name.replace(/\.json$/u, '')), vocabulary: VOCABULARY }, null, 1)}\n`;
  return files;
}

function main(argv: string[]): number {
  const files = generate();
  const drift = Object.entries(files).filter(([name, text]) => !existsSync(join(HERE, name)) || readFileSync(join(HERE, name), 'utf8') !== text).map(([name]) => name);
  if (argv.includes('--check')) { console.log(drift.length ? `scenes differ from the contract: ${drift.join(', ')}` : `${Object.keys(files).length} scene files are current`); return drift.length ? 1 : 0; }
  for (const [name, text] of Object.entries(files)) writeFileSync(join(HERE, name), text);
  console.log(`wrote ${Object.keys(files).length} files (${drift.length} changed)`);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
