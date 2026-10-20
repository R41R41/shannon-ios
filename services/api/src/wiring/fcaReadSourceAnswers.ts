import type { TaskMemoryReadSnapshot as ReadSourceSnapshot } from '../mind/memory/taskMemoryPorts.js';
import type { FcaReadSourcesOptions } from './fcaReadSources.js';

/**
 * The answer about one read receipt at one time, made once per moment and given to every check of that moment. Production run 18
 * (2026-10-19, Minecraft): the source guard asked a task's receipts again at every check that reused a verdict (its skill pins, a
 * skill read and its checks each time: 45.5 s of the 73 s of checks of 100 ms or more), and a decision makes a dozen checks within
 * moments of each other. Each receipt was answered afresh although nothing it was made from had changed.
 *
 * An answer is given again only while every input it was made from is the same, each checked in code:
 * - the caller's withholding (`shared.withholding`) and state: the withholding's remembered turns and its own memos of rows (a reader's
 *   withholding lives no longer than the rows it holds, as the guard's per-epoch one);
 * - the database: its change mark (every row any connection changes moves it; null inside a transaction, where nothing is kept);
 * - what the reader asks outside the database: whether Aether, Notion and Voyager are connected, as the answer found them; the skill
 *   reader's checks, the same object, and her skills' database's mark (`skillChecks`; without it no answer that read a skill is kept:
 *   her skills may be kept in another database than the turns). An answer that asked anything
 *   else outside the database (the clock, the calendar, a folder's host, a study piece, the Aether context) is never kept;
 * - the receipt, its time and its scope.
 * They are asked once per walk (`shared.walk`), as the skill reader's own memo of a walk already was: within one synchronous walk
 * nothing outside it runs. An answer made inside another (a remembered turn's receipt, met while a skill's sources are checked) is
 * asked under the outer one's walk, and what it rests on is what the outer one rests on too.
 */
type Flag = 'aether' | 'notion' | 'voyager';
const FLAGS: readonly Flag[] = ['aether', 'notion', 'voyager'];
/** The skill checks a read takes and her skills' database's mark (`SkillTurnPorts.readSourceChecks`). */
interface Checks { checks: object; mark: string | null }
/** What one walk found of the inputs, each asked at most once: the mark, the flags, and per scope the skill checks a read takes now. */
interface Walk { mark: string | null; flags: Partial<Record<Flag, boolean>>; skill: Map<string, Checks | null> }
/** What an answer being made has asked; `skills`: the scopes whose skill checks it read. */
interface Made { walk: Walk; flags: Partial<Record<Flag, boolean>>; skills: Set<string>; outside: boolean }
interface Answer { value: boolean; flags: Partial<Record<Flag, boolean>>; skills: ReadonlyMap<string, Checks> }
const sameChecks = (a: Checks | null, b: Checks) => a !== null && a.mark !== null && a.checks === b.checks && a.mark === b.mark;

