import { autonomyDomain } from '@shannon/cognition';
import { type Capability, type CapabilityPolicy, type CapabilityPrecondition, catalogProblems } from '@shannon/mind';
import { activityOfCapability, foldedValueCells, type ValueCell } from '@shannon/learning';
import { SHANNON_TOOLS, type ShannonToolDefinition } from '../../tools/toolRegistryPorts.js';

/**
 * Her capability catalog (Syzygy ADR-0009 stage 2, E1): every tool of the registry, and the activities the Executive chooses
 * from. Nothing runs from here yet: the old own-time loop keeps running, and this is what the owner's 点検 tab and, from E5,
 * the Executive read. A tool without the `autonomy` surface is `owner_request_only`: she never uses it on her own.
 */
type Defaulted = 'idempotency' | 'retry' | 'resumable' | 'stop';
type ActivitySpec = Omit<Capability, 'level' | Defaulted> & Partial<Pick<Capability, Defaulted>>;

const activity = (spec: ActivitySpec): Capability => Object.freeze({
  level: 'activity' as const, idempotency: 'keyed' as const, retry: 'none' as const, resumable: false, stop: 'after_step' as const, ...spec,
});
const gated = (gateDomain: string, policy: CapabilityPolicy = 'free') => Object.freeze({ gateDomain, policy });
const BASE: readonly CapabilityPrecondition[] = ['not_paused', 'budget_left'];

/**
 * The activities and the old own-time actions each replaces (plan §2). `notify.*` keeps today's gate (owner answer 2:
 * a message and a call for any reason), `minecraft.session` enters shannon-home only when nobody is there and checks again
 * just before entering (owner answer 2), `self.improve` only proposes.
 */
