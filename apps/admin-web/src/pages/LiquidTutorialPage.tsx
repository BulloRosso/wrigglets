import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Step from '@mui/material/Step';
import StepContent from '@mui/material/StepContent';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import ContentCopyOutlined from '@mui/icons-material/ContentCopyOutlined';
import OpenInNewOutlined from '@mui/icons-material/OpenInNewOutlined';
import RadioButtonUncheckedOutlined from '@mui/icons-material/RadioButtonUncheckedOutlined';
import { ConfirmDialog, ErrorAlert, PageHeader } from '@cw/ui';
import { api, useMe } from '../api';
import { Section } from '../components/Sections';
import { CHAPTERS, freeClassName, stepState, suggestedClass, type ActionId, type Chapter, type Ctx, type TutorialRun, type TutorialStep } from '../tutorial/steps';

/*
 * Liquid enterprise → Tutorial (ADR-0054): seven chapters, each one a core value of Liquid Enterprise. Steps tick
 * themselves from the live platform; the tutorial remembers its start in this browser (only state created after the
 * start counts). docs/liquid-tutorial.md is the same tour with screenshots.
 */

const KEY = 'cw.liquid.tutorial';
const load = (): TutorialRun | undefined => {
  try {
    const v = localStorage.getItem(KEY);
    return v ? (JSON.parse(v) as TutorialRun) : undefined;
  } catch {
    return undefined;
  }
};
const save = (r: TutorialRun | undefined) => {
  try {
    if (r) localStorage.setItem(KEY, JSON.stringify(r));
    else localStorage.removeItem(KEY);
  } catch {
    /* private window: the tutorial works for this visit only */
  }
};
export const tutorialStarted = () => !!load();

const TASK_FOR_MODELLER =
  'New requirement from procurement: purchase orders for high-risk commodities need a valid supplier due-diligence statement before release. Timber (BEAM-PINE-80) is high-risk. Model it in the ontology (a risk class on Material, an action to set it, the rule on release_purchase_order as a declarative check, the role that may write the new action), validate it and propose it for review.';

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Tooltip title={done ? 'Copied' : 'Copy'}>
      <IconButton
        size="small"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => setDone(true));
        }}
      >
        <ContentCopyOutlined fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

function Code({ text }: { text: string }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', bgcolor: 'action.hover', borderRadius: 1, p: 1, my: 1 }}>
      <Typography component="code" variant="body2" sx={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>
        {text}
      </Typography>
      <Copy text={text} />
    </Stack>
  );
}

function GitHostLogin() {
  const [show, setShow] = useState(false);
  const q = useQuery({ queryKey: ['liquid-tutorial-git-host'], queryFn: api.tutorialGitHost, enabled: show, staleTime: Infinity });
  return (
    <Alert severity="info" variant="outlined" sx={{ my: 1 }}>
      <Typography variant="body2" component="div">
        Reviews happen on the Git host (Forgejo), not in the console.{' '}
        {!show && (
          <Button size="small" onClick={() => setShow(true)}>
            Show the reviewer login
          </Button>
        )}
      </Typography>
      {q.data && (
        <Typography variant="body2" component="div" sx={{ mt: 1 }}>
          <a href={q.data.url} target="_blank" rel="noreferrer">
            {q.data.url}
          </a>
          {q.data.user ? (
            <>
              {' '}
              · user <code>{q.data.user}</code> · password <code>{q.data.password}</code> <Copy text={q.data.password ?? ''} />
            </>
          ) : (
            <> · {q.data.reason}</>
          )}
        </Typography>
      )}
      <ErrorAlert error={q.error} title="Could not read the Git host login" />
    </Alert>
  );
}

function ModellerBox() {
  const agents = useQuery({ queryKey: ['agents', 'tutorial'], queryFn: () => api.agents(false), staleTime: 30_000 });
  const m = agents.data?.find((a) => a.spec.agentId === 'sofa-modeller');
  return (
    <Alert severity="info" variant="outlined" icon={false} sx={{ my: 1 }}>
      <Typography variant="subtitle2">Or let an agent propose it (this uses model tokens)</Typography>
      <Typography variant="body2" component="div">
        The modelling agent <code>sofa-modeller</code> has only the config tools. It reads the ontology, drafts the smallest change, validates it and proposes it. It cannot merge anything.{' '}
        {m ? (
          <>
            Give it this task in its UI with <em>Approve plan first</em>:
          </>
        ) : (
          <>Create it once in the repository, then give it this task in its UI:</>
        )}
      </Typography>
      {!m && <Code text="node scripts/liquid/modelling-agent.mjs" />}
      <Code text={TASK_FOR_MODELLER} />
      {m && (
        <Button size="small" endIcon={<OpenInNewOutlined />} href={m.url} target="_blank" rel="noreferrer">
          Open sofa-modeller
        </Button>
      )}
    </Alert>
  );
}