export function readSourceAnswers(parts: FcaReadSourcesOptions) {
  const moments = new WeakMap<object, { mark: string; answers: Map<string, Answer> }>();
  const walks = new WeakMap<object, Walk>();
  /** The answers being made, innermost last; all of them under the outermost one's walk. */
  const making: Made[] = [];
  const connected = { aether: parts.aetherAvailable, notion: parts.notionAvailable, voyager: parts.voyagerAvailable };
  const flagOf = (flag: Flag): boolean => Boolean(connected[flag]?.());
  const flagIn = (walk: Walk, flag: Flag): boolean => walk.flags[flag] ??= flagOf(flag);
  /** The checks a skill read takes now in this scope (made anew if they have expired, as the read itself would), once per walk. */
  const skillIn = (walk: Walk, scope: string): Checks | null => {
    if (!walk.skill.has(scope)) walk.skill.set(scope, parts.skillChecks?.(scope, true) ?? null);
    return walk.skill.get(scope)!;
  };
  const asked = (flag: Flag): boolean => {
    const value = flagOf(flag);
    for (const made of making) made.flags[flag] ??= value;
    return value;
  };
  /** What `work` answers, noting on the answers being made that it was asked outside the database. */
  const outside = <T>(work: () => T): T => {
    for (const made of making) made.outside = true;
    return work();
  };
  /**
   * A skill is about to be read (or taken from the walk's own memo of it, `fcaReadSources.ts`): the answers being made rest on its
   * checks, which the walk takes now if it has not yet (before the read: a read that makes them anew is then seen after it).
   */
  const readSkill = (scope: string) => {
    if (!making.length) return;
    if (!parts.skillChecks) return void outside(() => null);
    skillIn(making[0]!.walk, scope);
    for (const made of making) made.skills.add(scope);
  };
  /** The reader's parts as answers are made with them: every question outside the database is noted on the answers being made. */
  const study = parts.study, upcoming = parts.upcoming, context = parts.aetherContext;
  const tracked: FcaReadSourcesOptions = {
    ...parts,
    aetherAvailable: () => asked('aether'),
    notionAvailable: () => asked('notion'),
    voyagerAvailable: () => asked('voyager'),
    now: () => outside(() => parts.now?.() ?? new Date().toISOString()),
    ...(context ? { aetherContext: { sourceText: (scope: string, id: string) => outside(() => context.sourceText?.(scope, id) ?? null) } } : {}),
    ...(study ? { study: {
      find: (scope: string, id: string, includeDeleted: boolean) => outside(() => study.find(scope, id, includeDeleted)),
      versions: (scope: string, id: string) => outside(() => study.versions(scope, id)),
    } } : {}),
    ...(upcoming ? { upcoming: {
      get calendarEnabled() { return outside(() => upcoming.calendarEnabled); },
      mayShareCalendar: (scope: string) => outside(() => upcoming.mayShareCalendar(scope)),
      get store() { return outside(() => upcoming.store); },
    } } : {}),
    folderAvailable: (scope, host) => outside(() => parts.folderAvailable?.(scope, host) ?? false),
    skill: (scope, id, revision) => {
      readSkill(scope);
      return parts.skill?.(scope, id, revision) ?? null;
    },
  };
  /** Still made from the same inputs, as this walk finds them. */
  const holds = (walk: Walk, known: Answer) => FLAGS.every(flag => known.flags[flag] === undefined || flagIn(walk, flag) === known.flags[flag])
    && [...known.skills].every(([scope, checks]) => sameChecks(skillIn(walk, scope), checks));
  /** A kept answer given again: what it was made from is what the answers waiting on it are made from too. */
  const given = (known: Answer): boolean => {
    for (const made of making) {
      for (const flag of FLAGS) if (known.flags[flag] !== undefined) made.flags[flag] ??= known.flags[flag];
      for (const scope of known.skills.keys()) made.skills.add(scope);
    }
    return known.value;
  };
  /**
   * The answer to keep, or null: nothing outside the database asked, the flags as the walk found them, and for each skill read the
   * checks the walk took before the reads, still the last ones made after them (checks are made anew, never made again, so they are the
   * ones every read of the answer took), with her skills' database's mark as the walk read it.
   */
  const keepable = (made: Made, value: boolean): Answer | null => {
    if (made.outside || !FLAGS.every(flag => made.flags[flag] === undefined || made.flags[flag] === flagIn(made.walk, flag))) return null;
    const skills = new Map<string, Checks>();
    for (const scope of made.skills) {
      const checks = made.walk.skill.get(scope) ?? null;
      if (checks === null || checks.mark === null || parts.skillChecks?.(scope, false)?.checks !== checks.checks) return null;
      skills.set(scope, checks);
    }
    return { value, flags: made.flags, skills };
  };
  /** The walk an answer is asked under: the outermost answer's being made, or this read's own. */
  const walkOf = (shared: ReadSourceSnapshot): Walk => {
    const token = shared.walk ?? shared.withholding;
    let walk = making[0]?.walk ?? walks.get(token);
    if (!walk) walks.set(token, walk = { mark: parts.conversations.changeMark?.() ?? null, flags: {}, skill: new Map() });
    return walk;
  };
  return {
    tracked, readSkill,
    /** `make()`'s answer, or the one made under the same inputs in this moment. */
    answer(scopeKey: string, sourceId: string, observedAt: string, shared: ReadSourceSnapshot, make: () => boolean): boolean {
      const walk = walkOf(shared);
      if (walk.mark === null) return make();
      let moment = moments.get(shared.withholding);
      if (moment?.mark !== walk.mark) moments.set(shared.withholding, moment = { mark: walk.mark, answers: new Map() });
      const key = `${scopeKey}\u0000${sourceId}\u0000${observedAt}\u0000${shared.state.version}\u0000${shared.state.updatedAt}`;
      const known = moment.answers.get(key);
      if (known && holds(walk, known)) return given(known);
      const made: Made = { walk, flags: {}, skills: new Set(), outside: false };
      making.push(made);
      let value: boolean;
      try {
        value = make();
      } finally { making.pop(); }
      const kept = keepable(made, value);
      if (kept) moment.answers.set(key, kept);
      return value;
    },
  };
}
