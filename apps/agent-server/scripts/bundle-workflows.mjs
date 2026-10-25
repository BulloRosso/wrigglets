// Pre-bundles the deterministic workflow code at build time (spec §7.1).
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bundleWorkflowCode } from '@temporalio/worker';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/workflow-bundle.js');
const workflowsPath = fileURLToPath(import.meta.resolve('@cw/workflows'));
const { code } = await bundleWorkflowCode({ workflowsPath });
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, code);
console.log(`workflow bundle written: ${out} (${Math.round(code.length / 1024)} KiB)`);
