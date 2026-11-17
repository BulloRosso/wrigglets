import type { ConfigProposal, GatewayInfo, InboxItem, LiquidApp, LiquidEvent, LiquidLakeStatus, LiquidPolicyStatus, LiquidProcesses, OntologyDraft, PlaybookRunView } from '../api';
import type { OntologyIr } from '@cw/ontology-ir/browser';

/*
 * The guided tutorial of Liquid Enterprise (ADR-0054): chapters, each showing one core value, and steps whose state
 * is computed from the live platform (pure functions over the API responses). docs/liquid-tutorial.md uses the same
 * wording; change both together.
 */

/** What the tutorial remembers in this browser (localStorage cw.liquid.tutorial). */
export interface TutorialRun {
  startedAt: string;
  startSeq: number;
  startVersion: string;
  /** the class chapter 5 suggests, fixed at the start (a name the ontology did not have) */
  suggestedClass?: string;
  purchaseOrders: string[];
  /** steps the evaluator ticked by hand (looking at something has no trace to check) */
  manual: Record<string, boolean>;
  /** the purchase order of chapter 7 (placed after the rule went live) and its supplier */
  ddOrder?: string;
  ddSupplier?: string;
  /** the material chapter 7 classifies high-risk (timber on a first run) */
  ddSku?: string;
}

export interface Ctx {
  run?: TutorialRun;
  me: string;
  policy?: LiquidPolicyStatus;
  inbox?: InboxItem[];
  processes?: LiquidProcesses;
  runs?: PlaybookRunView[];
  proposals?: ConfigProposal[];
  drafts?: OntologyDraft[];
  ontology?: OntologyIr;
  apps?: LiquidApp[];
  events?: LiquidEvent[];
  lake?: LiquidLakeStatus;
  gateway?: GatewayInfo;
}

export type StepState = 'done' | 'todo';
export type ActionId = 'prepare' | 'agent-cancel' | 'create-order' | 'propose-dd' | 'classify' | 'dd-order';

export interface TutorialStep {
  id: string;
  title: string;
  /** Markdown-free text; short sentences. */
  body: string;
  /** where to do it (a deep link in the console, or an external URL) */
  link?: (c: Ctx) => { label: string; to: string; external?: boolean } | undefined;
  action?: { id: ActionId; label: string };
  /** a terminal command for the one step that is the app owner's (copy button) */
  command?: string;
  /** looking at something: ticked by hand */
  manual?: boolean;
  check?: (c: Ctx) => boolean;
}

export interface Chapter {
  id: string;
  title: string;
  value: string;
  /** what just happened, and where to read more (docs/liquid-enterprise.md) */
  takeaway: string;
  steps: TutorialStep[];
  advanced?: boolean;
}

export const DD_RULE = 'due_diligence_for_high_risk_material';
export const APP_ID = 'supplier-due-diligence';
export const CLASS_SUGGESTIONS = ['Carrier', 'Warehouse', 'Shipment', 'Inspection', 'Forwarder', 'Dock'];

/* ------------------------------------------------------------------------------------------------ helpers */
const since = (c: Ctx, at?: string) => !!c.run && !!at && at >= c.run.startedAt;
const ev = (c: Ctx, type: string, f: (e: LiquidEvent) => boolean = () => true) => (c.events ?? []).some((e) => e.type === type && f(e));
const adminDid = (c: Ctx, action: string) => ev(c, 'AdminAction', (e) => (e.payload as { action?: string }).action === action);
const myProposals = (c: Ctx) => (c.proposals ?? []).filter((p) => since(c, p.createdAt));
const ontologyProposal = (c: Ctx) => myProposals(c).find((p) => p.author.kind === 'person' && p.paths.some((x) => x.startsWith('ontology/')) && !/due.diligence/i.test(p.title));
const ddProposal = (c: Ctx) => myProposals(c).find((p) => /due.diligence/i.test(p.title) || (p.author.kind === 'agent' && p.paths.some((x) => x.startsWith('ontology/'))));
const ddLive = (c: Ctx) => !!c.ontology?.actions.find((a) => a.name === 'release_purchase_order')?.preconditions?.includes(DD_RULE);
const tutorialRuns = (c: Ctx) => (c.runs ?? []).filter((r) => since(c, r.startTime));
const semverGt = (a: string, b: string) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
/** The first suggestion the ontology does not have yet; then Carrier2, Carrier3, … */
export const freeClassName = (classes: string[]) => {
  const free = CLASS_SUGGESTIONS.find((n) => !classes.includes(n));
  if (free) return free;
  let i = 2;
  while (classes.includes(`Carrier${i}`)) i++;
  return `Carrier${i}`;
};
export const suggestedClass = (c: Ctx) => c.run?.suggestedClass ?? freeClassName((c.ontology?.classes ?? []).map((k) => k.name));
const po = (c: Ctx, i: number) => c.run?.purchaseOrders[i] ?? `PO-…`;
const ddPoProcess = (c: Ctx) => [...(c.processes?.running ?? []), ...(c.processes?.recent ?? [])].find((p) => p.type === 'PurchaseOrderRelease' && !!c.run?.ddOrder && p.objects.includes(`PurchaseOrder:${c.run.ddOrder}`));

