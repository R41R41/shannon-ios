import type { ShannonPursuit } from '@shannon/cognition';
import { capabilityOfChoice, activityOfCapability, type ValueCell } from '@shannon/learning';
import { GOAL_LIMITS, evaluateGoalPredicate, goalPredicateSummary, goalProgressLabel, type CapabilityExecutor, type CapabilityPolicy } from '@shannon/mind';
import type { DeliberationRecord, PursuitClosedReason, PursuitEvent, PursuitGoalColumns } from '../ownTime/ownTimePorts.js';
import { capabilityCatalog, capabilityCatalogView, type CapabilityAvailability } from './capabilityCatalog.js';
import type { ChoiceUse, NoticeMark, PredictionMark } from './store/executiveReadings.js';

/**
 * The owner's reads of the Executive (Syzygy ADR-0009 stage 2; `docs/executive-ui-contract.md`): 目標 (goals), 点検 (inspection),
 * the capability catalog and the choices. Built from ports handed by wiring; words come from here, never from a model.
 */
export const EXECUTIVE_VIEW_SCHEMA = 1;
const DAY = 86_400_000;
const CLOSED_SHOWN_DAYS = 14;

export interface GoalReadPorts {
  pursuits(scopeKey: string, at: string): readonly ShannonPursuit[];
  columns(scopeKey: string): ReadonlyMap<string, PursuitGoalColumns>;
  events(scopeKey: string, limit: number): readonly PursuitEvent[];
}

const CLOSED_REASON_WORDS: Readonly<Record<PursuitClosedReason, string>> = Object.freeze({
  cap: '進める目標が多すぎたので休めた', shannon_rest: 'シャノンが休めた', shannon_drop: 'シャノンがやめた', owner_rest: 'ライ氏が休めた',
  owner_drop: 'ライ氏がやめた', evidence: '完了の条件を満たした', owner_confirm: 'ライ氏が完了を認めた', legacy: '以前の仕組みで閉じた',
});

const STATUS_ORDER: Readonly<Record<string, number>> = Object.freeze({ active: 0, resting: 1, done: 2, dropped: 2 });

function labelOf(capability: string): string {
  return capabilityCatalog().find(item => item.name === capability)?.label ?? capability;
}

function completionOf(columns: PursuitGoalColumns | undefined) {
  const predicate = columns?.predicate ?? null;
  if (!predicate) return { completion: null, predicate: null };
  return { completion: { summary: goalPredicateSummary(predicate, labelOf), met: evaluateGoalPredicate(predicate, columns!.evidence).met }, predicate };
}

function closedOf(columns: PursuitGoalColumns | undefined) {
  const reason = columns?.closedReason;
  return { closedReason: reason ? CLOSED_REASON_WORDS[reason] ?? null : null, closedAt: columns?.closedAt ?? null };
}

function goalItem(pursuit: ShannonPursuit, columns: PursuitGoalColumns | undefined) {
  const seed = pursuit.origin === 'seed';
  const open = pursuit.status === 'active' || pursuit.status === 'resting';
  const label = goalProgressLabel(columns?.predicate ?? null, columns?.evidence ?? []);
  return {
    id: pursuit.id, title: pursuit.title, why: pursuit.why, status: pursuit.status, origin: pursuit.origin, kind: pursuit.kind,
    progress: pursuit.status === 'done' ? 1 : columns?.progress ?? 0, ...(label ? { progressLabel: label } : {}),
    reviewAt: open ? columns?.reviewAt ?? null : null, lastWorkedAt: columns?.lastWorkedAt ?? null,
    ...completionOf(columns), evidenceCount: columns?.evidence.length ?? 0, sourceKind: columns?.sourceKind ?? null, ...closedOf(columns),
    ownerCanConfirm: !seed && open, ownerCanRest: !seed && pursuit.status === 'active', ownerCanDrop: !seed && open,
    createdAt: pursuit.createdAt, updatedAt: pursuit.updatedAt,
  };
}

/** `GET /v1/autonomy/goals`: open goals (active, then resting, nearest review first) and goals closed in the last 14 days. */
export function goalsView(ports: GoalReadPorts, scopeKey: string, at: string) {
  const columns = ports.columns(scopeKey);
  const since = new Date(Date.parse(at) - CLOSED_SHOWN_DAYS * DAY).toISOString();
  const goals = ports.pursuits(scopeKey, at)
    .filter(pursuit => pursuit.status === 'active' || pursuit.status === 'resting' || (columns.get(pursuit.id)?.closedAt ?? pursuit.updatedAt) >= since)
    .map(pursuit => goalItem(pursuit, columns.get(pursuit.id)))
    .sort((left, right) => (STATUS_ORDER[left.status] ?? 3) - (STATUS_ORDER[right.status] ?? 3)
      || (left.reviewAt ?? '9').localeCompare(right.reviewAt ?? '9') || (right.closedAt ?? '').localeCompare(left.closedAt ?? ''));
  return { schemaVersion: EXECUTIVE_VIEW_SCHEMA, generatedAt: at, activeLimit: GOAL_LIMITS.active, goals, events: ports.events(scopeKey, 20) };
}

