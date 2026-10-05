import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 実際の利用から集めるもの (Syzygy ADR-0003): the reach measures that can be read from a copy of the
 * production database, as counts and rates over a window, with a weekly trend.
 *
 * Read-only by construction: the file is opened with `readOnly`, the production path is refused, and no
 * environment variable is read. Message text is read only inside the two pattern checks of 一度で伝わる and
 * never leaves them; the report holds numbers, closed codes, and week keys only.
 */
export const PRODUCTION_DATABASE_DIRECTORY = '/home/azureuser/shannon-ios-data/';
const DAY = 86_400_000;
/** The same opening words the conversation orchestration treats as a correction (`conversationOrchestration.ts`). */
const CORRECTION = /^(?:違う|ちがう|訂正|そうじゃなく|そうではなく|いや[、,]|ではなく|じゃなく)/u;
const REASK_WINDOW = 10 * 60_000;
const REACTION_SCORE: Readonly<Record<string, number>> = { unclear: 0, more: 1, like: 2 };

export interface UsageReportOptions {
  days: number;
  until: string;
  scopeKey: string;
  /** Directories whose databases are refused (the production one by default), compared after symbolic links are resolved. */
  refusedDirectories?: readonly string[];
}

type Rate = { numerator: number; denominator: number; rate: number | null };
type Unavailable = { available: false; reason: string };

export interface UsageReport {
  schemaVersion: 1;
  kind: 'shannon-reach-usage';
  window: { from: string; until: string; days: number };
  measures: Record<string, Record<string, unknown> | Unavailable>;
}

const rate = (numerator: number, denominator: number): Rate => ({ numerator, denominator, rate: denominator ? Math.round(numerator / denominator * 1000) / 1000 : null });

const JST_OFFSET = 9 * 3_600_000;

