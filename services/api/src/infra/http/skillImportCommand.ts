import type { SkillImporter, SkillPack } from '../../mind/memory/memoryPorts.js';
import type { SkillImportReceipt } from '../../mind/memory/skillImportContract.js';

/** What one skill import command needs: the one importer and the app-owned packs (`standardSkillPack`). */
export interface SkillImportCommandDeps {
  memory: { ready(): boolean } | null;
  importer?: SkillImporter | null;
  pack?: (packId: string, revision: string) => SkillPack | null;
  now(): string;
}
export type SkillImportPhase = 'dry-run' | 'apply';
export interface SkillImportCommandResult {
  status: number; body: unknown; at: string;
  /** The receipt of a pack this command imported now (not an idempotent retry): the caller records who adopted it. */
  applied: SkillImportReceipt | null;
}

/**
 * One owner skill import, dry-run or apply. The owner's paired route (`POST /v1/autonomy/skills/import/*`, `skillRoutes.ts`) and
 * the operator's socket command (`opsCli.ts skills import`, `operatorMinecraftWiring.ts`) both run exactly this. It uses the same
 * importer, with the same validation, capacity check, transaction and immutable receipt, and gives the same status and body.
 * Nothing else imports a skill pack.
 */
export function runSkillImport(deps: SkillImportCommandDeps, scopeKey: string, phase: SkillImportPhase, raw: unknown): SkillImportCommandResult {
  const at = deps.now();
  const answer = (status: number, body: unknown, applied: SkillImportReceipt | null = null) => ({ status, body, at, applied });
  if (!deps.memory || !deps.memory.ready()) return answer(403, { error: 'SKILLS_DISABLED', message: 'Her skills are switched off on the server.' });
  if (!deps.importer || !deps.pack) return answer(403, { error: 'SKILL_IMPORT_DISABLED' });
  const command = importCommand(raw, phase);
  if (!command) return answer(400, { error: 'INVALID_SKILL_IMPORT' });
  const pack = deps.pack(command.packId, command.revision);
  if (!pack) return answer(404, { error: 'SKILL_PACK_NOT_FOUND' });
  if (!command.apply) return answer(200, deps.importer.dryRun(scopeKey, pack));
  const result = deps.importer.apply(scopeKey, pack, command.apply, at);
  if ('rejected' in result) return answer(409, result);
  return answer(200, result, result.idempotent ? null : result.receipt);
}

/** The command's fields, or null when one the phase needs is not a string (the importer validates their form). */
function importCommand(raw: unknown, phase: SkillImportPhase)
  : { packId: string; revision: string; apply: { planHash: string; approvalReference: string } | null } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const command = raw as Record<string, unknown>;
  if (typeof command.packId !== 'string' || typeof command.revision !== 'string') return null;
  if (phase === 'dry-run') return { packId: command.packId, revision: command.revision, apply: null };
  if (typeof command.planHash !== 'string' || typeof command.approvalReference !== 'string') return null;
  return { packId: command.packId, revision: command.revision, apply: { planHash: command.planHash, approvalReference: command.approvalReference } };
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/**
 * The import endpoint under a server's base URL, keeping its path (`https://sh4nnon.com/companion` →
 * `https://sh4nnon.com/companion/v1/autonomy/skills/import/dry-run`). Only HTTPS, or HTTP on the loopback, without credentials.
 */
export function skillImportEndpoint(base: string, phase: SkillImportPhase): URL {
  const url = new URL(base);
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.includes(url.hostname));
  if (url.username || url.password || !secure) {
    throw new Error('Use HTTPS or a local HTTP server without URL credentials');
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/v1/autonomy/skills/import/${phase}`;
  url.search = '';
  url.hash = '';
  return url;
}