export const ACTIVITY_CAPABILITIES: readonly Capability[] = Object.freeze([
  activity({ name: 'create.story', label: '物語を書く・直す', purpose: '書斎の物語を書き、直し、仕上げ、しまう。', executor: 'procedure',
    preconditions: BASE, longRunning: false, slotClass: 'creative', costYen: 8, effect: 'write', effectClass: 'external',
    permission: gated('aether_study'), observables: ['piece_version', 'piece_shown', 'owner_reaction'], replaces: ['draft', 'revise', 'ready', 'put_away'] }),
  activity({ name: 'create.note', label: 'メモを書く', purpose: '読んだこと・考えたことを書斎やフォルダのメモにする。', executor: 'procedure',
    preconditions: BASE, longRunning: false, slotClass: 'creative', costYen: 3, effect: 'write', effectClass: 'external',
    permission: gated('aether_study'), observables: ['note_written'], replaces: ['note', 'jot', 'copy'] }),
  activity({ name: 'research.read', label: '調べる', purpose: 'Web・Aether・Notion・記憶を読んで、調べた報告を残す。', executor: 'fca',
    preconditions: [...BASE, 'executive_on'], longRunning: true, slotClass: 'research', costYen: 30, effect: 'read', effectClass: 'none',
    permission: gated('public_read'), observables: ['research_report', 'note_written'], replaces: ['read', 'notion', 'tool.read'],
    idempotency: 'idempotent', retry: 'once', resumable: true, stop: 'immediate' }),
  activity({ name: 'aether.write', label: 'Aetherに書く', purpose: 'Aetherのシャノン用フォルダに文書を書く。', executor: 'fca',
    preconditions: [...BASE, 'aether_configured', 'executive_on'], longRunning: true, slotClass: 'research', costYen: 10, effect: 'write',
    effectClass: 'external', permission: gated('aether_study'), observables: ['aether_document'], replaces: ['aetherFolder.*', 'copy'], resumable: true }),
  activity({ name: 'notify.text', label: '文字で知らせる', purpose: 'ライ氏に自分から話しかける（今の声かけの関所のまま）。', executor: 'procedure',
    preconditions: [...BASE, 'not_quiet_hours'], longRunning: false, slotClass: 'other', costYen: 2, effect: 'write', effectClass: 'external',
    permission: gated('owner_message'), observables: ['reply', 'owner_reaction'], replaces: ['reach_out', 'follow_up'] }),
  activity({ name: 'notify.call', label: '電話をかける', purpose: 'ライ氏に電話をかける（今の電話の関所のまま）。', executor: 'procedure',
    preconditions: [...BASE, 'not_quiet_hours', 'call_available'], longRunning: false, slotClass: 'other', costYen: 20, effect: 'write',
    effectClass: 'external', permission: gated('owner_call'), observables: ['call_result'], replaces: ['call'] }),
  activity({ name: 'notify.none', label: '知らせない', purpose: '知らせたいことがあっても、今は知らせないと決める。', executor: 'none',
    preconditions: [], longRunning: false, slotClass: 'other', costYen: 0, effect: 'none', effectClass: 'none',
    permission: gated('thinking'), observables: [], idempotency: 'idempotent', stop: 'not_needed' }),
  activity({ name: 'show.piece', label: '見せる', purpose: '仕上げた物語をライ氏に見せる。', executor: 'procedure',
    preconditions: [...BASE, 'piece_shareable'], longRunning: false, slotClass: 'other', costYen: 1, effect: 'write', effectClass: 'external',
    permission: gated('owner_message'), observables: ['piece_shown', 'owner_reaction'], replaces: ['show'] }),
  activity({ name: 'look.room', label: '部屋を見る', purpose: '体のカメラで部屋を一度見て、メモにする。', executor: 'procedure',
    preconditions: [...BASE, 'body_camera'], longRunning: false, slotClass: 'other', costYen: 5, effect: 'read', effectClass: 'none',
    permission: gated('room_look'), observables: ['room_note'], replaces: ['look'] }),
  activity({ name: 'music.suggest', label: '音楽を提案する', purpose: '「かけようか？」と音楽カードを出す。自分からは鳴らさない。', executor: 'procedure',
    preconditions: [...BASE, 'not_quiet_hours', 'executive_on'], longRunning: false, slotClass: 'other', costYen: 1, effect: 'write',
    effectClass: 'external', permission: gated('owner_message'), observables: ['music_reaction'] }),
  activity({ name: 'minecraft.session', label: 'マイクラで遊ぶ', purpose: 'shannon-homeに誰もいない時に入り、遊んだことを報告する。', executor: 'fca',
    preconditions: [...BASE, 'shannon_home_empty', 'recheck_before_enter', 'executive_on'], longRunning: true, slotClass: 'minecraft', costYen: 60,
    effect: 'write', effectClass: 'external', permission: gated('minecraft_lifecycle'), observables: ['minecraft_report'],
    resumable: true, stop: 'immediate' }),
  activity({ name: 'self.improve', label: '自分を直す提案', purpose: '自分のコードの直し方を提案する（適用はライ氏の承認）。', executor: 'self_rewrite',
    preconditions: BASE, longRunning: true, slotClass: 'codex', costYen: 50, effect: 'write', effectClass: 'none',
    permission: gated('vm_workspace', 'propose_only'), observables: ['proposal'] }),
  activity({ name: 'rest', label: '休む', purpose: '何もしない。次に考える時間と理由を残す。', executor: 'none',
    preconditions: [], longRunning: false, slotClass: 'other', costYen: 0, effect: 'none', effectClass: 'none',
    permission: gated('thinking'), observables: ['rest_until'], replaces: ['rest'], idempotency: 'idempotent', stop: 'not_needed' }),
]);

const PRECONDITIONS_BY_DOMAIN: Readonly<Record<string, readonly CapabilityPrecondition[]>> = Object.freeze({
  aether_study: ['aether_configured'], owner_documents_read: ['aether_configured'], notion_read: ['notion_connected'],
});

function toolPolicy(tool: ShannonToolDefinition): CapabilityPolicy {
  if (!tool.surfaces.includes('autonomy')) return 'owner_request_only';
  if (tool.name === 'workspace.propose') return 'propose_only';
  return autonomyDomain(tool.domain)?.rule ?? 'approval';
}

