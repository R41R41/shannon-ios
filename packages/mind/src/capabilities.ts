import type { EffectClass, SlotClass } from './tasks.js';
import { EFFECT_CLASSES, SLOT_CLASSES } from './tasks.js';

/**
 * The capability vocabulary of the Executive (Syzygy ADR-0009 stage 2, E1), pure. A capability is something she can choose to
 * do: a tool of the registry (`level: 'tool'`, a part an FCA task uses) or an activity (`level: 'activity'`, what the Executive
 * chooses). The catalog itself is built by the server (`mind/action/executive/capabilityCatalog.ts`); this file holds the
 * shape, its closed values and the checks, so the app, the Executive and the tests read one definition.
 */
export const CAPABILITY_LEVELS = ['tool', 'activity'] as const;
export type CapabilityLevel = typeof CAPABILITY_LEVELS[number];

/** `procedure`: a fixed server procedure; `fca`: an FCA task; `tool`: one registry call; `self_rewrite`: a proposal; `none`: nothing runs. */
export const CAPABILITY_EXECUTORS = ['procedure', 'fca', 'tool', 'self_rewrite', 'none'] as const;
export type CapabilityExecutor = typeof CAPABILITY_EXECUTORS[number];

/**
 * How she may use it: `free` (the gate's free rule), `approval` (the owner approves each use), `forbidden`, `propose_only` (she
 * proposes, the owner decides), `owner_request_only` (only inside work the owner asked for, never on her own).
 */
export const CAPABILITY_POLICIES = ['free', 'approval', 'forbidden', 'propose_only', 'owner_request_only'] as const;
export type CapabilityPolicy = typeof CAPABILITY_POLICIES[number];

export const CAPABILITY_PRECONDITIONS = [
  'owner_alone', 'not_paused', 'budget_left', 'not_quiet_hours', 'aether_configured', 'notion_connected', 'body_camera',
  'piece_exists', 'piece_shareable', 'call_available', 'shannon_home_empty', 'recheck_before_enter', 'executive_on',
] as const;
export type CapabilityPrecondition = typeof CAPABILITY_PRECONDITIONS[number];

/** What can be seen afterwards, as evidence for a goal or a reward. */
export const CAPABILITY_OBSERVABLES = [
  'tool_result', 'piece_version', 'piece_shown', 'owner_reaction', 'note_written', 'research_report', 'aether_document',
  'reply', 'call_result', 'room_note', 'music_reaction', 'minecraft_report', 'proposal', 'rest_until',
] as const;
export type CapabilityObservable = typeof CAPABILITY_OBSERVABLES[number];

export type CapabilityStop = 'immediate' | 'after_step' | 'not_needed';
export type CapabilityIdempotency = 'idempotent' | 'keyed' | 'not_idempotent';
export type CapabilityRetry = 'none' | 'once' | 'backoff';
export type CapabilityEffect = 'read' | 'write' | 'none';

export interface CapabilityPermission {
  /** The gate domain of `authorizeAutonomousAction` a use is decided under (`thinking`, `owner_message`, …). */
  readonly gateDomain: string;
  readonly policy: CapabilityPolicy;
}

export interface Capability {
  /** `tool.<registry name>` or `<area>.<verb>` (`create.story`, `notify.call`). */
  readonly name: string;
  /** For the owner's screen. */
  readonly label: string;
  /** One line: what it is for. */
  readonly purpose: string;
  readonly level: CapabilityLevel;
  readonly executor: CapabilityExecutor;
  readonly preconditions: readonly CapabilityPrecondition[];
  readonly longRunning: boolean;
  readonly stop: CapabilityStop;
  readonly resumable: boolean;
  readonly idempotency: CapabilityIdempotency;
  readonly retry: CapabilityRetry;
  readonly slotClass: SlotClass;
  /** A planning estimate of one use in yen (E3's budget reserves the actual price per paid step). */
  readonly costYen: number;
  readonly effect: CapabilityEffect;
  readonly effectClass: EffectClass;
  readonly permission: CapabilityPermission;
  readonly observables: readonly CapabilityObservable[];
  /** For an activity: the own-time actions of the old loop it replaces (`draft`, `reach_out`, …). */
  readonly replaces?: readonly string[];
}

export const CAPABILITY_NAME = /^[a-z][A-Za-z0-9_]*(?:\.[a-z][A-Za-z0-9_]*){0,3}$/u;

/** The problems of one entry; empty when it is well formed. */
export function capabilityProblems(capability: Capability): string[] {
  const problems: string[] = [];
  const check = (ok: boolean, problem: string) => { if (!ok) problems.push(problem); };
  check(CAPABILITY_NAME.test(capability.name), 'name');
  check(capability.level !== 'tool' || capability.name.startsWith('tool.'), 'tool_prefix');
  check(Boolean(capability.label.trim()) && Boolean(capability.purpose.trim()), 'text');
  check(CAPABILITY_LEVELS.includes(capability.level) && CAPABILITY_EXECUTORS.includes(capability.executor), 'kind');
  check(capability.preconditions.every(item => CAPABILITY_PRECONDITIONS.includes(item)), 'precondition');
  check(capability.observables.every(item => CAPABILITY_OBSERVABLES.includes(item)), 'observable');
  check(SLOT_CLASSES.includes(capability.slotClass) && EFFECT_CLASSES.includes(capability.effectClass), 'class');
  check(Number.isFinite(capability.costYen) && capability.costYen >= 0, 'cost');
  check(CAPABILITY_POLICIES.includes(capability.permission.policy) && Boolean(capability.permission.gateDomain), 'permission');
  return problems;
}

/** The problems of a whole catalog: each entry's, and names that repeat. */
export function catalogProblems(catalog: readonly Capability[]): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const capability of catalog) {
    for (const problem of capabilityProblems(capability)) problems.push(`${capability.name}: ${problem}`);
    if (seen.has(capability.name)) problems.push(`${capability.name}: duplicate`);
    seen.add(capability.name);
  }
  return problems;
}

/** Whether she may choose it on her own (the Executive's candidates never include the others). */
export function choosableOnHerOwn(capability: Capability): boolean {
  return capability.level === 'activity' && capability.permission.policy !== 'owner_request_only' && capability.permission.policy !== 'forbidden';
}
