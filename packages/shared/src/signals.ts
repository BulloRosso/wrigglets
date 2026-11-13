import { z } from 'zod';

/*
 * Signals (optional module, ADR-0037): proactive reasoning on incoming observations and on deadlines.
 *
 *   observation (mail, MQTT message, API post, something an agent noticed)
 *     → 0..n events            "what actually happened?"
 *     → 0..n expectations      "what should follow, and by when?"   (one Temporal workflow each)
 *     → signal                 deadline passed without a matching observation
 *     → action                 notify people, or propose a task that a person must approve
 *
 * The interpretation is done by the agent's own model in the context of the agent's role (AGENTS.md) and a short
 * Signals brief: role, goals and limits, not process rules. Observations are untrusted data.
 */

export const SIGNAL_STATES = ['open', 'signalled', 'fulfilled', 'dismissed', 'expired'] as const;
export type SignalState = (typeof SIGNAL_STATES)[number];
export const OPEN_SIGNAL_STATES: readonly SignalState[] = ['open', 'signalled'];

/** What happens when an expectation is overdue. A task always needs a person's approval of its plan. */
export const SIGNAL_ACTIONS = ['notify', 'propose_task'] as const;
export type SignalAction = (typeof SIGNAL_ACTIONS)[number];

export const SIGNAL_SOURCES = ['api', 'playground', 'agent', 'imap', 'mqtt'] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export const SIGNALS_LIMITS = {
  /** Characters of an observation body that are kept (and shown to the model). */
  maxBody: 20_000,
  maxSubject: 500,
  maxEventsPerObservation: 10,
  maxExpectationsPerObservation: 5,
  /** Open expectations per agent; more observations are still recorded but derive no new expectations. */
  maxOpen: 200,
  /** Due dates further in the future are refused. */
  maxHorizonDays: 366,
  /** Human corrections (dismissals, edits) shown to the model as examples. */
  corrections: 10,
} as const;

/** The workflow id of an expectation, also its public id. */
export const EXPECTATION_ID_PATTERN = /^sig-exp-[A-Za-z0-9-]{6,80}$/;
export const OBSERVATION_ID_PATTERN = /^sig-obs-[A-Za-z0-9-]{6,120}$/;

/* ---------------------------------------------------------------- observations */

export const observationBody = z.object({
  source: z.enum(SIGNAL_SOURCES).default('api'),
  /** Stable reference used for de-duplication: Message-ID, MQTT topic + hash, an external id. */
  ref: z.string().trim().max(300).optional(),
  subject: z.string().trim().max(SIGNALS_LIMITS.maxSubject).optional(),
  from: z.string().trim().max(300).optional(),
  body: z.string().min(1).transform((s) => s.slice(0, SIGNALS_LIMITS.maxBody)),
  receivedAt: z.string().datetime({ offset: true }).optional(),
  /** Connector, agent or person that delivered it (informational). */
  reportedBy: z.string().trim().max(200).optional(),
});
export type ObservationInput = z.input<typeof observationBody>;
export type ObservationBody = z.output<typeof observationBody>;

/* ---------------------------------------------------------------- interpretation (model output) */

export const signalEvent = z.object({
  type: z.string().trim().min(1).max(80).describe('Short business event type, e.g. "hotel_booking_confirmed"'),
  summary: z.string().trim().min(1).max(500).describe('One sentence: what actually happened'),
  occurredAt: z.string().max(40).optional().describe('ISO date or date-time, if stated'),
});
export type SignalEvent = z.infer<typeof signalEvent>;

export const derivedExpectation = z.object({
  title: z.string().trim().min(3).max(120).describe('What should happen, e.g. "Invoice from Hotel Nordlicht arrives"'),
  description: z.string().trim().max(1000).default('').describe('Why it is expected and what to do if it does not happen'),
  matchHint: z.string().trim().max(500).default('').describe('How a later observation can be recognised as fulfilling it'),
  dueAt: z.string().datetime({ offset: true }).describe('ISO date-time by which it should have happened'),
  action: z.enum(SIGNAL_ACTIONS).optional().describe('notify = tell people; propose_task = prepare a follow-up a person must approve'),
  taskTitle: z.string().trim().min(3).max(120).optional().describe('Title of the follow-up task if it is overdue'),
  taskInstructions: z.string().trim().max(4000).optional().describe('Self-contained instructions for the follow-up task'),
});
export type DerivedExpectation = z.output<typeof derivedExpectation>;