function policyWord(policy: CapabilityPolicy): string {
  if (policy === 'owner_request_only') return 'owner_request_only';
  return policy === 'forbidden' ? 'off' : 'own_time';
}

function executionWord(executor: CapabilityExecutor): 'procedure' | 'fca' | 'none' {
  if (executor === 'tool') return 'fca';
  return executor === 'self_rewrite' ? 'procedure' : executor;
}

/** The uses of each capability: old choice keys folded (`capabilityOfChoice`), tools by their own key. */
function usesByCapability(uses: readonly ChoiceUse[]): Map<string, { total: number; recent: number; lastAt: string | null }> {
  const result = new Map<string, { total: number; recent: number; lastAt: string | null }>();
  for (const use of uses) {
    const folded = use.choice.startsWith('tool.') ? use.choice : capabilityOfChoice(use.choice);
    if (!folded) continue;
    const key = folded.startsWith('tool.') ? folded : activityOfCapability(folded);
    const known = result.get(key) ?? { total: 0, recent: 0, lastAt: null };
    const lastAt = [known.lastAt, use.lastAt].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
    result.set(key, { total: known.total + use.total, recent: known.recent + use.recent, lastAt });
  }
  return result;
}

/** `GET /v1/autonomy/capabilities`: both layers, with policy, value and uses. */
export function capabilitiesView(availability: CapabilityAvailability, cells: readonly ValueCell[], uses: readonly ChoiceUse[], at: string) {
  const counted = usesByCapability(uses);
  const capabilities = capabilityCatalogView(availability, cells).map(({ capability, enabled, blockedBy, value }) => {
    const use = counted.get(capability.name);
    return {
      id: capability.name, label: capability.label, purpose: capability.purpose, layer: capability.level, execution: executionWord(capability.executor),
      policy: policyWord(capability.permission.policy), permission: capability.permission, enabled, blockedBy, value,
      uses7d: use?.recent ?? 0, usesTotal: use?.total ?? 0, ...(use?.lastAt ? { lastUsedAt: use.lastAt } : {}),
      preconditions: capability.preconditions, slotClass: capability.slotClass, costYen: capability.costYen, effectClass: capability.effectClass,
      ...(capability.replaces ? { replaces: capability.replaces } : {}),
    };
  });
  return { schemaVersion: EXECUTIVE_VIEW_SCHEMA, generatedAt: at, capabilities };
}

/** `GET /v1/autonomy/choices`: the Executive's deliberations of the last `days`, newest first, at most 50. */
export function choicesView(records: readonly DeliberationRecord[], goalTitle: (id: string) => string | null, days: number, at: string) {
  const choices = records.slice(0, 50).map(record => ({
    id: record.id, at: record.at, capability: record.capability, label: labelOf(record.capability),
    ...(record.goalId ? { goalId: record.goalId, goalTitle: goalTitle(record.goalId) ?? undefined } : {}),
    ...(record.reason ? { reason: record.reason } : {}), outcome: record.outcome, offCandidates: record.offCandidates, topByValue: record.topByValue,
    trigger: record.trigger, valueRank: record.valueRank,
  }));
  return { schemaVersion: EXECUTIVE_VIEW_SCHEMA, generatedAt: at, days, choices };
}

export interface InspectionInputs {
  /** The owner-local day of an instant. */
  dayKey(at: string): string;
  events: readonly PursuitEvent[];
  predictions: readonly PredictionMark[];
  notices: readonly NoticeMark[];
  sleepRuns: ReadonlyMap<string, number>;
  spentYen(dayKey: string): number;
  /** Actions still unknown (a gauge of now, given for today only); null when not known. */
  unknownNow: number | null;
  /** The Executive's deliberations in the window (E5); absent before it ran. */
  deliberations?: readonly DeliberationRecord[];
}

interface DayCounts {
  goals: { created: number; completed: number; rested: number; dropped: number };
  notices: { sent: number; answered: number; unanswered: number };
  predictions: { made: number; hit: number };
  sleepRuns: number;
  spentYen: number;
  unknown?: number;
  deliberations?: number;
  choices?: number;
  chosenTopValue?: number;
  offCandidates?: number;
  distinctCapabilities?: number;
}