/* ------------------------------------------------------------------------------------------------ chapters */
export const CHAPTERS: Chapter[] = [
  {
    id: 'start',
    title: 'Prepare the demo world',
    value: 'A known starting point: the sofa company on day one, three open purchase orders, nothing held or contained.',
    takeaway: 'Preparing resets the simulated company and undoes what an earlier run left behind: playbook runs, holds, tutorial overlays, a disabled upstream. Each of these is an audited console action, like any other.',
    steps: [
      {
        id: 'prepare',
        title: 'Prepare the demo world',
        body: 'Resets the sofa company and places three purchase orders for pine beams from the supplier Nordholz, in your name. It takes about ten seconds.',
        action: { id: 'prepare', label: 'Prepare' },
        check: (c) => !!c.run,
      },
    ],
  },
  {
    id: 'data',
    title: '1 · Your data, one source of truth',
    value: 'Business data lives in open formats you own, and every change is an event in an append-only log.',
    takeaway: 'The three orders you placed are events. Within a minute they are also Parquet files in the lake, which any engine can read without this platform. Admin actions, tool calls, policy decisions and playbook steps go into the same log. Read more in docs/liquid-enterprise.md → Architecture.',
    steps: [
      {
        id: 'lake',
        title: 'See the lake catch up',
        body: 'The Overview page shows the event log, its high-water mark and every raw table of the lake. The step ticks itself once the flush, every 60 seconds, has written your orders into the lake.',
        link: () => ({ label: 'Overview', to: '/liquid' }),
        check: (c) => !!c.run && (c.lake?.hwm ?? 0) >= c.run.startSeq,
      },
      {
        id: 'events',
        title: 'Find your orders in the event log',
        body: 'Filter by type PurchaseOrderCreated. Each event records who did it (you), under which ontology version, and the objects it changed. Nobody can update or delete an event: a correction is a new event.',
        link: (c) => ({ label: 'Event log', to: `/liquid/events?types=PurchaseOrderCreated&actor=${encodeURIComponent(c.me)}` }),
        manual: true,
      },
    ],
  },
  {
    id: 'ontology',
    title: '2 · Meaning in one place',
    value: 'One versioned ontology says what the business data means. Tools, checks, policies and app SDKs are computed from it.',
    takeaway: 'PurchaseOrder is payment critical. That single annotation is why the next chapter asks for a second pair of eyes. The agents’ MCP tools, the input validation and the app SDK all come from the same IR. Read more in docs/liquid-enterprise.md → Ontology and IR contract.',
    steps: [
      {
        id: 'explore',
        title: 'Select the class PurchaseOrder',
        body: 'The panel shows its criticality (payment critical), its links to Supplier and Material, the actions that write it with their preconditions, and the raw table it is bound to.',
        link: () => ({ label: 'Ontology', to: '/liquid/ontology' }),
        manual: true,
      },
    ],
  },
  {
    id: 'policy',
    title: '3 · Rules as code, tightened without a deploy',
    value: 'Who may do what is code that is tested and versioned. Anyone may tighten it at once. Loosening it takes a person and leaves a trace.',
    takeaway: 'The four-eyes rule is Rego in policies/liquid/object.rego. It runs as WASM inside the gateway and inside the enterprise core, and it fails closed. The overlay took effect within about five seconds, with no build and no restart. Read more in docs/liquid-enterprise.md → Policies.',
    steps: [
      {
        id: 'agent-cancel',
        title: 'Let agent Lara cancel an order',
        body: 'The tutorial plays Lara’s tool call, without a model. Cancelling a payment-critical order outside an approved task needs a second pair of eyes, so nothing happens yet. A request goes to the approvals inbox.',
        action: { id: 'agent-cancel', label: 'Lara: cancel order' },
        check: (c) => ev(c, 'ActionApprovalRequested', (e) => e.action === 'cancel_purchase_order'),
      },
      {
        id: 'approve',
        title: 'Approve it as the second pair of eyes',
        body: 'In Approvals, open Lara’s request and approve it. The order is cancelled, and the event records you as approvedBy.',
        link: () => ({ label: 'Approvals', to: '/liquid/approvals' }),
        check: (c) => ev(c, 'PurchaseOrderCancelled', (e) => !!(e.payload as { approvedBy?: string }).approvedBy),
      },
      {
        id: 'overlay',
        title: 'Freeze purchasing with an overlay',
        body: 'Policies → Add overlay: effect “deny”, action create_purchase_order, reason starting with “Tutorial” (for example “Tutorial: purchasing frozen”).',
        link: () => ({ label: 'Policies', to: '/liquid/policies?tab=overlays' }),
        check: (c) => adminDid(c, 'liquid.policy.overlay.add') || (c.policy?.overlays ?? []).some((o) => since(c, o.createdAt) && o.effect === 'deny'),
      },
      {
        id: 'denied',
        title: 'Try to place an order',
        body: 'You place the order yourself, as a person. The overlay denies it, for people and agents alike, and the denial is an event (PolicyDecision).',
        action: { id: 'create-order', label: 'Place an order' },
        check: (c) => ev(c, 'PolicyDecision', (e) => e.action === 'create_purchase_order' && (e.payload as { allow?: boolean }).allow === false),
      },
      {
        id: 'lift',
        title: 'Lift the freeze',
        body: 'Remove the overlay on the Policies page. Loosening is allowed only to a person, and it is audited. Place the order again: now it goes through.',
        link: () => ({ label: 'Policies', to: '/liquid/policies?tab=overlays' }),
        check: (c) => adminDid(c, 'liquid.policy.overlay.remove'),
      },
    ],
  },
  {
    id: 'processes',
    title: '4 · Processes you can hold',
    value: 'Long-running business processes start from events, not from code calling code, and you can pause them by business object.',
    takeaway: 'Each purchase order started a PurchaseOrderRelease workflow, because the ontology says create_purchase_order starts it. A hold by object reached every workflow that touches Nordholz. Holding tightens, so it needs no approval, and it never skips a step. Read more in docs/liquid-enterprise.md → Business workflows.',
    steps: [
      {
        id: 'hold',
        title: 'Hold everything that touches Nordholz',
        body: 'Business processes → Hold by object → Supplier:S-NORDHOLZ. The release workflows of your orders show “held”.',
        link: () => ({ label: 'Business processes', to: '/liquid/processes?tab=running' }),
        check: (c) => adminDid(c, 'liquid.process.hold') || (c.processes?.running ?? []).some((p) => p.hold?.held && p.hold.holds.some((h) => h.ref.startsWith('console-'))),
      },
      {
        id: 'release',
        title: 'Release the hold',
        body: 'Release lifts this hold, and only this one: holds stack. The workflows continue where they stopped.',
        link: () => ({ label: 'Business processes', to: '/liquid/processes?tab=running' }),
        check: (c) => adminDid(c, 'liquid.process.release'),
      },
    ],
  },
  {
    id: 'change',
    title: '5 · Change through review, live without a deploy',
    value: 'The desired state lives in Git. Every change is a proposal that is validated and reviewed, and the ontology goes live at runtime.',
    takeaway: 'Your draft became a branch and a pull request with a required check (liquid/validate). After the merge, the reconciler applied the new IR to the running core, and the projection, the tools, the SDK and the policy data followed. Nothing was built or restarted. Read more in docs/liquid-enterprise.md → Config repository and proposals, and → Ontology evolution.',
    steps: [
      {
        id: 'draft',
        title: 'Draft a new class',
        body: 'Ontology → Edit as draft. Add a class (suggested below) with an attribute “name”, then drag a link from PurchaseOrder to it. The panel compiles every change and shows the compatibility class: minor. Click “Set version”.',
        link: () => ({ label: 'Ontology', to: '/liquid/ontology' }),
        check: (c) => (c.drafts ?? []).some((d) => since(c, d.createdAt) && d.ops.some((o) => o.op === 'add_class')) || !!ontologyProposal(c),
      },
      {
        id: 'submit',
        title: 'Submit it as a proposal',
        body: 'Submit opens a pull request on the Git host. The proposal page shows the validation, the owners who must approve, and the change as a diff graph.',
        link: (c) => {
          const p = ontologyProposal(c);
          return { label: 'Proposals', to: p ? `/liquid/proposals/${p.id}?view=ontology` : '/liquid/proposals' };
        },
        check: (c) => !!ontologyProposal(c)?.pr,
      },
      {
        id: 'merge',
        title: 'Review and merge it on the Git host',
        body: 'Sign in to Forgejo as the reviewer (login below), open the pull request, approve it and merge it. The console never decides a proposal itself.',
        link: (c) => {
          const p = ontologyProposal(c);
          return p?.pr ? { label: 'Pull request', to: p.pr.url, external: true } : undefined;
        },
        check: (c) => ontologyProposal(c)?.status === 'approved',
      },
      {
        id: 'live',
        title: 'See it live',
        body: 'Within a few seconds of the merge, the Ontology page shows the new version with your class.',
        link: () => ({ label: 'Ontology', to: '/liquid/ontology' }),
        check: (c) => !!c.run && !!c.ontology && semverGt(c.ontology.version, c.run.startVersion),
      },
    ],
  },
  {
    id: 'contain',
    title: '6 · Contain automatically, recover with a person',
    value: 'When something is sensed, the platform tightens at once by itself. Loosening again always waits for a person.',
    takeaway: 'One alert started a durable playbook run. It disabled the upstream, required four eyes on the write actions behind it (the blast radius comes from the ontology), held the affected workflows, mailed the owner and attached a shadow replay. A playbook that loosened by itself would fail validation. Read more in docs/liquid-enterprise.md → Playbooks.',
    steps: [
      {
        id: 'alert',
        title: 'Send a vulnerability alert',
        body: 'Playbooks → Send test alert, with the defaults: a critical issue in the ERP connector (upstream erp).',
        link: () => ({ label: 'Playbooks', to: '/liquid/playbooks?tab=active' }),
        check: (c) => tutorialRuns(c).length > 0,
      },
      {
        id: 'contained',
        title: 'Watch the containment',
        body: 'Within seconds: erp is disabled (Safety & tools), an overlay requires four eyes (Policies), the release workflows are held (Business processes), and a mail went to the security owner (Mail outbox).',
        link: () => ({ label: 'Playbooks', to: '/liquid/playbooks?tab=active' }),
        check: (c) => tutorialRuns(c).some((r) => r.state !== 'running' || r.steps.some((s) => s.id === 'restore' && s.state !== 'pending')),
      },
      {
        id: 'restore',
        title: 'Approve the recovery',
        body: 'The restore step waits in Approvals. Approve it: the upstream comes back, the overlay goes, and the workflows continue.',
        link: () => ({ label: 'Approvals', to: '/liquid/approvals' }),
        check: (c) => tutorialRuns(c).some((r) => r.state === 'completed') && !!c.gateway?.upstreams.find((u) => u.name === 'erp' && u.enabled !== false),
      },
    ],
  },
  {
    id: 'requirement',
    title: '7 · A new business requirement, end to end',
    advanced: true,
    value: 'One reviewed change carries a requirement through ontology, rule, workflow and app.',
    takeaway: 'The requirement became ontology data: an attribute, an action, and a declarative check on the release, reviewed as one pull request. The rule applies to direct calls at once, and new orders wait for it in their workflow. The app talks to the platform only through the SDK, which changed with the ontology. Read more in docs/liquid-enterprise.md → Results D3.',
    steps: [
      {
        id: 'propose-dd',
        title: 'Propose the rule',
        body: '“Purchase orders for high-risk commodities need a valid supplier due-diligence statement before release.” The tutorial proposes the prepared change in your name, with a shadow replay of last week as evidence. You can also let the modelling agent write it (see the box below).',
        action: { id: 'propose-dd', label: 'Propose the rule' },
        link: (c) => {
          const p = ddProposal(c);
          return p ? { label: 'Proposal', to: `/liquid/proposals/${p.id}?view=summary` } : undefined;
        },
        check: (c) => !!ddProposal(c) || ddLive(c),
      },
      {
        id: 'merge-dd',
        title: 'Merge it on the Git host',
        body: 'The owner (you, as the reviewer) approves and merges. Seconds later the release action carries the rule.',
        link: (c) => {
          const p = ddProposal(c);
          return p?.pr ? { label: 'Pull request', to: p.pr.url, external: true } : undefined;
        },
        check: ddLive,
      },
      {
        id: 'app',
        title: 'The app owner rebuilds the app on the new SDK',
        body: 'The ontology changed, so the sample app’s SDK is stale and its check fails (Apps → Check again shows it). Its owner downloads the new SDK, rebuilds and registers again. That is one command, run in the repository:',
        command: 'node scripts/liquid/app-register.mjs apps/liquid-app-due-diligence --id supplier-due-diligence --name "Supplier due diligence" --owner stefan.lang@sofaworks.example --actions submit_due_diligence_statement --reads Supplier,DueDiligenceStatement --activate',
        link: () => ({ label: 'Apps', to: '/liquid/apps' }),
        check: (c) => {
          const a = c.apps?.find((x) => x.id === APP_ID);
          return !!a && a.status === 'active' && a.ontologyVersion === c.ontology?.version;
        },
      },
      {
        id: 'classify',
        title: 'Classify timber as high-risk',
        body: 'This runs the new action set_commodity_risk, which no code implements: it runs generically from the IR. (On a later run, when every timber supplier already has a statement, the tutorial classifies the next material instead.)',
        action: { id: 'classify', label: 'Classify high-risk' },
        check: (c) => ev(c, 'MaterialRiskClassified'),
      },
      {
        id: 'wait',
        title: 'Place an order and watch it wait',
        body: 'You order the material from a supplier that has no statement yet. After its release window (about 30 seconds), the new order waits for a statement (awaiting_due_diligence) instead of being released. A direct release would be refused by the rule.',
        action: { id: 'dd-order', label: 'Place an order' },
        link: () => ({ label: 'Business processes', to: '/liquid/processes?tab=running' }),
        check: (c) => !!ddPoProcess(c) && (ddPoProcess(c)!.state === 'awaiting_due_diligence' || ev(c, 'DueDiligenceStatementSubmitted')),
      },
      {
        id: 'statement',
        title: 'Submit the statement in the app',
        body: 'Open the app (administrators may use every app), and record a statement for the supplier of your order (shown below) with “sanctions checked”. The order is released moments later.',
        link: (c) => {
          const a = c.apps?.find((x) => x.id === APP_ID);
          return a?.url ? { label: 'Supplier due diligence', to: a.url, external: true } : undefined;
        },
        check: (c) => !!c.run?.ddOrder && ev(c, 'PurchaseOrderReleased', (e) => e.object_id === c.run!.ddOrder),
      },
    ],
  },
];

export const ALL_STEPS = CHAPTERS.flatMap((ch) => ch.steps.map((s) => ({ ...s, chapter: ch.id })));

export function stepState(s: TutorialStep, c: Ctx): StepState {
  if (s.manual) return c.run?.manual[s.id] ? 'done' : 'todo';
  return s.check?.(c) ? 'done' : 'todo';
}

export const poLabel = po;
