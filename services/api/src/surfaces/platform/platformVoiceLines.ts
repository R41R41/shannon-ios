import { VoiceSegmentTags } from '../../infra/models/voiceAudioTags.js';
import type { VoiceTurnLine } from './platformVoiceRequest.js';

/**
 * The lines of a Discord voice channel's turn as they go out (dc-voice; moved out of `platformVoice.ts` for one head, which writes them
 * from the one voice turn as well): in order, and never stopping the turn when the reader went away.
 */
export class VoiceOut {
  count = 0;

  constructor(private readonly write: (line: VoiceTurnLine) => void) {}

  line(line: VoiceTurnLine): void {
    this.count += 1;
    try {
      this.write(line);
    } catch {
      /* the reader went away */
    }
  }
}

/** The sentences of one reply: the text shown and the voice's own text (tags) apart, numbered, with when the first went out. */
export class SpokenSentences {
  private readonly tags = new VoiceSegmentTags();
  private readonly streamed: string[] = [];
  private index = 0;
  firstAt: number | null = null;

  constructor(private readonly out: VoiceOut) {}

  get count(): number { return this.index; }

  /** A sentence that went out while the model wrote. */
  stream(raw: string): void {
    this.streamed.push(raw);
    this.say(raw);
  }

  say(raw: string, correction = false): void {
    const spoken = this.tags.take(raw);
    const text = spoken?.text.trim();
    if (!spoken || !text) return;
    this.firstAt ??= performance.now();
    const voiceText = spoken.voiceText?.trim();
    this.out.line({
      type: 'sentence', index: this.index, text,
      ...(voiceText && voiceText !== text ? { voiceText } : {}),
      ...(correction ? { correction: true as const } : {}),
    });
    this.index += 1;
  }

  /** What the model wrote after the last sentence that went out while it wrote (an unfinished one, or all of it when it could not stream). */
  rest(reply: string, split: (text: string) => string[]): void {
    const sent = this.streamed.join('');
    if (reply.startsWith(sent)) for (const sentence of split(reply.slice(sent.length))) this.say(sentence);
    else if (!sent) for (const sentence of split(reply)) this.say(sentence);
  }
}
