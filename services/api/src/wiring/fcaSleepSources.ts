import { createFcaSleepTaskEvidence } from './fcaSleepTaskEvidence.js';
import { isOwnerOnly, memoryControlFor, memoryIdentifier, ownerSpoke, visibleMemoryText } from '@shannon/cognition';
import type { SQLiteShannonStore } from '../infra/sqlite/sqliteStore.js';
import type { SkillMemory } from '../mind/memory/memoryPorts.js';
import type { SQLitePeopleMemoryStore } from '../mind/memory/store/peopleMemoryStore.js';
import { MemoryWithholding } from '../mind/memory/memoryVisibilityPorts.js';
import { ImpressionEvidenceCheck, usableImpression } from '../mind/recall/recallPorts.js';
import { usableKnowledgeFor } from '../mind/recall/recallPorts.js';
import type { TaskSource } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import { skillSourcesPass } from './skillMemoryWiring.js';

/** Purpose-bound internal reading. This does not grant owner-alone disclosure, tools, or messaging rights. */
export function sleepSourcesVisible(store: SQLiteShannonStore, scope: string, sources: readonly TaskSource[],
  skills: SkillMemory | null, people: SQLitePeopleMemoryStore) {
  try {
    const state = store.snapshot(scope), candidates = store.experienceCandidates(scope);
    const withheld = new MemoryWithholding(state, store, scope, candidates);
    const taskEvidence = createFcaSleepTaskEvidence(store.fcaDatabase());
    const episode = (id: string) => {
      const item = candidates.find(item => item.id === id) ?? store.experiencesById(scope, [id])[0];
      return !!item && isOwnerOnly(item.disclosure?.audience) && (id.startsWith('task:') ? taskEvidence(scope, id) : ownerSpoke(item.disclosure))
        && visibleMemoryText(state, id, item.summary) !== null && !withheld.withholdsExperience(item);
    };
    const notes = new Set(usableKnowledgeFor(store, scope, state).map(item => item.id));
    const knownNotes = new Map(store.listShannonKnowledge(scope, { includeRetired: true }).map(item => [item.id, item]));
    const pass = skills ? skillSourcesPass(store, skills, scope) : null;
    const impressionRows = store.impressionStore().impressions(scope);
    const check = new ImpressionEvidenceCheck(state, store, scope, candidates); check.load(impressionRows);
    const impressions = new Set(impressionRows.filter(row => usableImpression(row, state, check, store.impressionStore().people(scope))).map(row => `impression:${row.id}`));
    const items = new Map(people.items(scope).map(item => [`person:${item.id}`, item]));
    const retained = (id: string, at: string): boolean => {
      const control = memoryControlFor(state, id);
      if (control && (control.status !== 'active' || (control.overrideText && at <= (control.contextInvalidatedAt ?? control.updatedAt)))) return false;
      if (id.startsWith('self-interest:')) {
        const memory = store.selfInterests(), item = memory?.store.get(scope, id.slice('self-interest:'.length));
        return !!item && !item.forgotten && !!memory?.visible(scope, item)
          && [item.id, memoryIdentifier('interest', item.title)].every(key => {
            const current = memoryControlFor(state, key);
            return !current || current.status === 'active' && !(current.overrideText && at <= (current.contextInvalidatedAt ?? current.updatedAt));
          }) && item.evidenceRefs.every(episode);
      }
      if (id.startsWith('experience:')) return episode(id.slice(11));
      if (id.startsWith('knowledge:')) return retained(id.slice('knowledge:'.length), at);
      if (id.startsWith('pattern:')) return !!pass?.([id]);
      if (id.startsWith('choice:')) return !!store.choiceLedger()?.rows(scope).some(row => row.choiceId === id.slice(7));
      if (notes.has(id) || impressions.has(id)) return true;
      const retainedNote = knownNotes.get(id);
      if (retainedNote) return !withheld.withholdsKnowledge(retainedNote) && retainedNote.sourceExperienceIds.every(episode);
      const item = items.get(id);
      if (item) return (item.personId ? [item.personId] : item.disclosure.audience?.kind === 'people' ? item.disclosure.audience.personIds : []).every(personId => { const person = people.person(scope, personId); return !!person && !person.forgottenAt; })
        && visibleMemoryText(state, id, item.text) !== null;
      return episode(id);
    };
    return sources.every(source => source.kind === 'memory' && !(source.readSourceIds?.length)
      && source.recalledMemoryIds.every(id => retained(id, source.observedAt)));
  } catch { return false; }
}
