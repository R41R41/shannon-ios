import type { TaskMemoryReadSnapshot as ReadSourceSnapshot } from '../mind/memory/taskMemoryPorts.js';
import type { FcaReadSourcesOptions } from './fcaReadSources.js';
import { taskEvidenceReads } from './fcaTaskEvidenceReads.js';

/**
 * The answer about one read receipt at one time, made once per moment and given to every check of that moment. Production run 18
 * (2026-10-19, Minecraft): the source guard asked a task's receipts again at every check that reused a verdict (its skill pins, a
 * skill read and its checks each time: 45.5 s of the 73 s of checks of 100 ms or more), and a decision makes a dozen checks within
 * moments of each other. Each receipt was answered afresh although nothing it was made from had changed.
 *
 * An answer is given again only while every input it was made from is the same, each checked in code:
 * - the rows: the mark of the rows a source's visibility is read from (`provenanceMark`: state, turns, knowledge, her skills; the
 *   database's own change mark where that cannot be told; null inside a transaction, where nothing is kept). Production run 19
 *   (2026-10-20): under the database's own mark, which every lease renewal and every step's progress moves, almost nothing was kept;
 * - the caller's withholding and state: answers are shared by every withholding made from the rows of the same mark (`shared.rows`, the
 *   guard's moments), or else kept for the one withholding they were made with;
 * - what the reader asks outside those rows: whether Aether, Notion and Voyager are connected, as the answer found them; the skill
 *   reader's checks, the same object, and her skills' database's mark (`skillChecks`; without it no answer that read a skill is kept:
 *   her skills may be kept in another database than the turns). An answer that asked anything else (the clock, the calendar, a
 *   folder's host, a study piece, the Aether context, a task's own records) is never kept;
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
interface Moment { mark: string; answers: Map<string, Answer> }
const sameChecks = (a: Checks | null, b: Checks) => a !== null && a.mark !== null && a.checks === b.checks && a.mark === b.mark;
/** How often the counts below are named in the journal (`Shannon FCA receipt answers`), while answers are asked. */
export const RECEIPT_ANSWERS_LOG_MS = 60_000;
/**
 * Content-free counts since the last line: asked, given again, kept; why an answer was made afresh (`moved`: the rows' mark moved;
 * `fresh`: a withholding or moment not seen before; `first`: not asked yet in this moment; `flags`, `checks`: a connection or the skill
 * checks changed); why one was not kept (`outside`, `unkept`: the skill checks changed while it was made; `transaction`); and the walks
 * under the narrow mark (`p`) and under the database's own (`d`).
 */
type Count = 'asked' | 'given' | 'kept' | 'moved' | 'fresh' | 'first' | 'flags' | 'checks' | 'outside' | 'unkept' | 'transaction' | 'p' | 'd';
const COUNTS: readonly Count[] = ['asked', 'given', 'kept', 'moved', 'fresh', 'first', 'flags', 'checks', 'outside', 'unkept', 'transaction', 'p', 'd'];

