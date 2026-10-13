import { DatabaseSync } from 'node:sqlite';
import { stage4Enabled } from '../infra/config/stage4.js';
import { configuredRemoteMind } from './remoteMindWiring.js';
import type { ActionThreads } from '../contracts/actionThreadContract.js';
import { mindSwitches } from '../mind/perception/perceptionPorts.js';
import { createMindHost, type MindHost, type MindTurnPorts } from '../mind/workspace/workspacePorts.js';
import { SQLiteWorkspaceJournal } from '../mind/workspace/store/workspaceJournalStore.js';
import { SQLiteMindInbox } from '../mind/workspace/store/mindInboxStore.js';
import type { EmitMindEvent } from '../contracts/mindInboxContract.js';
import type { CompanionStateSnapshot } from '@shannon/cognition';
import { ActionLeaseReader } from '../mind/action/threads/store/actionLeaseReader.js';
import {
  agentTaskOutcomeNotices, lateFolderOutcomeNotices, lifecycleOutcomeNotices, promiseDueNotices,
  type EndedTask, type LateFolderReport, type LifecycleReport, type ProducedNotice,
} from '../mind/perception/noticeProducers.js';

/**
 * Wiring of Syzygy ADR-0008 stage 3's mind (`docs/mind-workspace-contract.md`). Null with `SHANNON_ADR8_STAGE3=off` or
 * `SHANNON_MIND_EVENTS=off`: then no surface perceives anything and every turn is afb38c28's.
 *
 * - Perception alone (`SHANNON_ATTENTION=off`): every surface builds its event, and nothing holds it.
 * - Attention without the workspace (`SHANNON_WORKSPACE=off`): what was perceived is ordered in memory; no table, no block.
 * - The workspace: the API process creates `mind_workspace_journal`, `mind_workspace_snapshots` and `mind_inbox`, restores the
 *   workspace (snapshot + journal), tails the inbox every 2 seconds and writes the journal after responses; the turn's prompt
 *   gets `[いまの場]`, the notices and (with `SHANNON_DATA_FRAMES`) the data frames.
 */
const PRAGMAS = 'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;';
/**
 * Once its tables exist, the journal's connection waits a short while only (stage 3 review): its writes are off the response path,
 * a busy write is retried at the next tick with its batch kept, and a long wait would hold the API's event loop.
 */
export const JOURNAL_BUSY_TIMEOUT_MILLISECONDS = 250;
const TICK_MILLISECONDS = 2_000;
/** How often the producers of the notices of a promise's time and of a task's end look (`noticeProducers.ts`). */
const NOTICE_MILLISECONDS = 60_000;

/** What the producers of the notices read: the owner's scope, his state (promises), his agent tasks. */
export interface NoticeSources {
  ownerScopeKey: string;
  snapshot(scopeKey: string): CompanionStateSnapshot | null;
  tasks(scopeKey: string): readonly EndedTask[];
}

export interface MindWiringParts {
  role?: 'api' | 'worker';
  databasePath: string | null;
  now: () => string;
  /** Runs the journal's write after a response; default `setImmediate`. */
  schedule?: (task: () => void) => void;
  /** Starts the 2-second tick (tail the inbox, write the journal); the server does, a test ticks by hand. */
  ticking?: boolean;
  timeZone?: string;
  log?: (line: string) => void;
  /** The sources of `【知らせ:約束の時刻】` and `【知らせ:作業終了】`; written into the inbox once each, every minute while ticking. */
  notices?: NoticeSources;
}

export function configuredMind(
  environment: Readonly<Record<string, string | undefined>>,
  parts: MindWiringParts = { databasePath: null, now: () => new Date().toISOString() },
): { mind: MindTurnPorts; host: MindHost | null; actions?: ActionThreads; close(): void; produceNotices?(): number } | null {
  const switches = mindSwitches(environment);
  if (!switches.mindEvents) return null;
  if (!switches.attention) return { mind: { perceive: () => null }, host: null, close: () => {} };
  if(stage4Enabled(environment) && parts.role!=='worker' && parts.databasePath){
    const remote=configuredRemoteMind(environment,parts.databasePath);
    // Notice producers remain API readers; they only append closed events, never own the workspace.
    const db=parts.notices?new DatabaseSync(parts.databasePath):null;
    if(db)db.exec(PRAGMAS);
    const inbox=db?new SQLiteMindInbox(db,{createSchema:true}):null;
    const produceNotices=()=>db&&inbox&&parts.notices?producedNotices(db,inbox,parts.notices,parts.now(),parts.log):0;
    const timer=parts.ticking&&inbox?setInterval(produceNotices,NOTICE_MILLISECONDS):null;timer?.unref();
    return {...remote,produceNotices,close:()=>{if(timer)clearInterval(timer);remote.close();db?.close();}};
  }
  const database = switches.workspace && parts.databasePath ? new DatabaseSync(parts.databasePath) : null;
  if (database) database.exec(PRAGMAS);
  const host = createMindHost({
    switches, now: parts.now,
    journal: database ? new SQLiteWorkspaceJournal(database, { createSchema: true }) : null,
    inbox: database ? new SQLiteMindInbox(database, { createSchema: true }) : null,
    ...(parts.schedule ? { schedule: parts.schedule } : {}), ...(parts.log ? { log: parts.log } : {}), ...(parts.timeZone ? { timeZone: parts.timeZone } : {}),
  });
  if (database) database.exec(`PRAGMA busy_timeout = ${JOURNAL_BUSY_TIMEOUT_MILLISECONDS};`);
  const timer = parts.ticking && database ? setInterval(() => host.tick(), TICK_MILLISECONDS) : null;
  timer?.unref();
  const inbox = database ? new SQLiteMindInbox(database, { createSchema: false }) : null;
  const produceNotices = inbox && parts.notices ? () => producedNotices(database!, inbox, parts.notices!, parts.now(), parts.log) : null;
  const noticeTimer = produceNotices && parts.ticking ? setInterval(produceNotices, NOTICE_MILLISECONDS) : null;
  noticeTimer?.unref();
  return {
    mind: host, host, ...(produceNotices ? { produceNotices } : {}),
    close: () => {
      if (timer) clearInterval(timer);
      if (noticeTimer) clearInterval(noticeTimer);
      if (database?.isOpen) database.exec(PRAGMAS); // The last write may wait as long as any other.
      host.close();
      if (database?.isOpen) database.close();
    },
  };
}

