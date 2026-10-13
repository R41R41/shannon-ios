import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { OPERATOR_LIMITS, operatorLabel, type OperatorEnvelope } from '../../contracts/operatorContract.js';
import { inspectOperatorAudit, type OperatorAuditInspection, type OperatorAuditRow } from './store/operatorAuditStore.js';
import { operatorSocketPath, requestOperatorSocket } from './operatorSocket.js';

/**
 * The operator's command line (`opsCli.ts`, owner decision 2026-10-14; `docs/operator-minecraft-contract.md`). It never opens
 * the database for writing: `status` reads it read-only, and every other command is one request to the running API over the
 * service user's socket, which audits it, refuses what is out of scope, and does the work itself.
 */
export const OPERATOR_CLI_USAGE = [
  'Usage (as the service user, with SHANNON_DATABASE_PATH set):',
  '  opsCli.ts minecraft status',
  '  opsCli.ts minecraft request --operator <label> [--max-minutes N] [--budget-yen N] <goal...>',
  '  opsCli.ts minecraft cancel --operator <label> (<task-id> | --latest)',
  '  opsCli.ts minecraft <start|stop|login|logout|set_day> --operator <label> [--server <id>]',
].join('\n');

export interface OperatorCliIo { out(line: string): void; err(line: string): void }
export interface OperatorCliDeps {
  send(path: string, body: OperatorEnvelope): Promise<{ status: number; body: unknown }>;
  inspect(path: string, now: string): OperatorAuditInspection;
  socketPresent(path: string): boolean;
  now(): string;
}

const defaults: OperatorCliDeps = {
  send: (path, body) => requestOperatorSocket(path, body),
  inspect: (path, now) => inspectOperatorAudit(path, now),
  socketPresent: path => {
    try {
      return lstatSync(path).isSocket();
    } catch {
      return false;
    }
  },
  now: () => new Date().toISOString(),
};

class UsageError extends Error {}

interface Parsed { flags: Map<string, string | true>; positional: string[] }

/** `--name value`, `--name=value`, a bare `--latest`; everything after `--` is positional. */
function parseArguments(argv: readonly string[]): Parsed {
  const flags = new Map<string, string | true>(), positional: string[] = [];
  const bare = new Set(['--latest']);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (item === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!item.startsWith('--')) {
      positional.push(item);
      continue;
    }
    const [name, inline] = item.split(/=(.*)/su, 2) as [string, string | undefined];
    if (bare.has(name)) flags.set(name, true);
    else if (inline !== undefined) flags.set(name, inline);
    else if (index + 1 < argv.length) flags.set(name, argv[(index += 1)]!);
    else throw new UsageError(`${name} needs a value`);
  }
  return { flags, positional };
}

function whole(value: string | true | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{1,6}$/u.test(value)) throw new UsageError(`${name} must be a whole number`);
  return Number(value);
}

function knownFlags(parsed: Parsed, allowed: readonly string[]): void {
  const unknown = [...parsed.flags.keys()].find(name => !allowed.includes(name));
  if (unknown) throw new UsageError(`${unknown} is not an option of this command`);
}

type Base = Pick<OperatorEnvelope, 'v' | 'operator' | 'domain' | 'op'>;

function requestEnvelope(base: Base, parsed: Parsed): OperatorEnvelope {
  knownFlags(parsed, ['--operator', '--max-minutes', '--budget-yen']);
  const goal = parsed.positional.join(' ').trim();
  if (!goal) throw new UsageError('the request needs a goal');
  const maxMinutes = whole(parsed.flags.get('--max-minutes'), '--max-minutes');
  const budgetYen = whole(parsed.flags.get('--budget-yen'), '--budget-yen');
  const limits = { ...(maxMinutes !== undefined ? { maxMinutes } : {}), ...(budgetYen !== undefined ? { budgetYen } : {}) };
  return { ...base, args: { goal, ...limits } };
}

function cancelEnvelope(base: Base, parsed: Parsed): OperatorEnvelope {
  knownFlags(parsed, ['--operator', '--latest']);
  if (parsed.flags.get('--latest') === true && !parsed.positional.length) return { ...base, args: { latest: true } };
  if (parsed.positional.length !== 1 || parsed.flags.has('--latest')) throw new UsageError('cancel takes one task id or --latest');
  return { ...base, args: { taskId: parsed.positional[0] } };
}

