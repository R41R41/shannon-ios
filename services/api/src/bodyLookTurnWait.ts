/**
 * Her message about a look opened in a voice turn must follow that turn in the Talk. The client stores a voice turn in
 * a request of its own (`POST /v1/voice/…/turns`), which may arrive before or after the look is answered. This keeps,
 * in memory only, which turns are still awaited, and for 60 seconds which turns were stored. A turn is known by the
 * client's utterance id when both requests carry one, otherwise by his words; the words are held for that purpose alone.
 * The owner of this object records nothing here while looks are switched off, the wait is 0, or other people are present.
 */
export interface TurnWait {
  /** Scope and Talk. */
  key: string;
  /** The client's id of the utterance, when it sent one. */
  turnId?: string;
  /** His words, without spaces and punctuation. */
  said: string;
  /** Ends when the turn is stored or the wait runs out. */
  stored: Promise<void>;
  done(): void;
}

/** His words as the delegation and the turn store both carry them, without spaces and punctuation. */
const saidKey = (said: string) => said.normalize('NFKC').replace(/[\s\p{P}]/gu, '');
const characters = (text: string) => Array.from(text).length;
/**
 * The two requests may carry the raw and the tidied transcript of the same utterance: equal, or one inside the other
 * when the shorter is at least six characters and 60% of the longer. Empty words are no turn.
 */
function sameWords(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return characters(shorter) >= 6 && characters(shorter) >= 0.6 * characters(longer) && longer.includes(shorter);
}
/** By id when both sides have one, and then by id only; otherwise by words. */
const sameTurn = (left: { turnId?: string; said: string }, right: { turnId?: string; said: string }) =>
  left.turnId && right.turnId ? left.turnId === right.turnId : sameWords(left.said, right.said);
const MAXIMUM_ENTRIES = 64;
const STORED_TURN_MILLISECONDS = 60_000;

export class VoiceTurnWaits {
  /** One entry per awaited turn, oldest first. */
  private readonly unstored = new Set<TurnWait>();
  /** The voice turns the client stored in the last minute, oldest first: a turn already stored is not waited for. */
  private storedTurns: Array<{ key: string; turnId?: string; said: string; sequence: number; at: number }> = [];
  private storedSequence = 0;

  constructor(private readonly milliseconds: number, private readonly clock: () => number = Date.now) {}

  /** Where the stored turns stand now: a turn stored after this was stored "since". */
  get mark(): number {
    return this.storedSequence;
  }

  /** The client stored a voice turn. A late store of the turn before the awaited one is another turn and releases nothing. */
  turnStored(scopeKey: string, threadId: string, said: string, turnId?: string): void {
    this.storedSequence += 1;
    if (this.milliseconds <= 0) return;
    const now = this.clock();
    const stored = { key: `${scopeKey}\u0000${threadId}`, said: saidKey(said), sequence: this.storedSequence, at: now, ...(turnId ? { turnId } : {}) };
    this.storedTurns = this.storedTurns.filter(turn => now - turn.at < STORED_TURN_MILLISECONDS).slice(-(MAXIMUM_ENTRIES - 1));
    this.storedTurns.push(stored);
    for (const wait of [...this.unstored]) if (wait.key === stored.key && sameTurn(wait, stored)) wait.done();
  }

  /**
   * The wait for one voice turn to be stored, or null when nothing is waited for: waiting is switched off, the turn has
   * neither an id nor words, or the client stored it after `since` already. Each turn has its own entry and its own timer.
   */
  await(scopeKey: string, threadId: string, said: string, since: number, turnId?: string): TurnWait | null {
    const key = `${scopeKey}\u0000${threadId}`;
    const turn = { said: saidKey(said), ...(turnId ? { turnId } : {}) };
    if (this.milliseconds <= 0 || (!turn.said && !turn.turnId)) return null;
    const now = this.clock();
    this.storedTurns = this.storedTurns.filter(stored => now - stored.at < STORED_TURN_MILLISECONDS);
    if (this.storedTurns.some(stored => stored.sequence > since && stored.key === key && sameTurn(turn, stored))) return null;
    if (this.unstored.size >= MAXIMUM_ENTRIES) this.unstored.values().next().value?.done();
    let finish = (): void => undefined;
    const stored = new Promise<void>(resolve => { finish = resolve; });
    const wait: TurnWait = { key, ...turn, stored, done: () => { clearTimeout(timer); this.unstored.delete(wait); finish(); } };
    const timer = setTimeout(() => wait.done(), this.milliseconds);
    timer.unref();
    this.unstored.add(wait);
    return wait;
  }
}