/** One registry tool as a capability (`tool.<name>`): a part an FCA task uses, never a choice of the Executive itself. */
export function toolCapability(tool: ShannonToolDefinition): Capability {
  const write = tool.effect === 'write';
  return Object.freeze<Capability>({
    name: `tool.${tool.name}`, label: tool.name, purpose: firstSentence(tool.description), level: 'tool', executor: 'tool',
    preconditions: [...(tool.audiences.includes('others') ? [] : ['owner_alone' as const]), ...(PRECONDITIONS_BY_DOMAIN[tool.domain] ?? [])],
    longRunning: false, stop: 'after_step', resumable: false, idempotency: write ? 'keyed' : 'idempotent', retry: write ? 'none' : 'once',
    slotClass: tool.domain.startsWith('minecraft') ? 'minecraft' : 'research', costYen: tool.cost === 'model' ? 5 : 0,
    effect: tool.effect, effectClass: write && tool.domain !== 'vm_workspace' ? 'external' : 'none',
    permission: { gateDomain: tool.domain, policy: toolPolicy(tool) }, observables: ['tool_result'],
  });
}

function firstSentence(description: string): string {
  const sentence = description.split(/(?<=。)/u)[0] ?? description;
  return sentence.length > 80 ? `${sentence.slice(0, 79)}…` : sentence;
}

let built: readonly Capability[] | null = null;

/** The whole catalog: the activities first, then every tool of the registry. A malformed entry fails here, at first use. */
export function capabilityCatalog(): readonly Capability[] {
  if (built) return built;
  const catalog = Object.freeze([...ACTIVITY_CAPABILITIES, ...SHANNON_TOOLS.map(toolCapability)]);
  const problems = catalogProblems(catalog);
  if (problems.length) throw new Error(`CAPABILITY_CATALOG_INVALID: ${problems.slice(0, 5).join(', ')}`);
  built = catalog;
  return catalog;
}

/** The old own-time action a capability replaces → that capability (plan §2's table). */
export function capabilityOfOwnTimeAction(action: string): string | null {
  for (const capability of ACTIVITY_CAPABILITIES) {
    if (capability.replaces?.some(old => old === action || (old.endsWith('.*') && action.startsWith(old.slice(0, -1))))) return capability.name;
  }
  return null;
}

/** What the server knows now about the conditions a capability names (the rest are checked at use time). */
export interface CapabilityAvailability {
  readonly paused: boolean;
  readonly aether: boolean;
  /** The Executive runs (`SHANNON_EXECUTIVE`, E5); until then FCA activities from her own time wait for it. */
  readonly executive: boolean;
}

export interface CapabilityValue {
  readonly mean: number;
  readonly sd: number;
  readonly n: number;
}

export interface CapabilityEntryView {
  readonly capability: Capability;
  readonly enabled: boolean;
  /** The known conditions that are not met now. */
  readonly blockedBy: readonly CapabilityPrecondition[];
  /** V of the value table's active version at the choice level, the old choices folded in (`capabilityOfChoice`); null without data. */
  readonly value: CapabilityValue | null;
}

/** The catalog as the owner's 点検 tab reads it: each entry, whether it can be used now, and its value. */
export function capabilityCatalogView(availability: CapabilityAvailability, cells: readonly ValueCell[]): CapabilityEntryView[] {
  const values = new Map<string, CapabilityValue>();
  const choiceCells = cells.filter(cell => cell.level === 'choice');
  for (const cell of [...choiceCells.filter(item => item.choice.startsWith('tool.')), ...foldedValueCells(choiceCells, activityOfCapability)]) {
    if (cell.n > 0) values.set(cell.choice, Object.freeze({ mean: cell.mean, sd: Math.sqrt(Math.max(0, cell.uncertainty)), n: cell.n }));
  }
  const unmet: Partial<Record<CapabilityPrecondition, boolean>> = {
    not_paused: availability.paused, aether_configured: !availability.aether, executive_on: !availability.executive,
  };
  return capabilityCatalog().map(capability => {
    const blockedBy = capability.preconditions.filter(condition => unmet[condition] === true);
    return Object.freeze({ capability, enabled: blockedBy.length === 0, blockedBy, value: values.get(capability.name) ?? null });
  });
}
