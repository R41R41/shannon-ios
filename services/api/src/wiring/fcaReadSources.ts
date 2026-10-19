import { memoryControlFor, visibleMemoryText, type CompanionStateStore } from '@shannon/cognition';
import { MemoryWithholding, insideDeepWalk, isStackOverflow } from '../mind/memory/memoryVisibilityPorts.js';
import type { TaskMemoryReadSnapshot as ReadSourceSnapshot } from '../mind/memory/taskMemoryPorts.js';
import type { ConversationStore } from '../mind/memory/memoryPorts.js';
import type { StudyStore } from '../mind/action/ownTime/store/studyStore.js';
import type { OwnerUpcoming } from '../mind/memory/ownerUpcoming.js';
import type { AetherContextReader } from '../integrations/aether/aetherContext.js';

/** Taken once, here: asked from a catch block at the very end of the stack, a lookup through another module's exports can itself fail. */
const stackRanOut = isStackOverflow, insideWalk = insideDeepWalk;
/** A stack overflow goes up only inside a long recall walk (it settles the chain and asks again); anywhere else it is "not visible", as before. */
const goesUp = (error: unknown) => stackRanOut(error) && insideWalk();

export interface FcaReadSourcesOptions {
  ownerScope: string; ownerAlone(): boolean; state: Pick<CompanionStateStore, 'snapshot'>; conversations: ConversationStore;
  /** Availability uses the current clock; forgetting/correction still uses the original read receipt's observedAt. */
  now?(): string;
  /** Original remote reads already passed their native document/root gate. Reuse keeps the same owner-only scope. */
  aetherAvailable?(): boolean; notionAvailable?(): boolean; voyagerAvailable?(): boolean;
  aetherContext?: Pick<AetherContextReader, 'sourceText'> | null;
  study?: Pick<StudyStore, 'find' | 'versions'> | null;
  upcoming?: Pick<OwnerUpcoming, 'calendarEnabled' | 'mayShareCalendar' | 'store'> | null;
  /** These native readers return only currently accessible sources; no prompt parsing or new remote executor. */
  skill?(scopeKey: string, skillId: string, revisionId?: string): { body: string } | null;
  folderAvailable?(scopeKey: string, host: string): boolean;
}

/**
 * Checks reuse of a trusted read receipt as existing conversation replay does, under fresh local memory controls. `shared`: the
 * caller's snapshot and withholding of the same synchronous check (the FCA source guard), so that many receipts share one walk.
 */
export function createFcaReadSources(parts: FcaReadSourcesOptions):
  (scopeKey: string, sourceId: string, observedAt: string, shared?: ReadSourceSnapshot) => boolean {
  const job = readSourceJob(parts.conversations);
  /**
   * What the skill reader answered (existence, status, ancestry, body checks: the same at every time of a receipt), per skill and
   * revision, for one check of the caller's (`shared`: one walk of the FCA source guard over one snapshot); a later check asks
   * again, so a skill retired or withdrawn since is seen at once. The memory controls, the receipt's time and the withholding of
   * its text are still checked per receipt. 2026-10-13: one report's walk asked the skill reader 1,280 times for 16 skills (~80
   * recalled memories, each with the receipts of what it read), ~0.7 s of the API's one thread.
   */
  const walks = new WeakMap<object, Map<string, { body: string } | null>>();
  const skillOf = (shared: ReadSourceSnapshot | undefined): SkillReader => (scopeKey, skillId, revisionId) => {
    if (!shared) return parts.skill?.(scopeKey, skillId, revisionId) ?? null;
    const walk = shared.walk ?? shared.withholding;
    let known = walks.get(walk);
    if (!known) walks.set(walk, known = new Map());
    const key = revisionId === undefined ? `${scopeKey}\u0000${skillId}` : `${scopeKey}\u0000${skillId}\u0000${revisionId}\u0001`;
    if (!known.has(key)) known.set(key, parts.skill?.(scopeKey, skillId, revisionId) ?? null);
    return known.get(key)!;
  };
  return (scopeKey, sourceId, observedAt, shared) => {
    try {
      if (scopeKey !== parts.ownerScope || !parts.ownerAlone() || sourceId.length > 240) return false;
      if (shared) return readSourceVisible(parts, skillOf(shared), scopeKey, sourceId, observedAt, shared);
      // Without a caller's snapshot: the state is read fresh every time, and one synchronous job shares the withholding made under
      // that same state (2026-10-13: each of a turn's ~224 checks loaded every remembered turn again, ~3 s a turn on the VM).
      const state = parts.state.snapshot(scopeKey);
      return readSourceVisible(parts, skillOf(undefined), scopeKey, sourceId, observedAt, { state, withholding: job.withholding(scopeKey, state) });
    } catch (error) {
      // A stack overflow inside a long recall walk is not "not visible": it goes up to the walk, which settles the chain and asks again.
      if (goesUp(error)) throw error;
      return false;
    }
  };
}

