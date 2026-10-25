import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ExpandMoreOutlined from '@mui/icons-material/ExpandMoreOutlined';
import AddTaskOutlined from '@mui/icons-material/AddTaskOutlined';
import type { ApprovalPolicy } from '@cw/shared';
import { AiProblemAlert, SpendMeter } from './Spend';
import { ErrorAlert } from '@cw/ui';
import { api, useAgentStatus } from '../api';

const TYPES = [
  { value: 'analysis', label: 'Analysis', help: 'Read and evaluate data; results go to reports/' },
  { value: 'report', label: 'Report', help: 'Produce a document in reports/' },
  { value: 'change', label: 'Change', help: 'Modify team data in the workspace' },
] as const;

export function NewTaskForm() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [type, setType] = useState<'analysis' | 'report' | 'change'>('report');
  const [approval, setApproval] = useState<ApprovalPolicy>('plan');
  const status = useAgentStatus();
  const spend = status.data?.spend;
  const blocked = !!spend && (!spend.ai.configured || spend.exceeded);

  const create = useMutation({
    mutationFn: () => api.createTask({ title, instructions, type, approval }),
    onSuccess: ({ taskId }) => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      navigate(`/tasks/${encodeURIComponent(taskId)}`);
    },
  });
  const valid = title.trim().length >= 3 && instructions.trim().length > 0;

  return (
    <Accordion expanded={expanded} onChange={(_, e) => setExpanded(e)} disableGutters sx={{ mb: 3 }}>
      <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
          <AddTaskOutlined color="primary" />
          <Typography variant="subtitle1">New task</Typography>
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack
          component="form"
          spacing={2.5}
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) create.mutate();
          }}
        >
          <TextField label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} slotProps={{ htmlInput: { maxLength: 120 } }} helperText="Short, e.g. “Compare the offers of November 2026”" />
          <TextField
            label="Instructions"
            required
            multiline
            minRows={4}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            slotProps={{ htmlInput: { maxLength: 20000 } }}
            helperText="What should be done, with which inputs, and what result you expect."
          />
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={3}>
            <TextField select label="Type" value={type} onChange={(e) => setType(e.target.value as typeof type)} sx={{ minWidth: 220 }} helperText={TYPES.find((t) => t.value === type)?.help}>
              {TYPES.map((t) => (
                <MenuItem key={t.value} value={t.value}>
                  {t.label}
                </MenuItem>
              ))}
            </TextField>
            <FormControl>
              <FormLabel id="approval-label">Approval</FormLabel>
              <RadioGroup row aria-labelledby="approval-label" value={approval} onChange={(e) => setApproval(e.target.value as ApprovalPolicy)}>
                <FormControlLabel value="plan" control={<Radio size="small" />} label="Approve plan first" />
                <FormControlLabel value="deviation" control={<Radio size="small" />} label="Only on deviations" />
                <FormControlLabel value="none" control={<Radio size="small" />} label="No approval" />
              </RadioGroup>
            </FormControl>
          </Stack>
          {spend && spend.ai.configured && <SpendMeter spend={spend} name={status.data?.displayName ?? 'The agent'} />}
          <AiProblemAlert spend={spend} />
          <ErrorAlert error={create.error} />
          <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
            <Button onClick={() => setExpanded(false)}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={!valid || create.isPending || blocked}>
              {create.isPending ? 'Submitting…' : 'Submit task'}
            </Button>
          </Stack>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
