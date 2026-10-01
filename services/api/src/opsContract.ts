import { looksSecret } from '@shannon/cognition';

/**
 * The operational snapshot the legacy runtime reports (`docs/ops-contract.md`).
 * It is status for the owner's management window: closed vocabulary, counters, and
 * short operator-facing labels. It carries no conversation text and no model reads it.
 */
export const OPS_SCHEMA_VERSION = 1;
export const OPS_STATUSES = ['running', 'stopped', 'degraded', 'unknown'] as const;
export const OPS_STEP_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'] as const;
export type OpsStatus = typeof OPS_STATUSES[number];
export type OpsStepStatus = typeof OPS_STEP_STATUSES[number];

export const OPS_LIMITS = {
  bodyBytes: 64 * 1024,
  /** A snapshot older than this is reported as stale. The reporter sends one a minute. */
  staleAfterSeconds: 180,
  reportAfterSeconds: 60,
  snapshotsPerMinute: 30,
  readsPerMinute: 120,
  id: 80, label: 80, category: 40, release: 80, server: 80, scheduleName: 80, scheduleTime: 40,
  /** `detail`, a task title and a step title: one short operator-facing label. */
  shortLabel: 120,
  skillName: 80, skillDescription: 160,
  services: 40, minebot: 10, steps: 20, schedules: 60, skills: 100,
  counter: 1_000_000_000_000,
} as const;

export interface OpsSnapshot {
  reportedAt: string;
  runtime: { release: string; startedAt: string };
  services: Array<{ id: string; label: string; category: string; status: OpsStatus; detail?: string }>;
  minebot: Array<{ id: string; server: string; status: OpsStatus; task?: { title: string; steps: Array<{ title: string; status: OpsStepStatus }> } }>;
  schedules: Array<{ name: string; time: string; postedToday?: boolean }>;
  /** Absent when the runtime keeps no such counters; a reporter must not send zeros it did not count. */
  kpi?: { postsToday: number; postsPlanned: number; tokensToday: number; apiCallsToday: number };
  skills: Array<{ name: string; description: string }>;
}

export function opsIngestEnabled(environment: Readonly<Record<string, string | undefined>>): boolean {
  return !['off', 'false', '0', 'disabled'].includes(environment.SHANNON_PLATFORM_OPS_INGEST?.trim().toLowerCase() ?? '');
}

type Fields = Record<string, unknown>;
class Refusal extends Error {}
const refuse = (message: string): never => { throw new Refusal(message); };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
// C0/C1 controls, DEL, line/paragraph separators, bidi overrides and zero-width characters.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u;
const LONG_RUN = /[A-Za-z0-9_+/=]{32,}/gu;
const DOTTED_TOKEN = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/u;

/**
 * Refuses credential-shaped text. `looksSecret` is the guard Shannon's knowledge drafts
 * already use (`packages/cognition/src/shannonKnowledge.ts`); two rules are added for
 * tokens without a known prefix: three long dot-separated parts (a bot token), and an
 * unbroken run of 32 or more token characters that mixes letters and digits.
 */
export function opsSecretLike(text: string): boolean {
  if (looksSecret(text) || DOTTED_TOKEN.test(text)) return true;
  return (text.match(LONG_RUN) ?? []).some(run => /[A-Za-z]/u.test(run) && /[0-9]/u.test(run));
}

function fields(value: unknown, path: string, allowed: readonly string[]): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse(`${path} must be an object`);
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown !== undefined) return refuse(`${path === 'body' ? '' : `${path}.`}${unknown.slice(0, 40).replace(CONTROL, '?')} is not allowed`);
  return value as Fields;
}

function text(value: unknown, path: string, maximum: number): string {
  if (typeof value !== 'string') return refuse(`${path} must be a string`);
  if (CONTROL.test(value)) return refuse(`${path} contains a control character`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum) return refuse(`${path} must contain 1..${maximum} characters`);
  if (opsSecretLike(trimmed)) return refuse(`${path} looks like a credential`);
  return trimmed;
}

function identifier(value: unknown, path: string): string {
  const id = text(value, path, OPS_LIMITS.id);
  return IDENTIFIER.test(id) ? id : refuse(`${path} must match [A-Za-z0-9][A-Za-z0-9_.:-]*`);
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as T : refuse(`${path} must be one of ${allowed.join(', ')}`);
}

function timestamp(value: unknown, path: string): string {
  const parsed = typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/u.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : refuse(`${path} must be an ISO 8601 timestamp`);
}

function counter(value: unknown, path: string): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= OPS_LIMITS.counter
    ? value : refuse(`${path} must be an integer in 0..${OPS_LIMITS.counter}`);
}

function list<T>(value: unknown, path: string, maximum: number, item: (entry: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) return refuse(`${path} must be an array`);
  if (value.length > maximum) return refuse(`${path} must contain at most ${maximum} entries`);
  return value.map((entry, index) => item(entry, `${path}[${index}]`));
}

