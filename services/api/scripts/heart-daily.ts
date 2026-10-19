/**
 * The day's numbers of her heart (owner 2026-10-19, item 17; `src/mind/emotion/heartDaily.ts`), read from the database opened
 * read-only. Nothing is written; no word of his is printed, and of hers only the stock phrases she repeated.
 *
 *   node --import tsx services/api/scripts/heart-daily.ts [--days 7] [--until YYYY-MM-DD] [--scope <scopeKey>] [--database <path>]
 *     [--time-zone Asia/Tokyo] [--json]
 *
 * Without `--json`, a Markdown table a day a row and the run of days she still said she was cross.
 */
import { DatabaseSync } from 'node:sqlite';
import { configuredDatabasePath } from '../src/infra/sqlite/sqliteStore.js';
import { shannonNowOwnerScope } from '../src/contracts/shannonNowContract.js';
import { heartDayNumbers, heartDaysMarkdown, type HeartDayRows } from '../src/mind/emotion/heartDaily.js';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const scopeKey = option('--scope') ?? shannonNowOwnerScope(process.env);
const timeZone = option('--time-zone') ?? 'Asia/Tokyo';
const days = Math.max(1, Math.min(31, Number(option('--days') ?? 7) || 7));
const database = new DatabaseSync(option('--database') ?? configuredDatabasePath(), { readOnly: true });

/** 3:00 of a local day in the zone, as an instant (her day's start). */
function dayStart(day: string): string {
  const guess = Date.parse(`${day}T03:00:00Z`);
  const offset = (instant: number) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
      minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant)).map(part => [part.type, part.value]));
    return Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`) - instant;
  };
  return new Date(guess - offset(guess)).toISOString();
}
const hourIn = (at: string) => Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(at)));
const rows = <T>(sql: string, ...values: (string | number)[]): T[] => {
  try { return database.prepare(sql).all(...values) as unknown as T[]; } catch { return []; }
};
const facts = (json: string | null): Record<string, unknown> => { try { return JSON.parse(json ?? '{}') as Record<string, unknown>; } catch { return {}; } };

const snapshot = rows<{ snapshot_json: string }>('SELECT snapshot_json FROM companion_states WHERE scope_key = ?', scopeKey)[0];
const promises = (() => {
  try { return (JSON.parse(snapshot?.snapshot_json ?? '{}').prospectiveMemories ?? []) as { status: string; dueAt?: string; dueDate?: string }[]; } catch { return []; }
})();

const until = option('--until') ?? new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
const result = Array.from({ length: days }, (_, index) => {
  const day = new Date(Date.parse(`${until}T00:00:00Z`) - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
  const start = dayStart(day), end = new Date(Date.parse(start) + 86_400_000).toISOString();
  const talk = rows<{ role: 'user' | 'assistant'; content: string; observed_at: string }>(`SELECT role, content, observed_at FROM conversation_messages
    WHERE scope_key = ? AND observed_at >= ? AND observed_at < ? ORDER BY observed_at, sequence`, scopeKey, start, end)
    .filter(row => !row.content.startsWith('［運用者の操作のお知らせ］')).map(row => ({ role: row.role, text: row.content, at: row.observed_at }));
  const events = rows<{ kind: string; channel: string; facts_json: string }>(`SELECT kind, channel, facts_json FROM shannon_feeling_events
    WHERE scope_key = ? AND audience = 'owner_alone' AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at`, scopeKey, start, end);
  const reachOuts = rows<{ occurred_at: string }>(`SELECT occurred_at FROM autonomy_activity WHERE scope_key = ? AND tool = 'owner.reach_out'
    AND outcome = 'done' AND occurred_at >= ? AND occurred_at < ?`, scopeKey, start, end).map(row => ({ at: row.occurred_at, hour: hourIn(row.occurred_at) }));
  const told = rows<{ found: number }>(`SELECT COUNT(*) AS found FROM initiative_messages WHERE scope_key = ? AND source_item_id LIKE 'commitment:%'
    AND created_at >= ? AND created_at < ?`, scopeKey, start, end)[0]?.found ?? 0;
  const due = promises.filter(item => (item.dueAt ? item.dueAt >= start && item.dueAt < end : item.dueDate === day));
  const input: HeartDayRows = {
    day, talk,
    stances: events.filter(event => event.kind === 'own_reply' && (event.channel === 'text' || event.channel === 'voice'))
      .map(event => String(facts(event.facts_json).turnStance ?? '')).filter(Boolean),
    reachOuts,
    promises: { due: due.length, told: Number(told), closed: due.filter(item => item.status === 'completed').length,
      openAfterTime: due.filter(item => item.status === 'pending' && (item.dueAt ?? `${item.dueDate}T23:59:59Z`) < new Date().toISOString()).length },
    touchStances: events.filter(event => event.kind === 'touched').map(event => String(facts(event.facts_json).stance ?? '')).filter(Boolean),
  };
  return heartDayNumbers(input);
});
database.close();
console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : heartDaysMarkdown(result));
