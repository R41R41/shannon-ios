import { actionPermit } from '../../../infra/context/actionExecution.js';
import { actionResource } from '../../../contracts/actionThreadContract.js';
import type { StepDependencies, PreparedStep } from './autonomyLoopSteps.js';
import type { AutonomyLoopCycle, AutonomyPlannedStep } from './store/autonomyLoopState.js';
import type { ShowingOutcome } from './autonomyShowing.js';
import { shownLater } from './autonomyLoopProvenance.js';
import { clip } from './autonomyLoopStepText.js';

export function prepareShowing(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep): PreparedStep | null {
  const { store } = dependencies;
  const piece = step.pieceId ? store.study.get(cycle.scopeKey, step.pieceId) : null;
  if (!piece || piece.kind !== 'story' || (piece.status !== 'draft' && piece.status !== 'ready')) return null;
  return {
    request: { domain: 'owner_message', summary: '物語を1つ「見せてもいい」にして、持ち主に知らせます。', tool: 'study.show' },
    async perform(adapters, at) {
      if (!adapters.showing) return { outcome: 'failed', summary: '知らせる道具が渡されなかったため、見せませんでした。' };
      // Readable first, so the piece can be opened the moment the message arrives.
      await actionPermit([actionResource(cycle.scopeKey,'study')]);
      const ready = store.transaction(() => store.study.markReady(cycle.scopeKey, piece.id, at));
      if (typeof ready === 'string') return { outcome: 'failed', summary: '物語を「見せてもいい」にできませんでした。' };
      const revised = store.study.versions(cycle.scopeKey, piece.id).length > 1 && Boolean(piece.shownAt);
      let told: ShowingOutcome | 'others_present';
      // A story written after reading the owner's is not named in the Talk while anyone else may see it: told later (ADR-0007).
      if (shownLater(dependencies, cycle, piece.id, at)) told = 'others_present';
      else try { await actionPermit(); told = adapters.showing.tell(cycle.scopeKey, { id: piece.id, title: ready.title, version: ready.version, revised }, at); } catch { told = 'unavailable'; }
      const sent = told === 'sent' || told === 'already-told';
      return {
        outcome: 'done', link: `shannon-study://${piece.id}`, tool: sent ? 'study.show' : 'study.ready',
        summary: sent ? `物語「${clip(ready.title, 60)}」を持ち主に見せました。`
          : `物語「${clip(ready.title, 60)}」を「見せてもいい」にしました。知らせるのは、あとにします（${waitingReason(told)}）。`,
        // Syzygy ADR-0008 stage 1: whether and how the owner reacts is predicted when he is told (`StudyDesk.react` settles it).
        commit: (_remaining, commitAt) => { if (sent) { store.study.markShown(cycle.scopeKey, piece.id, commitAt); dependencies.prediction?.shown?.(cycle.scopeKey, { id: piece.id, revised }, commitAt); } },
      };
    },
  };
}

function waitingReason(outcome: ShowingOutcome | 'others_present'): string {
  switch (outcome) {
    case 'others_present': return 'ほかの人がいるため';
    case 'quiet-hours': return '夜の静かな時間のため';
    case 'recent-conversation': return '話している最中のため';
    case 'today-is-enough': return '今日はもう一度話しかけたため';
    case 'reserved-for-commitment': return '今日は約束の声かけを先にするため';
    case 'held': return '自分から話しかけるのを止められたため';
    default: return '今は知らせる場所がないため';
  }
}
