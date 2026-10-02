/**
 * Her message about a look opened in a voice turn must follow that turn in the Talk. The client stores a voice turn in
 * a request of its own (`POST /v1/voice/…/turns`), which may arrive before or after the look is answered; this keeps,
 * in memory, which turns are still awaited. It holds his words only to recognise the turn, and only until then.
 */
export interface TurnWait {
  /** Scope and Talk. */
  key: string;
  /** His words, without spaces and punctuation. */
  said: string;
  /** Ends when the turn is stored or the wait runs out. */
  stored: Promise<void>;
  done(): void;
}

/** His words as the delegation and the turn store both carry them, without spaces and punctuation. */
const saidKey = (said: string) => said.normalize('NFKC').replace(/[\s\p{P}]/gu, '');
/** The two requests may carry the raw and the tidied transcript of the same utterance. */
const sameWords = (left: string, right: string) => left.length > 0 && right.length > 0 && (left === right || left.includes(right) || right.includes(left));
const MAXIMUM_ENTRIES = 64;

export class VoiceTurnWaits {
  /** One entry per awaited turn, oldest first. */
  private readonly unstored = new Set<TurnWait>();
  /** The voice turns the client stored lately, oldest first: a turn already stored is not waited for. */
  private readonly storedTurns: Array<{ key: string; said: string; sequence: number }> = [];
  private storedSequence = 0;

  constructor(private readonly milliseconds: number) {}

  /** Where the stored turns stand now: a turn stored after this was stored "since". */
  get mark(): number {
    return this.storedSequence;
  }

  /**
   * The client stored a voice turn. The store carries no turn id, so the turn is known by its Talk and his words:
   * a late store of the turn before it has other words and releases nothing.
   */
  turnStored(scopeKey: string, threadId: string, said: string): void {
    const stored = { key: `${scopeKey}\u0000${threadId}`, said: saidKey(said), sequence: ++this.storedSequence };
    if (this.storedTurns.length >= MAXIMUM_ENTRIES) this.storedTurns.shift();
    this.storedTurns.push(stored);
    for (const wait of [...this.unstored]) if (wait.key === stored.key && sameWords(wait.said, stored.said)) wait.done();
  }

  /**
   * The wait for one voice turn to be stored, or null when nothing is waited for: waiting is switched off, or the
   * client stored the turn after `since` already. Each turn has its own entry and its own timer.
   */
  await(scopeKey: string, threadId: string, said: string, since: number): TurnWait | null {
    const key = `${scopeKey}\u0000${threadId}`;
    const words = saidKey(said);
    if (this.milliseconds <= 0 || this.storedTurns.some(turn => turn.sequence > since && turn.key === key && sameWords(words, turn.said))) return null;
    if (this.unstored.size >= MAXIMUM_ENTRIES) this.unstored.values().next().value?.done();
    let finish = (): void => undefined;
    const stored = new Promise<void>(resolve => { finish = resolve; });
    const wait: TurnWait = { key, said: words, stored, done: () => { clearTimeout(timer); this.unstored.delete(wait); finish(); } };
    const timer = setTimeout(() => wait.done(), this.milliseconds);
    timer.unref();
    this.unstored.add(wait);
    return wait;
  }
}
