import { defineQuery, defineUpdate } from '@temporalio/workflow';
import type { ExpectationEditInput, ExpectationResolveInput, ExpectationState, ObservationRecord } from '@cw/shared';

/* ------------------------------------------------------- expectationWorkflow (one per open loop) */

/** Change title, due date, action … (a new due date re-arms the timer and re-opens a signalled expectation). */
export const editExpectationUpdate = defineUpdate<ExpectationState, [ExpectationEditInput]>('editExpectation');
/** The expected thing happened (matching observation, an agent or a person says so). */
export const fulfillExpectationUpdate = defineUpdate<ExpectationState, [ExpectationResolveInput]>('fulfillExpectation');
/** Not needed (wrong interpretation, no longer relevant). The reason teaches the interpreter. */
export const dismissExpectationUpdate = defineUpdate<ExpectationState, [ExpectationResolveInput]>('dismissExpectation');
export const expectationStateQuery = defineQuery<ExpectationState>('expectationState');

/* ------------------------------------------------------- observationWorkflow */

export const observationResultQuery = defineQuery<ObservationRecord>('observationResult');
