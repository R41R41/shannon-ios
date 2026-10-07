import {
  visibleMemoryText, type CompanionStateSnapshot, type MemoryAudience,
} from '@shannon/cognition';
import type { MemoryOp } from './memoryOpCodec.js';
import type { MemoryModelCall, MemoryTargets } from './memoryOps.js';
import type { PersonCall, PersonMemoryItem } from './store/peopleMemoryStore.js';
import { personMemoryId } from './peopleMemory.js';
import { PERSON_FACTS_V1, planFact, ruleJudgement, type PersonFactPlan } from './personFacts.js';

/**
 * The people kinds' plan and filter of the memory writer (Syzygy ADR-0008 stage 3, F5 and F6): split out of `memoryOps.ts` for its
 * size in the stage 3 review, unchanged but for the review's own changes (the judge's input, forgotten people).
 */
export interface PersonPayload {
  callId: string; mode: 'replace' | 'upsert'; items: Array<Omit<PersonMemoryItem, 'callId'> & { validAt?: string; episodeIds?: string[] }>;
  call?: PersonCall; summary?: { label: string; audience: MemoryAudience; at: string; text?: string };
}

const payloadOf = <T>(op: MemoryOp): T => op.payload as unknown as T;

/**
 * F6: before person facts are written, one judgement for the op over at most 30 of each person's current facts: by luna through
 * the writer's cache while the day has calls left, otherwise by the rule. A duplicate is not inserted and gives its episode to the
 * row it repeats; a contradicted row is closed where the new fact begins.
 */
export async function personFactPlan(targets: MemoryTargets, op: MemoryOp, model: MemoryModelCall, state: CompanionStateSnapshot): Promise<PersonFactPlan | null> {
  const facts = targets.personFacts;
  if (op.kind !== 'person.fact' || !facts) return null;
  const payload = payloadOf<PersonPayload>(op);
  const at = targets.now();
  // A person forgotten is not judged (review: privacy): none of their facts, old or new, goes to a model or the rule.
  const live = (personId: string) => { const person = targets.people?.person(op.scopeKey, personId); return Boolean(person && !person.forgottenAt); };
  const items = payload.items.filter(item => item.personId && live(item.personId));
  const plan: PersonFactPlan = { inserts: [], updates: [], repeated: [], judgedBy: [] };
  if (!items.length) return plan;
  const personIds = [...new Set(items.map(item => item.personId!))];
  // Only rows the owner's controls leave usable (review H3): a forgotten or hidden row is never shown to the judge, never a
  // duplicate target and never closed by a new fact.
  const rows = personIds.flatMap(id => facts.store.facts(op.scopeKey, id, { limit: PERSON_FACTS_V1.rows }))
    .filter(row => visibleMemoryText(state, personMemoryId(row.id), row.text) !== null).slice(0, PERSON_FACTS_V1.rows);
  const shown = rows.map((row, index) => ({ key: `f${index + 1}`, id: row.id, text: row.text }));
  let answers: Array<{ key: string; duplicates: string[]; contradicts: string[] }> | null = null;
  if (facts.judge && shown.length && facts.callsToday(at) < PERSON_FACTS_V1.callsPerDay) {
    const judge = facts.judge;
    const input = { newFacts: items.map((item, index) => ({ key: `n${index + 1}`, text: item.text })), facts: shown.map(({ key, text }) => ({ key, text })) };
    const answer = await model('fact_judge', input, () => judge.judge(op.scopeKey, input));
    answers = Array.isArray(answer?.judgements) ? answer.judgements : null;
  }
  const byKey = new Map(shown.map(item => [item.key, item.id]));
  const ids = (keys: unknown) => (Array.isArray(keys) ? [...new Set(keys.flatMap(key => (typeof key === 'string' && byKey.has(key) ? [byKey.get(key)!] : [])))] : []);
  let current = rows;
  items.forEach((item, index) => {
    const own = current.filter(row => row.personId === item.personId);
    const answered = answers?.find(entry => entry.key === `n${index + 1}`);
    const judgement = answered ? { duplicates: ids(answered.duplicates), contradicts: ids(answered.contradicts) } : ruleJudgement(item.text, own);
    plan.judgedBy.push(answered ? 'luna' : shown.length ? 'rule' : 'none');
    const step = planFact(own, { id: item.id, validAt: item.validAt ?? item.observedAt, episodeIds: item.episodeIds ?? [] }, judgement, at);
    for (const update of step.updates) {
      const earlier = plan.updates.find(entry => entry.fact.id === update.fact.id);
      if (earlier) earlier.fact = update.fact; else plan.updates.push(update);
    }
    current = current.map(row => { const updated = step.updates.find(entry => entry.fact.id === row.id); return updated ? { ...row, ...updated.fact } : row; });
    if (step.insert) plan.inserts.push({ itemId: item.id, fact: step.insert }); else plan.repeated.push(item.id);
  });
  return plan;
}

/** The items that may still be written: their person is known and not forgotten, and the owner did not forget the item. */
export function writableItems(targets: MemoryTargets, op: MemoryOp, state: CompanionStateSnapshot): PersonPayload['items'] {
  const people = targets.people!;
  const payload = payloadOf<PersonPayload>(op);
  return payload.items.filter(item => {
    const ids = [...(item.personId ? [item.personId] : []), ...(item.disclosure.audience?.kind === 'people' ? item.disclosure.audience.personIds : [])];
    if (ids.some(id => { const person = people.person(op.scopeKey, id); return !person || Boolean(person.forgottenAt); })) return false;
    return visibleMemoryText(state, personMemoryId(item.id), item.text) !== null;
  });
}

