import type { ApiResponse } from '../../contracts/contracts.js';
import { expressionOf, type VoiceSeat } from '../../contracts/oneHeadContract.js';
import type { ShannonChatModelResult } from '../../infra/models/chatModel.js';
import { platformAudienceTurn, type PlatformAudiencePolicy } from '../../mind/memory/platformMemoryPorts.js';
import { SpokenSentences, type VoiceOut } from './platformVoiceLines.js';

/**
 * One head (`SHANNON_ONE_HEAD`, owner 2026-10-20): a Discord voice channel's reply from the one voice turn the apps use
 * (`apiLiveVoice.ts`, through `ShannonApiKernel.seatedVoiceTurn`), instead of the text turn read aloud. The channel hands the turn its seat
 * (`VoiceSeat`: the bridge's policy for this speaker, the audience's and the channel's blocks, where the turn is kept) and reads the
 * turn's stream back as the channel's lines: her face as `expression`, her words as `sentence`s cut at a clause as the channel speaks them.
 */
export interface SeatedVoiceObserver {
  onPlan(plan: Record<string, unknown>): void | Promise<void>;
  onTextDelta(delta: string): void | Promise<void>;
  flushSpoken(): Promise<void>;
}

export type SeatedVoiceTurn = (turn: { scopeKey: string; transcript: string; seat: VoiceSeat }, observer: SeatedVoiceObserver) => Promise<ApiResponse>;

/** A reply cut into the sentences the channel speaks, while it is written (`ChatSentenceSplitter` with `VOICE_SENTENCE_CUT`). */
export interface SentenceSplitter {
  append(text: string): string[];
  flush(): string[];
}

/** The seat of this speaker, from the bridge's policy: what the one voice turn reads instead of a paired device's. */
export function platformVoiceSeat(input: {
  policy: PlatformAudiencePolicy; owner: boolean; message: string; prompt: string; title: string; offerMinecraftIntent: boolean;
  keep: VoiceSeat['keep'];
}): VoiceSeat {
  const { policy } = input;
  const audience = platformAudienceTurn(policy);
  return {
    threadId: policy.threadId, present: policy.present, ownerAlone: policy.gate.ownerOnly, ownerSpeaking: input.owner, ownerPresent: policy.ownerPresent,
    ...(policy.speaker ? { speaker: policy.speaker } : {}), message: input.message,
    // The audience's own instructions first, the channel's after them: the order of the platform's typed turn.
    prompt: [audience.instructions, input.prompt].filter(Boolean).join('\n\n'), threadTitle: input.title, turnLabel: audience.turnLabel,
    offerMinecraftIntent: input.offerMinecraftIntent, keep: input.keep,
  };
}

/** Without a splitter the reply is cut once it is complete. */
class EndSplitter implements SentenceSplitter {
  private written = '';

  constructor(private readonly sentences: (text: string) => string[]) {}

  append(text: string): string[] {
    this.written += text;
    return [];
  }

  flush(): string[] {
    const all = this.sentences(this.written);
    this.written = '';
    return all;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

/**
 * The one voice turn, read as the channel's lines. A failed turn (any status but 2xx) is an error after the decision line (the
 * channel's `error` line); what was said before it stands.
 */
export async function askSeated(seated: SeatedVoiceTurn, turn: { scopeKey: string; transcript: string; seat: VoiceSeat }, out: VoiceOut,
  cut: { sentences(text: string): string[]; splitter?: () => SentenceSplitter }): Promise<{
    reply: string; minecraftIntent?: ShannonChatModelResult['minecraftIntent']; experienceId?: string; spoken: SpokenSentences;
  }> {
  const spoken = new SpokenSentences(out);
  const splitter = cut.splitter?.() ?? new EndSplitter(cut.sentences);
  let face = '';
  let heard = false;
  const response = await seated(turn, {
    onPlan: plan => {
      const expression = expressionOf(plan);
      const seen = JSON.stringify(expression);
      if (!expression || seen === face) return;
      face = seen;
      out.line(expression);
    },
    onTextDelta: delta => {
      if (delta) heard = true;
      for (const sentence of splitter.append(delta)) spoken.stream(sentence);
    },
    flushSpoken: async () => { for (const sentence of splitter.flush()) spoken.stream(sentence); },
  });
  for (const sentence of splitter.flush()) spoken.stream(sentence);
  if (response.status < 200 || response.status >= 300) throw new Error('PLATFORM_VOICE_TURN_FAILED');
  const body = record(response.body);
  const reply = typeof body.reply === 'string' ? body.reply : '';
  // Unstreamed (a structured reply), the words are the finished reply.
  if (!heard) for (const sentence of cut.sentences(reply)) spoken.say(sentence);
  const intent = body.minecraftIntent as ShannonChatModelResult['minecraftIntent'] | undefined;
  const experience = typeof body.experienceId === 'string' ? { experienceId: body.experienceId } : {};
  return { reply, ...(intent ? { minecraftIntent: intent } : {}), ...experience, spoken };
}
