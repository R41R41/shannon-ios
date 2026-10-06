/**
 * What she would like her Minecraft body to do, as a field of the structured reply of a turn with the owner
 * (`minecraftBody.ts`). No imports: the chat model's parsing reads it without the body's wiring.
 */
export interface MinecraftIntent {
  kind: 'none' | 'task' | 'stop';
  /** What to do, in her words, for `task`. Empty otherwise. */
  goal: string;
}

export const MINECRAFT_INTENT_GOAL_CHARACTERS = 120;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The field of the structured reply by which she asks her Minecraft body to do something. Offered in a turn of the owner only. */
export const MINECRAFT_INTENT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string', enum: ['none', 'task', 'stop'],
      description: 'マイクラの体に頼むこと。task=ライ氏にゲームの中でしてほしいことをはっきり頼まれた。stop=今していることをやめてと言われた。none=それ以外',
    },
    goal: { type: 'string', description: `task の時だけ、何をどれだけするかを${MINECRAFT_INTENT_GOAL_CHARACTERS}字以内で。それ以外は空文字` },
  },
  required: ['kind', 'goal'],
});

/** The intent of a structured reply, or null when it is absent or unreadable. A task without a goal is no task. */
export function parsedMinecraftIntent(value: unknown): MinecraftIntent | null {
  if (!isRecord(value)) return null;
  const goal = typeof value.goal === 'string'
    ? value.goal.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, MINECRAFT_INTENT_GOAL_CHARACTERS) : '';
  if (value.kind === 'task') return goal ? { kind: 'task', goal } : null;
  if (value.kind === 'stop') return { kind: 'stop', goal: '' };
  if (value.kind === 'none') return { kind: 'none', goal: '' };
  return null;
}
