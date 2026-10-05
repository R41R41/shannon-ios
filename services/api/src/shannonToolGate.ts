import { AetherAccessError, type AetherAccess } from './aetherAccess.js';
import type { AutonomousActionRequest, AutonomyDecision } from './autonomyPolicy.js';
import type { ToolInput } from './shannonToolInput.js';
import { toolFailure, type ShannonToolDefinition, type ToolAudience, type ToolResult, type ToolSurface } from './shannonTools.js';

/**
 * The one gate entry of a tool call (Syzygy ADR-0003 stage 1). It decides from the registry entry and the
 * call's context; executors check nothing of this themselves.
 *
 * 1. The surface and the audience (`authorizeToolCall`): a tool is used only on a surface it lists and only
 *    while everyone who can see or hear the reply is in its audiences. Owner decision 2026-10-05: her study and
 *    her folder are used only while the owner alone can see or hear, so nothing of them is spoken or shown to others.
 * 2. Her own time additionally goes through `authorizeAutonomousAction` with the tool's domain
 *    (`toolGateRequest`), which holds the stop switch, the server switch, the budget, the folder's host
 *    registration and path rules, and writes the decision to the activity record. Its refusal comes back to
 *    her in the tool result shape (`toolRefusal`).
 * 3. A call from a conversation is work the owner called her for: it is not charged to her budget and not
 *    stopped by her pause (ADR-0002), and it is still written to the activity record by the runner.
 * 4. Aether (Syzygy ADR-0007 revised, owner decision 2026-10-06): the owner's documents, outside 「シャノン用フォルダ」, are
 *    searched and read only while the owner alone can see or hear the reply. With anyone else present, and in her own time
 *    (whose gate domain is her study, not his documents), a search must name her folder or her study (`authorizeToolInput`)
 *    and the executor is handed a client that refuses everything outside her folder (`gatedAether`), whatever it asks.
 */
export interface ToolCallContext {
  scopeKey: string;
  surface: ToolSurface;
  audience: ToolAudience;
}

export function authorizeToolCall(tool: ShannonToolDefinition | null, context: ToolCallContext): ToolResult | null {
  if (!tool) {
    return toolFailure('not_offered', 'そういう道具はない。', { retryable: false, refusal: { why: '道具の一覧にない名前だった', wouldWork: '一覧にある道具の名前で呼ぶ' } });
  }
  if (!tool.surfaces.includes(context.surface)) {
    return toolFailure('not_offered', `${tool.name} はここでは使えない。`, { retryable: false, refusal: { why: 'この場面では出していない道具', wouldWork: '使える場面で呼ぶ' } });
  }
  if (!tool.audiences.includes(context.audience)) {
    return toolFailure('not_offered', `${tool.name} は、ライ氏と二人だけの時にしか使わない。`, {
      retryable: false, refusal: { why: 'ライ氏以外の人がこの返事を見聞きできる', wouldWork: 'ライ氏と二人だけになった時に使う（中身はこの場では話さない）' },
    });
  }
  return null;
}

/** How far her Aether tools reach in this call: the owner's documents too, or only her folder (her study is inside it). */
export function aetherReach(context: Pick<ToolCallContext, 'surface' | 'audience'>): 'everything' | 'shannon_folder' {
  return context.audience === 'owner_alone' && context.surface !== 'autonomy' ? 'everything' : 'shannon_folder';
}

/** The input of a call, after its schema: with anyone else present, or in her own time, a search names her folder or her study. */
export function authorizeToolInput(tool: ShannonToolDefinition, input: ToolInput, context: ToolCallContext): ToolResult | null {
  if (tool.name !== 'aether.search' || aetherReach(context) === 'everything' || input.scope === 'shannonFolder' || input.scope === 'study') return null;
  const why = context.surface === 'autonomy' ? '自分の時間には、ライ氏の文書は探さない' : 'ライ氏以外の人がこの返事を見聞きできるので、ライ氏の文書は探さない';
  return toolFailure('refused', 'ここでは、シャノン用フォルダの外は探さない。', { retryable: false, refusal: { why, wouldWork: 'scope を shannonFolder か study にして呼び直す（ライ氏の文書は二人だけの会話で）' } });
}

/**
 * The Aether client an executor of this call is handed. While the reach is her folder only, a search is held to her folder
 * or her study and keeps only hits placed there, and a read first asks for one character to see where the document is,
 * so that nothing of a document outside her folder is returned.
 */
export function gatedAether(access: AetherAccess, context: Pick<ToolCallContext, 'surface' | 'audience'>): AetherAccess {
  if (aetherReach(context) === 'everything') return access;
  const placed = (inShannonFolder: boolean) => { if (!inShannonFolder) throw new AetherAccessError('OUTSIDE_AUDIENCE'); };
  return Object.freeze({
    search: async (input, signal) => (await access.search({ ...input, scope: input.scope === 'study' ? 'study' as const : 'shannonFolder' as const }, signal))
      // Placed in her folder, and for her study also tagged 書斎 there: a hit missing either is dropped.
      .filter(hit => hit.inShannonFolder === true && (input.scope !== 'study' || hit.inStudy === true)),
    read: async (input, signal) => {
      placed((await access.read({ documentId: input.documentId, offset: 0, maxChars: 1 }, signal)).inShannonFolder);
      const document = await access.read(input, signal);
      placed(document.inShannonFolder);
      return document;
    },
    list: signal => access.list(signal),
    create: (input, signal) => access.create(input, signal),
    update: (input, signal) => access.update(input, signal),
    delete: (input, signal) => access.delete(input, signal),
  } satisfies AetherAccess);
}

/** What `authorizeAutonomousAction` is asked for one call in her own time. */
export function toolGateRequest(
  tool: ShannonToolDefinition, summary: string,
  folder?: Pick<AutonomousActionRequest, 'host' | 'relativePath' | 'pathKind' | 'toRelativePath'>,
): AutonomousActionRequest {
  return { domain: tool.domain, summary, tool: tool.name, ...(tool.domain === 'host_folder' && folder ? folder : {}) };
}

/** A decision of the autonomy gate that did not allow the call, as a tool result she can act on. */
export function toolRefusal(decision: Pick<AutonomyDecision, 'reason' | 'explanation'>): ToolResult {
  const refused = (why: string, wouldWork: string, retryable = false) =>
    toolFailure('refused', decision.explanation, { retryable, refusal: { why, wouldWork } });
  switch (decision.reason) {
    case 'paused': return refused('ライ氏が自分の時間の活動を一時停止している', 'ライ氏が再開したあと');
    case 'disabled': return refused('自分から動く仕組みがサーバーで切られている', 'ライ氏が仕組みを入れたあと');
    case 'budget_exhausted': return toolFailure('limit', decision.explanation, { retryable: false, refusal: { why: '今日の予算が残っていない', wouldWork: '明日か、ライ氏が予算を足したあと' } });
    case 'access_limit': return toolFailure('limit', decision.explanation, { retryable: false, refusal: { why: '今日の回数の上限に達した', wouldWork: '明日' } });
    case 'unknown_host': return toolFailure('unavailable', decision.explanation, { retryable: false, refusal: { why: 'PCのフォルダを受け持つ端末が登録されていない', wouldWork: 'ライ氏がPCを登録したあと' } });
    case 'malformed_request': return toolFailure('invalid_input', decision.explanation, { retryable: false, refusal: { why: '依頼の形かパスが決まりに合わない', wouldWork: '決まりに合うパスや入力で呼び直す' } });
    default: return refused('決められた範囲の外', 'ライ氏に提案して承認をもらう');
  }
}
