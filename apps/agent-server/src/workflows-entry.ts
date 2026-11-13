// Entry of the agent's workflow bundle: the core workflows plus the (optional) Signals workflows (ADR-0037).
// Registering the Signals workflows is harmless when the module is off: nothing starts them.
export * from '@cw/workflows';
export * from '@cw/signals/workflows';
