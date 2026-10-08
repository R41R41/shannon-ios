import { createHash, randomUUID } from 'node:crypto';
import { withMinecraftBodyCapability } from '@shannon/cognition';
import type { MinecraftBodyRequests } from '../../surfaces/minecraft/minecraftBodyRequests.js';
import { stringInput } from './shannonToolInput.js';
import type { ToolExecutor } from './shannonToolTypes.js';
import { toolFailure, toolOk, type ShannonToolDefinition } from './shannonTools.js';

/**
 * Her Minecraft body's tools (`minecraft.*` in `shannonTools.ts`; phase 4 of `docs/minecraft-body-contract.md`).
 * `minecraft.request` only queues: the body claims the request, works on it and reports, and what it reported reaches
 * her later as `[マイクラの体で起きたこと]` and as an experience. The tool fails at once while the body is not present,
 * so nothing waits to run later by surprise. The activity record gets one line per call, never the goal.
 */
export type MinecraftRequestPort = Pick<MinecraftBodyRequests, 'configuredFor' | 'present' | 'enqueue' | 'cancel' | 'statusText'>;

/** Whether a surface offers this tool now: `minecraft.request` only while the body is present; the others while it is configured. */
export function minecraftToolOffered(requests: MinecraftRequestPort | null | undefined, tool: ShannonToolDefinition, scopeKey: string | undefined): boolean {
  if (!requests || scopeKey === undefined || !requests.configuredFor(scopeKey)) return false;
  return tool.name !== 'minecraft.request' || requests.present(scopeKey);
}

/**
 * The owner's capability description with her Minecraft body's line (`withMinecraftBodyCapability`), only while the
 * configured body is in the game: the line says 「入っている時」, and that is when `minecraft.request` is offered.
 * Without a body, or while it is away, the prompt is exactly what it is without one. Never throws.
 */
export function withMinecraftBodyLine(body: { present?(scopeKey: string): boolean } | null | undefined, scopeKey: string, prompt: string): string {
  try { return body?.present?.(scopeKey) ? withMinecraftBodyCapability(prompt) : prompt; } catch { return prompt; }
}

/**
 * A model request with her Minecraft body's capability line, exactly when the turn's own tools include `minecraft.request`
 * (second review, 2026-10-06): the owner alone as the server knows it, her tools on, the body configured and in the game,
 * and the turn offered tools at all (a voice turn by its words). Otherwise the request is returned as it is, so a server
 * without a body sends exactly what it sent before.
 */
export function withMinecraftToolLine<T extends { systemPrompt: string; tools?: { definitions: readonly { name: string }[]; menu?: { offered: readonly { name: string }[] } } }>(request: T): T {
  // With the tool menu (Syzygy ADR-0008 stage 2) the line follows every tool the turn offers, not only the schemas sent.
  return (request.tools?.menu?.offered ?? request.tools?.definitions)?.some(tool => tool.name === 'minecraft.request')
    ? { ...request, systemPrompt: withMinecraftBodyCapability(request.systemPrompt) } : request;
}

const NOT_CONFIGURED = toolFailure('unavailable', 'マイクラの体は、まだ用意されていない。', {
  retryable: false, refusal: { why: 'マイクラの体の設定がない', wouldWork: 'ライ氏がマイクラの体を用意したあと' },
});

