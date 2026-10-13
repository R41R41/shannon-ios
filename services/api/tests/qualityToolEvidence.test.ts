import { afterEach, describe, expect, it, vi } from 'vitest';
import { AetherAccessError } from '../src/integrations/aether/aetherAccess.js';
import type { ToolExecutionEvidence } from '../src/contracts/toolEvidenceContract.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { ShannonAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { conversationTools, turnToolResults, turnCompletedWriteReceipts } from '../src/mind/tools/shannonToolSession.js';
import { toolOk, toolResultForModel } from '../src/mind/tools/shannonTools.js';
import { withToolEvidence } from '../src/mind/tools/toolEvidence.js';
import { verifyWriteClaims, type TurnToolResult } from '../src/mind/selectors/turnVerifier.js';
import { turnDoing } from '../src/mind/action/respond/turnRouting.js';
import { TEXT_TURN_DEADLINE, TurnDeadline } from '../src/mind/action/respond/turnDeadline.js';
import { FakeAetherFolder } from './support/fakeAetherFolder.js';

const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const at = '2026-10-09T00:00:00.000Z';
function fixture() {
  vi.stubEnv('SHANNON_ADR8_STAGE2', 'on'); vi.stubEnv('SHANNON_TURN_VERIFY', 'on');
  const access = new FakeAetherFolder(), store = new SQLiteAutonomyStore(':memory:'); closers.push(() => store.close());
  const service = new ShannonAutonomyService({ store, config: configuredAutonomy({}), now: () => at, aether: { access, proposals: null } });
  const session = (alone = true) => conversationTools(service, 'owner', 'text', alone ? true : 'shared',
    { audience: { othersKnown: () => !alone, noteOthers() {} }, secrets: () => ({ carries: text => text.includes('private-target') }) },
    'thread\nAetherのシャノン用フォルダに文書を書いて', new TurnDeadline(TEXT_TURN_DEADLINE)).tools!;
  return { access, service, session };
}
function write(name: string, evidence: ToolExecutionEvidence, ok = true): TurnToolResult { return { name, effect: 'write', ok, evidence }; }
const folder = (id: string, outcome: ToolExecutionEvidence['outcome'] = 'applied'): ToolExecutionEvidence => ({
  outcome, action: 'update', target: { kind: 'folder', id: `owner-mac:${id}` }, labels: [id],
});
const lifecycle = (action = 'start', id = 'home'): ToolExecutionEvidence => ({ outcome: 'applied', action,
  target: { kind: 'minecraft_server', id }, operationId: 'original-operation', receiptId: 'original-operation' });

