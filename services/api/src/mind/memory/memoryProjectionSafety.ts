import { memoryIdentifier, visibleMemoryText, filterMeaningfulInterests, type CompanionStateSnapshot } from '@shannon/cognition';
import type { SQLiteStoreContext } from '../../infra/sqlite/sqliteStoreContext.js';
import { parseTurnPayload } from '../../infra/sqlite/sqliteStoreCodecs.js';

/** Old controls did not carry provenance. Recover exact original evidence from
 * durable records, never from a model-generated profile or paraphrase. */
export function hydrateMemoryBoundaries(context: SQLiteStoreContext, state: CompanionStateSnapshot): CompanionStateSnapshot {
  const controls = state.memoryControls.map(control => {
    if (control.status === 'active' && !control.overrideText) return control;
    let evidence = control.sourceEvidence ?? state.userFacts.find(item => item.id === control.memoryId)?.evidence
      ?? state.relationships.find(item => item.id === control.memoryId)?.evidence;
    if (!evidence && control.kind === 'experience') {
      const row = context.database.prepare(`SELECT payload_json FROM experience_events
        WHERE scope_key = ? AND event_id = ? AND event_type = 'turn.completed'`).get(state.scopeKey, control.memoryId);
      evidence = row ? parseTurnPayload(String(row.payload_json))?.userMessage : undefined;
    }
    if (!evidence && control.kind === 'user-fact') {
      const row = context.database.prepare(`SELECT quote FROM knowledge_evidence
        WHERE scope_key = ? AND answer_id = ? ORDER BY observed_at DESC LIMIT 1`).get(state.scopeKey, control.memoryId);
      evidence = row ? String(row.quote) : undefined;
    }
    return Object.freeze({ ...control, contextInvalidatedAt: control.contextInvalidatedAt ?? control.updatedAt,
      ...(evidence ? { sourceEvidence: evidence.slice(0, 8_000) } : {}) });
  });
  return Object.freeze({ ...state, memoryControls: Object.freeze(controls) });
}

/** A profile is a projection, never an independent source of personal facts. */
export function safePersonalityAnalysis(state: CompanionStateSnapshot): string {
  const facts = state.userFacts.flatMap(item => visibleMemoryText(state, item.id, item.statement) ?? []).slice(0, 6);
  const relationships = state.relationships.flatMap(item => visibleMemoryText(state, item.id, item.statement) ?? []).slice(0, 4);
  const interests = filterMeaningfulInterests(state.interests).flatMap(item => visibleMemoryText(state, memoryIdentifier('interest', item), item) ?? []).slice(0, 8);
  return [
    facts.length ? `把握している特徴: ${facts.join('、')}` : '本人について断定できる特徴はまだ少ない。',
    relationships.length ? `好む関わり方: ${relationships.join('、')}` : '好む関わり方はまだ観察中。',
    interests.length ? `最近の関心: ${interests.join('、')}` : '最近の関心はまだ定まっていない。',
  ].join('\n');
}