export function minecraftExecutors(requests: MinecraftRequestPort | null | undefined): Readonly<Record<string, ToolExecutor>> {
  return Object.freeze({
    'minecraft.request': (input, context) => {
      if (!requests?.configuredFor(context.scopeKey)) return NOT_CONFIGURED;
      const goal = stringInput(input, 'goal')?.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim() ?? '';
      if (!goal) return toolFailure('invalid_input', '何をするか（goal）が空だった。', { retryable: false });
      // A retry of the same turn asks for the same thing once.
      const dedupeKey = `tool:${createHash('sha256').update(`${context.memory.turnKey ?? randomUUID()}\n${goal}`).digest('hex').slice(0, 40)}`;
      return {
        summary: 'マイクラの体に頼みごとを渡す。',
        async run() {
          const outcome = requests.enqueue(context.scopeKey, {
            goal, dedupeKey, origin: { surface: context.surface === 'voice' ? 'voice' : 'text', ...(context.threadId ? { threadId: context.threadId } : {}) },
          });
          if (outcome.kind === 'queued') {
            return {
              result: toolOk(`マイクラの体に頼んだ（id: ${outcome.request.id}）。頼んだこと: 「${outcome.request.goal}」。体が受け取ったら動き出し、終わると結果が届く。いまはまだ何もしていないので、終わった・集めたとは言わない。`),
              record: { summary: outcome.duplicate ? 'マイクラの体への同じ頼みごとを、もう一度は渡しませんでした。' : '会話の中で、マイクラの体に頼みごとを渡しました。', outcome: 'done' },
            };
          }
          const failed = (summary: string, reasonCode: string) => ({ summary, outcome: 'failed' as const, reasonCode });
          if (outcome.kind === 'absent') {
            return {
              result: toolFailure('unavailable', 'マイクラの体はいまゲームに入っていない（体から連絡がない）ので、頼めなかった。', {
                retryable: false, refusal: { why: 'マイクラの体がいまつながっていない', wouldWork: '体がゲームに入ったあとで頼み直す' },
              }),
              record: failed('マイクラの体に頼もうとしましたが、体がいませんでした。', 'absent'),
            };
          }
          if (outcome.kind === 'model_unavailable') return { result: toolFailure('unavailable', '選択中のモデルをマイクラの体で使えないので、頼みごとは受け付けなかった。', { retryable: false }),
            record: failed('選択中のモデルをマイクラの体で使えませんでした。', 'model_unavailable') };
          if (outcome.kind === 'limit') {
            return {
              result: toolFailure('limit', 'マイクラの体への頼みごとが、もういっぱいたまっている。', {
                retryable: false, refusal: { why: '終わっていない頼みごとが上限まである', wouldWork: 'どれかが終わるか、minecraft.cancel でやめたあと' },
              }),
              record: failed('マイクラの体に頼もうとしましたが、頼みごとがいっぱいでした。', 'limit'),
            };
          }
          return { result: outcome.kind === 'not_configured' ? NOT_CONFIGURED : toolFailure('invalid_input', '頼みごとの形が正しくなかった。', { retryable: false }),
            record: failed('マイクラの体に頼もうとしましたが、できませんでした。', outcome.kind) };
        },
      };
    },
    'minecraft.status': (_input, context) => {
      if (!requests?.configuredFor(context.scopeKey)) return NOT_CONFIGURED;
      return {
        summary: 'マイクラの体に頼んだことの様子を見る。',
        async run() {
          return { result: toolOk(requests.statusText(context.scopeKey)), record: { summary: '会話の中で、マイクラの体に頼んだことの様子を見ました。', outcome: 'done' } };
        },
      };
    },
    'minecraft.cancel': (input, context) => {
      if (!requests?.configuredFor(context.scopeKey)) return NOT_CONFIGURED;
      const id = stringInput(input, 'id')?.trim() || undefined;
      return {
        summary: 'マイクラの体に頼んだことをやめてもらう。',
        async run() {
          const outcome = requests.cancel(context.scopeKey, id);
          if (outcome === 'NOT_FOUND') {
            return { result: toolFailure('not_found', id ? 'その id の頼みごとはない。' : '進行中の頼みごとはない。', { retryable: false }),
              record: { summary: 'マイクラの体の頼みごとをやめようとしましたが、見つかりませんでした。', outcome: 'failed', reasonCode: 'not_found' } };
          }
          if (outcome === 'FINISHED') {
            return { result: toolFailure('conflict', 'その頼みごとは、もう終わっている。', { retryable: false }),
              record: { summary: 'マイクラの体の頼みごとをやめようとしましたが、もう終わっていました。', outcome: 'failed', reasonCode: 'finished' } };
          }
          return {
            result: toolOk(outcome.state === 'cancelled' ? `「${outcome.goal}」は体が受け取る前だったので、取り消した。` : `「${outcome.goal}」をやめるよう体に伝えた。止まったら結果が届く。`),
            record: { summary: '会話の中で、マイクラの体に頼んだことをやめてもらいました。', outcome: 'done' },
          };
        },
      };
    },
  });
}
