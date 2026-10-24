import { readFileSync } from 'node:fs';
import { dataFile } from './allRuns.js';
/** 実走38 の比べの答え（why と手の先頭）を場面・版ごとに並べる。`node --import tsx tests/decisionReplay/peek38.ts r38-base.jsonl r38-fix.jsonl` */
for (const file of process.argv.slice(2)) {
  for (const line of readFileSync(dataFile(file), 'utf8').split('\n').filter(Boolean)) {
    const row = JSON.parse(line) as Record<string, any>;
    const calls = (row.calls ?? row.answer?.calls ?? []) as Array<Record<string, any>>;
    const first = (row.rawFirst ?? row.raw ?? row.answer) as Record<string, any> | undefined;
    const text = JSON.stringify(calls.length ? calls.map(call => [call.name, call.input]) : first ?? row).slice(0, 420);
    console.log(`${row.variant} ${String(row.scene).slice(0, 3)} r${row.rep} ${text}`);
  }
}