describe('bounded original tool evidence (Q02 / Q07)', () => {
  it('carries the actual Aether document/version before the next model round and matches only the explicit target', async () => {
    const f = fixture(), tools = f.session();
    const output = JSON.parse(await tools.call('aetherFolder_create', JSON.stringify({ title: '資料A', body: 'synthetic body' })));
    expect(output).toMatchObject({ ok: true, executionEvidence: { outcome: 'applied', action: 'create', target: { kind: 'aether_document', id: 'doc-1' }, revision: 1 } });
    expect(JSON.stringify(output.executionEvidence)).not.toContain('synthetic body');
    expect(output.executionEvidence.receiptId).toBeUndefined();
    const results = turnToolResults(tools);
    expect(verifyWriteClaims('Aetherの文書「資料A」を作成しました。', results)).toBe('ok');
    expect(verifyWriteClaims('Aetherの文書「資料B」を作成しました。', results)).toBe('claim_without_write');
    expect(f.access.writes).toEqual([{ kind: 'create', documentId: 'doc-1' }]);
  });

  it('keeps uncertain remote writes unknown and non-retryable in the model projection without inventing a receipt', async () => {
    const f = fixture(), tools = f.session();
    await f.access.create({ title: '資料A', body: 'before', idempotencyKey: 'seed' });
    const update = vi.spyOn(f.access, 'update').mockRejectedValue(new AetherAccessError('TIMEOUT'));
    const output = JSON.parse(await tools.call('aetherFolder_update', JSON.stringify({ documentId: 'doc-1', baseVersion: 1, body: 'after' })));
    expect(output).toMatchObject({ ok: false, retryable: false, executionEvidence: { outcome: 'unknown', target: { id: 'doc-1' } } });
    expect(output.executionEvidence.receiptId).toBeUndefined(); expect(update).toHaveBeenCalledTimes(1);
    expect(verifyWriteClaims('Aetherの文書「doc-1」を更新しました。', turnToolResults(tools))).toBe('claim_without_write');
    expect(f.access.documents.get('doc-1')!.body).toBe('before');
  });

  it('does not let a successful other file, lifecycle operation or cancellation certify the requested completion', () => {
    const results = [write('folder.update', folder('a.txt')), write('folder.update', folder('b.txt', 'failed'), false), write('minecraft.start', lifecycle())];
    expect(verifyWriteClaims('ファイル「a.txt」を更新しました。', results)).toBe('ok');
    expect(verifyWriteClaims('ファイル「b.txt」を更新しました。', results)).toBe('claim_without_write');
    expect(verifyWriteClaims('ファイル「a.txt」を更新しました。ファイル「b.txt」を更新しました。', results)).toBe('claim_without_write');
    expect(verifyWriteClaims('メモを保存しました。', [write('minecraft.start', lifecycle()), { name: 'study.create', effect: 'write', ok: false }])).toBe('claim_without_write');
    const cancelled = write('minecraft.cancel', { outcome: 'applied', action: 'cancel', target: { kind: 'minecraft_request', id: 'request-a' }, operationId: 'request-a' });
    expect(verifyWriteClaims('マイクラの採掘を停止しました。', [cancelled])).toBe('ok');
    expect(verifyWriteClaims('マイクラで採掘完了しました。', [cancelled])).toBe('claim_without_write');
    expect(verifyWriteClaims('マイクラで家を作成しました。', [write('minecraft.start', lifecycle())])).toBe('claim_without_write');
    expect(verifyWriteClaims('マイクラを起動しましたが、停止できませんでした。', [])).toBe('claim_without_write');
    expect(verifyWriteClaims('Aether文書を作成しましたが、更新できませんでした。', [])).toBe('claim_without_write');
    expect(verifyWriteClaims('マイクラのサーバーを起動しましたが、停止できませんでした。', [write('minecraft.start', lifecycle())])).toBe('ok');
  });

  it('distinguishes accepted requests/proposals from completion and requires the original lifecycle receipt', () => {
    const queued = write('minecraft.request', { outcome: 'queued', action: 'request', target: { kind: 'minecraft_request', id: 'request-a' }, operationId: 'request-a' });
    expect(verifyWriteClaims('マイクラに依頼を送りました。', [queued])).toBe('ok');
    for (const claim of ['マイクラで原木を集めました。', 'マイクラに依頼したファイルを作成しました。']) expect(verifyWriteClaims(claim, [queued])).toBe('claim_without_write');
    expect(turnDoing('action', 'マイクラで原木を集めました。', [queued], true)).toBe('described_not_done');
    const proposal = write('aether.propose', { outcome: 'queued', action: 'propose', target: { kind: 'aether_proposal', id: 'proposal-a' }, operationId: 'proposal-a' });
    expect(verifyWriteClaims('Aetherに提案を送りました。', [proposal])).toBe('ok');
    expect(verifyWriteClaims('Aetherの文書を更新しました。', [proposal])).toBe('claim_without_write');
    expect(verifyWriteClaims('Aetherに提案を送信しましたが、文書も更新しました。', [proposal])).toBe('claim_without_write');
    expect(verifyWriteClaims('マイクラのサーバー「home」を起動しました。', [write('minecraft.start', lifecycle())])).toBe('ok');
    expect(verifyWriteClaims('マイクラのサーバー「other」を起動しました。', [write('minecraft.start', lifecycle())])).toBe('claim_without_write');
    expect(verifyWriteClaims('マイクラのサーバー「home」をログインしました。', [write('minecraft.start', lifecycle())])).toBe('claim_without_write');
    // `minecraft.set_day` (2026-10-14): a claim of daytime matches only its own receipt.
    expect(verifyWriteClaims('マイクラのサーバー「home」を昼にしました。', [write('minecraft.set_day', lifecycle('set_day'))])).toBe('ok');
    expect(verifyWriteClaims('マイクラのサーバー「home」を昼にしました。', [write('minecraft.start', lifecycle())])).toBe('claim_without_write');
    expect(verifyWriteClaims('ワールドを昼にしました。', [write('minecraft.set_day', lifecycle('set_day'))])).toBe('ok');
    expect(verifyWriteClaims('ワールドを昼にしました。', [write('minecraft.start', lifecycle())])).toBe('claim_without_write');
    // Review P3-3: a start or stop verb wins over 「昼」.
    expect(verifyWriteClaims('昼にサーバーを起動しました。', [write('minecraft.start', lifecycle())])).toBe('ok');
    expect(verifyWriteClaims('昼にサーバーを起動しました。', [write('minecraft.set_day', lifecycle('set_day'))])).toBe('claim_without_write');
    const missing = lifecycle(); delete missing.receiptId;
    expect(verifyWriteClaims('マイクラのサーバーを起動しました。', [write('minecraft.start', missing)])).toBe('claim_without_write');
  });

  it('keeps private evidence out of others turns and refuses secret-bearing target labels before any write', async () => {
    const f = fixture(), others = f.session(false);
    const refused = JSON.parse(await others.call('aetherFolder_create', JSON.stringify({ title: 'private-target', body: 'synthetic' })));
    expect(refused).toMatchObject({ ok: false, failure: 'not_offered' }); expect(refused.executionEvidence).toBeUndefined();
    expect(JSON.stringify(refused)).not.toContain('private-target');
    const owner = f.session(), secret = JSON.parse(await owner.call('aetherFolder_create', JSON.stringify({ title: 'private-target', body: 'synthetic' })));
    expect(secret).toMatchObject({ ok: false, failure: 'refused' }); expect(secret.executionEvidence).toBeUndefined();
    expect(JSON.stringify(secret)).not.toContain('private-target'); expect(f.access.writes).toEqual([]);
  });

  it.each([{ SHANNON_ADR8_STAGE2: 'off' }, { SHANNON_TURN_VERIFY: 'off' }])('retains historical tool output bytes with %j', async switches => {
    const f = fixture(); for (const [name, value] of Object.entries(switches)) vi.stubEnv(name, value);
    const tools = f.session(), output = JSON.parse(await tools.call('aetherFolder_create', JSON.stringify({ title: '資料A', body: 'synthetic' })));
    expect(Object.keys(output)).toEqual(['ok', 'text', 'retryable']); expect(turnToolResults(tools)[0]!.evidence).toBeUndefined();
    expect(turnCompletedWriteReceipts(tools)[0]).toMatch(/^実行済み:/u);
    const bare = toolOk('accepted'), evidence = withToolEvidence(bare, { outcome: 'queued', action: 'request', target: { kind: 'minecraft_request', id: 'original' } });
    expect(toolResultForModel(evidence)).toBe(toolResultForModel(bare));
  });
});
