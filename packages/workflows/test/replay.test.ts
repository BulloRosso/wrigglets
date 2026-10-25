import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { historyFromJSON } from '@temporalio/common/lib/proto-utils.js';

/*
 * Replay tests (spec §16.2): every stored history must replay deterministically against the
 * current workflow code. A failure means a change needs `patched()` (or must wait until no
 * affected workflows are running). Regenerate fixtures with RECORD_HISTORIES=1.
 */

const dir = fileURLToPath(new URL('./histories/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

describe('replay', () => {
  it('has recorded histories', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('replays all recorded histories without non-determinism', async () => {
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL('../dist/index.js', import.meta.url)),
      logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } as never,
    });
    // The original workflow id matters: the lock only accepts grants addressed to its own id.
    const histories = files.map((f) => {
      const { workflowId, history } = JSON.parse(readFileSync(dir + f, 'utf8')) as { workflowId: string; history: unknown };
      return { workflowId, history: historyFromJSON(history) };
    });
    for await (const result of Worker.runReplayHistories({ workflowBundle }, histories)) {
      expect(result.error, `${result.workflowId}: ${String(result.error)}`).toBeUndefined();
    }
  }, 120_000);
});