function emptyCounts(): DayCounts {
  return {
    goals: { created: 0, completed: 0, rested: 0, dropped: 0 }, notices: { sent: 0, answered: 0, unanswered: 0 },
    predictions: { made: 0, hit: 0 }, sleepRuns: 0, spentYen: 0,
  };
}

function countEvent(counts: DayCounts, event: PursuitEvent): void {
  if (event.kind === 'created') counts.goals.created += 1;
  else if (event.kind === 'completed' || event.kind === 'owner_confirmed') counts.goals.completed += 1;
  else if (event.kind === 'capped' || (event.kind === 'status' && event.toStatus === 'resting')) counts.goals.rested += 1;
  else if (event.kind === 'status' && event.toStatus === 'dropped') counts.goals.dropped += 1;
}

/** The seven owner-local days ending on `day`, oldest first. */
export function weekEnding(day: string): string[] {
  const end = Date.parse(`${day}T12:00:00.000Z`);
  return Array.from({ length: 7 }, (_, index) => new Date(end - (6 - index) * DAY).toISOString().slice(0, 10));
}

/** `GET /v1/autonomy/inspection`: what exists today of the plan §6 counts (E8 fills the Executive's own counts). */
export function inspectionView(inputs: InspectionInputs, day: string, at: string) {
  const days = weekEnding(day);
  const byDay = new Map(days.map(key => [key, emptyCounts()]));
  for (const event of inputs.events) {
    const counts = byDay.get(inputs.dayKey(event.at));
    if (counts) countEvent(counts, event);
  }
  for (const mark of inputs.predictions) {
    const counts = byDay.get(inputs.dayKey(mark.at));
    if (!counts) continue;
    counts.predictions.made += 1;
    counts.predictions.hit += mark.hit ? 1 : 0;
  }
  for (const mark of inputs.notices) {
    const counts = byDay.get(inputs.dayKey(mark.at));
    if (!counts) continue;
    counts.notices.sent += 1;
    if (mark.answered === true) counts.notices.answered += 1;
    if (mark.answered === false) counts.notices.unanswered += 1;
  }
  for (const [key, counts] of byDay) {
    counts.sleepRuns = inputs.sleepRuns.get(key) ?? 0;
    counts.spentYen = Math.round(inputs.spentYen(key) * 100) / 100;
  }
  if (inputs.deliberations?.length) countDeliberations(byDay, inputs.deliberations, inputs.dayKey);
  const today = byDay.get(day)!;
  if (inputs.unknownNow !== null && day === inputs.dayKey(at)) today.unknown = inputs.unknownNow;
  return { schemaVersion: EXECUTIVE_VIEW_SCHEMA, generatedAt: at, day, today, week: summed([...byDay.values()]) };
}

/** The Executive's rows of plan §6: deliberations, active choices, the top-valued and off-candidate ones, capabilities used. */
function countDeliberations(byDay: Map<string, DayCounts>, records: readonly DeliberationRecord[], dayKey: (at: string) => string): void {
  const capabilities = new Map<string, Set<string>>();
  for (const record of records) {
    const key = dayKey(record.at);
    const counts = byDay.get(key);
    if (!counts) continue;
    const chose = record.dispatch !== 'none';
    counts.deliberations = (counts.deliberations ?? 0) + 1;
    counts.choices = (counts.choices ?? 0) + (chose ? 1 : 0);
    counts.chosenTopValue = (counts.chosenTopValue ?? 0) + (chose && record.topByValue ? 1 : 0);
    counts.offCandidates = (counts.offCandidates ?? 0) + (record.offCandidates ? 1 : 0);
    capabilities.set(key, (capabilities.get(key) ?? new Set()).add(record.capability));
    counts.distinctCapabilities = capabilities.get(key)!.size;
  }
}

function summed(all: readonly DayCounts[]): DayCounts {
  const total = emptyCounts();
  for (const counts of all) {
    for (const key of ['created', 'completed', 'rested', 'dropped'] as const) total.goals[key] += counts.goals[key];
    for (const key of ['sent', 'answered', 'unanswered'] as const) total.notices[key] += counts.notices[key];
    total.predictions.made += counts.predictions.made;
    total.predictions.hit += counts.predictions.hit;
    total.sleepRuns += counts.sleepRuns;
    total.spentYen = Math.round((total.spentYen + counts.spentYen) * 100) / 100;
    for (const key of ['deliberations', 'choices', 'chosenTopValue', 'offCandidates'] as const) {
      if (counts[key] !== undefined) total[key] = (total[key] ?? 0) + counts[key]!;
    }
  }
  return total;
}
