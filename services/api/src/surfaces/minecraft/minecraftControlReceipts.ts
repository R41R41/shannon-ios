import { createHash } from 'node:crypto';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { MinecraftControlCommand, MinecraftControlReceipt, MinecraftControlPoll } from '../../contracts/minecraftControlContract.js';
import type { SettledEvent } from './minecraftControlState.js';
import type { MinecraftControlStore } from './store/minecraftControlStore.js';
interface ReceiptPorts {
  store: MinecraftControlStore;
  now(): number;
  settledListeners: Set<(event: SettledEvent) => void>;
  deliveries: Map<string, number>;
  images: Map<string, { dataUrl: string; expires: number }>;
  captureMisses: Map<string, { connectionId: string; at: number }>;
}
function receiptMatches(command: MinecraftControlCommand, receipt: MinecraftControlReceipt, bodyId: string): boolean {
  const invalidReflexReceipt = () =>
    command.kind === 'reflex' &&
    (!receipt.action ||
      receipt.action.schemaVersion !== 1 ||
      receipt.action.outcome !== receipt.outcome ||
      receipt.action.inputsReleased !== receipt.inputsReleased ||
      !receipt.action.evidenceId);
  if (invalidReflexReceipt()) return false;
  const invalidStopReceipt = () =>
    command.stop &&
    (!receipt.stop ||
      receipt.stop.inputsReleased !== receipt.inputsReleased ||
      !['stopped', 'unknown'].includes(receipt.stop.state) ||
      (receipt.stop.state === 'stopped' && !receipt.inputsReleased));
  if (invalidStopReceipt()) return false;
  const actionContextMismatch = () =>
    receipt.action &&
    (receipt.action.operationId !== command.operation?.operationId ||
      receipt.action.bodyId !== bodyId ||
      receipt.action.sessionId !== command.context.sessionId ||
      receipt.action.generation !== command.context.generation);
  if (actionContextMismatch()) return false;
  const stopContextMismatch = () =>
    receipt.stop &&
    (receipt.stop.requestId !== command.stop?.requestId ||
      receipt.stop.bodyId !== bodyId ||
      receipt.stop.sessionId !== command.context.sessionId ||
      receipt.stop.generation !== command.context.generation);
  if (stopContextMismatch()) return false;
  const unexpectedImage = () => receipt.image && command.kind !== 'capture';
  if (unexpectedImage()) return false;
  return true;
}
export function settlePollReceipts(ports: ReceiptPorts, input: MinecraftControlPoll, observation: BodyObservation): string[] {
  const bodyId = observation.bodyId;
  const acknowledged: string[] = [];
  for (const receipt of input.receipts) {
    const command = ports.store.command(receipt.id);
    if (!command || command.context.bodyId !== bodyId || command.connectionId !== input.connectionId) continue;
    if (!receiptMatches(command, receipt, bodyId)) continue;
    const change = ports.store.settleWith(receipt);
    if (!change.acked) continue;
    if (change.to && change.to !== change.from)
      for (const listener of ports.settledListeners)
        try {
          listener({ id: receipt.id, command, receipt, from: change.from, to: change.to });
        } catch {
          /* learning never fails a poll */
        }
    ports.deliveries.delete(receipt.id);
    acknowledged.push(receipt.id);
    const saveReceiptPicture = () => {
      let pictured = false;
      if (
        receipt.image &&
        receipt.outcome === 'completed' &&
        ports.now() - Date.parse(receipt.image.capturedAt) >= 0 &&
        ports.now() - Date.parse(receipt.image.capturedAt) <= 2500
      ) {
        const ref = `frame:${createHash('sha256').update(receipt.id).digest('hex')}`;
        const expires = ports.now() + 3000;
        ports.images.set(ref, { dataUrl: receipt.image.dataUrl, expires });
        observation.image = { ref, capturedAt: receipt.image.capturedAt, expiresAt: new Date(expires).toISOString() };
        pictured = true;
      }
      return pictured;
    };
    const pictured = saveReceiptPicture();
    if (command.kind === 'capture' && receipt.outcome !== 'cancelled') {
      if (pictured) ports.captureMisses.delete(bodyId);
      else ports.captureMisses.set(bodyId, { connectionId: input.connectionId, at: ports.now() });
    }
  }
  return acknowledged;
}
