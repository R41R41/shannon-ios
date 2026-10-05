import type { ShannonModelToolSession } from './chatModelTools.js';
import { CONVERSATION_TOOL_CALLS } from './chatModelTools.js';
import type { ShannonToolRunner } from './shannonToolRunner.js';
import { toolSessionMemory } from './shannonToolTypes.js';
import { toolFromProviderName, toolResultForModel } from './shannonTools.js';

/**
 * The tools of one conversation turn, for the model adapter (`chatModelTools.ts`). Owner decision 2026-10-05: her
 * study and her folder are offered only while the owner alone can see or hear the reply, so with a guest, with
 * 「友人も一緒」, or with anyone else present the turn has no tools at all and nothing of them can be said to others.
 *
 * Text offers them in every turn the owner alone reads (unless it forces a web search). Voice offers them only when
 * the words are about her writing or her folder (`asksAboutOwnThings`), so that an ordinary spoken turn keeps its speed.
 */
export function conversationTools(
  autonomy: { tools?: ShannonToolRunner } | undefined, scopeKey: string, surface: 'text' | 'voice', ownerAlone: boolean,
): { tools?: ShannonModelToolSession } {
  const runner = autonomy?.tools;
  if (!runner || !ownerAlone || !ownToolsEnabled()) return {};
  const definitions = runner.offered(surface, 'owner_alone');
  if (!definitions.length) return {};
  const memory = toolSessionMemory();
  const session = { definitions, maximumCalls: CONVERSATION_TOOL_CALLS } as ShannonModelToolSession;
  // Not enumerable: two turns that offer the same tools are the same request (what the model is asked), whoever runs the calls.
  Object.defineProperty(session, 'call', {
    enumerable: false,
    value: async (providerName: string, argumentsJson: string, signal?: AbortSignal) => {
      const tool = toolFromProviderName(providerName);
      const result = await runner.call(tool?.name ?? providerName.slice(0, 80), argumentsJson, { scopeKey, surface, audience: 'owner_alone', memory }, signal);
      return toolResultForModel(result);
    },
  });
  return { tools: session };
}

/** `SHANNON_OWN_TOOLS=off` offers no tool on any surface; every request and prompt is then what it was before the tools. */
export function ownToolsEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !['off', 'false', '0', 'disabled', 'no', 'none'].includes(environment.SHANNON_OWN_TOOLS?.trim().toLowerCase() ?? '');
}

/** Words of a spoken turn that are about her own writing or her folder: the voice turn then offers her tools. */
export function asksAboutOwnThings(transcript: string): boolean {
  return /(?:書斎|下書き|物語|お話|メモ|ノート|原稿|草稿|書いた|書いて|書き直|フォルダ|ファイル|ゴミ箱)/u.test(transcript);
}
