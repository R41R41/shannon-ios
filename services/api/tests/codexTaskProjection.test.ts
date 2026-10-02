import { describe, expect, it } from 'vitest';
import type { AgentHostConfig, AgentHostProject } from '../src/agentHostConfig.js';
import { deliveryInstructions, recoveryPrompt } from '../src/codexTaskProjection.js';

describe('cloud TestFlight task instructions', () => {
  const config = { deliveryMode: 'cloud-testflight' } as AgentHostConfig;

  it('treats an explicit delivery request as authorization for integration and push', () => {
    const instructions = deliveryInstructions(config, 'task-1').join('\n');
    expect(instructions).toContain('その依頼が対象変更の統合・push・配信を許可します');
    expect(instructions).toContain('実行時に同じ許可を再確認しないでください');
    expect(instructions).toContain('テスト成功前にmainへ統合またはpushしてはいけません');
    expect(instructions).toContain('配布を依頼されていない場合');
    expect(instructions).not.toContain('その操作時の承認が必要');
  });

  it('tells every task, on either kind of host, to leave the uncommitted changes of another task alone', () => {
    const local = { deliveryMode: 'local-device' } as AgentHostConfig;
    for (const each of [config, local]) {
      const instructions = deliveryInstructions(each, 'task-1').join('\n');
      expect(instructions).toContain('同じ作業ホストの他の作業（一時停止中の作業を含む）と共有しています');
      expect(instructions).toContain('破棄・stash・上書きをせず');
      expect(instructions).toContain('git worktree で別の作業ツリーを作って');
    }
  });

  it('retains that authorization after a host restart while renewing expired permission grants', () => {
    const project = { key: 'shannon', path: '/tmp/shannon' } satisfies AgentHostProject;
    const prompt = recoveryPrompt(project, config, 'task-1', true, 'TestFlightへ配信して');
    expect(prompt).toContain('明示的な配布依頼による統合・push・配信の許可は継続');
    expect(prompt).toContain('実際の権限昇格がまだ必要なら、新しい承認要求');
    expect(prompt).not.toContain('その操作時の承認が必要');
  });
});