export const fulfilment = z.object({
  expectationId: z.string().max(200),
  confidence: z.number().min(0).max(1).describe('0..1: how sure it is that this observation fulfils the expectation'),
  reason: z.string().trim().max(500),
});
export type Fulfilment = z.infer<typeof fulfilment>;

/** The structured answer of the interpreter. Zero events is a valid (and frequent) answer. */
export const interpretResult = z.object({
  events: z.array(signalEvent).max(SIGNALS_LIMITS.maxEventsPerObservation).default([]),
  fulfills: z.array(fulfilment).max(20).default([]),
  expectations: z.array(derivedExpectation).max(SIGNALS_LIMITS.maxExpectationsPerObservation).default([]),
  note: z.string().trim().max(500).optional().describe('Optional remark, e.g. why nothing follows'),
});
export type InterpretResult = z.output<typeof interpretResult>;

/* ---------------------------------------------------------------- expectations (workflow state) */

export interface ExpectationHistoryEntry {
  at: string;
  kind: 'created' | 'edited' | 'reminded' | 'signalled' | 'fulfilled' | 'dismissed' | 'expired';
  by?: string;
  text?: string;
}

export interface ExpectationInput {
  agentId: string;
  title: string;
  description: string;
  matchHint: string;
  dueAt: string;
  action: SignalAction;
  taskTitle?: string;
  taskInstructions?: string;
  /** How long a signalled expectation stays open for a late fulfilment before it expires. */
  graceDays: number;
  source: { observationId: string; kind: SignalSource; subject?: string; events: string[] };
  createdBy: string;
}

export interface ExpectationState extends ExpectationInput {
  id: string;
  state: SignalState;
  createdAt: string;
  history: ExpectationHistoryEntry[];
  signal?: { at: string; action: SignalAction; taskId?: string; error?: string };
  resolution?: { at: string; by: string; reason: string; observationId?: string };
}

export const expectationEditBody = z
  .object({
    title: derivedExpectation.shape.title.optional(),
    description: z.string().trim().max(1000).optional(),
    matchHint: z.string().trim().max(500).optional(),
    dueAt: z.string().datetime({ offset: true }).optional(),
    action: z.enum(SIGNAL_ACTIONS).optional(),
    taskTitle: z.string().trim().min(3).max(120).optional(),
    taskInstructions: z.string().trim().max(4000).optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to change' });
export type ExpectationEdit = z.infer<typeof expectationEditBody>;

export const expectationResolveBody = z.object({ reason: z.string().trim().min(1).max(1000) });

export interface ExpectationEditInput extends ExpectationEdit {
  by: string;
}
export interface ExpectationResolveInput {
  by: string;
  reason: string;
  observationId?: string;
}

/** Row of the open-loops list (from Temporal visibility + memo). */
export interface ExpectationListItem {
  id: string;
  title: string;
  state: SignalState | string;
  dueAt?: string;
  source?: string;
  startTime: string;
  closeTime?: string;
}

/* ---------------------------------------------------------------- observation log */

export interface ObservationRecord {
  id: string;
  at: string;
  source: SignalSource;
  ref?: string;
  subject?: string;
  from?: string;
  /** First characters of the body (the full body stays in the workflow history). */
  excerpt: string;
  events: SignalEvent[];
  fulfilled: Array<{ expectationId: string; reason: string }>;
  created: string[];
  note?: string;
  skipped?: string;
  error?: string;
}

export interface CorrectionRecord {
  at: string;
  by: string;
  expectationId: string;
  kind: 'dismissed' | 'edited' | 'fulfilled';
  title: string;
  text: string;
}

/* ---------------------------------------------------------------- per-agent configuration (control plane) */

export const DEFAULT_SIGNALS_BRIEF = `You watch incoming information for the team you work for. Recognise business events that matter for your role and the open loops they create (something that should follow: an invoice, a confirmation, an answer, a delivery). Ignore newsletters, advertising and pure information without consequences: zero events is a correct result. You may not act outside the platform without a person's approval.`;

const identityRef = z.object({ upn: z.string().min(1).max(200), name: z.string().max(200).default(''), oid: z.string().max(200).default('') });

export const signalsAgentConfig = z.object({
  enabled: z.boolean().default(false),
  /** Role, goals and limits for the interpretation (no process rules). Added to the agent's AGENTS.md. */
  brief: z.string().max(4000).default(DEFAULT_SIGNALS_BRIEF),
  /** The person signal tasks are started for (requester). Unset = the platform identity "signals". */
  owner: identityRef.optional(),
  defaultAction: z.enum(SIGNAL_ACTIONS).default('propose_task'),
  /** A model answer "this observation fulfils expectation X" is applied from this confidence on. */
  fulfilThreshold: z.number().min(0.5).max(1).default(0.7),
  maxObservationsPerHour: z.number().int().min(1).max(1000).default(60),
  graceDays: z.number().int().min(1).max(365).default(30),
  /** Empty = the agent's small model (or its main model). */
  model: z.string().max(100).default(''),
});
export type SignalsAgentConfig = z.output<typeof signalsAgentConfig>;
export const DEFAULT_SIGNALS_AGENT_CONFIG: SignalsAgentConfig = signalsAgentConfig.parse({});

export const SIGNALS_IDENTITY = { upn: 'signals', name: 'Signals', oid: 'signals' } as const;

/* ---------------------------------------------------------------- connectors (signals-hub, control plane) */

const connectorId = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'lower-case letters, digits and dashes');
const agentRef = z.string().regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/);
const secretRef = z.string().regex(/^[A-Za-z0-9-]{1,127}$/, 'Key Vault secret name');