/**
 * What the checks of one synchronous job share: per scope and state (its version, update time and number of memory controls), one
 * `MemoryWithholding`, so that the remembered turns are loaded once, not once per receipt. The source itself (availability,
 * the clock, the audience) is checked on every call as before. Cleared at the end of the job (a microtask); a forget or a
 * correction changes the state key, so no check uses a withholding from before it.
 */
function readSourceJob(conversations: ConversationStore) {
  const entries = new Map<string, MemoryWithholding>();
  let clearing = false;
  return {
    withholding(scopeKey: string, state: ReadSourceSnapshot['state']): MemoryWithholding {
      // Every forget or correction is a new state version (and update time); the count is a further guard. Never the controls' text.
      const key = `${scopeKey}\u0000${state.version}\u0000${state.updatedAt}\u0000${state.memoryControls.length}`;
      let withholding = entries.get(key);
      if (!withholding) {
        withholding = new MemoryWithholding(state, conversations, scopeKey);
        entries.set(key, withholding);
        if (!clearing) {
          clearing = true;
          queueMicrotask(() => {
            entries.clear();
            clearing = false;
          });
        }
      }
      return withholding;
    },
  };
}

type SkillReader = (scopeKey: string, skillId: string, revisionId?: string) => { body: string } | null;

/** What a receipt's text says by itself (a pure function of it): its family, the id it names, and for a skill the skill, the revision and the controls naming them. */
interface ParsedSource { family: string; id: string; skill?: { skillId: string; revisionId: string | undefined; controlKeys: readonly string[] } }
const SOURCE_PATTERN = /^(aether-document|aether-context|notion-page|voyager-task|calendar-item|shannon-study|shannon-folder|shannon-skill):\/\/(.+)$/u;
const PARSED = new Map<string, ParsedSource | null>();
const PARSED_KEPT = 8_192;

/**
 * A receipt is checked once for every time it was read at (thousands in one walk), and each time its text was matched against four
 * expressions and decoded. Parsed once; null for one that is not a receipt of a family, or whose id is unusable (answered "not visible", as before).
 */
function parsedSource(sourceId: string): ParsedSource | null {
  const known = PARSED.get(sourceId);
  if (known !== undefined) return known;
  let result: ParsedSource | null;
  try {
    result = parseSource(sourceId);
  } catch (error) {
    if (goesUp(error)) throw error;
    result = null; // a malformed escape: not a receipt, as the caller's catch answered
  }
  if (PARSED.size >= PARSED_KEPT) PARSED.clear();
  PARSED.set(sourceId, result);
  return result;
}

