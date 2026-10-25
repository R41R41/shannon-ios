import { existsSync, readFileSync } from 'node:fs';
import { dataFile } from './allRuns.js';
import { loadScenes, type SceneFile } from './score.js';
import type { View } from './views5.js';
import type { Row2 } from './run2.js';

/**
 * 10/26 の「再現台で Sonnet を測る」の共通部品。版は 4 つ: O（Opus 5.5・今の main の形）、S（Sonnet 5.5・同じ形）、
 * N（Sonnet 5.5 で見えない考えを切る。`thinking: {type:"between_tools"}`。`disabled` はこのモデルが 400 で断る）、
 * S2（S の 2 つの答えを送る前の守りに通し、止められなかった方を使う。S の回の組から `makeS2.ts` が作る）。
 * 結果の行は run6.ts が data/sn-<版>.jsonl に書く（S2 だけ makeS2.ts）。
 */
export const SN_VARIANTS = ['O', 'S', 'N', 'S2'] as const;
export const SN_FILES = SN_VARIANTS.map(id => `sn-${id}.jsonl`);
export const VIEWS10: View[] = [
  { id: 'O', variant: 'O', transform: 'candidate', label: 'O: Opus 5.5（今の main の形）+ 頭の変換・守り' },
  { id: 'S', variant: 'S', transform: 'candidate', label: 'S: Sonnet 5.5（同じ形、考えは本番のまま adaptive・low）' },
  { id: 'N', variant: 'N', transform: 'candidate', label: 'N: Sonnet 5.5 で見えない考えを切る（between_tools）' },
  { id: 'S2', variant: 'S2', transform: 'candidate', label: 'S×2: Sonnet 2 つを並列に出し、守りで止められなかった方' },
];
export function readRows10(files: readonly string[] = SN_FILES): Row2[] {
  return files.flatMap(name => existsSync(dataFile(name)) ? readFileSync(dataFile(name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Row2) : []);
}
const sceneDir = (name: string) => new URL(`./${name}/`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
/** 60 場面（scenes/）と実走38 の場面（scenes-c/）のうち、結果の行がある場面。 */
export function scenes10(rows: readonly { scene: string }[]): SceneFile[] {
  const have = new Set(rows.map(row => row.scene));
  return [...loadScenes(sceneDir('scenes')), ...loadScenes(sceneDir('scenes-c'))].filter(scene => have.has(scene.id));
}
export interface S2Meta {
  reps: [number, number]; used: number; bothHeld: boolean; bothPassed: boolean;
  /** 使った方までの時間（ms）: 通った方の 1 回目の終わり。両方止められたら先に返った方の 1 回目 + その聞き直し。 */
  tUsed: number; tFirstBlock: number;
  /** 2 つの 1 回目の呼び出し（使う使わないに関わらず出した物）+ 使った方の聞き直しの分。 */
  firstUsages: [unknown, unknown]; reaskUsage?: unknown; costActual: number;
}
