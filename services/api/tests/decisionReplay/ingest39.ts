import { readFileSync, writeFileSync } from 'node:fs';
import { dataFile } from './allRuns.js';

/**
 * 10/26 の動作確認の実走（dragon26: エンドラを討伐して、task 8d0b7d3b）の控え（scratchpad の history.json・summaries.json・ops.json・task.json）を、
 * 台が読む `@@` の形（vm/export-history.sh と同じ）にして data/export5.txt に書く。道具の定義（core）は実走38 の物を借りる（この実走の控えには無い）。
 *   node --import tsx tests/decisionReplay/ingest39.ts <dragon26 のフォルダ>
 */
const dir = process.argv[2]!;
const read = (name: string) => JSON.parse(readFileSync(`${dir}/${name}`, 'utf8')) as any[];
const p = '8d0b7d3b';
const task = read('task.json')[0];
const out: string[] = [];
const line = (kind: string, value: unknown) => out.push(`@@${kind}\t${JSON.stringify(value)}`);
line('task', { p, task: [task.task_id, task.created_at, task.status, task.updated_at, task.title, task.goal] });
for (const row of read('history.json').sort((a, b) => a.sequence - b.sequence)) {
  line('hist', { p, seq: row.sequence, step: row.step_id, at: row.committed_at, status: row.committed_status, entries: JSON.parse(row.entries_json) });
}
for (const row of read('summaries.json')) {
  line('summary', { p, rev: row.revision, from: row.from_sequence, through: row.through_sequence, reset: row.reset_through_sequence, template: row.template_json, bootstrap: row.bootstrap_text, at: row.updated_at });
}
const core = readFileSync(dataFile('export4.txt'), 'utf8').split('\n').find(l => l.startsWith('@@core\t'))!;
line('core', { p, tools: JSON.parse(core.slice(core.indexOf('\t') + 1)).tools });
line('plantree', { p, tree: null });
for (const row of read('ops.json')) {
  line('op', { p, id: row.id, cmd: JSON.parse(row.command_json), phase: row.phase, receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null, at: row.created_at });
}
writeFileSync(dataFile('export5.txt'), `${out.join('\n')}\n`);
console.log('wrote', dataFile('export5.txt'), out.length, 'lines');
