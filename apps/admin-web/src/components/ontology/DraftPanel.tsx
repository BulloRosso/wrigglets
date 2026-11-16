import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { OntologyIr } from '@cw/ontology-ir/browser';
import type { DraftValidation, OntologyDraft } from '../../api';
import { CHANGE_COLOR } from './ClassNode';

/*
 * Side panel of the ontology editor in draft mode (E2): typed operations (add class, attribute, enum value, annotation),
 * the validation result of the compiler with errors, the changes against the base revision, and "Submit as proposal".
 * Links are added by dragging from one class to another on the canvas.
 */

type Op = Record<string, unknown> & { op: string };
const SCALARS = ['string', 'integer', 'float', 'boolean', 'date', 'datetime'];

export function DraftPanel(props: {
  draft: OntologyDraft;
  ir: OntologyIr;
  validation?: DraftValidation;
  selected?: string;
  busy: boolean;
  error?: unknown;
  onOps: (ops: Op[]) => void;
  onSubmit: (title: string, reason: string, migrationNote?: string) => void;
  onDiscard: () => void;
}) {
  const { draft, ir, validation, selected, busy, onOps } = props;
  const [cls, setCls] = useState({ name: '', description: '', owner: 'head-of-logistics', criticality: 'normal', data_class: 'internal' });
  const [attr, setAttr] = useState({ name: '', range: 'string', required: false });
  const [ev, setEv] = useState({ enum: ir.enums[0]?.name ?? '', value: '' });
  const [sub, setSub] = useState({ title: '', reason: '', note: '' });
  const compat = validation?.compat;
  const major = compat?.level === 'major';
  const ranges = [...SCALARS, ...ir.enums.map((e) => e.name), ...ir.classes.map((c) => c.name)];
  const sel = selected ? ir.classes.find((c) => c.name === selected) : undefined;
  const submitted = !!draft.proposal;

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="overline" color="text.secondary">
          Draft {draft.id}
        </Typography>
        <Typography variant="body2">
          Based on <code>{draft.base.slice(0, 12)}</code> · {draft.ops.length} change(s)
        </Typography>
      </Box>
      {submitted && <Alert severity="success">Submitted as proposal {draft.proposal}. It is applied after the owners approve it (Liquid enterprise → Proposals).</Alert>}
      {validation && (validation.ok ? <Alert severity="success">Compiles: {validation.ir?.classes.length} classes, {validation.ir?.actions.length} actions.</Alert> : <Alert severity="error">Does not compile: {validation.errors.map((e) => `${e.path}: ${e.message}`).join(' · ')}</Alert>)}
      {compat && compat.findings.length > 0 && (
        <Alert severity={major ? 'warning' : 'info'} icon={false}>
          <Stack spacing={0.75}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Chip size="small" color={major ? 'error' : compat.level === 'minor' ? 'primary' : 'default'} label={`${compat.level}${major ? ' (breaking)' : ''}`} />
              <Typography variant="body2">compatibility · version {validation?.ir?.version}</Typography>
            </Stack>
            {!compat.versionOk && (
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Typography variant="caption">A {compat.level} change needs version {compat.suggestedVersion}.</Typography>
                <Button size="small" disabled={busy || submitted} onClick={() => onOps([{ op: 'set_version', version: compat.suggestedVersion }])}>
                  Set {compat.suggestedVersion}
                </Button>
              </Stack>
            )}
            {major && (
              <Typography variant="caption">
                Breaking: {compat.findings.filter((f) => f.level === 'major').map((f) => `${f.path} (${f.reason})`).join('; ')}. A migration note is required; the projection is rebuilt from the events.
              </Typography>
            )}
          </Stack>
        </Alert>
      )}
      {props.error ? <Alert severity="error">{(props.error as Error).message}</Alert> : null}
      {validation?.diff && validation.diff.changes.length > 0 && (
        <Stack spacing={0.5}>
          <Typography variant="subtitle2">Changes</Typography>
          {validation.diff.changes.map((c, i) => (
            <Stack key={i} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Chip size="small" label={c.kind} sx={{ bgcolor: CHANGE_COLOR[c.kind], color: 'common.white', height: 20 }} />
              <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                {c.element} {c.path}
              </Typography>
            </Stack>
          ))}
        </Stack>
      )}
      {!submitted && (
        <>
          <Divider />
          {sel ? (
            <Stack spacing={1}>
              <Typography variant="subtitle2">Add attribute to {sel.name}</Typography>
              <TextField size="small" label="Name (snake_case)" value={attr.name} onChange={(e) => setAttr({ ...attr, name: e.target.value })} />
              <TextField size="small" select label="Range" value={attr.range} onChange={(e) => setAttr({ ...attr, range: e.target.value })}>
                {ranges.map((r) => (
                  <MenuItem key={r} value={r}>
                    {r}
                  </MenuItem>
                ))}
              </TextField>
              <FormControlLabel control={<Switch checked={attr.required} onChange={(e) => setAttr({ ...attr, required: e.target.checked })} />} label="required" />
              <Button disabled={busy || !attr.name} onClick={() => onOps([{ op: 'add_attribute', class: sel.name, name: attr.name, range: attr.range, required: attr.required || undefined }])}>
                Add attribute
              </Button>
              <TextField size="small" select label="Criticality" value={sel.annotations.criticality} onChange={(e) => onOps([{ op: 'set_annotation', class: sel.name, key: 'criticality', value: e.target.value }])}>
                {['normal', 'business_critical', 'payment_critical'].map((x) => (
                  <MenuItem key={x} value={x}>
                    {x}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Select a class to add attributes or change its criticality. Drag from the blue dot of one class to another to add a link.
            </Typography>
          )}
          <Divider />
          <Stack spacing={1}>
            <Typography variant="subtitle2">Add class</Typography>
            <TextField size="small" label="Name (PascalCase)" value={cls.name} onChange={(e) => setCls({ ...cls, name: e.target.value })} />
            <TextField size="small" label="Description" value={cls.description} onChange={(e) => setCls({ ...cls, description: e.target.value })} />
            <Stack direction="row" spacing={1}>
              <TextField size="small" label="Owner" value={cls.owner} onChange={(e) => setCls({ ...cls, owner: e.target.value })} sx={{ flex: 1 }} />
              <TextField size="small" select label="Data class" value={cls.data_class} onChange={(e) => setCls({ ...cls, data_class: e.target.value })} sx={{ flex: 1 }}>
                {['public', 'internal', 'confidential'].map((x) => (
                  <MenuItem key={x} value={x}>
                    {x}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
            <Button disabled={busy || !cls.name} onClick={() => onOps([{ op: 'add_class', name: cls.name, description: cls.description || undefined, identifier: 'id', annotations: { criticality: cls.criticality, data_class: cls.data_class, owner: cls.owner } }])}>
              Add class
            </Button>
          </Stack>
          <Divider />
          <Stack spacing={1}>
            <Typography variant="subtitle2">Add enum value</Typography>
            <Stack direction="row" spacing={1}>
              <TextField size="small" select label="Enum" value={ev.enum} onChange={(e) => setEv({ ...ev, enum: e.target.value })} sx={{ flex: 1 }}>
                {ir.enums.map((x) => (
                  <MenuItem key={x.name} value={x.name}>
                    {x.name}
                  </MenuItem>
                ))}
              </TextField>
              <TextField size="small" label="Value" value={ev.value} onChange={(e) => setEv({ ...ev, value: e.target.value })} sx={{ flex: 1 }} />
            </Stack>
            <Button disabled={busy || !ev.value} onClick={() => onOps([{ op: 'add_enum_value', enum: ev.enum, value: ev.value }])}>
              Add value
            </Button>
          </Stack>
          <Divider />
          <Stack spacing={1}>
            <Typography variant="subtitle2">Submit as proposal</Typography>
            <TextField size="small" label="Title" value={sub.title} onChange={(e) => setSub({ ...sub, title: e.target.value })} />
            <TextField size="small" label="Reason" multiline minRows={2} value={sub.reason} onChange={(e) => setSub({ ...sub, reason: e.target.value })} />
            {major && <TextField size="small" label="Migration note (required for a breaking change)" multiline minRows={2} value={sub.note} onChange={(e) => setSub({ ...sub, note: e.target.value })} />}
            <Stack direction="row" spacing={1}>
              <Button variant="contained" disabled={busy || !draft.ops.length || !validation?.ok || !compat?.versionOk || (major && sub.note.length < 3) || sub.title.length < 3 || sub.reason.length < 3} onClick={() => props.onSubmit(sub.title, sub.reason, sub.note || undefined)}>
                Submit
              </Button>
              <Button color="error" disabled={busy} onClick={props.onDiscard}>
                Discard draft
              </Button>
            </Stack>
          </Stack>
        </>
      )}
    </Stack>
  );
}