export function readSourceAnswers(parts: FcaReadSourcesOptions, log: (line: string) => void = line => console.warn(line), clock: () => number = Date.now) {
  const moments = new WeakMap<object, Moment>();
  /** The moment every withholding made from the rows of the current mark shares (`shared.rows`). */
  let rowsMoment: Moment | null = null;
  const walks = new WeakMap<object, Walk>();
  /** The answers being made, innermost last; all of them under the outermost one's walk. */
  const making: Made[] = [];
  const counts = Object.fromEntries(COUNTS.map(name => [name, 0])) as Record<Count, number>;
  let loggedAt = clock();
  const count = (name: Count) => { counts[name] += 1; };
  const report = () => {
    const at = clock();
    if (at - loggedAt < RECEIPT_ANSWERS_LOG_MS || !counts.asked) return;
    loggedAt = at;
    log(`Shannon FCA receipt answers ${COUNTS.map(name => `${name}=${counts[name]}`).join(' ')}`);
    for (const name of COUNTS) counts[name] = 0;
  };
  const markOf = () => parts.conversations.provenanceMark?.() ?? parts.conversations.changeMark?.() ?? null;
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
  /** What `work` answers, noting on the answers being made that it was asked outside the rows. */
  const outside = <T>(work: () => T): T => {
    for (const made of making) made.outside = true;
    return work();
  };
  const taskRecords = () => void outside(() => null);
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
  /** The reader's parts as answers are made with them: every question outside the rows is noted on the answers being made. */
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
  /** Why a kept answer is not given again (null: it is), as this walk finds the inputs. */
  const changed = (walk: Walk, known: Answer): Count | null => {
    if (!FLAGS.every(flag => known.flags[flag] === undefined || flagIn(walk, flag) === known.flags[flag])) return 'flags';
    return [...known.skills].every(([scope, checks]) => sameChecks(skillIn(walk, scope), checks)) ? null : 'checks';
  };
  /** A kept answer given again: what it was made from is what the answers waiting on it are made from too. */
  const given = (known: Answer): boolean => {
    for (const made of making) {
      for (const flag of FLAGS) if (known.flags[flag] !== undefined) made.flags[flag] ??= known.flags[flag];
      for (const scope of known.skills.keys()) made.skills.add(scope);
    }
    return known.value;
  };
  /**
   * The answer to keep, or why not: nothing outside the rows asked, the flags as the walk found them, and for each skill read the checks
   * the walk took before the reads, still the last ones made after them (checks are made anew, never made again, so they are the ones
   * every read of the answer took), with her skills' database's mark as the walk read it.
   */
  const keepable = (made: Made, value: boolean): Answer | Count => {
    if (made.outside) return 'outside';
    if (!FLAGS.every(flag => made.flags[flag] === undefined || made.flags[flag] === flagIn(made.walk, flag))) return 'unkept';
    const skills = new Map<string, Checks>();
    for (const scope of made.skills) {
      const checks = made.walk.skill.get(scope) ?? null;
      if (checks === null || checks.mark === null || parts.skillChecks?.(scope, false)?.checks !== checks.checks) return 'unkept';
      skills.set(scope, checks);
    }
    return { value, flags: made.flags, skills };
  };
  /** The walk an answer is asked under: the outermost answer's being made, or this read's own. */
  const walkOf = (shared: ReadSourceSnapshot): Walk => {
    const token = shared.walk ?? shared.withholding;
    let walk = making[0]?.walk ?? walks.get(token);
    if (!walk) {
      walks.set(token, walk = { mark: markOf(), flags: {}, skill: new Map() });
      if (walk.mark !== null) count(walk.mark.startsWith('p') ? 'p' : 'd');
    }
    return walk;
  };
  /** The moment of this read under the walk's mark, and whether it was made just now (moved: its mark moved; fresh: none before). */
  const momentOf = (shared: ReadSourceSnapshot, mark: string): { moment: Moment; made?: Count } => {
    if (shared.rows === mark) {
      if (rowsMoment?.mark === mark) return { moment: rowsMoment };
      const made: Count = rowsMoment ? 'moved' : 'fresh';
      return { moment: rowsMoment = { mark, answers: new Map() }, made };
    }
    const known = moments.get(shared.withholding);
    if (known?.mark === mark) return { moment: known };
    const moment = { mark, answers: new Map<string, Answer>() };
    moments.set(shared.withholding, moment);
    return { moment, made: known ? 'moved' : 'fresh' };
  };
  /** `make()` with what it asks noted, the task records' proofs among them. */
  const made = (walk: Walk, make: () => boolean): { value: boolean; made: Made } => {
    const frame: Made = { walk, flags: {}, skills: new Set(), outside: false };
    if (!making.length) taskEvidenceReads.add(taskRecords);
    making.push(frame);
    try {
      return { value: make(), made: frame };
    } finally {
      making.pop();
      if (!making.length) taskEvidenceReads.delete(taskRecords);
    }
  };
  /** Object identities as short numbers, for a fingerprint (the skill checks are an object a fresh read makes anew). */
  const objectIds = new WeakMap<object, number>();
  let objectCount = 0;
  const objectId = (value: object): number => {
    let id = objectIds.get(value);
    if (id === undefined) objectIds.set(value, id = ++objectCount);
    return id;
  };
  /**
   * r9: the receipt ids whose answers rest only on the inputs above: a skill, and the documents whose answer is the connection's flag. Any
   * other family (the Aether context, a study piece, a folder's host, the calendar) asks the clock or an outside store: never kept.
   */
  const KEPT_FAMILY = /^(?:shannon-skill|aether-document|notion-page|voyager-task):\/\//u;
  const families = new WeakMap<readonly string[], { kept: boolean; skill: boolean }>();
  const familiesOf = (ids: readonly string[]) => {
    let known = families.get(ids);
    if (!known) {
      known = { kept: ids.every(id => KEPT_FAMILY.test(id)), skill: ids.some(id => id.startsWith('shannon-skill://')) };
      families.set(ids, known);
    }
    return known;
  };
  return {
    tracked, readSkill,
    /**
     * r9: the inputs every answer about `ids` (at any time) is made from, as one string: the rows' mark, the state's version, update time and
     * number of controls, the connections' flags, and for a skill the checks a read takes now and her skills' mark. The same string at two
     * moments means each answer would be given again (`changed` is null for every kept answer), so a list found unchanged is unchanged.
     * Null where that cannot be told: inside a transaction (no mark), a receipt of a family that is never kept, a skill with no checks.
     */
    fingerprint(scopeKey: string, state: ReadSourceSnapshot['state'], ids: readonly string[]): string | null {
      const mark = markOf();
      if (mark === null) return null;
      // No receipt named: the inputs alone, her skills' among them when there are checks (to see none moved while a walk was made).
      const family = ids.length ? familiesOf(ids) : { kept: true, skill: Boolean(parts.skillChecks) };
      if (!family.kept) return null;
      let skills = '';
      if (family.skill) {
        const checks = parts.skillChecks?.(scopeKey, true) ?? null;
        if (checks === null || checks.mark === null) { if (ids.length) return null; } else skills = `${objectId(checks.checks)}:${checks.mark}`;
      }
      return [mark, state.version, state.updatedAt, state.memoryControls.length, FLAGS.map(flag => flagOf(flag) ? 1 : 0).join(''), skills, scopeKey].join('|');
    },
    /** `make()`'s answer, or the one made under the same inputs in this moment. */
    answer(scopeKey: string, sourceId: string, observedAt: string, shared: ReadSourceSnapshot, make: () => boolean): boolean {
      count('asked');
      report();
      const walk = walkOf(shared);
      if (walk.mark === null) {
        count('transaction');
        return make();
      }
      const { moment, made: momentMade } = momentOf(shared, walk.mark);
      const key = `${scopeKey}\u0000${sourceId}\u0000${observedAt}\u0000${shared.state.version}\u0000${shared.state.updatedAt}`;
      const known = moment.answers.get(key);
      const why = known ? changed(walk, known) : momentMade ?? 'first';
      if (known && why === null) {
        count('given');
        return given(known);
      }
      count(why!);
      const result = made(walk, make);
      const kept = keepable(result.made, result.value);
      if (typeof kept === 'string') count(kept);
      else {
        count('kept');
        moment.answers.set(key, kept);
      }
      return result.value;
    },
  };
}
