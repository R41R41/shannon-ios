import { aetherErrorCode, type AetherAccess } from './aetherAccess.js';
import { AETHER_DOCUMENT_PREFIX } from './ownerInformedMarks.js';
import { DEFAULT_READ_CHARACTERS, NOT_CONFIGURED, aetherToolFailure, documentText, hitLines } from './shannonAetherTools.js';
import { numberInput, stringInput } from './shannonToolInput.js';
import type { PreparedToolCall, ToolExecutor, ToolRun } from './shannonToolTypes.js';
import { toolOk } from './shannonTools.js';

/**
 * The executors of `ownerDocs.search` and `ownerDocs.read` (owner decision 2026-10-06, Syzygy ADR-0007 「自分の時間に所有者の文書を
 * 読む」): her own time reads the owner's Aether documents, outside 「シャノン用フォルダ」, for one of her active pursuits.
 *
 * They are handed Aether as it is (`access`, not narrowed by `gatedAether`): the registry offers them on her own time only and with
 * the owner alone, the runner only while `SHANNON_AUTONOMY_OWNER_DOCUMENTS=on`, and the loop checks the pursuit
 * (`autonomyLoopToolStep.ts`). What she reads stays in the loop's memory until her next thought (「[道具の結果]」); a call that
 * read something of his says so (`documents.informs`), which marks the session (`autonomyLoopProvenance.ts`). The activity
 * record keeps a sentence and the document's address, never its title or text.
 */
export function ownerDocumentExecutors(access: AetherAccess | null): Readonly<Record<string, ToolExecutor>> {
  const reading = (summary: string, run: (aether: AetherAccess, signal?: AbortSignal) => Promise<ToolRun>): PreparedToolCall | typeof NOT_CONFIGURED => {
    if (!access) return NOT_CONFIGURED;
    return { summary, run: async signal => {
      try { return await run(access, signal); } catch (error) {
        return { result: aetherToolFailure(error), record: { summary: `${summary.replace(/。$/u, '')}としましたが、できませんでした。`, outcome: 'failed', reasonCode: `aether_${aetherErrorCode(error).toLowerCase()}` } };
      }
    } };
  };
  return Object.freeze({
    'ownerDocs.search': input => reading('ライ氏のAetherの文書を探します。', async (aether, signal) => {
      // His documents only: her folder is read with her own tools.
      const hits = (await aether.search({ query: stringInput(input, 'query')!, limit: numberInput(input, 'limit') ?? 5 }, signal)).filter(hit => hit.inShannonFolder !== true);
      return {
        result: toolOk(hits.length ? [`${hits.length}件:`, ...hits.map(hitLines)].join('\n') : '当てはまるところはなかった。'),
        record: { summary: `ライ氏のAetherの文書を探しました（${hits.length}件）。`, outcome: 'done' },
        // The excerpts are his words too.
        ...(hits.length ? { documents: { informs: true as const } } : {}),
      };
    }),
    'ownerDocs.read': input => reading('ライ氏のAetherの文書を1つ読みます。', async (aether, signal) => {
      const documentId = stringInput(input, 'documentId')!.trim();
      const sectionId = stringInput(input, 'sectionId')?.trim();
      const document = await aether.read(sectionId ? { documentId, sectionId } : {
        documentId, offset: numberInput(input, 'offset') ?? 0, maxChars: numberInput(input, 'maxChars') ?? DEFAULT_READ_CHARACTERS.autonomy!,
      }, signal);
      return {
        result: toolOk(documentText(document)),
        record: { summary: 'ライ氏のAetherの文書を1つ読みました。', outcome: 'done', link: `${AETHER_DOCUMENT_PREFIX}${encodeURIComponent(document.documentId)}` },
        documents: { informs: true },
      };
    }),
  });
}
