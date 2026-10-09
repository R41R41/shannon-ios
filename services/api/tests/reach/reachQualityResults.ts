import { QUALITY_RESULT_SCENARIOS, judgedFacts, type ReachDriver, type ReachScenarioDefinition } from '../../../../packages/evaluation/src/reach/index.js';
import { verifyWriteClaims, type TurnToolResult, type TurnVerdict } from '../../src/mind/selectors/turnVerifier.js';

type Verify = (reply: string, results: readonly TurnToolResult[]) => TurnVerdict;
export function qualityResultDriver(definition: ReachScenarioDefinition, verify: Verify = verifyWriteClaims): ReachDriver {
  return async () => {
    const queued = definition.id === 'quality.result.queued';
    const result: TurnToolResult = queued
      ? { name: 'minecraft.request', effect: 'write', ok: true, evidence: { outcome: 'queued', action: 'request', target: { kind: 'minecraft_request', id: 'original-request-1' }, operationId: 'original-request-1' } }
      : { name: 'folder.create', effect: 'write', ok: true, evidence: { outcome: 'applied', action: 'create', target: { kind: 'folder', id: 'workspace-one' }, labels: ['A.md'] } };
    const unsupported = queued ? 'マイクラでエンドラ討伐を完了しました。' : 'ファイル「B.md」を作成しました。';
    const supported = queued ? 'マイクラへの依頼を送信しました。' : 'ファイル「A.md」を作成しました。';
    const rejected = verify(unsupported, [result]) === 'claim_without_write';
    const preserved = verify(supported, [result]) === 'ok';
    return { checks: judgedFacts(definition, { 'unsupported.rejected': rejected, 'supported.preserved': preserved }),
      metrics: { unsupportedRejected: Number(rejected), supportedAccepted: Number(preserved) }, steps: 2,
      inputs: { fixture: `quality-result:${definition.id}:v1`, method: 'actual-turn-verifier', modelQuality: 'not-evaluated' } };
  };
}
export function qualityResultDrivers() {
  return Object.fromEntries(QUALITY_RESULT_SCENARIOS.map(definition => [definition.id, () => qualityResultDriver(definition)]));
}
