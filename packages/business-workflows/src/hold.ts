import { condition, defineQuery, defineSignal, setHandler, upsertSearchAttributes } from '@temporalio/workflow';
import { BSA } from './common.js';

/*
 * Holdable helper (ADR-0045): every business workflow accepts `hold(reason, ref)` and `release(ref)` and answers
 * `holdState`. While at least one hold is active, the workflow runs no activity that changes state (it awaits
 * `whileHeld()` before each). Holds are keyed by ref (e.g. a playbook run id), so several holders do not release each
 * other. Holding is a tightening step (automatic, e.g. by a playbook); releasing is loosening (a person, M7).
 */

export interface HoldInput {
  reason: string;
  ref: string;
}
export interface HoldState {
  held: boolean;
  holds: Array<{ ref: string; reason: string; since: string }>;
  /** Business state the workflow reported last (also in the BusinessState search attribute). */
  state: string;
}

export const holdSignal = defineSignal<[HoldInput]>('hold');
export const releaseSignal = defineSignal<[{ ref: string }]>('release');
export const holdStateQuery = defineQuery<HoldState>('holdState');

export interface Holdable {
  /** Resolves when no hold is active (immediately if none). */
  whileHeld(): Promise<void>;
  isHeld(): boolean;
  /** Reports a new business state (search attribute + query). */
  setState(state: string): void;
}

export function holdable(initialState: string): Holdable {
  const holds = new Map<string, { reason: string; since: string }>();
  let state = initialState;
  const publish = () => upsertSearchAttributes([{ key: BSA.BusinessState, value: holds.size ? 'held' : state }]);
  setHandler(holdSignal, ({ reason, ref }) => {
    if (!ref) return;
    holds.set(ref, { reason: String(reason ?? ''), since: new Date().toISOString() });
    publish();
  });
  setHandler(releaseSignal, ({ ref }) => {
    holds.delete(ref);
    publish();
  });
  setHandler(holdStateQuery, () => ({ held: holds.size > 0, holds: [...holds].map(([ref, h]) => ({ ref, ...h })), state }));
  return {
    whileHeld: () => condition(() => holds.size === 0),
    isHeld: () => holds.size > 0,
    setState(s) {
      state = s;
      publish();
    },
  };
}
