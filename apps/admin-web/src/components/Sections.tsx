import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import Tab from '@mui/material/Tab';
import TablePagination from '@mui/material/TablePagination';
import Tabs from '@mui/material/Tabs';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import ExpandMoreOutlined from '@mui/icons-material/ExpandMoreOutlined';

/*
 * UI building blocks of the UI review (docs/review/user-interface.md):
 *   - the role view: "IT Engineer" (platform, security, configuration) or "Business Engineer" (business model,
 *     processes, approvals) filters navigation, tabs and sections; "All" shows everything. A preference per browser,
 *     not a permission: the server decides what a person may do.
 *   - SectionTabs: one level of tabs (optionally a second level), synced to ?tab= so every view has a link;
 *   - Section: a collapsible block with a one-line summary;
 *   - ProcessStepper: where a screen is a step of a sequential process, the steps and the current one.
 */

export type RoleView = 'it' | 'business' | 'all';
export const ROLE_LABEL: Record<RoleView, string> = {
  it: 'IT Engineer',
  business: 'Business Engineer',
  all: 'All',
};
const KEY = 'cw.roleView';

const isView = (v: unknown): v is RoleView => v === 'it' || v === 'business' || v === 'all';

/** ?role=it|business|all in the URL wins (links, screenshots) and is remembered; otherwise the stored choice. */
const read = (): RoleView => {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('role');
    if (isView(fromUrl)) {
      localStorage.setItem(KEY, fromUrl);
      return fromUrl;
    }
    const v = localStorage.getItem(KEY);
    return isView(v) ? v : 'all';
  } catch {
    return 'all';
  }
};

const Ctx = createContext<{ view: RoleView; setView: (v: RoleView) => void }>({
  view: 'all',
  setView: () => undefined,
});

export function RoleViewProvider({ children }: { children: ReactNode }) {
  const [view, setViewState] = useState<RoleView>(read);
  const setView = (v: RoleView) => {
    setViewState(v);
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
  };
  return <Ctx.Provider value={{ view, setView }}>{children}</Ctx.Provider>;
}

export const useRoleView = () => useContext(Ctx);

/** Shown for a role view? Items without roles are for everyone. */
export const forView = (view: RoleView, roles?: Array<'it' | 'business'>) => view === 'all' || !roles || roles.includes(view);

export function RoleViewSwitch() {
  const { view, setView } = useRoleView();
  return (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={view}
      onChange={(_, v: RoleView | null) => v && setView(v)}
      aria-label="Role view"
      sx={{
        display: { xs: 'none', md: 'inline-flex' },
        '& .MuiToggleButton-root': {
          py: 0.25,
          px: 1.25,
          textTransform: 'none',
        },
      }}
    >
      {(['it', 'business', 'all'] as const).map((v) => (
        <ToggleButton key={v} value={v}>
          {ROLE_LABEL[v]}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

export interface SectionTab {
  id: string;
  label: string;
  roles?: Array<'it' | 'business'>;
  /** A count or state next to the label (e.g. pending alerts). */
  badge?: string | number;
  badgeColor?: 'default' | 'error' | 'warning' | 'primary' | 'success';
  render?: () => ReactNode;
  /** Second level: shown as a row of options below the tab strip. */
  sub?: Array<{
    id: string;
    label: string;
    roles?: Array<'it' | 'business'>;
    render: () => ReactNode;
  }>;
}

/** Tabs synced to ?tab= (and ?sub=), filtered by the role view. */
export function SectionTabs({ tabs, param = 'tab' }: { tabs: SectionTab[]; param?: string }) {
  const { view } = useRoleView();
  const [params, setParams] = useSearchParams();
  const visible = tabs.filter((t) => forView(view, t.roles));
  const current = visible.find((t) => t.id === params.get(param)) ?? visible[0];
  const subs = (current?.sub ?? []).filter((s) => forView(view, s.roles));
  const sub = subs.find((s) => s.id === params.get(`${param}.sub`)) ?? subs[0];
  const go = (tab: string, s?: string) => {
    const next = new URLSearchParams(params);
    next.set(param, tab);
    if (s) next.set(`${param}.sub`, s);
    else next.delete(`${param}.sub`);
    setParams(next, { replace: true });
  };
  useEffect(() => {
    // a tab hidden by the role view: fall back to the first visible one
    if (current && params.get(param) && params.get(param) !== current.id) go(current.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  if (!current) return null;
  return (
    <>
      <Tabs
        value={current.id}
        onChange={(_, v: string) => go(v)}
        variant="scrollable"
        sx={{
          mb: subs.length ? 1.5 : 3,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        {visible.map((t) => (
          <Tab
            key={t.id}
            value={t.id}
            label={
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <span>{t.label}</span>
                {t.badge !== undefined && t.badge !== 0 && t.badge !== '' && <Chip size="small" color={t.badgeColor ?? 'default'} label={t.badge} sx={{ height: 20 }} />}
              </Stack>
            }
          />
        ))}
      </Tabs>
      {subs.length > 1 && (
        <Stack direction="row" spacing={1} useFlexGap sx={{ mb: 3, flexWrap: 'wrap' }}>
          {subs.map((s) => (
            <Chip key={s.id} label={s.label} color={s.id === sub?.id ? 'primary' : 'default'} variant={s.id === sub?.id ? 'filled' : 'outlined'} onClick={() => go(current.id, s.id)} />
          ))}
        </Stack>
      )}
      {sub ? sub.render() : current.render?.()}
    </>
  );
}

/** A block that can be folded away; the summary line stays visible. */
export function Section({ title, summary, defaultOpen = false, children }: { title: string; summary?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <Accordion defaultExpanded={defaultOpen} disableGutters variant="outlined" sx={{ borderRadius: 1, '&:before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
        <Stack sx={{ minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            {title}
          </Typography>
          {summary && (
            <Typography variant="body2" color="text.secondary" component="div">
              {summary}
            </Typography>
          )}
        </Stack>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>{children}</AccordionDetails>
    </Accordion>
  );
}

/** The steps of a sequential process and where this item stands; failed steps are marked. */
export function ProcessStepper({ steps, active, failed, caption }: { steps: string[]; active: number; failed?: number; caption?: ReactNode }) {
  return (
    <Box sx={{ mb: 3 }}>
      <Stepper activeStep={active} alternativeLabel>
        {steps.map((s, i) => (
          <Step key={s} completed={i < active}>
            <StepLabel error={failed === i}>{s}</StepLabel>
          </Step>
        ))}
      </Stepper>
      {caption && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, textAlign: 'center' }} component="div">
          {caption}
        </Typography>
      )}
    </Box>
  );
}

/** Client-side paging for long lists: the visible rows and a pager to render below them. */
export function usePaged<T>(rows: T[], size = 25) {
  const [page, setPage] = useState(0);
  const [perPage, setPerPage] = useState(size);
  const last = Math.max(0, Math.ceil(rows.length / perPage) - 1);
  const p = Math.min(page, last);
  const pager =
    rows.length > perPage ? (
      <TablePagination
        component="div"
        count={rows.length}
        page={p}
        onPageChange={(_, n) => setPage(n)}
        rowsPerPage={perPage}
        onRowsPerPageChange={(e) => {
          setPerPage(Number(e.target.value));
          setPage(0);
        }}
        rowsPerPageOptions={[size, size * 2, size * 4]}
      />
    ) : null;
  return { rows: rows.slice(p * perPage, (p + 1) * perPage), pager };
}
