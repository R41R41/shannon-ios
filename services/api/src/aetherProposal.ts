import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export type AetherProposalOperation = 'new-note' | 'append';

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

  create(_scopeKey: string, input: AetherProposalInput): AetherProposal {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const pendingCount = readdirSync(this.directory, { withFileTypes: true })
      .filter(item => item.isFile() && item.name.endsWith('.json')).length;
    if (pendingCount >= 100) throw new Error('AETHER_PROPOSAL_QUEUE_FULL');
    const targetNoteId = input.targetNoteId?.trim();
    const expectedUpdatedAt = input.expectedUpdatedAt?.trim();
    if (Boolean(targetNoteId) !== Boolean(expectedUpdatedAt)) throw new Error('INVALID_AETHER_PROPOSAL');
    if (expectedUpdatedAt && !Number.isFinite(Date.parse(expectedUpdatedAt))) throw new Error('INVALID_AETHER_PROPOSAL');
    const content = boundedContent(input.content, 6_000);
    if (!content) throw new Error('INVALID_AETHER_PROPOSAL');
    const proposal: AetherProposal = {
      id: randomUUID(),
      operation: targetNoteId ? 'append' : 'new-note',
      title: compact(input.title ?? firstLine(content), 120) ?? 'Shannonからの提案',
      content,
      reason: compact(input.reason ?? 'Shannonとの会話から保存', 300) ?? 'Shannonとの会話から保存',
      ...(targetNoteId ? { targetNoteId: compact(targetNoteId, 160)!, expectedUpdatedAt: new Date(expectedUpdatedAt!).toISOString() } : {}),
      createdAt: new Date(this.now()).toISOString(),
    };
    const finalPath = join(this.directory, `${proposal.id}.json`);
    const temporary = join(this.directory, `.${basename(finalPath)}.${process.pid}`);
    try {
      writeFileSync(temporary, `${JSON.stringify(proposal)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      renameSync(temporary, finalPath);
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
