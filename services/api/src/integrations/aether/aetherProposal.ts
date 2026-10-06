import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/**
 * Proposals to change the owner's Aether documents, written to Aether's file inbox (`AETHER_SHANNON_PROPOSAL_DIR`).
 * v2 (`syzygy.aether-shannon-access.v1`, owner decision 2026-10-06) adds `update` (the whole new body, at most 60,000
 * characters) and `delete` (what is removed, at most 6,000), each against `targetNoteId` and `expectedUpdatedAt`; older
 * apps ignore them. Nothing here changes a document: the owner adopts or rejects each proposal in his apps.
 */
export type AetherProposalOperation = 'new-note' | 'append' | 'update' | 'delete';

export const AETHER_PROPOSAL_LIMITS = Object.freeze({ content: 6_000, updateContent: 60_000, fileBytes: 256 * 1024 });

export interface AetherProposal {
  id: string;
  operation: AetherProposalOperation;
  title: string;
  content: string;
  reason: string;
  targetNoteId?: string;
  expectedUpdatedAt?: string;
  createdAt: string;
}

export interface AetherProposalInput {
  requestKey?: string;
  /** v2: absent, a proposal with a target appends and one without is a new note (as before). */
  operation?: AetherProposalOperation;
  title?: string;
  content: string;
  reason?: string;
  targetNoteId?: string;
  expectedUpdatedAt?: string;
}

export interface AetherProposalStore {
  configured: boolean;
  create(scopeKey: string, input: AetherProposalInput): AetherProposal;
}

export class FileAetherProposalStore implements AetherProposalStore {
  readonly configured = true;
  private readonly directory: string;

  constructor(directory: string, private readonly now: () => string) {
    this.directory = resolve(directory);
  }

  create(scopeKey: string, input: AetherProposalInput): AetherProposal {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const requestHash = input.requestKey ? createHash('sha256').update(JSON.stringify([scopeKey, input.requestKey])).digest('hex') : undefined;
    // The operation joins the hash only when it is one of v2's, so a receipt written before v2 still matches its retry.
    const v2 = input.operation === 'update' || input.operation === 'delete';
    const inputHash = createHash('sha256').update(JSON.stringify([input.content, input.title, input.targetNoteId, input.expectedUpdatedAt, ...(v2 ? [input.operation] : [])])).digest('hex');
    const receiptPath = requestHash ? join(this.directory, `.${requestHash}.receipt`) : undefined;
    if (receiptPath && existsSync(receiptPath)) {
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { status: string; inputHash: string; proposal: AetherProposal };
      if (receipt.inputHash !== inputHash) throw new Error('AETHER_PROPOSAL_REQUEST_CONFLICT');
      if (receipt.status !== 'published') throw new Error('AETHER_PROPOSAL_OUTCOME_UNKNOWN');
      return receipt.proposal;
    }
    const pendingCount = readdirSync(this.directory, { withFileTypes: true })
      .filter(item => item.isFile() && item.name.endsWith('.json')).length;
    if (pendingCount >= 100) throw new Error('AETHER_PROPOSAL_QUEUE_FULL');
    const targetNoteId = input.targetNoteId?.trim();
    const expectedUpdatedAt = input.expectedUpdatedAt?.trim();
    if (Boolean(targetNoteId) !== Boolean(expectedUpdatedAt)) throw new Error('INVALID_AETHER_PROPOSAL');
    if (expectedUpdatedAt && !Number.isFinite(Date.parse(expectedUpdatedAt))) throw new Error('INVALID_AETHER_PROPOSAL');
    const operation: AetherProposalOperation = input.operation ?? (targetNoteId ? 'append' : 'new-note');
    if ((operation === 'new-note') === Boolean(targetNoteId)) throw new Error('INVALID_AETHER_PROPOSAL');
    const content = boundedContent(input.content, operation === 'update' ? AETHER_PROPOSAL_LIMITS.updateContent : AETHER_PROPOSAL_LIMITS.content);
    if (!content) throw new Error('INVALID_AETHER_PROPOSAL');
    const proposal: AetherProposal = {
      id: randomUUID(),
      operation,
      title: compact(input.title ?? firstLine(content), 120) ?? 'Shannonからの提案',
      content,
      reason: compact(input.reason ?? 'Shannonとの会話から保存', 300) ?? 'Shannonとの会話から保存',
      ...(targetNoteId ? { targetNoteId: compact(targetNoteId, 160)!, expectedUpdatedAt: new Date(expectedUpdatedAt!).toISOString() } : {}),
      createdAt: new Date(this.now()).toISOString(),
    };
    if (Buffer.byteLength(`${JSON.stringify(proposal)}\n`, 'utf8') > AETHER_PROPOSAL_LIMITS.fileBytes) throw new Error('INVALID_AETHER_PROPOSAL');
    const finalPath = join(this.directory, `${proposal.id}.json`);
    const temporary = join(this.directory, `.${basename(finalPath)}.${process.pid}`);
    try {
      // Reserve before publication. After a crash in the two-file handoff,
      // fail closed rather than enqueue a second externally consumable proposal.
      if (receiptPath) writeFileSync(receiptPath, JSON.stringify({ status: 'prepared', inputHash, proposal }), { flag: 'wx', mode: 0o600 });
      writeFileSync(temporary, `${JSON.stringify(proposal)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      renameSync(temporary, finalPath);
      if (receiptPath) {
        writeFileSync(temporary, JSON.stringify({ status: 'published', inputHash, proposal }), { flag: 'wx', mode: 0o600 });
        renameSync(temporary, receiptPath);
      }
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* Nothing was written. */ }
      throw error;
    }
    return proposal;
  }
}

export class DisabledAetherProposalStore implements AetherProposalStore {
  readonly configured = false;
  create(): AetherProposal { throw new Error('AETHER_PROPOSALS_NOT_CONFIGURED'); }
}

function compact(value: string, maximum: number): string | null {
  const result = value.replace(/\s+/g, ' ').trim();
  if (!result || result.length > maximum) return null;
  return result;
}

function boundedContent(value: string, maximum: number): string | null {
  const result = value.replace(/\r\n/g, '\n').trim();
  if (!result || result.length > maximum) return null;
  return result;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? value;
}