function parseSource(sourceId: string): ParsedSource | null {
  const match = SOURCE_PATTERN.exec(sourceId);
  if (!match || /[\u0000-\u0020\u007f?#]/u.test(match[2]!)) return null;
  const family = match[1]!, id = decodeURIComponent(match[2]!);
  if (!id || /[\u0000-\u001f\u007f]/u.test(id)) return null;
  if (family !== 'shannon-skill') return { family, id };
  const skill = parsedSkill(match[2]!, id);
  return skill ? { family, id, skill } : null;
}

/** `/revision/` is a skill.read pin, `/gist-revision/` and `/gist` a gist pin (`fcaSkillGistSource.ts`): the same checks. */
function parsedSkill(encoded: string, id: string): NonNullable<ParsedSource['skill']> | null {
  const revision = /^([^/]+)\/(?:gist-)?revision\/([^/]+)$/u.exec(encoded), bare = /^([^/]+)\/gist$/u.exec(encoded);
  const skillId = revision ? decodeURIComponent(revision[1]!) : bare ? decodeURIComponent(bare[1]!) : id;
  const revisionId = revision ? decodeURIComponent(revision[2]!) : undefined;
  if (!skillId || (revisionId !== undefined && (!revisionId || /[\u0000-\u001f\u007f]/u.test(revisionId)))) return null;
  const controlKeys = [skillId, `shannon-skill://${encodeURIComponent(skillId)}`, ...(revisionId ? [revisionId] : [])];
  return { skillId, revisionId, controlKeys };
}
function readSourceVisible(parts: FcaReadSourcesOptions, skillOf: SkillReader, scopeKey: string, sourceId: string, observedAt: string,
  shared: ReadSourceSnapshot): boolean {
    try {
      const parsed = parsedSource(sourceId);
      if (!parsed) return false;
      const { family, id } = parsed;
      const { state, withholding } = shared;
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
        case 'shannon-skill': {
          // `/revision/` is a skill.read pin, `/gist-revision/` and `/gist` a gist pin (`fcaSkillGistSource.ts`): the same checks.
          const { skillId, revisionId, controlKeys } = parsed.skill!;
          if (controlKeys.some(key => {
            const control = memoryControlFor(state, key);
            return control && (control.status !== 'active' || Boolean(control.overrideText && observedAt <= (control.contextInvalidatedAt ?? control.updatedAt)));
          })) return false;
          const skill = skillOf(scopeKey, skillId, revisionId);
          if (!skill) return false;
          text = skill.body; break;
        }
        case 'shannon-folder': {
          const folder = /^([^/]+)\/([a-f0-9]{64})$/u.exec(id);
          if (!folder || !parts.folderAvailable?.(scopeKey, folder[1]!)) return false; break;
        }
        case 'calendar-item': {
          if (!parts.upcoming?.mayShareCalendar(scopeKey)) return false;
          const currentAt = parts.now?.() ?? new Date().toISOString();
          if (!Number.isFinite(Date.parse(currentAt))) return false;
          if (id.startsWith('promise:')) {
            const promise = state.prospectiveMemories.find(item => item.id === id.slice(8));
            if (!promise || !visibleMemoryText(state, promise.id, promise.summary)
              || (promise.sourceExperienceId && !visibleMemoryText(state, promise.sourceExperienceId, promise.summary))) return false;
            text = promise.summary; break;
          }
          if (id.startsWith('task:')) {
            const item = parts.upcoming.store.tasks(scopeKey, 'voyager', '0001-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z', 6 * 60 * 60_000, currentAt).find(item => item.id === id.slice(5));
            if (!item || !parts.voyagerAvailable?.()) return false; text = item.title; break;
          }
          const calendar = /^calendar:(.+)@(.+)$/u.exec(id);
          if (!calendar || !parts.upcoming.calendarEnabled || !Number.isFinite(Date.parse(calendar[2]!))) return false;
          const instant = Date.parse(calendar[2]!);
          const event = parts.upcoming.store.calendarEvents(scopeKey, new Date(instant - 1).toISOString(), new Date(instant + 1).toISOString(), currentAt)
            .find(item => item.id === calendar[1] && item.start === calendar[2]);
          if (!event) return false; text = [event.title, event.location ?? ''].join('\n'); break;
        }
        default: return false;
      }
      return !withholding.withholdsReply({ text, observedAt, recalledMemoryIds: [sourceId, id] });
    } catch (error) {
      if (goesUp(error)) throw error; // see createFcaReadSources: the walk above settles the chain; nothing is remembered as "not visible"
      return false;
    }
}

/** Storage of an already-authorized receipt checks local forgetting/correction, not a new remote read.
 * Full source availability is still checked by createFcaReadSources whenever the experience is recalled. */
export function fcaReadSourceRetained(state: Pick<CompanionStateStore, 'snapshot'>, conversations: ConversationStore,
  scopeKey: string, sourceId: string, observedAt: string): boolean {
  try {
    if (sourceId.length > 240 || !Number.isFinite(Date.parse(observedAt))) return false;
    const match = /^(aether-document|aether-context|notion-page|voyager-task|calendar-item|shannon-study|shannon-folder|shannon-skill):\/\/(.+)$/u.exec(sourceId);
    if (!match || /[\u0000-\u0020\u007f?#]/u.test(match[2]!)) return false;
    const id = decodeURIComponent(match[2]!);
    if (!id || /[\u0000-\u001f\u007f]/u.test(id)) return false;
    const snapshot = state.snapshot(scopeKey);
    const skillRevision = match[1] === 'shannon-skill' ? /^([^/]+)\/(?:gist-)?revision\/([^/]+)$/u.exec(match[2]!) : null;
    const skillBare = match[1] === 'shannon-skill' ? /^([^/]+)\/gist$/u.exec(match[2]!) : null;
    const keys = [sourceId, id, ...(skillRevision ? [decodeURIComponent(skillRevision[1]!), decodeURIComponent(skillRevision[2]!),
      `shannon-skill://${skillRevision[1]!}`] : skillBare ? [decodeURIComponent(skillBare[1]!), `shannon-skill://${skillBare[1]!}`] : [])];
    if (keys.some(key => {
      const control = memoryControlFor(snapshot, key);
      return control && (control.status !== 'active' || Boolean(control.overrideText && observedAt <= (control.contextInvalidatedAt ?? control.updatedAt)));
    })) return false;
    return !new MemoryWithholding(snapshot, conversations, scopeKey).withholdsReply({ text: '', observedAt, recalledMemoryIds: keys });
  } catch { return false; }
}
