import { memoryControlFor, visibleMemoryText, type CompanionStateStore } from '@shannon/cognition';
import { MemoryWithholding } from '../mind/memory/memoryVisibilityPorts.js';
import type { ConversationStore } from '../mind/memory/memoryPorts.js';
import type { StudyStore } from '../mind/action/ownTime/store/studyStore.js';
import type { OwnerUpcoming } from '../mind/memory/ownerUpcoming.js';
import type { AetherContextReader } from '../integrations/aether/aetherContext.js';

export interface FcaReadSourcesOptions {
  ownerScope: string; ownerAlone(): boolean; state: Pick<CompanionStateStore, 'snapshot'>; conversations: ConversationStore;
  /** Original remote reads already passed their native document/root gate. Reuse keeps the same owner-only scope. */
  aetherAvailable?(): boolean; notionAvailable?(): boolean; voyagerAvailable?(): boolean;
  aetherContext?: Pick<AetherContextReader, 'sourceText'> | null;
  study?: Pick<StudyStore, 'find' | 'versions'> | null;
  upcoming?: Pick<OwnerUpcoming, 'calendarEnabled' | 'mayShareCalendar' | 'store'> | null;
  /** These native readers return only currently accessible sources; no prompt parsing or new remote executor. */
  skill?(scopeKey: string, skillId: string): { body: string } | null;
  folderAvailable?(scopeKey: string, host: string): boolean;
}

/** Checks reuse of a trusted read receipt as existing conversation replay does, under fresh local memory controls. */
export function createFcaReadSources(parts: FcaReadSourcesOptions): (scopeKey: string, sourceId: string, observedAt: string) => boolean {
  return (scopeKey, sourceId, observedAt) => {
    try {
      if (scopeKey !== parts.ownerScope || !parts.ownerAlone() || sourceId.length > 240) return false;
      const match = /^(aether-document|aether-context|notion-page|voyager-task|calendar-item|shannon-study|shannon-folder|shannon-skill):\/\/(.+)$/u.exec(sourceId);
      if (!match || /[\u0000-\u0020\u007f?#]/u.test(match[2]!)) return false;
      const family = match[1]!, id = decodeURIComponent(match[2]!);
      if (!id || /[\u0000-\u001f\u007f]/u.test(id)) return false;
      const state = parts.state.snapshot(scopeKey), withholding = new MemoryWithholding(state, parts.conversations, scopeKey);
      const blocked = [sourceId, id].some(key => {
        const control = memoryControlFor(state, key);
        return control && (control.status !== 'active' || Boolean(control.overrideText && observedAt <= (control.contextInvalidatedAt ?? control.updatedAt)));
      });
      if (blocked) return false;
      let text = '';
      switch (family) {
        case 'aether-document': if (!parts.aetherAvailable?.()) return false; break;
        case 'aether-context': { const source = parts.aetherContext?.sourceText?.(scopeKey, id); if (source === null || source === undefined) return false; text = source; break; }
        case 'notion-page': if (!/^[a-f0-9]{32}$/u.test(id.replaceAll('-', '')) || !parts.notionAvailable?.()) return false; break;
        case 'voyager-task': if (!parts.voyagerAvailable?.()) return false; break;
        case 'shannon-study': {
          const piece = parts.study?.find(scopeKey, id, true); if (!piece) return false;
          // Earlier versions can remain in a task's native history; a new revision cannot erase their withholding boundary.
          text = withholding.inactive ? '' : [piece.title, piece.body, ...parts.study!.versions(scopeKey, id).flatMap(version => [version.title, version.body])].join('\n'); break;
        }
        case 'shannon-skill': { const skill = parts.skill?.(scopeKey, id); if (!skill) return false; text = skill.body; break; }
        case 'shannon-folder': {
          const folder = /^([^/]+)\/([a-f0-9]{64})$/u.exec(id);
          if (!folder || !parts.folderAvailable?.(scopeKey, folder[1]!)) return false; break;
        }
        case 'calendar-item': {
          if (!parts.upcoming?.mayShareCalendar(scopeKey)) return false;
          if (id.startsWith('promise:')) {
            const promise = state.prospectiveMemories.find(item => item.id === id.slice(8));
            if (!promise || !visibleMemoryText(state, promise.id, promise.summary)
              || (promise.sourceExperienceId && !visibleMemoryText(state, promise.sourceExperienceId, promise.summary))) return false;
            text = promise.summary; break;
          }
          if (id.startsWith('task:')) {
            const item = parts.upcoming.store.tasks(scopeKey, 'voyager', '0001-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z', 6 * 60 * 60_000).find(item => item.id === id.slice(5));
            if (!item || !parts.voyagerAvailable?.()) return false; text = item.title; break;
          }
          const calendar = /^calendar:(.+)@(.+)$/u.exec(id);
          if (!calendar || !parts.upcoming.calendarEnabled || !Number.isFinite(Date.parse(calendar[2]!))) return false;
          const instant = Date.parse(calendar[2]!);
          const event = parts.upcoming.store.calendarEvents(scopeKey, new Date(instant - 1).toISOString(), new Date(instant + 1).toISOString())
            .find(item => item.id === calendar[1] && item.start === calendar[2]);
          if (!event) return false; text = [event.title, event.location ?? ''].join('\n'); break;
        }
        default: return false;
      }
      return !withholding.withholdsReply({ text, observedAt, recalledMemoryIds: [sourceId, id] });
    } catch { return false; }
  };
}
