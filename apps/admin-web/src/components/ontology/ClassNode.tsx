import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import KeyOutlined from '@mui/icons-material/KeyOutlined';
import LockOutlined from '@mui/icons-material/LockOutlined';
import type { GraphNode } from '@cw/ontology-ir';
import { NODE_WIDTH } from './layout';

/* One ontology class on the canvas: name, criticality, data class, scalar/enum fields and its actions. */

export const CRITICALITY_COLOR = { payment_critical: 'error', business_critical: 'warning', normal: 'default' } as const;
export type ClassNodeData = { [K in keyof GraphNode]: GraphNode[K] } & { dimmed: boolean; selected: boolean };
export type ClassFlowNode = Node<ClassNodeData, 'class'>;

function ClassNodeView({ data }: NodeProps<ClassFlowNode>) {
  const writes = data.actions.filter((a) => !a.readOnly).length;
  return (
    <Box
      sx={{
        width: NODE_WIDTH,
        bgcolor: 'background.paper',
        border: 2,
        borderColor: data.selected ? 'primary.main' : data.criticality === 'payment_critical' ? 'error.light' : data.criticality === 'business_critical' ? 'warning.light' : 'divider',
        borderRadius: 2,
        boxShadow: data.selected ? 4 : 1,
        opacity: data.dimmed ? 0.25 : 1,
        transition: 'opacity 120ms',
        overflow: 'hidden',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Stack direction="row" spacing={0.5} sx={{ px: 1.25, py: 0.75, bgcolor: 'action.hover', alignItems: 'center' }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, flex: 1, minWidth: 0 }} noWrap>
          {data.label}
        </Typography>
        {data.dataClass === 'confidential' && (
          <Tooltip title="data class: confidential">
            <LockOutlined sx={{ fontSize: 15, color: 'text.secondary' }} />
          </Tooltip>
        )}
        {data.criticality !== 'normal' && <Chip size="small" color={CRITICALITY_COLOR[data.criticality]} label={data.criticality === 'payment_critical' ? 'payment' : 'critical'} sx={{ height: 18, fontSize: 10 }} />}
      </Stack>
      <Box sx={{ px: 1.25, py: 0.5 }}>
        {data.fields.slice(0, 6).map((f) => (
          <Stack key={f.name} direction="row" spacing={0.5} sx={{ alignItems: 'center', height: 18 }}>
            {f.identifier ? <KeyOutlined sx={{ fontSize: 12, color: 'warning.main' }} /> : <Box sx={{ width: 12 }} />}
            <Typography variant="caption" sx={{ fontFamily: 'monospace', flex: 1, minWidth: 0, fontWeight: f.required ? 600 : 400 }} noWrap>
              {f.name}
            </Typography>
            <Typography variant="caption" sx={{ fontFamily: 'monospace', color: f.kind === 'enum' ? 'secondary.main' : 'text.secondary' }} noWrap>
              {f.range}
              {f.multivalued ? '[]' : ''}
            </Typography>
          </Stack>
        ))}
        {data.fields.length > 6 && (
          <Typography variant="caption" color="text.secondary">
            +{data.fields.length - 6} more
          </Typography>
        )}
      </Box>
      {data.actions.length > 0 && (
        <Stack direction="row" spacing={0.5} sx={{ px: 1.25, pb: 0.75 }}>
          <Chip size="small" variant="outlined" label={`${data.actions.length - writes} read`} sx={{ height: 18, fontSize: 10 }} />
          {writes > 0 && <Chip size="small" variant="outlined" color="primary" label={`${writes} write`} sx={{ height: 18, fontSize: 10 }} />}
          {!data.bound && <Chip size="small" variant="outlined" label="action-only" sx={{ height: 18, fontSize: 10 }} />}
        </Stack>
      )}
    </Box>
  );
}

export const ClassNode = memo(ClassNodeView);
