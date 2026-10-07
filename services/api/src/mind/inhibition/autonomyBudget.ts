import { dailyCount } from '../../infra/config/dailyCount.js';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHANNON_AUTONOMY_DAILY_BUDGET_YEN } from '@shannon/cognition';
import { ownerDay } from '@shannon/cognition';
import { configuredAutonomyModelPrices, type AutonomyModelPrices } from '../action/ownTime/ownTimePorts.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';

/**
 * Server-side configuration of bounded autonomy. Nothing Shannon can write through
 * the autonomy service changes these values; they come from the deployment
 * environment, which is core (deployment).
 */
export interface AutonomyPlaces {
  /** Her own folder on each named host (owner's Mac, Windows PC). */
  hostFolders: Readonly<Record<string, string>>;
  /** The paired device that works in her folder on a named host. The server never sees that folder; only this device may claim its steps. */
  hostDevices?: Readonly<Record<string, string>>;
  /** Her workspace on the Azure VM, apart from the production service. */
  workspaceRoot: string | null;
  /** Deployed source of the running service. Everything inside needs approval. */
  productionRoots: readonly string[];
  /** Shannon repository checkouts, where the core path map applies. */
  repositoryRoots: readonly string[];
  /** Runtime files that are core wherever they live: the database and the secret store. */
  protectedPaths: readonly string[];
}

export interface AutonomyConfig {
  /** Master switch from the deployment environment. Off until the owner enables step 3. */
  enabled: boolean;
  dailyBudgetYen: number;
  /** Largest increase the owner can approve for one day. */
  maximumExtraYenPerDay: number;
  /** Conversion used for the yen cap. Set above the market rate so the count errs high. */
  yenPerUsd: number;
  timeZone: string;
  maximumPublicReadsPerDay: number;
  /** Reads of the owner's shared Notion pages per owner-local day. */
  maximumNotionReadsPerDay: number;
  /** Looks at the room from her own activity per owner-local day, inside the overall look limits. 0 switches them off. */
  maximumRoomLooksPerDay: number;
  /** Messages she may start on her own, from her own activity, per owner-local day. 0 switches them off. */
  maximumReachOutsPerDay: number;
  /**
   * Second calls after a message of hers got no answer, per owner-local day, at most one per message. 0 switches off the whole
   * act → observe → think-again mechanism: no waiting after a message, no observation, no second thinking step.
   */
  maximumReachOutFollowUpsPerDay: number;
  /** Files she may queue for her folders per owner-local day. */
  maximumHostFolderWritesPerDay: number;
  /** How long a device may hold a claimed step before it is closed as failed. */
  hostStepLeaseMilliseconds: number;
  modelPrices: AutonomyModelPrices;
  places: AutonomyPlaces;
}

const SERVICE_REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));

export function configuredAutonomy(
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
  runtime: { databasePath?: string } = {},
): AutonomyConfig {
  const roots = (value: string | undefined) => (value ?? '').split(delimiter).map(item => item.trim()).filter(Boolean);
  const databasePath = runtime.databasePath && runtime.databasePath !== ':memory:' ? [resolve(runtime.databasePath, '..')] : [];
  return Object.freeze({
    enabled: environment.SHANNON_AUTONOMY_ENABLED?.trim() === 'true',
    dailyBudgetYen: boundedNumber(environment.SHANNON_AUTONOMY_DAILY_BUDGET_YEN, 0, 100_000, SHANNON_AUTONOMY_DAILY_BUDGET_YEN),
    maximumExtraYenPerDay: boundedNumber(environment.SHANNON_AUTONOMY_MAX_EXTRA_YEN, 0, 100_000, 3_000),
    yenPerUsd: boundedNumber(environment.SHANNON_AUTONOMY_YEN_PER_USD, 50, 1_000, 160),
    timeZone: environment.SHANNON_AUTONOMY_TIMEZONE?.trim() || 'Asia/Tokyo',
    maximumPublicReadsPerDay: Math.trunc(boundedNumber(environment.SHANNON_AUTONOMY_MAX_PUBLIC_READS, 0, 10_000, 200)),
    maximumNotionReadsPerDay: Math.trunc(boundedNumber(environment.SHANNON_AUTONOMY_MAX_NOTION_READS, 0, 10_000, 100)),
    // No count a day for the looks of her own time either (owner decision 2026-10-03); 0 switches them off, a number is a cap.
    maximumRoomLooksPerDay: dailyCount(environment.SHANNON_AUTONOMY_MAX_ROOM_LOOKS),
    maximumReachOutsPerDay: dailyCount(environment.SHANNON_AUTONOMY_MAX_REACH_OUTS),
    maximumReachOutFollowUpsPerDay: dailyCount(environment.SHANNON_AUTONOMY_MAX_FOLLOW_UPS),
    maximumHostFolderWritesPerDay: Math.trunc(boundedNumber(environment.SHANNON_AUTONOMY_MAX_HOST_FOLDER_WRITES, 0, 1_000, 10)),
    hostStepLeaseMilliseconds: Math.trunc(boundedNumber(environment.SHANNON_AUTONOMY_HOST_STEP_LEASE_SECONDS, 30, 3_600, 300)) * 1_000,
    modelPrices: configuredAutonomyModelPrices(environment),
    places: Object.freeze({
      ...hostPlaces(environment.SHANNON_AUTONOMY_HOST_FOLDERS_JSON),
      workspaceRoot: environment.SHANNON_AUTONOMY_WORKSPACE_ROOT?.trim() || null,
      productionRoots: Object.freeze([SERVICE_REPOSITORY_ROOT, ...roots(environment.SHANNON_AUTONOMY_PRODUCTION_ROOTS)]),
      repositoryRoots: Object.freeze([SERVICE_REPOSITORY_ROOT, ...roots(environment.SHANNON_AUTONOMY_REPOSITORY_ROOTS)]),
      protectedPaths: Object.freeze([...databasePath, ...roots(environment.SHANNON_AUTONOMY_PROTECTED_PATHS)]),
    }),
  });
}

