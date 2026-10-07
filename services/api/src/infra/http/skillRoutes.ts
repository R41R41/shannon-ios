import type { IncomingMessage, ServerResponse } from 'node:http';
import { SHANNON_AUTONOMY_SYSTEM_DOMAIN } from '@shannon/cognition';
import type { AutonomyActivityRecord } from '../../mind/inhibition/store/autonomyActivity.js';
import { autonomyDayKey, type AutonomyConfig } from '../../mind/inhibition/autonomyBudget.js';
import { SKILL_CAPACITY, SKILL_LIFECYCLE, type SkillMemory, type StoredSkill } from '../../mind/memory/memoryPorts.js';
import { sendJson } from './serverHttp.js';

/**
 * The owner's view and controls of her skills, for the app's 学び tab (Syzygy ADR-0008 stage 2, review scope gap;
 * `docs/skill-and-routing-contract.md`, 「ライ氏の学びの画面」). Core: approval and budget (the owner's controls), memory.
 *
 * - `GET /v1/autonomy/skills`: the index's usage against its capacity, and each skill (retired ones too): status, version, whether
 *   it is pinned, on trial (the version a failed trial returns to, its uses so far of three), the owner's version, its uses and
 *   successes, and where its copy is.
 * - `GET /v1/autonomy/skills/{id}`: one skill with its SKILL.md, its versions (actor, reason, lineage) and its audit; a skill retired
 *   because a source was forgotten, or whose copy was withdrawn, without its body (`HIDDEN_BODY`, review N4), and, here and in the
 *   list, without its name and description (`HIDDEN_TITLE`, `hidden: true`).
 * - `POST /v1/autonomy/skills/{id}/pin` and `/unpin`: the sleep never writes to a pinned skill (a patch, a branch, a rollback, a
 *   retirement, a consolidation); unpinned, it may again.
 *
 * Only a paired device of the owner's scope. Each pin and unpin is written to the activity record as an owner control.
 */
export const SKILLS_PATH = '/v1/autonomy/skills';

export function isSkillsPath(path: string): boolean {
  return path === SKILLS_PATH || path.startsWith(`${SKILLS_PATH}/`);
}

export type OwnerSkillRecorder = (scopeKey: string, action: 'pin' | 'unpin', skillId: string, at: string) => void;

export interface SkillsRouteDependencies {
  /** Null while her skills are switched off. */
  memory: Pick<SkillMemory, 'ready' | 'store' | 'write'> | null;
  record: OwnerSkillRecorder;
  ownerScopeKey: string;
  now: () => string;
}

/** Writes an owner's pin or unpin to the activity record (what was done, and the skill's id; no content). */
export function ownerSkillRecorder(activity: Pick<AutonomyActivityRecord, 'append'>, config: Pick<AutonomyConfig, 'timeZone'>): OwnerSkillRecorder {
  return (scopeKey, action, skillId, at) => {
    activity.append(scopeKey, autonomyDayKey(at, config), at, {
      kind: 'control', actor: 'owner', domain: SHANNON_AUTONOMY_SYSTEM_DOMAIN.id, outcome: 'recorded', approval: 'not_needed',
      tool: `skills.${action}`, reasonCode: `skills_${action}`, detail: skillId,
      summary: action === 'pin' ? '所有者がスキルを固定しました。眠っている間の見直しは、このスキルを変えません。' : '所有者がスキルの固定を外しました。',
    });
  };
}

/** What the 学び tab shows in place of a body that may no longer be shown. */
export const HIDDEN_BODY = '（このスキルの本文は表示しません。元にした会話が忘れられたか、写しを取り下げたためです）';
/**
 * What the 学び tab shows in place of the name and the description of such a skill (independent review of the 学び tab,
 * 2026-10-07): they were written from the same sources as the body, so they are withheld with it.
 */
export const HIDDEN_TITLE = '（表示しないスキル）';

function hidden(skill: StoredSkill): boolean {
  return skill.statusReason === 'source_forgotten' || skill.exportHold === 'withdrawn';
}

