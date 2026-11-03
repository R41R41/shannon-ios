// Prints the nodes of the seed plan of the dragon goal (id, kind, title, doneWhen), for writing scenes that stand between two nodes.
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';

const tree = seedPlan(process.argv[2] ?? 'エンダードラゴンを討伐した');
for (const node of tree?.nodes ?? []) console.log(`${node.id}\t${node.kind}\t${node.title}\t${node.doneWhen ?? ''}`);
