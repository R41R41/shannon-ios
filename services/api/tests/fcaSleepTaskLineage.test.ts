import { afterEach, expect, it, vi } from 'vitest';
import { createFcaSleepTaskLineage } from '../src/wiring/fcaSleepTaskLineage.js';
import { memoryWorld } from './support/memoryWorld.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const world = memoryWorld(); cleanup.push(world.close);
  const db = world.store.fcaDatabase(), check = createFcaSleepTaskLineage(db);
  const episode = (payload: Record<string, unknown> = {}, scope = 'owner') => {
    const turn = world.store.appendTurn(scope, 'thread', '観測の依頼', '観測した結果', world.now());
    const row = db.prepare('SELECT payload_json FROM experience_events WHERE scope_key=? AND event_id=?').get(scope, turn.id)!;
    db.prepare('UPDATE experience_events SET payload_json=? WHERE scope_key=? AND event_id=?')
      .run(JSON.stringify({ ...JSON.parse(String(row.payload_json)), ...payload }), scope, turn.id);
    return turn.id;
  };
  const note = (sources: string[]) => world.store.createShannonKnowledge('owner', { title: '手順', bodyMarkdown: '## 手順\n条件を確かめる',
    applicability: '同じ条件で', status: 'confirmed', sourceExperienceIds: sources }, world.now(), '整理');
  return { ...world, db, check, episode, note };
}

it('allows ordinary leaves and a shared DAG with query-local memo, then rereads changed ancestors', () => {
  const f = fixture(), leaf = f.episode(), left = f.episode({ recalledMemoryIds: [leaf] }), right = f.episode({ sourceIds: [leaf] });
  const root = f.episode({ task: { scopeKey: 'owner', sourceIds: [left, right], readSourceIds: [] } });
  const prepare = vi.spyOn(f.db, 'prepare');
  expect(f.check('owner', [root, left, right, `experience:${root}`])).toBe(true);
  expect(prepare.mock.calls.filter(([sql]) => sql.startsWith('SELECT event_id'))).toHaveLength(5);
  prepare.mockRestore();
  f.db.prepare('UPDATE experience_events SET payload_json=? WHERE event_id=?').run(JSON.stringify({ readSourceIds: ['aether-document://private'] }), leaf);
  expect(f.check('owner', [root])).toBe(false);
});

it.each(['outer', 'task'] as const)('refuses a private document in an %s ancestor even with current read permission', kind => {
  const f = fixture(); f.store.readSourceVisible = () => true;
  const privateRead = { readSourceIds: ['aether-document://private'] };
  const leaf = f.episode(kind === 'outer' ? privateRead : { task: { scopeKey: 'owner', ...privateRead } });
  const middle = f.episode({ recalledMemoryIds: [leaf] });
  const root = f.episode({ task: { scopeKey: 'owner', sourceIds: [middle] } });
  expect(f.check('owner', [root])).toBe(false);
});

it.each(['missing', 'other_scope', 'task_scope', 'cycle', 'malformed_sources', 'malformed_reads', 'malformed_task'] as const)('fails closed for %s lineage', kind => {
  const f = fixture(), leaf = f.episode();
  let payload: Record<string, unknown> = {};
  if (kind === 'missing') payload = { sourceIds: ['not-a-canonical-id'] };
  if (kind === 'other_scope') payload = { recalledMemoryIds: [f.episode({}, 'someone-else')] };
  if (kind === 'task_scope') payload = { task: { scopeKey: 'someone-else', sourceIds: [leaf] } };
  if (kind === 'cycle') payload = { recalledMemoryIds: [`experience:${leaf}`] };
  if (kind === 'malformed_sources') payload = { sourceIds: [null] };
  if (kind === 'malformed_reads') payload = { readSourceIds: 'private' };
  if (kind === 'malformed_task') payload = { task: [] };
  f.db.prepare('UPDATE experience_events SET payload_json=? WHERE event_id=?').run(JSON.stringify(payload), leaf);
  expect(f.check('owner', [leaf])).toBe(false);
});

