import { proxyActivities } from '@temporalio/workflow';
import type { BusinessActivities } from './common.js';

/* Lake flush (ADR-0040/0045): run by the Temporal schedule `lake-flush` every minute; idempotent by seq. */
const acts = proxyActivities<BusinessActivities>({ startToCloseTimeout: '2 minutes', retry: { maximumAttempts: 3 } });

export async function lakeFlush(): Promise<{ flushed: number; hwm: number }> {
  return acts.flushLake();
}