// The inbox writer another process is handed lives in `mindInboxWiring.ts`, so such a process loads nothing else of the mind.
export { configuredMindInbox } from './mindInboxWiring.js';
export { withMindOps } from './mindOpsWiring.js';

/**
 * Writes into the inbox, once each (by kind and source id), the notices of the owner's promises whose time is near, of his agent
 * tasks that ended, and of her own time's folder operations whose report came after her step stopped waiting. Closed values only.
 * Answers how many rows it wrote. Never throws.
 */
function producedNotices(database: DatabaseSync, inbox: SQLiteMindInbox, sources: NoticeSources, at: string, log?: (line: string) => void): number {
  const scopeKey = sources.ownerScopeKey;
  const produced: ProducedNotice[] = [];
  const safely = (name: string, read: () => readonly ProducedNotice[]) => {
    try { produced.push(...read()); } catch (error) { try { log?.(`notice producer ${name} failed: ${error instanceof Error ? error.name : 'unknown'}`); } catch { /* optional */ } }
  };
  safely('promises', () => { const state = sources.snapshot(scopeKey); return state ? promiseDueNotices(state, at) : []; });
  safely('tasks', () => agentTaskOutcomeNotices(sources.tasks(scopeKey), at));
  safely('folder', () => lateFolderOutcomeNotices(lateFolderReports(database, scopeKey, at), at));
  safely('minecraft', () => lifecycleOutcomeNotices(lifecycleReports(database, scopeKey, at), at));
  let written = 0;
  for (const notice of produced) {
    try {
      if (inbox.has(scopeKey, notice.draft.kind, notice.draft.sourceId)) continue;
      if (inbox.append(scopeKey, notice.draft, notice.at)) written += 1;
    } catch { /* a row that is not closed is not written */ }
  }
  return written;
}

/** Her own time's folder operations that closed after her step stopped waiting, or that ran out, in the last hour. */
function lateFolderReports(database: DatabaseSync, scopeKey: string, at: string): readonly LateFolderReport[] {
  const exists = database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'autonomy_host_operations'`).get();
  if (!exists) return [];
  const since = new Date(Date.parse(at) - 60 * 60_000).toISOString();
  return (database.prepare(`
    SELECT op_id, tool, status, finished_at FROM autonomy_host_operations
    WHERE scope_key = ? AND origin = 'autonomy' AND finished_at IS NOT NULL AND finished_at >= ? AND (waiter_gone = 1 OR status = 'expired')
  `).all(scopeKey, since) as Array<{ op_id: string; tool: string; status: string; finished_at: string }>)
    .map(row => ({ id: row.op_id, tool: row.tool, status: row.status, finishedAt: row.finished_at }));
}

/**
 * The Minecraft lifecycle operations she answered with 「受け付けました」 in a conversation, within the last hour: their accepted
 * receipt, or that they never started (`lifecycle_not_started:<action>:<reason>`, with its closed reason).
 */
function lifecycleReports(database: DatabaseSync, scopeKey: string, at: string): LifecycleReport[] {
  const since = Date.parse(at) - 60 * 60_000;
  const leases = new ActionLeaseReader(database);
  const received = leases.ownLifecycleReceipts(scopeKey).filter(row => Date.parse(row.observedAt) >= since);
  const notStarted = leases.notStartedLifecycle(scopeKey).filter(row => Date.parse(row.at) >= since).flatMap(row => {
    const [, action, reason] = row.result.split(':');
    return action && reason ? [{ id: row.id, action, outcome: 'failed', observedAt: row.at, notStarted: reason }] : [];
  });
  const unknown = leases.unknownExitedLifecycle(scopeKey).filter(row => Date.parse(row.at) >= since)
    .map(row => ({ id: row.id, action: row.action, outcome: 'unknown', observedAt: row.at }));
  return [...received, ...notStarted, ...unknown];
}
