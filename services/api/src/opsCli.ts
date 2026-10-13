import { runOperatorCli } from './infra/ops/operatorCli.js';

// The operator's Minecraft command line (docs/operator-minecraft-contract.md). Run as the service user on the VM.
process.exitCode = await runOperatorCli(process.argv.slice(2), process.env, { out: line => console.log(line), err: line => console.error(line) });