function lifecycleEnvelope(base: Base, parsed: Parsed): OperatorEnvelope {
  knownFlags(parsed, ['--operator', '--server']);
  if (parsed.positional.length) throw new UsageError(`${base.op} takes no words, only --server`);
  const server = parsed.flags.get('--server');
  return { ...base, args: typeof server === 'string' ? { serverId: server } : {} };
}

/** The envelope one command sends. A domain or operation outside Minecraft is sent as it is, so the API refuses and audits it. */
export function operatorEnvelope(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): OperatorEnvelope {
  const [domain, op, ...rest] = argv;
  if (!domain || !op) throw new UsageError('a domain and an operation are required');
  const parsed = parseArguments(rest);
  const operator = (parsed.flags.get('--operator') as string | undefined) ?? env.SHANNON_OPERATOR?.trim();
  if (!operator || operatorLabel(operator) === 'unknown') throw new UsageError('--operator <label> ([A-Za-z0-9._@-], at most 64) is required');
  const base: Base = { v: 1, operator, domain, op };
  if (domain !== 'minecraft') return { ...base, args: {} };
  if (op === 'request') return requestEnvelope(base, parsed);
  if (op === 'cancel') return cancelEnvelope(base, parsed);
  return lifecycleEnvelope(base, parsed);
}

function auditLine(row: OperatorAuditRow): string {
  const ids = [row.taskId && `task=${row.taskId}`, row.lifecycleId && `lifecycle=${row.lifecycleId}`, row.deadlineAt && `until=${row.deadlineAt}`,
    row.budgetYen !== null && `yen=${row.budgetYen}`].filter(Boolean).join(' ');
  return `${row.at}  ${row.operator}  ${row.command}/${row.event}  ${row.code}${row.action ? `  ${row.action}` : ''}${ids ? `  ${ids}` : ''}`;
}

function status(path: string, io: OperatorCliIo, deps: OperatorCliDeps): number {
  const inspection = deps.inspect(path, deps.now());
  const socket = operatorSocketPath(path);
  io.out(`socket: ${deps.socketPresent(socket) ? 'present' : 'absent (SHANNON_OPERATOR_MINECRAFT off, or the API is not running)'}`);
  io.out(`audit schema (execution/012_operator_audit): ${inspection.step}`);
  if (inspection.step === 'changed') {
    io.err('the audit step on this database differs from this build; stop and check the deployment.');
    return 1;
  }
  io.out(`open operator requests: ${inspection.open.length}`);
  for (const row of inspection.open) io.out(`  ${auditLine(row)}`);
  io.out(`recent audit (${inspection.recent.length}):`);
  for (const row of inspection.recent) io.out(`  ${auditLine(row)}`);
  return 0;
}

function printReply(reply: { status: number; body: unknown }, io: OperatorCliIo): number {
  const body = (reply.body && typeof reply.body === 'object' ? reply.body : {}) as Record<string, unknown>;
  if (typeof body.outcome !== 'string') {
    io.err(`the API answered ${reply.status} ${JSON.stringify(body).slice(0, 300)}`);
    return 1;
  }
  const line = (key: string) => body[key] !== undefined && io.out(`${key}: ${String(body[key])}`);
  for (const key of ['outcome', 'code', 'message', 'operationId', 'taskId', 'lifecycleId', 'actionId', 'deadlineAt', 'budgetYen']) line(key);
  return body.outcome === 'accepted' ? 0 : 1;
}

/** Runs one command; the exit code is 0 when accepted (or status read), 1 when refused or failed, 2 for a usage error. */
export async function runOperatorCli(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: OperatorCliIo,
  deps: OperatorCliDeps = defaults): Promise<number> {
  const path = env.SHANNON_DATABASE_PATH?.trim();
  try {
    if (!path || !isAbsolute(path)) throw new UsageError('SHANNON_DATABASE_PATH must name the database (an absolute path)');
    if (!existsSync(path)) throw new UsageError(`no database at ${path}`);
    if (argv[0] === 'minecraft' && argv[1] === 'status' && argv.length === 2) return status(path, io, deps);
    const envelope = operatorEnvelope(argv, env);
    if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > OPERATOR_LIMITS.bodyBytes) throw new UsageError('the request is too long');
    const socket = operatorSocketPath(path);
    if (!deps.socketPresent(socket)) {
      io.err('the operator socket is absent: SHANNON_OPERATOR_MINECRAFT is off, or the API is not running.');
      return 1;
    }
    return printReply(await deps.send(socket, envelope), io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      io.err(OPERATOR_CLI_USAGE);
      return 2;
    }
    io.err(`failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return 1;
  }
}