function summary(skill: StoredSkill): Record<string, unknown> {
  const settled = skill.uses.filter(use => use.o !== null);
  const trial = skill.status === 'trial' ? { baseVersion: skill.trialBaseVersion, uses: settled.filter(use => use.v === skill.version).length, of: SKILL_LIFECYCLE.trialUses } : null;
  const withheld = hidden(skill);
  return {
    id: skill.skillId, name: withheld ? HIDDEN_TITLE : skill.name, description: withheld ? HIDDEN_TITLE : skill.description, hidden: withheld,
    status: skill.status, statusReason: skill.statusReason, version: skill.version,
    pinned: skill.pinned, ownerVersion: skill.madeBy === 'owner_edit', trial, uses: settled.length, successes: settled.filter(use => use.o === 1).length,
    copy: skill.aetherDocumentId ? { documentId: skill.aetherDocumentId, hold: skill.exportHold } : null, createdAt: skill.createdAt, updatedAt: skill.updatedAt,
  };
}

export function createSkillsRoute(dependencies: SkillsRouteDependencies) {
  return async (request: IncomingMessage, response: ServerResponse, principal: { scopeKey: string } | null, path: string): Promise<void> => {
    if (!principal) return sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED' });
    if (principal.scopeKey !== dependencies.ownerScopeKey) return sendJson(response, 403, { error: 'SKILLS_OWNER_ONLY' });
    const memory = dependencies.memory;
    if (!memory || !memory.ready()) return sendJson(response, 403, { error: 'SKILLS_DISABLED', message: 'Her skills are switched off on the server.' });
    const scopeKey = principal.scopeKey;
    if (path === SKILLS_PATH) {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      const all = memory.store.all(scopeKey, { includeRetired: true });
      return sendJson(response, 200, { capacity: { used: all.filter(skill => skill.status !== 'retired').length, limit: SKILL_CAPACITY }, skills: all.map(summary) });
    }
    const match = /^\/v1\/autonomy\/skills\/([A-Za-z0-9][A-Za-z0-9_:-]{0,119})(?:\/(pin|unpin))?$/u.exec(path);
    if (!match) return sendJson(response, 404, { error: 'NOT_FOUND' });
    const [, skillId, action] = match;
    const skill = memory.store.get(scopeKey, skillId!);
    if (!skill) return sendJson(response, 404, { error: 'SKILL_NOT_FOUND' });
    if (!action) {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return sendJson(response, 200, {
        // Review N4: a skill built from something forgotten, or whose copy was withdrawn, is shown without its body.
        ...summary(skill), ...(hidden(skill) ? { body: HIDDEN_BODY, bodyHidden: true } : { body: skill.body, bodyHidden: false }),
        versions: memory.store.revisions(scopeKey, skill.skillId).map(item => ({ version: item.version, kind: item.kind, actor: item.actor, reason: item.reason,
          parent: item.parentRevisionId, restores: item.variantOf, uses: item.uses, successes: item.successes, createdAt: item.createdAt })),
        audit: memory.store.audits(scopeKey).filter(entry => entry.skillId === skill.skillId).map(entry => ({ kind: entry.kind, status: entry.status, reason: entry.reason,
          fromVersion: entry.fromVersion, toVersion: entry.toVersion, baselineRate: entry.baselineRate, trialUses: entry.trialUses, trialSuccesses: entry.trialSuccesses,
          lint: entry.lint, proposedAt: entry.proposedAt, decidedAt: entry.decidedAt })),
      });
    }
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    const at = dependencies.now();
    memory.write(at, () => { memory.store.setPinned(scopeKey, skill.skillId, action === 'pin'); });
    try { dependencies.record(scopeKey, action as 'pin' | 'unpin', skill.skillId, at); } catch (error) { console.error('Shannon skill control record failed', error instanceof Error ? error.name : 'unknown'); }
    return sendJson(response, 200, summary(memory.store.get(scopeKey, skill.skillId) ?? skill));
  };
}
