import { OPS_LIMITS, opsIdentifier, opsLabel, type OpsSnapshot } from './opsContract.js';

/**
 * Operations console, stage 2 (`docs/ops-contract.md`): what the owner's desktop may ask
 * the legacy runtime to do. A command is a closed type and one target that the latest
 * snapshot names. It has no arguments and no text, and no model reads or writes one.
 */
export const OPS_COMMAND_TYPES = ['service.start', 'service.stop', 'schedule.run', 'minecraft.start', 'minecraft.stop'] as const;
export type OpsCommandType = typeof OPS_COMMAND_TYPES[number];

export const OPS_COMMAND_STATUSES = ['pending', 'claimed', 'done', 'failed', 'refused', 'expired'] as const;
export type OpsCommandStatus = typeof OPS_COMMAND_STATUSES[number];

export const OPS_COMMAND_OUTCOMES = ['done', 'failed', 'refused'] as const;
export type OpsCommandOutcome = typeof OPS_COMMAND_OUTCOMES[number];

/** The codes the runtime may report. Nothing else describes an outcome: there is no free text. */
export const OPS_COMMAND_REPORT_CODES = [
  'not_registered', 'already_running', 'already_stopped', 'busy', 'lab_running', 'timeout', 'error', 'unsupported', 'not_allowed',
] as const;
export type OpsCommandReportCode = typeof OPS_COMMAND_REPORT_CODES[number];
/** Set by the server, never reported: the runtime claimed the command and did not report in time. */
export const OPS_COMMAND_NO_REPORT = 'no_report';
export type OpsCommandCode = OpsCommandReportCode | typeof OPS_COMMAND_NO_REPORT;

export const OPS_COMMAND_LIMITS = {
  bodyBytes: 4 * 1024,
  /** Commands that are `pending` or `claimed` at once, per scope. */
  open: 5,
  /** Accepted commands in any 60 minutes, per scope. Counted from the record, so a restart does not reset it. */
  perHour: 20,
  /** A command not claimed this long after it was created is `expired` and never handed out. */
  claimWithinSeconds: 300,
  /** A claimed command not reported this long after the claim is `failed` / `no_report` and never handed out again. */
  reportWithinSeconds: 120,
  /** How many commands `GET /v1/ops` lists, newest first. */
  recent: 20,
  requestsPerMinute: 30,
  claimsPerMinute: 60,
  reportsPerMinute: 60,
  pollAfterSeconds: 10,
  pollAfterSecondsWhenOff: 60,
} as const;

/**
 * The allowlist. A service the runtime registers and that is absent here cannot be
 * commanded: `minecraft:<server>` as a `service.*` target (use `minecraft.*`), and anything new.
 * `minecraft` is the server manager, not a server.
 */
export const OPS_SERVICE_START_ALLOWED: readonly string[] = ['discord', 'twitter', 'youtube', 'youtube:live_chat', 'notion', 'minecraft'];
/**
 * `discord` is absent on purpose. Stopping it takes Shannon offline on Discord and stops
 * the Discord side of the platform bridge. It can be started from here, and stopped on the VM.
 */
export const OPS_SERVICE_STOP_ALLOWED: readonly string[] = ['twitter', 'youtube', 'youtube:live_chat', 'notion', 'minebot', 'minebot:bot', 'minecraft'];
/**
 * Can be stopped, cannot be started: starting the production Minebot body begins using a
 * paid planner API outside its budget controls. Opening this needs a separate owner
 * decision; then move these ids into `OPS_SERVICE_START_ALLOWED`.
 */
export const OPS_SERVICE_START_WITHHELD: readonly string[] = ['minebot', 'minebot:bot'];
/** Lab servers are never manageable, whatever the type. */
export const OPS_FORBIDDEN_TARGET_PREFIXES: readonly string[] = ['progressive-lab-', 'minecraft:progressive-lab-'];
export const OPS_MINECRAFT_PREFIX = 'minecraft:';

/** Off unless the owner switches it on: the legacy runtime must be deployed with its claimer first. */
export function opsCommandsEnabled(environment: Readonly<Record<string, string | undefined>>): boolean {
  return ['on', 'true', '1', 'enabled'].includes(environment.SHANNON_PLATFORM_OPS_COMMANDS?.trim().toLowerCase() ?? '');
}

export interface OpsCommandRequest {
  idempotencyKey: string;
  type: OpsCommandType;
  /** Normalized: a `minecraft.*` target always carries the `minecraft:` prefix. */
  target: string;
}

export interface OpsCommandRefusal {
  status: 400 | 403;
  error: 'INVALID_REQUEST' | 'TARGET_NOT_ALLOWED';
  message: string;
}

export interface OpsCommandAllowed {
  serviceStart: string[];
  serviceStop: string[];
  minecraft: boolean;
  scheduleRun: boolean;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,79}$/u;
