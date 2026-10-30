import type { ActionThreads } from '../contracts/actionThreadContract.js';
import { OPERATOR_LIMITS, type OperatorCode } from '../contracts/operatorContract.js';
import type { OperatorAuditStore } from '../infra/ops/store/operatorAuditStore.js';
import type { OperatorLifecycle } from './operatorLifecycleWiring.js';
import type { OperatorMinecraftRequests } from './operatorMinecraftRequests.js';
import type { MinecraftBodyRecheck } from './minecraftBodyRecheckWiring.js';
import { type SkillImportCommandDeps } from '../infra/http/skillImportCommand.js';
import { feet, type Feet, type HeldAgain } from './minecraftIncidentHold.js';

/** What the activity record (「したことの記録」, shown in 自律活動 › 記録) keeps of an operator invocation. */
export interface OperatorActivity {
  summary: string;
  tool: string;
  outcome: 'done' | 'refused';
  reasonCode: string;
  detail: string;
  domain?: string;
}

export interface OperatorMinecraftParts {
  scopeKey: string;
  enabled(): boolean;
  ownerAlone(): boolean;
  now(): string;
  /** Admission is standalone under the root, with the fixed game-only menu and no private sources. */
  gameOnlyAvailable?(): boolean;
  audit: OperatorAuditStore;
  lifecycle: OperatorLifecycle | null;
  requests: (OperatorMinecraftRequests & { wake(): void }) | null;
  actions: ActionThreads | null;
  /** The body re-check (`minecraftBodyRecheckWiring.ts`); absent without a configured body. */
  bodyRecheck?: Pick<MinecraftBodyRecheck, 'request'> | null;
  /** What a task has used so far in yen, confirmed and estimated (`TaskBudgetStore`): `minecraft budget` never
   * lowers a cap below it.
   * Absent: no lowering. */
  spentYen?(taskId: string): number;
  lifecycleUnresolved(): boolean;
  activity(at: string, entry: OperatorActivity): void;
  /** A short note in the owner's Talk, written once per id. */
  note(id: string, text: string, at: string): void;
  /** The owner's skill import (`skillImportCommand.ts`) while her skills are on; absent, `skills import` is refused. */
  skillImport?: SkillImportCommandDeps | null;
}

export const FINISHED = ['stopped', 'completed', 'failed', 'stopping'];

/** A hold row's detail (`hold` below): the incident, the held act's command and where it began and ended. */
export function holdDetail(detail: string | null): {
  incident?: string;
  command?: string;
  start?: Feet | null;
  end?: Feet | null;
  mismatch?: string;
  replay?: HeldAgain;
  take?: string;
  notHeld?: string;
  bodyHold?: string;
  frozen?: boolean | null;
  box?: string;
  scene?: string;
} {
  try {
    const value = JSON.parse(detail ?? '{}') as Record<string, unknown>;
    return {
      ...(typeof value.incident === 'string' ? { incident: value.incident } : {}),
      ...(typeof value.command === 'string' ? { command: value.command } : {}),
      start: feet(value.start),
      end: feet(value.end),
      ...(typeof value.mismatch === 'string' ? { mismatch: value.mismatch } : {}),
      ...(typeof value.take === 'string' ? { take: value.take } : {}),
      ...(typeof value.notHeld === 'string' ? { notHeld: value.notHeld } : {}),
      ...(typeof value.bodyHold === 'string' ? { bodyHold: value.bodyHold } : {}),
      ...(typeof value.frozen === 'boolean' || value.frozen === null ? { frozen: value.frozen as boolean | null } : {}),
      ...(typeof value.box === 'string' ? { box: value.box } : {}),
      ...(typeof value.scene === 'string' ? { scene: value.scene } : {}),
      ...(heldAgainOf(value.replay) ? { replay: heldAgainOf(value.replay)! } : {}),
    };
  } catch {
    return {};
  }
}

/** A hold row's `replay` (the second try of a held act, held again), or null when it does not read. */
export function heldAgainOf(value: unknown): HeldAgain | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { code?: unknown; dropped?: unknown };
  if (typeof record.code !== 'string') return null;
  const dropped = (Array.isArray(record.dropped) ? record.dropped : []).flatMap((entry) =>
    entry && typeof entry === 'object' && typeof (entry as { item?: unknown }).item === 'string'
      ? [{ item: (entry as { item: string }).item, why: String((entry as { why?: unknown }).why ?? '') }]
      : [],
  );
  return { code: record.code, dropped };
}

/**
 * The hold row's detail text (at most 600 characters, still whole JSON): the second try's record loses its
 * dropped items one by one
 * before anything else is cut. Amendment A-12: a hold the
 * head found carries the body's answer to its take as well (its box and scene are long paths); when that does not fit, the head's
 * own box path, then the freeze's words, then the scene
 * and the box go, in that order (the head's box file has all of it).
 */
export function holdDetailText(base: Record<string, unknown>, replay: HeldAgain | undefined): string {
  const dropped = [...(replay?.dropped ?? [])],
    kept = { ...base };
  for (;;) {
    const text = JSON.stringify({ ...kept, ...(replay ? { replay: { code: replay.code.slice(0, 40), dropped } } : {}) });
    if (text.length <= 600) return text;
    if (dropped.length) {
      dropped.pop();
      continue;
    }
    const droppable = ['record', 'freeze', 'scene', 'box'].find((key) => key in kept);
    if (!droppable) return text.slice(0, 600);
    delete kept[droppable];
  }
}

