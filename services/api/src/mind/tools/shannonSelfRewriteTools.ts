import type { SelfRewriteCandidate, SelfRewriteRuntimePort } from '../inhibition/selfRewritePorts.js';
import { toolFailure, type ToolResult } from './shannonTools.js';
import type { ToolExecutor } from './shannonToolTypes.js';

/** Only offered in an already authorized own-time step; candidate data is never a permission. */
export function selfRewriteExecutors(port: SelfRewriteRuntimePort): Readonly<Record<string, ToolExecutor>> {
  const refused = () => toolFailure('refused', '元の作業の権限か検査を確かめられないため、適用しなかった。', { retryable: false });
  const candidate = (raw: unknown, scope: string): SelfRewriteCandidate | null => {
    try { const value = typeof raw === 'string' ? JSON.parse(raw) as SelfRewriteCandidate : null; return value?.scopeKey === scope ? value : null; }
    catch { return null; }
  };
  return {
    'workspace.inspect': (input, context) => {
      let paths: unknown; try { paths = JSON.parse(String(input.paths)); } catch { return refused(); }
      if (typeof input.workId !== 'string' || !Array.isArray(paths) || !paths.length || paths.length > 64 || paths.some(path => typeof path !== 'string')) return refused();
      return { summary: '隔離作業場の候補の基準を読んだ。', paths,
        run: async () => {
          const value = await port.inspect(context.scopeKey, String(input.workId), paths as string[]);
          const result: ToolResult = value ? { ok: true, text: JSON.stringify(value), retryable: false } : refused();
          return { result, record: { summary: '隔離作業場の候補の基準を確かめた。', outcome: result.ok ? 'done' : 'failed' } };
        } };
    },
    'workspace.rewrite': (input, context) => {
      const value = candidate(input.candidate, context.scopeKey); if (!value) return refused();
      return { summary: '元の作業の権限で、隔離作業場の候補を順に検査して適用する。', paths: Array.isArray(value.files) ? value.files.map(file => file.path) : [],
        run: async () => {
          const result = await port.execute(context.scopeKey, value);
          return { result: result.state === 'completed' ? { ok: true, text: '候補の検査と前後のsnapshotを確かめ、適用した。', retryable: false }
            : toolFailure(result.state === 'unknown' ? 'unavailable' : 'refused', `適用結果: ${result.state}（${result.gate}/${result.code}）。元の結果を確かめてから続ける。`, { retryable: false }),
            acknowledged: result.state !== 'unknown', record: { summary: `自己改修の候補を${result.state === 'completed' ? '適用した' : '保持した'}。`,
              outcome: result.state === 'completed' ? 'done' : 'failed', ...(result.state !== 'completed' ? { reasonCode: result.code } : {}) } };
        } };
    },
    'workspace.propose': (input, context) => {
      const value = candidate(input.candidate, context.scopeKey); if (!value) return refused();
      return { summary: '正確な候補の差分と基準を、既存の作業提案へ渡す。',
        run: async () => {
          const result = await port.propose(context.scopeKey, value);
          return { result: result ? { ok: true, text: `提案に記録した（proposalId: ${result.proposalId}）。適用はしていない。`, retryable: false } : refused(),
            record: { summary: '自己改修の候補を所有者への提案に記録した。', outcome: result ? 'done' : 'failed' } };
        } };
    },
  };
}
