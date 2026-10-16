import type { DatabaseSync } from 'node:sqlite';
import { privateReadIds } from './fcaSkillGistSource.js';
import { memoryIdentifier } from '@shannon/cognition';

type Boundary = { at: string; before: number };
type Node = { key: string; sources: readonly string[]; boundary?: Boundary };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function ids(value: unknown): readonly string[] | null {
  if (value === undefined) return [];
  return Array.isArray(value) && value.every(id => typeof id === 'string' && id.length > 0) ? value : null;
}

/** Generalized sleep material cannot inherit a private document, even while its original reader still has access.
 * This checks canonical lineage only; the caller retains disclosure, forgetting and committed-outcome checks. */
export function createFcaSleepTaskLineage(db: DatabaseSync): (scope: string, sourceIds: readonly string[], at?: string) => boolean {
  return (scope, sourceIds, at) => {
    try {
      if (!ids(sourceIds) || at !== undefined && !Number.isFinite(Date.parse(at))) return false;
      const cutoff = at === undefined ? '9999-12-31T23:59:59.999Z' : new Date(at).toISOString();
      // Per-query caches: neither a later forget nor a changed ancestor can reuse a previous verdict.
      const loaded = new Map<string, Node | null>(), complete = new Set<string>(), visiting = new Set<string>();
      let state: Record<string, unknown> | null | undefined;
      const scalar = (id: string): Node | null => {
        if (state === undefined) {
          const row = db.prepare('SELECT snapshot_json FROM companion_states WHERE scope_key=?').get(scope);
          const parsed: unknown = row ? JSON.parse(String(row.snapshot_json)) : null;
          state = object(parsed) ? parsed : null;
        }
        if (!state) return null;
        const records = ['userFacts', 'relationships', 'prospectiveMemories', 'activeMemories'].flatMap(key => {
          const rows = state![key]; return Array.isArray(rows) ? rows.filter(object) : [];
        });
        const record = records.find(item => item.id === id);
        if (record) {
          const source = record.sourceExperienceId;
          if (source !== undefined && (typeof source !== 'string' || !source)) return null;
          const reads = ids(record.readSourceIds), inherited = ids(record.sourceIds), recalled = ids(record.recalledMemoryIds);
          if (!reads || reads.length || !inherited || !recalled) return null;
          return { key: `scalar:${id}`, sources: [...source ? [source as string] : [], ...inherited, ...recalled] };
        }
        return Array.isArray(state.interests) && state.interests.some(item => typeof item === 'string' && memoryIdentifier('interest', item) === id)
          ? { key: `scalar:${id}`, sources: [] } : null;
      };
      const load = (source: string, boundary: Boundary): Node | null => {
        const cacheKey = source.startsWith('thread:') ? `${source}:${boundary.at}:${boundary.before}` : source;
        if (loaded.has(cacheKey)) return loaded.get(cacheKey)!;
        if (loaded.size >= 5000) return null;
        loaded.set(cacheKey, null);
        if (source.startsWith('thread:')) {
          const threadId = source.slice(7);
          const thread = db.prepare('SELECT thread_id FROM conversation_threads WHERE scope_key=? AND thread_id=? AND created_at<=?').get(scope, threadId, boundary.at);
          if (!thread) return null;
          // turn_id is freezeStoredMessage.sourceExperienceId. A summary's chain start is a forget boundary,
          // not permission to discard older source turns. Read the complete pre-observation lineage, or reject its bound.
          // An episode may have recalled this very thread's earlier summary. Its own canonical event sequence
          // excludes itself and later same-clock turns, while retaining both roles of every earlier turn.
          const rows = db.prepare(`SELECT DISTINCT m.turn_id FROM conversation_messages m
            LEFT JOIN experience_events e ON e.scope_key=m.scope_key AND e.event_id=m.turn_id
            WHERE m.scope_key=? AND m.thread_id=? AND m.observed_at<=? AND (e.sequence IS NULL OR e.sequence<?) LIMIT 5001`)
            .all(scope, threadId, boundary.at, boundary.before);
          const sources = ids(rows.map(row => row.turn_id));
          if (!sources?.length || sources.length > 5000) return null;
          const node = { key: cacheKey, sources }; loaded.set(cacheKey, node); return node;
        }
        const explicitKnowledge = source.startsWith('knowledge:'), explicitExperience = source.startsWith('experience:');
        const id = explicitKnowledge ? source.slice(10) : explicitExperience ? source.slice(11) : source;
        if (!id) return null;
        const row = explicitKnowledge ? undefined : db.prepare("SELECT event_id,payload_json,observed_at,sequence FROM experience_events WHERE scope_key=? AND event_id=? AND event_type='turn.completed'").get(scope, id);
        let node: Node;
        if (row) {
          const payload: unknown = JSON.parse(String(row.payload_json));
          if (!object(payload)) return null;
          const task = payload.task;
          if (task !== undefined && (!object(task) || task.scopeKey !== scope)) return null;
          const records = task === undefined ? [payload] : [payload, task as Record<string, unknown>];
          const sources = new Set<string>();
          for (const record of records) {
            const reads = ids(record.readSourceIds), recalled = ids(record.recalledMemoryIds), inherited = ids(record.sourceIds);
            if (!reads || privateReadIds(reads).length || !recalled || !inherited) return null;
            for (const ref of [...recalled, ...inherited]) sources.add(ref);
          }
          const before = Number(row.sequence), at = new Date(String(row.observed_at)).toISOString();
          if (!Number.isSafeInteger(before) || before <= 0) return null;
          node = { key: `experience:${id}`, sources: [...sources], boundary: { at, before } };
        } else {
          if (explicitExperience) return null;
          // Retired knowledge retains its sources. Raw UUIDs and the recall protocol's knowledge: alias name the same row.
          const note = db.prepare('SELECT source_experience_ids_json,aether_refs_json FROM shannon_knowledge_documents WHERE scope_key=? AND knowledge_id=?').get(scope, id);
          if (!note) {
            if (explicitKnowledge) return null;
            const node = scalar(id); loaded.set(source, node); return node;
          }
          const sources = ids(JSON.parse(String(note.source_experience_ids_json)));
          const references: unknown = JSON.parse(String(note.aether_refs_json));
          if (!sources?.length || !Array.isArray(references) || references.length) return null;
          node = { key: `knowledge:${id}`, sources };
        }
        loaded.set(source, node);
        return node;
      };
      // An explicit stack rejects cycles without a JS recursion limit; shared DAG ancestors are checked once.
      const pending: Array<{ id: string; boundary: Boundary } | { done: string }> = [...sourceIds].reverse()
        .map(id => ({ id, boundary: { at: cutoff, before: Number.MAX_SAFE_INTEGER } }));
      while (pending.length) {
        const item = pending.pop()!;
        if ('done' in item) { visiting.delete(item.done); complete.add(item.done); continue; }
        const node = load(item.id, item.boundary);
        if (!node || node.boundary && (node.boundary.at > item.boundary.at || node.boundary.before >= item.boundary.before)) return false;
        const key = node.boundary ? node.key : `${node.key}:${item.boundary.at}:${item.boundary.before}`;
        if (visiting.has(key)) return false;
        if (complete.has(key)) continue;
        visiting.add(key); pending.push({ done: key });
        for (const id of [...node.sources].reverse()) pending.push({ id, boundary: node.boundary ?? item.boundary });
      }
      return true;
    } catch { return false; }
  };
}