const invalid = (message: string): OpsCommandRefusal => ({ status: 400, error: 'INVALID_REQUEST', message });
const notAllowed = (message: string): OpsCommandRefusal => ({ status: 403, error: 'TARGET_NOT_ALLOWED', message });

export function opsTargetForbidden(target: string): boolean {
  return OPS_FORBIDDEN_TARGET_PREFIXES.some(prefix => target.startsWith(prefix));
}

function manageableMinecraftService(id: string): boolean {
  return id.startsWith(OPS_MINECRAFT_PREFIX) && id.length > OPS_MINECRAFT_PREFIX.length && !opsTargetForbidden(id);
}

/**
 * The request as it will be recorded, or why it is refused. This part needs no snapshot:
 * the fields, and the allowlist. `opsCommandTargetKnown` checks the target against one.
 */
export function validatedOpsCommandRequest(value: unknown): OpsCommandRequest | OpsCommandRefusal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('JSON object body is required');
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).find(key => !['scopeKey', 'idempotencyKey', 'type', 'target'].includes(key));
  if (unknown !== undefined) return invalid(`${unknown.slice(0, 40).replace(/[^\x20-\x7e]/gu, '?')} is not allowed`);
  const idempotencyKey = body.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return invalid('idempotencyKey must be 8..80 characters of [A-Za-z0-9_.:-]');
  }
  const type = OPS_COMMAND_TYPES.find(candidate => candidate === body.type);
  if (!type) return invalid(`type must be one of ${OPS_COMMAND_TYPES.join(', ')}`);
  const lab = notAllowed('Lab servers (progressive-lab-*) are not managed from the operations console.');

  if (type === 'schedule.run') {
    const name = opsLabel(body.target, OPS_LIMITS.scheduleName);
    if (name === null) return invalid('target must be a schedule name of the snapshot');
    return opsTargetForbidden(name) ? lab : { idempotencyKey, type, target: name };
  }
  const id = opsIdentifier(body.target);
  if (id === null) return invalid('target must match [A-Za-z0-9][A-Za-z0-9_.:-]* and be at most 80 characters');
  if (type === 'minecraft.start' || type === 'minecraft.stop') {
    const target = id.startsWith(OPS_MINECRAFT_PREFIX) ? id : `${OPS_MINECRAFT_PREFIX}${id}`;
    if (target.length > OPS_LIMITS.id || opsIdentifier(target.slice(OPS_MINECRAFT_PREFIX.length)) === null) {
      return invalid('target must be a Minecraft server id of the snapshot');
    }
    return opsTargetForbidden(target) ? lab : { idempotencyKey, type, target };
  }
  if (opsTargetForbidden(id)) return lab;
  if (type === 'service.stop' && id === 'discord') {
    return notAllowed('Discord cannot be stopped from here: it would take Shannon offline on Discord and stop the Discord side of the bridge.');
  }
  if (type === 'service.start' && OPS_SERVICE_START_WITHHELD.includes(id)) {
    return notAllowed('Minebot cannot be started from here: it would begin using a paid planner API outside its budget controls.');
  }
  const allowlist = type === 'service.start' ? OPS_SERVICE_START_ALLOWED : OPS_SERVICE_STOP_ALLOWED;
  if (!allowlist.includes(id)) return notAllowed('This service is not on the list the operations console may start or stop.');
  return { idempotencyKey, type, target: id };
}

/** Whether the latest snapshot names the target. A command for something the runtime did not report is refused. */
export function opsCommandTargetKnown(request: Pick<OpsCommandRequest, 'type' | 'target'>, snapshot: OpsSnapshot): boolean {
  if (request.type === 'schedule.run') return snapshot.schedules.some(schedule => schedule.name === request.target);
  return snapshot.services.some(service => service.id === request.target);
}

/** What the desktop may offer: the allowlist intersected with what a current snapshot reports. Null: nothing. */
export function opsCommandsAllowed(snapshot: OpsSnapshot | null): OpsCommandAllowed {
  if (!snapshot) return { serviceStart: [], serviceStop: [], minecraft: false, scheduleRun: false };
  const ids = snapshot.services.map(service => service.id).filter(id => !opsTargetForbidden(id));
  return {
    serviceStart: ids.filter(id => OPS_SERVICE_START_ALLOWED.includes(id)),
    serviceStop: ids.filter(id => OPS_SERVICE_STOP_ALLOWED.includes(id)),
    minecraft: ids.some(manageableMinecraftService),
    scheduleRun: snapshot.schedules.some(schedule => !opsTargetForbidden(schedule.name)),
  };
}

export function isOpsCommandReportCode(value: unknown): value is OpsCommandReportCode {
  return typeof value === 'string' && (OPS_COMMAND_REPORT_CODES as readonly string[]).includes(value);
}
