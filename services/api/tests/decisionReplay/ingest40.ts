import { readFileSync, writeFileSync } from 'node:fs';
import { dataFile } from './allRuns.js';

/**
 * 10/26 の実走 39（rel55b、頭 628a5a3、タスク e7021389、依頼は「エンドラを討伐してください」、34.6 分で予算の手前で止まった）の控え
 * （run39-dump の hist.jsonl・ops.jsonl・task.json）を台の `@@` の形にして data/export6.txt に書く。台では r40。
 * 道具の定義（core）は実走38 の物を借りる（この控えには無い）。要約（bootstrap）は台が Haiku で作り直す。
 *   node --import tsx tests/decisionReplay/ingest40.ts <run39-dump のフォルダ>
 */
const dir = process.argv[2]!;
const lines = (name: string) => readFileSync(`${dir}/${name}`, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as any);
const task = JSON.parse(readFileSync(`${dir}/task.json`, 'utf8')); const t = Array.isArray(task) ? task[0] : task;
const p = 'e7021389';
const out: string[] = [];
const put = (kind: string, value: unknown) => out.push(`@@${kind}\t${JSON.stringify(value)}`);
put('task', { p, task: [t.task_id, t.created_at, t.status, t.updated_at, t.title, t.goal] });
for (const row of lines('hist.jsonl').sort((a, b) => a.sequence - b.sequence)) {
  put('hist', { p, seq: row.sequence, step: row.step_id, at: row.committed_at, status: row.committed_status, entries: JSON.parse(row.entries_json) });
}
const core = readFileSync(dataFile('export4.txt'), 'utf8').split('\n').find(l => l.startsWith('@@core\t'))!;
put('core', { p, tools: JSON.parse(core.slice(core.indexOf('\t') + 1)).tools });
put('plantree', { p, tree: null });
for (const row of lines('ops.jsonl')) put('op', { p, id: row.cmd.id, cmd: row.cmd, phase: row.rc ? 'done' : 'open', receipt: row.rc ?? null, at: row.c });
writeFileSync(dataFile('export6.txt'), `${out.join('\n')}\n`);
console.log('wrote', dataFile('export6.txt'), out.length, 'lines');
