// Pre-bundles the deterministic business workflows at build time (like apps/agent-server).
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleWorkflowCode } from '@temporalio/worker';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../dist/workflow-bundle.js');
const workflowsPath = createRequire(import.meta.url).resolve('@cw/business-workflows');
const { code } = await bundleWorkflowCode({ workflowsPath });
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, code);
console.log(`business workflow bundle written: ${out} (${Math.round(code.length / 1024)} KiB)`);
