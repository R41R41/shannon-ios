import type { AutonomyLoopCycle, AutonomyPlannedStep } from './autonomyLoopState.js';
import type { PreparedStep, StepDependencies } from './autonomyLoopSteps.js';

/**
 * The step 「自分のフォルダに写しを置く」: she queues a copy of one study piece for her folder
 * on the owner's PC or Mac. No model is called and nothing is sent from here; the bound
 * device pulls the step later, and that hand-out asks the gate again.
 *
 * Null when there is nothing to copy: no host with a bound device, today's count used up,
 * an unknown piece, or a story she has not called 「見せてもいい」. Such a step is skipped unasked.
 */
export function prepareFolderCopy(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep, at: string): PreparedStep | null {
  const copy = dependencies.service.folder.nextCopy(cycle.scopeKey, at, step.pieceId);
  if (!copy) return null;
  const place = `自分のフォルダ（${copy.host}）`;
  return {
    request: {
      domain: 'host_folder', host: copy.host, relativePath: copy.relativePath, tool: 'folder.copy',
      summary: `書斎の${copy.kindLabel}の写しを1つ、${place}に置く用意をします。`,
    },
    async perform(adapters) {
      const folder = adapters.folder;
      if (!folder) return { outcome: 'failed', summary: 'フォルダに渡す道具が渡されなかったため、用意しませんでした。' };
      return {
        outcome: 'done', link: `shannon-study://${copy.pieceId}`,
        summary: `${copy.kindLabel}「${clip(copy.title, 60)}」の写しを、${place}に置く用意をしました。端末が受け取ると「${copy.relativePath}」に置かれます。`,
        commit: (_remaining, commitAt) => { folder.enqueue(cycle.scopeKey, copy, commitAt); },
      };
    },
  };
}

function clip(value: string, maximum: number): string {
  const line = value.replace(/\s+/gu, ' ').trim();
  return line.length > maximum ? `${line.slice(0, maximum - 1)}…` : line;
}