/** What the body said of the hold the head asked for, in the operator's words (the activity record, `held`). */
export function takeWords(take: string | undefined, d: { notHeld?: string; bodyHold?: string; frozen?: boolean | null }): string {
  if (take === 'held')
    return d.frozen === false ? '体も保留したが世界は止まっていない' : '体も同じ id で保留し、世界を止め、黒箱と現場を取った';
  if (take === 'not_held')
    return `体は世界を止められず保留していない（${(d.notHeld ?? '理由不明').slice(0, 60)}）。黒箱と現場だけ取った。世界は動いている`;
  if (take === 'other_hold') return `体は別の保留 ${d.bodyHold ?? '?'} を持っていて、頭の保留は取っていない。世界はその保留のまま`;
  if (take === 'failed') return '体へ頼めなかった（答えが無かった）。世界は止まっていない';
  return '世界は止めていない（体は保留していない）';
}

/** The reason a hold row names (its detail's `why`), or ''. */
export function holdWhy(detail: string | null): string {
  try {
    return String((JSON.parse(detail ?? '{}') as { why?: unknown }).why ?? '');
  } catch {
    return '';
  }
}

/** Phases after which a held request holds nothing any more. */
export const FINISHED_FOR_GOOD = ['completed', 'failed'];

export const HOUR_MS = 3_600_000;

export const STATUS: Partial<Record<OperatorCode, number>> = { out_of_scope: 403, rate_limited: 429, flooded: 429 };

export const ago = (at: string, ms: number) => new Date(Date.parse(at) - ms).toISOString();

/** Amendment A-14/A-15: a task the body's recovery paused (its step was lost): stopped, paused, waiting for the
 * owner's resume. */
export const isRecoveredPause = (task: { phase: string; status?: string; pauseReason?: string | null }): boolean =>
  task.phase === 'stopped' && task.status === 'paused' && task.pauseReason === 'fca_stopped';

export const MESSAGES: Partial<Record<OperatorCode, string>> = {
  disabled: '運用者のマイクラ操作はサーバーで有効になっていません（SHANNON_OPERATOR_MINECRAFT）。',
  owner_not_alone: 'ライ氏以外の人がいる間は始めません。',
  body_unavailable: 'マイクラの体が一つに決まっていないか、接続されていません。',
  minecraft_busy: 'ほかのマイクラの作業がまだ動いています。先に止めるか終わるのを待ってください。',
  lease_conflict: 'マイクラの管理操作がまだ動いています。',
  unresolved_operation: '前のマイクラ管理操作の結果がまだ確認できていません。',
  rate_limited: `1時間に${OPERATOR_LIMITS.requestsPerHour}件までです。`,
  flooded: '呼び出しが多すぎるので、しばらく受け付けません（監査はまとめて残します）。',
  not_found: '運用者が始めた進行中のマイクラの依頼が見つかりません。',
  not_operator_task: 'このタスクは運用者が始めたものではないので止めません（ライ氏の依頼は本人の「止まって」で止めます）。',
  not_running: 'このタスクはもう終わっているか、止めている途中です。',
  lifecycle_unavailable: 'マイクラ管理が設定されていないか、新しい状態が届いていません。',
  released: 'マイクラの体が止まっていて入力も離していることを体に確かめ直し、保持を解放しました。',
  not_retained: '確認待ちで保持されているマイクラの体はありません。',
  not_confirmed: '体が停止と入力の解放を確かめられなかったので、保持したままにしました。',
  proof_refused: '体の答えを解放の証明として受け付けられなかったので、保持したままにしました。',
  recheck_busy: '体の確認をいま実行中です。',
  not_settled: 'ログイン直後で、サーバーの状態（ほかの参加者の数）をまだ確かめられません。少し待ってからもう一度頼んでください。',
  not_held: 'このタスクは保留されていません（再開は、保留された依頼と、体の取り戻しで止まった依頼だけです）。',
};

export const BUDGET_NOT_RUNNING =
  'このタスクはもう止まっているか、止めている途中です。予算を変えても再開はしません（止まった理由が予算でも同じです。再開はライ氏の操作で、新しく頼むこともできます）。';

export const SKILL_IMPORT_MESSAGES = {
  'dry-run': '取り込みの計画です。問題が無ければ plan hash で apply します。',
  apply: 'スキルの取り込みを記録しました。',
  refused: 'スキルの取り込みを受け付けませんでした（skillImport に理由があります）。',
};

/** The operator code of a skill import answer: the importer's own refusals by name, the route's status otherwise. */
export function skillImportCode(result: { status: number; body: unknown }): OperatorCode {
  const rejected = (result.body as { rejected?: unknown } | null)?.rejected;
  if (result.status === 200) return 'accepted';
  if (rejected === 'stale_plan' || rejected === 'validation_failed') return rejected;
  return result.status === 404 ? 'not_found' : result.status === 403 ? 'disabled' : 'refused';
}

export const RECHECK_UNAVAILABLE = 'マイクラの体が接続されていないので、まだ確かめられません。接続されたらサーバーが自動でも確かめます。';