/** HTTP ingest source: callers present a bearer token; only its SHA-256 is stored. */
export const signalsHttpSource = z.object({
  id: connectorId,
  agentId: agentRef,
  tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  enabled: z.boolean().default(true),
});

export const signalsImapAccount = z.object({
  id: connectorId,
  agentId: agentRef,
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  user: z.string().min(1).max(320),
  passwordRef: secretRef,
  mailbox: z.string().min(1).max(200).default('INBOX'),
  /** Folder processed mails are moved to; unset = they are only marked as seen. */
  moveTo: z.string().max(200).optional(),
  pollSeconds: z.number().int().min(15).max(3600).default(60),
  enabled: z.boolean().default(true),
});

export const signalsMqttSubscription = z.object({
  topic: z.string().min(1).max(300),
  agentId: agentRef,
  /** Messages on the same topic within this window are folded into one observation (the last one wins). */
  debounceSeconds: z.number().int().min(0).max(3600).default(10),
  maxPerHour: z.number().int().min(1).max(1000).default(30),
  maxPayloadBytes: z.number().int().min(16).max(SIGNALS_LIMITS.maxBody).default(4000),
});

export const signalsMqttBroker = z.object({
  id: connectorId,
  url: z.string().regex(/^(mqtts?|wss?):\/\/.+/, 'mqtt://, mqtts://, ws:// or wss:// URL').max(500),
  username: z.string().max(200).optional(),
  passwordRef: secretRef.optional(),
  subscriptions: z.array(signalsMqttSubscription).max(50).default([]),
  enabled: z.boolean().default(true),
});

export const signalsConnectors = z.object({
  http: z.array(signalsHttpSource).max(100).default([]),
  imap: z.array(signalsImapAccount).max(20).default([]),
  mqtt: z.array(signalsMqttBroker).max(20).default([]),
});
export type SignalsConnectors = z.output<typeof signalsConnectors>;
export type SignalsHttpSource = z.output<typeof signalsHttpSource>;
export type SignalsImapAccount = z.output<typeof signalsImapAccount>;
export type SignalsMqttBroker = z.output<typeof signalsMqttBroker>;

/** What the hub polls from the control plane. */
export interface SignalsHubConfig {
  version: string;
  connectors: SignalsConnectors;
  /** Agents with Signals switched on (observations for others are refused). */
  agents: string[];
}

export interface SignalsConnectorStatus {
  id: string;
  kind: 'http' | 'imap' | 'mqtt';
  state: 'up' | 'down' | 'disabled' | 'connecting';
  lastError?: string;
  lastObservationAt?: string;
  observations: number;
}

export interface SignalsHubStatus {
  configVersion?: string;
  configAt?: string;
  outbox: { pending: number; failed: number; oldest?: string };
  connectors: SignalsConnectorStatus[];
}