it('follows raw and prefixed retired knowledge sources, including private ancestors and cycles', () => {
  const f = fixture(), leaf = f.episode(), note = f.note([leaf]);
  f.store.retireShannonKnowledge('owner', note.id, '統合済み', f.now());
  const root = f.episode({ recalledMemoryIds: [`knowledge:${note.id}`] });
  expect(f.check('owner', [note.id, `knowledge:${note.id}`, root])).toBe(true);
  f.db.prepare('UPDATE experience_events SET payload_json=? WHERE event_id=?').run(JSON.stringify({ sourceIds: [root] }), leaf);
  expect(f.check('owner', [root])).toBe(false);
  f.db.prepare('UPDATE experience_events SET payload_json=? WHERE event_id=?').run(JSON.stringify({ readSourceIds: ['notion-page://private'] }), leaf);
  expect(f.check('owner', [note.id])).toBe(false);
});

it('refuses a knowledge document with independent Aether input and checks the canonical scope', () => {
  const f = fixture(), note = f.note([f.episode()]);
  expect(f.check('other', [`knowledge:${note.id}`])).toBe(false);
  f.db.prepare('UPDATE shannon_knowledge_documents SET aether_refs_json=? WHERE knowledge_id=?').run(JSON.stringify([{ documentId: 'private' }]), note.id);
  expect(f.check('owner', [note.id])).toBe(false);
});

it('checks canonical thread sources at the original observation time, preserving both same-time message roles', () => {
  const f = fixture(), leaf = f.episode(), at = f.now(), thread = f.store.threadOfTurn('owner', leaf)!;
  expect(f.check('owner', [`thread:${thread}`], at)).toBe(true);
  expect(f.check('other', [`thread:${thread}`], at)).toBe(false);
  expect(f.check('owner', ['thread:missing'], at)).toBe(false);
  f.advance(1000); f.episode({ readSourceIds: ['aether-document://later-private'] });
  expect(f.check('owner', [`thread:${thread}`], at)).toBe(true);
  expect(f.check('owner', [`thread:${thread}`], f.now())).toBe(false);
  f.db.prepare('UPDATE experience_events SET payload_json=? WHERE event_id=?').run(JSON.stringify({ readSourceIds: ['aether-document://original-private'] }), leaf);
  expect(f.check('owner', [`thread:${thread}`], at)).toBe(false);
});

it('resolves canonical profile IDs and follows their source experience without accepting unknown lookalikes', () => {
  const f = fixture(), source = f.episode();
  f.store.apply('owner', { type: 'user-fact-upserted', fact: { id: 'user-fact-one', statement: '石を集めている',
    confidence: 1, observedAt: f.now(), sourceExperienceId: source } });
  expect(f.check('owner', ['user-fact-one'])).toBe(true);
  expect(f.check('owner', ['user-fact-missing'])).toBe(false);
  expect(f.check('other', ['user-fact-one'])).toBe(false);
  f.db.prepare('UPDATE experience_events SET payload_json=? WHERE event_id=?').run(JSON.stringify({ readSourceIds: ['aether-document://private'] }), source);
  expect(f.check('owner', ['user-fact-one'])).toBe(false);
});

it('resolves a turn recalling its own earlier thread summary without permitting an actual cycle', () => {
  const f = fixture(), first = f.episode(), thread = f.store.threadOfTurn('owner', first)!;
  // The clock is intentionally identical: canonical event sequence, not a millisecond subtraction, separates the turns.
  const second = f.episode({ recalledMemoryIds: [`thread:${thread}`] });
  expect(f.check('owner', [second, `thread:${thread}`], f.now())).toBe(true);
  f.advance(1000); f.episode({ readSourceIds: ['aether-document://later-private'] });
  expect(f.check('owner', [second], f.now())).toBe(true);
  f.db.prepare('UPDATE experience_events SET payload_json=? WHERE event_id=?').run(JSON.stringify({ sourceIds: [second] }), first);
  expect(f.check('owner', [second], f.now())).toBe(false);
});
