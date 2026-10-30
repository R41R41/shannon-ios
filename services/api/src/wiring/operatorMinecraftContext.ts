import { HOUR_MS, STATUS, ago, MESSAGES } from './operatorMinecraftWords.js';
import type { OperatorActivity, OperatorMinecraftParts } from './operatorMinecraftWords.js';
import { randomUUID } from 'node:crypto';
import { ACTION_TERMINAL } from '@shannon/mind';
import {
  auditedArguments,
  operatorLabel,
  parseOperatorEnvelope,
  OPERATOR_LIMITS,
  type OperatorCode,
  type OperatorReply,
} from '../contracts/operatorContract.js';
import type { OperatorAuditDraft } from '../infra/ops/store/operatorAuditStore.js';
import { observeSync, withObserverRunSync } from '../infra/observer/observerContext.js';

export function createOperatorContext(parts: OperatorMinecraftParts) {
  const audit = (draft: Omit<OperatorAuditDraft, 'scopeKey'>) => parts.audit.append({ ...draft, scopeKey: parts.scopeKey });

  const flood = { suppressed: 0, lastRowAt: 0 };

  /**
   * Past `invocationsPerHour` invocations in the last hour, nothing is audited one by one: one coalesced `flooded` row a minute
   * says how many were turned away, and the owner's activity record is not written at all (a runaway process cannot flood it).
   */
  function flooded(at: string, operator: string): { status: number; body: unknown } | null {
    if (parts.audit.invocationsSince(parts.scopeKey, ago(at, HOUR_MS)) < OPERATOR_LIMITS.invocationsPerHour) return null;
    flood.suppressed += 1;
    if (Date.parse(at) - flood.lastRowAt >= OPERATOR_LIMITS.floodRowMs) {
      audit({
        operationId: `operator:${randomUUID()}`,
        at,
        operator,
        command: 'unknown',
        event: 'refused',
        code: 'flooded',
        argsJson: '{}',
        detail: `suppressed=${flood.suppressed}`,
      });
      flood.suppressed = 0;
      flood.lastRowAt = Date.parse(at);
    }
    return { status: 429, body: { outcome: 'refused', code: 'flooded', message: MESSAGES.flooded } };
  }

  /** A refusal reaches the activity record only for the first few an hour; one line says the rest are in the audit only. */
  function recordRefusal(at: string, entry: OperatorActivity): void {
    const count = parts.audit.refusalsSince(parts.scopeKey, ago(at, HOUR_MS));
    if (count <= OPERATOR_LIMITS.refusalsRecordedPerHour) parts.activity(at, entry);
    else if (count === OPERATOR_LIMITS.refusalsRecordedPerHour + 1) {
      parts.activity(at, {
        ...entry,
        summary: '運用者のマイクラ操作の拒否が続いているので、この1時間の残りは監査記録だけに残します。',
        reasonCode: 'operator_refusals_coalesced',
      });
    }
  }

  const observed = <T,>(operation: string, operationId: string, work: () => T): T =>
    withObserverRunSync({ scopeKey: parts.scopeKey, surface: 'operator_cli', audience: parts.ownerAlone() ? 'owner' : 'others' }, () =>
      observeSync('taskHub', { operation, via: 'operator_cli', operationId }, work, (value) => ({
        operation,
        outcome: value === null ? 'none' : 'returned',
      })),
    );

  async function minecraftActionLive(): Promise<boolean> {
    if (!parts.actions) return false;
    const views = await parts.actions.list(parts.scopeKey);
    return views.some((view) => view.kind === 'minecraft' && !ACTION_TERMINAL.includes(view.state));
  }

  function context(value: unknown) {
    const operationId = `operator:${randomUUID()}`,
      at = parts.now(),
      parsed = parseOperatorEnvelope(value);
    const operator = parsed.ok ? parsed.operator : operatorLabel((value as { operator?: unknown } | null)?.operator);
    const command = parsed.ok ? parsed.input.command : 'unknown';
    const argsJson = auditedArguments(value);
    const reply = (outcome: OperatorReply['outcome'], code: OperatorCode, message: string, extra: Partial<OperatorReply> = {}) => ({
      status: outcome === 'accepted' ? 202 : (STATUS[code] ?? 409),
      body: { operationId, outcome, code, message, ...extra },
    });
    const refuse = (code: OperatorCode, message = MESSAGES[code] ?? code, extra: Partial<OperatorAuditDraft> = {}) => {
      audit({ operationId, at: parts.now(), operator, command, event: 'refused', code, argsJson, detail: message, ...extra });
      recordRefusal(at, {
        summary: `運用者（${operator}）のマイクラ操作を受け付けませんでした。`,
        tool: `operator.minecraft.${command}`,
        outcome: 'refused',
        reasonCode: code,
        detail: `operation=${operationId}`,
      });
      return reply('refused', code, message);
    };
    return { operationId, at, parsed, operator, command, argsJson, reply, refuse };
  }
  return { audit, flood, flooded, recordRefusal, observed, minecraftActionLive, context };
}

export type OperatorContext = ReturnType<ReturnType<typeof createOperatorContext>['context']>;
