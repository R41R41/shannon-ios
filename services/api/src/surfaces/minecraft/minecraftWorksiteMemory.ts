import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { lifeViewOf } from './minecraftMadeIn.js';
import { readPos } from './minecraftLlmcProbeInput.js';
type Position = { x: number; y: number; z: number };
interface Worksite {
  bodyId: string; life: number; dimension: string; sequence: number; at: number;
  target: Position; stand: Position; retreat: Position;
}
function readSaved(saved: unknown): Worksite | null {
  if (!saved || typeof saved !== 'object') return null;
  const v = saved as Worksite;
  return typeof v.bodyId === 'string' && Number.isSafeInteger(v.life) && typeof v.dimension === 'string'
    && Number.isSafeInteger(v.sequence) && Number.isFinite(v.at) && readPos(v.target) && readPos(v.stand) && readPos(v.retreat) ? v : null;
}
/** A requested return destination is remembered as a candidate, never as an enduring safety certificate. */
export function createWorksiteMemory(saved: unknown) {
  let value = readSaved(saved);
  return {
    remember(result: string | undefined, frame: BodyObservation | null): void {
      const life = lifeViewOf(frame);
      if (!frame || !life || !result) return;
      let probe;
      try { probe = JSON.parse(result); } catch { return; }
      const at = Date.parse(probe.evidence?.observedAt), target = readPos(probe.target?.at);
      const stand = readPos(probe.standCandidates?.[0]?.at), retreat = readPos(probe.retreat?.to);
      if (probe.kind !== 'worksite' || probe.evidence?.life !== life.life || probe.evidence?.dimension !== life.dimension) return;
      if (!target || !stand || !retreat || !Number.isFinite(at) || Math.abs(Date.parse(frame.stateAt) - at) > 20000) return;
      value = { bodyId: frame.bodyId, life: life.life, dimension: life.dimension, sequence: frame.sequence, at, target, stand, retreat };
    },
    read(frame: BodyObservation | null): string[] {
      const life = lifeViewOf(frame);
      if (!value || !frame?.connected || !life || frame.sequence < value.sequence) return [];
      if (value.bodyId !== frame.bodyId || value.life !== life.life || value.dimension !== life.dimension) {
        value = null;
        return [];
      }
      const at = (p: Position) => `(${p.x},${p.y},${p.z})`;
      return [`前回の作業場照会: 対象${at(value.target)}・立ち位置${at(value.stand)}・帰還先候補${at(value.retreat)}。`
        + `観測${value.sequence}時点の記録。施工・水流・落下で変わるため、現在の帰路は再確認が必要`];
    },
    checkpoint: () => ({ minecraftWorksite: value ? { ...value } : null }),
  };
}