export interface AutonomyBudgetStatus {
  dayKey: string;
  /** The configured daily cap. */
  baseCapYen: number;
  /** What the owner added for this day only. */
  extraYen: number;
  capYen: number;
  spentYen: number;
  remainingYen: number;
  exhausted: boolean;
  yenPerUsd: number;
}

export function autonomyDayKey(at: string, config: Pick<AutonomyConfig, 'timeZone'>): string {
  return ownerDay(at, config.timeZone);
}

export function autonomyBudgetStatus(
  dayKey: string,
  spentYen: number,
  approvedExtraYen: number,
  config: Pick<AutonomyConfig, 'dailyBudgetYen' | 'maximumExtraYenPerDay' | 'yenPerUsd'>,
): AutonomyBudgetStatus {
  const extraYen = Math.max(0, Math.min(config.maximumExtraYenPerDay, finite(approvedExtraYen)));
  const capYen = config.dailyBudgetYen + extraYen;
  const spent = roundYen(Math.max(0, finite(spentYen)));
  return Object.freeze({
    dayKey,
    baseCapYen: config.dailyBudgetYen,
    extraYen,
    capYen,
    spentYen: spent,
    remainingYen: roundYen(Math.max(0, capYen - spent)),
    exhausted: spent >= capYen,
    yenPerUsd: config.yenPerUsd,
  });
}

/** Whether a paid step of the estimated size still fits in the day. */
export function fitsAutonomyBudget(budget: Pick<AutonomyBudgetStatus, 'capYen' | 'spentYen'>, estimatedCostYen: number): boolean {
  if (!Number.isFinite(estimatedCostYen) || estimatedCostYen < 0) return false;
  return budget.spentYen < budget.capYen && budget.spentYen + estimatedCostYen <= budget.capYen;
}

/** Yen for a USD cost, rounded up to a hundredth of a yen so the count never errs low. */
export function yenFromUsd(costUsd: number, config: Pick<AutonomyConfig, 'yenPerUsd'>): number {
  return Math.ceil(Math.max(0, finite(costUsd)) * config.yenPerUsd * 100 - 1e-9) / 100;
}

export function roundYen(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * `{"<host>": "<absolute folder>"}` names a folder this server can reach itself.
 * `{"<host>": {"deviceId": "<paired device id>"}}` names her folder on the owner's machine: the
 * server never sees it, and only that paired device may claim work for it. An object may carry both.
 */
function hostPlaces(raw: string | undefined): Required<Pick<AutonomyPlaces, 'hostFolders' | 'hostDevices'>> {
  const folders: Record<string, string> = {};
  const devices: Record<string, string> = {};
  try {
    const parsed: unknown = raw?.trim() ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [host, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(host)) continue;
        const entry = value && typeof value === 'object' && !Array.isArray(value) ? value as { folder?: unknown; deviceId?: unknown } : { folder: value };
        if (typeof entry.folder === 'string' && entry.folder.trim()) folders[host] = entry.folder.trim();
        if (typeof entry.deviceId === 'string' && /^[a-f0-9]{16}$/u.test(entry.deviceId)) devices[host] = entry.deviceId;
      }
    }
  } catch { /* an unreadable value registers no host */ }
  return { hostFolders: Object.freeze(folders), hostDevices: Object.freeze(devices) };
}

function boundedNumber(value: string | undefined, minimum: number, maximum: number, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export { dailyCount } from '../../infra/config/dailyCount.js';

/** Yen as the owner reads it in her record (moved from the activity store in stage 3, S2, unchanged). */
export function formatYen(value: number): string {
  const rounded = roundYen(value);
  return `${Number.isInteger(rounded) ? rounded.toLocaleString('en-US') : rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}円`;
}