function unique<T>(entries: T[], key: (entry: T) => string, path: string): T[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(key(entry))) return refuse(`${path} contains a duplicate ${key(entry)}`);
    seen.add(key(entry));
  }
  return entries;
}

function task(value: unknown, path: string): NonNullable<OpsSnapshot['minebot'][number]['task']> {
  const source = fields(value, path, ['title', 'steps']);
  return {
    title: text(source.title, `${path}.title`, OPS_LIMITS.shortLabel),
    steps: list(source.steps, `${path}.steps`, OPS_LIMITS.steps, (entry, at) => {
      const step = fields(entry, at, ['title', 'status']);
      return { title: text(step.title, `${at}.title`, OPS_LIMITS.shortLabel), status: oneOf(step.status, `${at}.status`, OPS_STEP_STATUSES) };
    }),
  };
}

/** The validated, normalized snapshot, or the reason the request is refused. Nothing is stored on refusal. */
export function validatedOpsSnapshot(value: unknown): OpsSnapshot | string {
  try {
    const body = fields(value, 'body', ['schemaVersion', 'scopeKey', 'reportedAt', 'runtime', 'services', 'minebot', 'schedules', 'kpi', 'skills']);
    if (body.schemaVersion !== undefined && body.schemaVersion !== OPS_SCHEMA_VERSION) refuse(`schemaVersion must be ${OPS_SCHEMA_VERSION}`);
    text(body.scopeKey, 'scopeKey', 160);
    const runtime = fields(body.runtime, 'runtime', ['release', 'startedAt']);
    const kpi = body.kpi === undefined ? null : fields(body.kpi, 'kpi', ['postsToday', 'postsPlanned', 'tokensToday', 'apiCallsToday']);
    return {
      reportedAt: timestamp(body.reportedAt, 'reportedAt'),
      runtime: { release: text(runtime.release, 'runtime.release', OPS_LIMITS.release), startedAt: timestamp(runtime.startedAt, 'runtime.startedAt') },
      services: unique(list(body.services, 'services', OPS_LIMITS.services, (entry, at) => {
        const service = fields(entry, at, ['id', 'label', 'category', 'status', 'detail']);
        return {
          id: identifier(service.id, `${at}.id`), label: text(service.label, `${at}.label`, OPS_LIMITS.label),
          category: text(service.category, `${at}.category`, OPS_LIMITS.category), status: oneOf(service.status, `${at}.status`, OPS_STATUSES),
          ...(service.detail === undefined ? {} : { detail: text(service.detail, `${at}.detail`, OPS_LIMITS.shortLabel) }),
        };
      }), service => service.id, 'services'),
      minebot: unique(list(body.minebot, 'minebot', OPS_LIMITS.minebot, (entry, at) => {
        const bot = fields(entry, at, ['id', 'server', 'status', 'task']);
        return {
          id: identifier(bot.id, `${at}.id`), server: text(bot.server, `${at}.server`, OPS_LIMITS.server),
          status: oneOf(bot.status, `${at}.status`, OPS_STATUSES),
          ...(bot.task === undefined ? {} : { task: task(bot.task, `${at}.task`) }),
        };
      }), bot => bot.id, 'minebot'),
      schedules: list(body.schedules, 'schedules', OPS_LIMITS.schedules, (entry, at) => {
        const schedule = fields(entry, at, ['name', 'time', 'postedToday']);
        if (schedule.postedToday !== undefined && typeof schedule.postedToday !== 'boolean') refuse(`${at}.postedToday must be a boolean`);
        return {
          name: text(schedule.name, `${at}.name`, OPS_LIMITS.scheduleName), time: text(schedule.time, `${at}.time`, OPS_LIMITS.scheduleTime),
          ...(schedule.postedToday === undefined ? {} : { postedToday: schedule.postedToday as boolean }),
        };
      }),
      ...(kpi ? { kpi: {
        postsToday: counter(kpi.postsToday, 'kpi.postsToday'), postsPlanned: counter(kpi.postsPlanned, 'kpi.postsPlanned'),
        tokensToday: counter(kpi.tokensToday, 'kpi.tokensToday'), apiCallsToday: counter(kpi.apiCallsToday, 'kpi.apiCallsToday'),
      } } : {}),
      skills: list(body.skills, 'skills', OPS_LIMITS.skills, (entry, at) => {
        const skill = fields(entry, at, ['name', 'description']);
        return { name: text(skill.name, `${at}.name`, OPS_LIMITS.skillName), description: text(skill.description, `${at}.description`, OPS_LIMITS.skillDescription) };
      }),
    };
  } catch (error) {
    if (error instanceof Refusal) return error.message;
    throw error;
  }
}
