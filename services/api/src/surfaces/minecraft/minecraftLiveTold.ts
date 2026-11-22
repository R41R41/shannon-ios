/**
 * What she has already told of her work, kept as the events (the fact lines) and not as her own words. The writer that is shown her last
 * words says them back: the same first syllable, the same phrase, even the story of a request that ended. Shown the event, it knows the
 * thing is told and still finds its own words. The story of one request is what is kept: the end of a request, or a stop, closes it.
 */
export class LiveToldFacts {
  private lines: string[] = [];

  constructor(private readonly limit = 6) {}

  /** A line was said about this event (the fact line the writer was given for it). */
  add(fact: string): void {
    if (!fact) return;
    this.lines = [...this.lines.filter(line => line !== fact), fact].slice(-this.limit);
  }

  /** The story is over (the request ended, or her work was stopped): what was told of it is not told again as a thing to avoid. */
  close(): void { this.lines = []; }

  /** Oldest first. */
  list(): string[] { return [...this.lines]; }
}