type Result = { severity: 'success' | 'warning' | 'info' | 'error'; text: string };
const describe = (r: { status: number; ok: boolean; result?: string; as: string }): Result => {
  const text = (r.result ?? '').length > 400 ? `${r.result!.slice(0, 400)}…` : (r.result ?? '');
  if (r.ok) return { severity: 'success', text: `Done as ${r.as}. ${text}` };
  if (r.status === 403) return { severity: 'warning', text: `Not run, as ${r.as}: ${text}` };
  return { severity: 'info', text: `As ${r.as} (HTTP ${r.status}): ${text}` };
};

function StepView({ s, ctx, done, run, onRun, busy, result, onManual }: { s: TutorialStep; ctx: Ctx; done: boolean; run?: TutorialRun; onRun: (a: ActionId) => void; busy: boolean; result?: Result; onManual: (v: boolean) => void }) {
  const navigate = useNavigate();
  const link = s.link?.(ctx);
  const disabled = !run && s.action?.id !== 'prepare';
  return (
    <Step expanded completed={done}>
      <StepLabel icon={done ? <CheckCircleOutlined color="success" /> : <RadioButtonUncheckedOutlined color="disabled" />}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          {s.title}
        </Typography>
      </StepLabel>
      <StepContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {s.body}
        </Typography>
        {s.id === 'draft' && (
          <Typography variant="body2" sx={{ mb: 1 }}>
            Suggested class: <code>{suggestedClass(ctx)}</code> (a name the ontology does not have yet).
          </Typography>
        )}
        {(s.id === 'wait' || s.id === 'statement') && run?.ddOrder && (
          <Typography variant="body2" sx={{ mb: 1 }}>
            Your order: <code>{run.ddOrder}</code>, {run.ddSku} from supplier <code>{run.ddSupplier}</code>.
          </Typography>
        )}
        {s.command && <Code text={s.command} />}
        {s.id === 'merge' && <GitHostLogin />}
        {s.id === 'propose-dd' && <ModellerBox />}
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', alignItems: 'center', rowGap: 1 }}>
          {s.action && (
            <Button size="small" variant={done ? 'outlined' : 'contained'} disabled={disabled || busy} onClick={() => onRun(s.action!.id)}>
              {busy ? 'Working…' : s.action.label}
            </Button>
          )}
          {link &&
            (link.external ? (
              <Button size="small" endIcon={<OpenInNewOutlined />} href={link.to} target="_blank" rel="noreferrer" disabled={!run}>
                {link.label}
              </Button>
            ) : (
              <Button size="small" onClick={() => navigate(link.to)} disabled={!run}>
                Open {link.label}
              </Button>
            ))}
          {s.manual && <FormControlLabel control={<Checkbox size="small" checked={done} disabled={!run} onChange={(e) => onManual(e.target.checked)} />} label={<Typography variant="body2">Seen it</Typography>} />}
        </Stack>
        {result && (
          <Alert severity={result.severity} sx={{ mt: 1 }}>
            <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
              {result.text}
            </Typography>
          </Alert>
        )}
      </StepContent>
    </Step>
  );
}

function ChapterView({ ch, ctx, open, ...rest }: { ch: Chapter; ctx: Ctx; open: boolean; run?: TutorialRun; onRun: (a: ActionId) => void; busy?: ActionId; results: Partial<Record<ActionId, Result>>; onManual: (id: string, v: boolean) => void }) {
  const states = ch.steps.map((s) => stepState(s, ctx) === 'done');
  const n = states.filter(Boolean).length;
  const complete = n === ch.steps.length;
  return (
    <Section
      title={ch.title}
      defaultOpen={open}
      summary={
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip size="small" color={complete ? 'success' : n ? 'warning' : 'default'} label={`${n}/${ch.steps.length}`} />
          {ch.advanced && <Chip size="small" variant="outlined" label="advanced" />}
          <span>{ch.value}</span>
        </Stack>
      }
    >
      <Stepper orientation="vertical" nonLinear>
        {ch.steps.map((s, i) => (
          <StepView key={s.id} s={s} ctx={ctx} done={states[i]!} run={rest.run} onRun={rest.onRun} busy={!!s.action && rest.busy === s.action.id} result={s.action ? rest.results[s.action.id] : undefined} onManual={(v) => rest.onManual(s.id, v)} />
        ))}
      </Stepper>
      {complete && (
        <Alert severity="success" sx={{ mt: 2 }}>
          <Typography variant="subtitle2">What just happened</Typography>
          <Typography variant="body2">{ch.takeaway}</Typography>
        </Alert>
      )}
    </Section>
  );
}

