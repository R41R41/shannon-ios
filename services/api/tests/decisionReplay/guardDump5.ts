import { readFileSync, writeFileSync } from 'node:fs';
import { loadAllRuns, dataFile } from './allRuns.js';
import { candFrame } from './candidateAdapter.js';
import { candidateInput } from '../../src/surfaces/minecraft/minecraftLlmcV2.js';
import { llmcPrepare } from '../../src/surfaces/minecraft/minecraftLlmc.js';
import { checkedStopIf } from '../../src/surfaces/minecraft/minecraftLlmcStopIf.js';
import { heldOfFrame } from '../../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { decisionOf, loadScenes } from './score.js';
import { frames } from './sceneSet.js';
import { latest, readRows } from './views5.js';

/**
 * 候補の守りが止めた答えを 1 つずつ、守りが見た地図（直前の act の終わりの地図）・足・止めた手・返した事実と並べて出す（誤って止めたかを人が読むため）。
 *   node --import tsx tests/decisionReplay/guardDump5.ts s15,s56 出力ファイル
 */
const wanted = (process.argv[2] ?? '').split(',').filter(Boolean);
const out = process.argv[3] ?? dataFile('guard-dump5.txt');
const runs = loadAllRuns();
const rows = latest(readRows()).filter(row => row.variant === 'cand' && (row as { sent?: { guard?: unknown } }).sent?.guard);
let text = '';
for (const scene of loadScenes()) {
  if (wanted.length && !wanted.includes(scene.id.slice(0, 3))) continue;
  for (const row of rows.filter(item => item.scene === scene.id)) {
    const decision = decisionOf(runs, scene), frame = candFrame(decision, frames(runs, decision.run.key));
    const world = frame.state.world as { position: unknown; localMap?: string; health: number };
    const prepared = llmcPrepare('mc.act', candidateInput('mc.act', (row as { rawFirst?: unknown }).rawFirst));
    const held = heldOfFrame(checkedStopIf(prepared.input, frame).input, frame, `replay-${row.scene}-${row.rep}`);
    text += `\n\n######## ${scene.id} 回${row.rep}\nSITUATION: ${scene.situation}\nHINDSIGHT: ${scene.hindsight}\n足: ${JSON.stringify(world.position)} 体力 ${world.health}\n`;
    text += `モデルの 1 回目の答え（短い書き方）: ${JSON.stringify((row as { rawFirst?: unknown }).rawFirst)}\n`;
    text += `守り: 手 ${held?.hand} ${held?.code}\n返した事実: ${held?.line}\n`;
    text += `守りが見た地図:\n${world.localMap ?? '(なし)'}\n`;
  }
}
writeFileSync(out, text);
console.log('wrote', out, text.length, readFileSync(out, 'utf8').length);
