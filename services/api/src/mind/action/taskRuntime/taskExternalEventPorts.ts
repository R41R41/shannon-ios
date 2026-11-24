/**
 * What a person said, as the task's head reads it beside the line that sums it up (the voice's request or message): who, their own words, when, and
 * where they stood in the game when they said it. Every field but the name and the words is optional, and a message without any of it reads as before.
 */
export interface SpokenWords {
  speakerName: string;
  speakerWords: string;
  spokenAt: string;
  speakerPos?: { x: number; y: number; z: number; dimension?: string | undefined };
}

export interface TaskExternalEvent {
  /** Stable upstream identity, never generated again for a retry. */
  eventId: string;
  experienceIds: readonly string[];
  observedAt: string;
  text: string;
  /** The person's own words with the line (`SpokenWords`): kept with the message and shown to the task's head as its fields. */
  said?: SpokenWords;
}