/** ISO week key of an instant in the owner's time (Tokyo), `2026-W40`, for the weekly trend. */
export function weekKey(at: string): string {
  const date = new Date(Date.parse(at) + JST_OFFSET);
  const day = (date.getUTCDay() + 6) % 7;
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 3));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thursday.getTime() - firstThursday.getTime()) / DAY - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function reachUsageReport(path: string, options: UsageReportOptions): UsageReport {
  const absolute = realPath(path);
  for (const directory of options.refusedDirectories ?? [PRODUCTION_DATABASE_DIRECTORY]) {
    const refused = realPath(directory);
    if (absolute === refused || absolute.startsWith(refused.endsWith(sep) ? refused : `${refused}${sep}`)) {
      throw new Error('REACH_USAGE_PRODUCTION_PATH: run it against a copy');
    }
  }
  const database = new DatabaseSync(absolute, { readOnly: true });
  try {
    const until = options.until;
    const from = new Date(Date.parse(until) - options.days * DAY).toISOString();
    const tables = new Set((database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(row => row.name));
    const has = (...names: string[]) => names.every(name => tables.has(name));
    const missing = (...names: string[]): Unavailable => ({ available: false, reason: `missing table: ${names.filter(name => !tables.has(name)).join(', ')}` });
    const scope = options.scopeKey;
    const all = <T>(sql: string, ...values: (string | number)[]) => database.prepare(sql).all(...values) as unknown as T[];

    const measures: UsageReport['measures'] = {};

    // 話しかけが的確: her own messages, and whether the owner wrote or spoke within 30 minutes and 2 hours.
    measures.reachOutAnswered = has('initiative_messages', 'conversation_messages') ? (() => {
      const sent = all<{ created_at: string; read_at: string | null; follow_up: number }>(`
        SELECT created_at, read_at, source_item_id LIKE 'reach-out:follow_up:%' AS follow_up FROM initiative_messages
        WHERE scope_key = ? AND source_item_id LIKE 'reach-out:%' AND created_at >= ? AND created_at < ?`, scope, from, until);
      const answered = (at: string, window: number) => Boolean(database.prepare(`
        SELECT 1 AS found FROM conversation_messages WHERE scope_key = ? AND role = 'user' AND observed_at > ? AND observed_at <= ? LIMIT 1
      `).get(scope, at, new Date(Date.parse(at) + window).toISOString()));
      const first = sent.filter(row => !row.follow_up);
      const weekly: Record<string, Rate> = {};
      for (const week of [...new Set(first.map(row => weekKey(row.created_at)))].sort()) {
        const rows = first.filter(row => weekKey(row.created_at) === week);
        weekly[week] = rate(rows.filter(row => answered(row.created_at, 2 * 3_600_000)).length, rows.length);
      }
      const deliveries = has('reach_out_deliveries') ? Object.fromEntries(all<{ outcome: string; count: number }>(`
        SELECT outcome, COUNT(*) AS count FROM reach_out_deliveries WHERE scope_key = ? AND reported_at >= ? AND reported_at < ? GROUP BY outcome
      `, scope, from, until).map(row => [row.outcome, Number(row.count)])) : null;
      return {
        sent: first.length, followUps: sent.length - first.length,
        answeredWithin30Minutes: rate(first.filter(row => answered(row.created_at, 1_800_000)).length, first.length),
        answeredWithin2Hours: rate(first.filter(row => answered(row.created_at, 2 * 3_600_000)).length, first.length),
        opened: rate(first.filter(row => row.read_at).length, first.length),
        deliveries, weekly,
        goodReaction: { available: false, reason: 'no reaction signal is stored for her messages yet' },
      };
    })() : missing('initiative_messages', 'conversation_messages');

    // 一度で伝わる: owner messages that open as a correction, or repeat his previous message within ten minutes.
    measures.correctionsAndReasks = has('conversation_messages') ? (() => {
      const rows = all<{ content: string; observed_at: string }>(`
        SELECT content, observed_at FROM conversation_messages WHERE scope_key = ? AND role = 'user' AND observed_at >= ? AND observed_at < ?
        ORDER BY observed_at, sequence`, scope, from, until);
      let corrections = 0;
      let reasks = 0;
      const weekly: Record<string, { messages: number; corrections: number; reasks: number }> = {};
      rows.forEach((row, index) => {
        const week = (weekly[weekKey(row.observed_at)] ??= { messages: 0, corrections: 0, reasks: 0 });
        week.messages += 1;
        const text = row.content.trim();
        if (CORRECTION.test(text)) { corrections += 1; week.corrections += 1; }
        const previous = rows[index - 1];
        if (previous && Date.parse(row.observed_at) - Date.parse(previous.observed_at) <= REASK_WINDOW && similar(previous.content, text)) { reasks += 1; week.reasks += 1; }
      });
      return { ownerMessages: rows.length, corrections: rate(corrections, rows.length), reasks: rate(reasks, rows.length), weekly };
    })() : missing('conversation_messages');

    // やり切る (agent work the owner asked for): how the tasks begun in the window ended.
    measures.requestsCompleted = has('agent_tasks') ? (() => {
      const statuses = Object.fromEntries(all<{ status: string; count: number }>(`
        SELECT status, COUNT(*) AS count FROM agent_tasks WHERE scope_key = ? AND created_at >= ? AND created_at < ? GROUP BY status
      `, scope, from, until).map(row => [row.status, Number(row.count)]));
      const ended = (statuses.completed ?? 0) + (statuses.failed ?? 0) + (statuses.cancelled ?? 0);
      return { statuses, completed: rate(statuses.completed ?? 0, ended) };
    })() : missing('agent_tasks');

    // 人の像が合っている: how often what she knows was corrected, by week.
    measures.knowledgeCorrections = has('knowledge_revisions') ? (() => {
      const rows = all<{ observed_at: string }>(`SELECT observed_at FROM knowledge_revisions WHERE scope_key = ? AND observed_at >= ? AND observed_at < ?`, scope, from, until);
      const weekly: Record<string, number> = {};
      for (const row of rows) weekly[weekKey(row.observed_at)] = (weekly[weekKey(row.observed_at)] ?? 0) + 1;
      return { revisions: rows.length, weekly, confirmedRate: { available: false, reason: 'no confirmation of her picture of the owner is stored yet' } };
    })() : missing('knowledge_revisions');

    // 作って、直して、良くなる: stories that reached the owner, and whether a revision after his reaction was liked better.
    measures.storiesShownAndRevised = has('study_pieces', 'study_feedback') ? (() => {
      const shown = Number((database.prepare(`
        SELECT COUNT(*) AS count FROM study_pieces WHERE scope_key = ? AND kind = 'story' AND readable_version IS NOT NULL AND updated_at >= ? AND updated_at < ?
      `).get(scope, from, until) as { count: number }).count);
      const feedback = all<{ piece_id: string; version: number; reaction: string }>(`
        SELECT piece_id, version, reaction FROM study_feedback WHERE scope_key = ? AND created_at < ? ORDER BY created_at`, scope, until);
      const byPiece = new Map<string, Array<{ version: number; score: number }>>();
      for (const row of feedback) byPiece.set(row.piece_id, [...(byPiece.get(row.piece_id) ?? []), { version: Number(row.version), score: REACTION_SCORE[row.reaction] ?? 0 }]);
      let revisedAfterReaction = 0;
      let better = 0;
      for (const reactions of byPiece.values()) {
        const first = reactions[0]!;
        const later = reactions.find(item => item.version > first.version);
        if (!later) continue;
        revisedAfterReaction += 1;
        if (later.score > first.score) better += 1;
      }
      return { storiesReadable: shown, revisedAfterReaction, reactionImproved: rate(better, revisedAfterReaction) };
    })() : missing('study_pieces', 'study_feedback');

    // できることが増える: her proposals and what the owner did with them.
    measures.proposals = has('autonomy_proposals') ? {
      statuses: Object.fromEntries(all<{ status: string; count: number }>(`
        SELECT status, COUNT(*) AS count FROM autonomy_proposals WHERE scope_key = ? AND created_at >= ? AND created_at < ? GROUP BY status
      `, scope, from, until).map(row => [row.status, Number(row.count)])),
      toolUses: { available: false, reason: 'tools she added are not on main yet' },
    } : missing('autonomy_proposals');

    // Her pacing: how her sessions ended, and what a day cost.
    measures.ownTimePacing = has('autonomy_loop_sessions', 'autonomy_spend') ? (() => {
      const ends = Object.fromEntries(all<{ code: string; count: number }>(`
        SELECT end_code AS code, COUNT(*) AS count FROM autonomy_loop_sessions WHERE scope_key = ? AND ended_at >= ? AND ended_at < ? GROUP BY end_code
      `, scope, from, until).map(row => [row.code, Number(row.count)]));
      const days = all<{ yen: number }>(`SELECT SUM(cost_yen) AS yen FROM autonomy_spend WHERE scope_key = ? AND occurred_at >= ? AND occurred_at < ? GROUP BY day_key`, scope, from, until);
      const closed = Object.values(ends).reduce((sum, count) => sum + count, 0);
      return {
        sessionEnds: ends, restByHer: rate(ends.rest ?? 0, closed), activeDays: days.length,
        yenPerActiveDay: days.length ? Math.round(days.reduce((sum, row) => sum + Number(row.yen), 0) / days.length * 100) / 100 : null,
      };
    })() : missing('autonomy_loop_sessions', 'autonomy_spend');

    return { schemaVersion: 1, kind: 'shannon-reach-usage', window: { from, until, days: options.days }, measures };
  } finally {
    database.close();
  }
}

/** A path with every symbolic link resolved; a path that does not exist (yet) as written. */
function realPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** Two owner messages say the same thing: equal after spacing and punctuation, or nearly the same pairs of characters. */
function similar(left: string, right: string): boolean {
  const normal = (text: string) => text.replace(/[\s、。,.!?！？「」]/gu, '');
  const a = normal(left);
  const b = normal(right);
  if (a.length < 6 || b.length < 6) return false;
  if (a === b) return true;
  const pairs = (text: string) => new Set(Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2)));
  const x = pairs(a);
  const y = pairs(b);
  const shared = [...x].filter(pair => y.has(pair)).length;
  return shared / (x.size + y.size - shared) >= 0.8;
}

export function usageReportMarkdown(report: UsageReport): string {
  const lines = [`# Shannon reach measures from use`, '', `- Window: ${report.window.from} to ${report.window.until} (${report.window.days} days)`, ''];
  for (const [name, value] of Object.entries(report.measures)) {
    lines.push(`## ${name}`, '', '```json', JSON.stringify(value, null, 2), '```', '');
  }
  return lines.join('\n');
}