export function LiquidTutorialPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const [run, setRunState] = useState<TutorialRun | undefined>(load);
  const setRun = (r: TutorialRun | undefined) => {
    save(r);
    setRunState(r);
  };
  const [results, setResults] = useState<Partial<Record<ActionId, Result>>>({});
  const [busy, setBusy] = useState<ActionId>();
  const [confirmRestart, setConfirmRestart] = useState(false);
  const live = { enabled: !!run, refetchInterval: 3000 };

  const ontology = useQuery({ queryKey: ['liquid-ontology'], queryFn: api.liquidOntology, refetchInterval: run ? 3000 : false });
  const policy = useQuery({ queryKey: ['liquid-policy'], queryFn: api.liquidPolicy, ...live });
  const inbox = useQuery({ queryKey: ['liquid-inbox'], queryFn: api.liquidInbox, ...live });
  const processes = useQuery({ queryKey: ['liquid-processes'], queryFn: api.liquidProcesses, ...live });
  const runs = useQuery({ queryKey: ['liquid-playbook-runs'], queryFn: api.liquidPlaybookRuns, ...live });
  const proposals = useQuery({ queryKey: ['liquid-proposals'], queryFn: api.liquidProposals, ...live });
  const drafts = useQuery({ queryKey: ['liquid-drafts'], queryFn: api.ontologyDrafts, ...live });
  const apps = useQuery({ queryKey: ['liquid-apps'], queryFn: api.liquidApps, ...live });
  const lake = useQuery({ queryKey: ['liquid-lake'], queryFn: api.liquidLake, ...live });
  const gateway = useQuery({ queryKey: ['gateway'], queryFn: api.gateway, ...live });
  const events = useQuery({ queryKey: ['liquid-tutorial-events', run?.startedAt], queryFn: () => api.liquidEvents({ since: run!.startedAt, limit: '500' }), ...live });

  const ctx: Ctx = {
    run,
    me: me.data?.user.upn ?? '',
    ontology: ontology.data,
    policy: policy.data,
    inbox: inbox.data,
    processes: processes.data,
    runs: runs.data,
    proposals: proposals.data,
    drafts: drafts.data,
    apps: apps.data,
    lake: lake.data,
    gateway: gateway.data,
    events: events.data?.events,
  };
  const allSteps = CHAPTERS.flatMap((c) => c.steps);
  const doneCount = allSteps.filter((s) => stepState(s, ctx) === 'done').length;
  // the first chapter with work left opens; decided once the live state is loaded (sections keep their own state)
  const ready = !run || (!!events.data && !!proposals.data && !!runs.data);
  const firstOpen = CHAPTERS.findIndex((ch) => ch.steps.some((s) => stepState(s, ctx) !== 'done'));
  const [openAt, setOpenAt] = useState<number>();
  useEffect(() => {
    if (openAt === undefined && ready) setOpenAt(Math.max(0, firstOpen));
  }, [openAt, ready, firstOpen]);

  const act = useMutation({
    mutationFn: async (a: ActionId): Promise<Result> => {
      const order = { supplierId: 'S-NORDHOLZ', sku: 'BEAM-PINE-80', quantity: 2000 };
      switch (a) {
        case 'prepare': {
          const p = await api.tutorialPrepare();
          const o = await api.liquidOntology();
          setRun({ startedAt: p.startedAt, startSeq: p.startSeq, startVersion: o.version, suggestedClass: freeClassName(o.classes.map((c) => c.name)), purchaseOrders: p.purchaseOrders, manual: {} });
          return { severity: 'success', text: `Demo world ready: ${p.purchaseOrders.join(', ')} placed${p.cleaned.length ? `; cleaned up: ${p.cleaned.join(', ')}` : ''}.` };
        }
        case 'agent-cancel':
          return describe(await api.tutorialAction('cancel_purchase_order', { poId: run!.purchaseOrders[0], reason: 'Tutorial: the supplier cannot deliver in time' }));
        case 'create-order':
          return describe(await api.tutorialAction('create_purchase_order', order));
        case 'classify':
        case 'dd-order': {
          // chapter 7: a material and supplier without a statement (timber from Nordholz on a first run)
          const { candidate: c, covered } = await api.tutorialDueDiligence();
          if (!c) return { severity: 'info', text: `Every supplier of the demo materials already has a statement (${covered.join(', ')}), so a new order would be released at once. The rule still refuses direct releases. A fresh install starts over.` };
          if (a === 'classify') {
            const r = await api.tutorialAction('set_commodity_risk', { sku: c.sku, commodityRisk: 'high' });
            if (r.ok) setRun({ ...run!, ddSku: c.sku, ddSupplier: c.supplier });
            return describe(r);
          }
          const r = await api.tutorialAction('create_purchase_order', { supplierId: c.supplier, sku: c.sku, quantity: c.quantity });
          if (r.ok) {
            const poId = (JSON.parse(r.result ?? '{}') as { id?: string }).id;
            if (poId) setRun({ ...run!, ddOrder: poId, ddSupplier: c.supplier, ddSku: c.sku });
          }
          return describe(r);
        }
        case 'propose-dd': {
          try {
            const p = await api.tutorialProposeDueDiligence();
            const sr = p.shadowReplay;
            return { severity: p.validation.ok ? 'success' : 'warning', text: `Proposed: ${p.title}. Validation ${p.validation.ok ? 'passed' : 'failed'}${p.compat ? ` (${p.compat.level})` : ''}.${sr ? ` Evidence: ${sr.blocked} of ${sr.total} releases of the last week (${sr.share} %) would have waited for a statement.` : ''}` };
          } catch (err) {
            if (/already live/.test(String(err))) return { severity: 'info', text: 'The rule is already live (an earlier run merged it). Continue with the next steps.' };
            throw err;
          }
        }
      }
    },
    onMutate: (a) => setBusy(a),
    onSuccess: (r, a) => setResults((x) => ({ ...x, [a]: r })),
    onError: (err, a) => setResults((x) => ({ ...x, [a]: { severity: 'error', text: String((err as Error).message ?? err) } })),
    onSettled: () => {
      setBusy(undefined);
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('liquid') });
    },
  });

  return (
    <>
      <PageHeader
        overline="Liquid enterprise"
        title="Tutorial"
        subtitle="Seven short chapters, each one a core value: you own the data, meaning in one place, rules as code, holdable processes, change through review, automatic containment, a requirement end to end"
        actions={
          run ? (
            <Button variant="outlined" onClick={() => setConfirmRestart(true)}>
              Restart
            </Button>
          ) : undefined
        }
      />
      <Stack spacing={2}>
        <Card variant="outlined">
          <CardContent>
            <Stack spacing={1}>
              <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  {run ? `${doneCount} of ${allSteps.length} steps done` : 'Not started'}
                </Typography>
                {run && (
                  <Typography variant="body2" color="text.secondary">
                    started {new Date(run.startedAt).toLocaleString()} · ontology {run.startVersion} at the start
                  </Typography>
                )}
              </Stack>
              <LinearProgress variant="determinate" value={(doneCount / allSteps.length) * 100} />
              <Typography variant="body2" color="text.secondary">
                About 30 minutes for chapters 1–6 and 15 more for chapter 7. Each step tells you where to go. The step ticks itself once the platform shows that it happened, so leave this tab open, or come back to it. You need the demo data (installed with <em>Seed the sofa-company demo data</em>). No model and no API key are needed, except for the optional agent in chapter 7.
              </Typography>
            </Stack>
          </CardContent>
        </Card>
        <ErrorAlert error={ontology.error} title="The enterprise core does not answer" />
        {openAt !== undefined &&
          CHAPTERS.map((ch, i) => (
          <ChapterView key={ch.id} ch={ch} ctx={ctx} open={i === openAt} run={run} onRun={(a) => act.mutate(a)} busy={busy} results={results} onManual={(id, v) => run && setRun({ ...run, manual: { ...run.manual, [id]: v } })} />
        ))}
        {run && (
          <Card variant="outlined">
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                What you did
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Everything since the start of the tutorial is in one log: your console actions, Lara’s request, the policy decisions, the playbook’s steps, the ontology versions and the business events. Nothing here was written anywhere else first.
              </Typography>
              <Box>
                <Button size="small" onClick={() => navigate(`/liquid/events?since=${encodeURIComponent(run.startedAt)}`)}>
                  Open the event log since the start
                </Button>
              </Box>
            </CardContent>
          </Card>
        )}
      </Stack>
      <ConfirmDialog
        open={confirmRestart}
        title="Restart the tutorial?"
        text="The tutorial forgets its progress in this browser. Prepare the demo world again to start from a clean company. Changes you merged (ontology versions) stay: they are history."
        confirmLabel="Restart"
        onConfirm={() => {
          setRun(undefined);
          setResults({});
          setOpenAt(0);
          setConfirmRestart(false);
        }}
        onClose={() => setConfirmRestart(false)}
      />
    </>
  );
}
