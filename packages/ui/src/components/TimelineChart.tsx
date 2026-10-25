import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { MarkerCategory, SpanCategory, Timeline, TimelineItem, TimelineMarker, TimelineSpan } from '@cw/shared';
import { formatDateTime, formatDuration } from '../format';

/*
 * Activity timeline (spec §10/§11): swimlanes per task over time, rendered as plain SVG.
 * Spans = activities and waits, markers = human decisions and lifecycle events.
 */

export const SPAN_COLORS: Record<SpanCategory, string> = {
  plan: '#7e57c2',
  run: '#1e88e5',
  fix: '#fb8c00',
  verify: '#00897b',
  finalize: '#43a047',
  upload: '#5c6bc0',
  maintenance: '#78909c',
  'wait-lock': '#9e9e9e',
  'wait-approval': '#f9a825',
};

export const MARKER_COLORS: Record<MarkerCategory, string> = {
  requested: '#1e88e5',
  approved: '#2e7d32',
  rejected: '#d32f2f',
  revise: '#ef6c00',
  comment: '#757575',
  cancelled: '#616161',
  reminder: '#f9a825',
  completed: '#2e7d32',
  failed: '#d32f2f',
};

const SPAN_LABEL: Record<SpanCategory, string> = {
  plan: 'Plan',
  run: 'Run',
  fix: 'Fix',
  verify: 'Verify',
  finalize: 'Finalize',
  upload: 'Upload',
  maintenance: 'Maintenance',
  'wait-lock': 'Waiting for workspace',
  'wait-approval': 'Waiting for approval',
};

const TICKS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 86_400_000, 2 * 86_400_000, 7 * 86_400_000];
const LANE_H = 34;
const AXIS_H = 26;

export interface TimelineChartProps {
  timeline: Timeline;
  from?: string;
  to?: string;
  onLaneClick?: (laneId: string) => void;
  showLegend?: boolean;
  labelWidth?: number;
}

const isSpan = (i: TimelineItem): i is TimelineSpan => i.type === 'span';

export function TimelineChart({ timeline, from, to, onLaneClick, showLegend = true, labelWidth = 200 }: TimelineChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, e!.contentRect.width)));
    ro.observe(el);
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => {
      ro.disconnect();
      clearInterval(t);
    };
  }, []);

  const { t0, t1 } = useMemo(() => {
    const times = timeline.items.flatMap((i) => (isSpan(i) ? [Date.parse(i.start), i.end ? Date.parse(i.end) : now] : [Date.parse((i as TimelineMarker).at)]));
    let a = from ? Date.parse(from) : Math.min(...times, now - 60_000);
    let b = to ? Date.parse(to) : Math.max(...times, a + 60_000);
    if (!Number.isFinite(a)) a = now - 3_600_000;
    if (!Number.isFinite(b) || b <= a) b = a + 60_000;
    const pad = (b - a) * 0.03;
    return { t0: from ? a : a - pad, t1: to ? b : b + pad };
  }, [timeline, from, to, now]);

  const lw = width < 600 ? Math.min(labelWidth, 110) : labelWidth;
  const plotW = Math.max(100, width - lw - 8);
  const x = (t: number) => lw + ((t - t0) / (t1 - t0)) * plotW;
  const lanes = timeline.lanes;
  const laneIndex = new Map(lanes.map((l, i) => [l.id, i]));
  const height = AXIS_H + lanes.length * LANE_H + 4;
  const tickStep = TICKS.find((s) => (t1 - t0) / s <= Math.max(3, Math.floor(plotW / 110))) ?? TICKS[TICKS.length - 1]!;
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / tickStep) * tickStep; t <= t1; t += tickStep) ticks.push(t);
  const multiDay = t1 - t0 > 86_400_000;
  const tickLabel = (t: number) =>
    new Date(t).toLocaleString(undefined, multiDay ? { month: 'short', day: 'numeric', hour: tickStep < 86_400_000 ? '2-digit' : undefined } : { hour: '2-digit', minute: '2-digit' });

  return (
    <Box ref={ref} sx={{ width: '100%', overflow: 'hidden' }}>
      <svg width={width} height={height} role="img" aria-label="Activity timeline" style={{ display: 'block', fontFamily: 'inherit' }}>
        <defs>
          <pattern id="cw-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="2" opacity="0.35" />
          </pattern>
        </defs>
        {/* lanes */}
        {lanes.map((l, i) => (
          <g key={l.id} transform={`translate(0, ${AXIS_H + i * LANE_H})`} style={{ cursor: onLaneClick && l.kind === 'task' ? 'pointer' : undefined }} onClick={() => l.kind === 'task' && onLaneClick?.(l.id)}>
            <rect x={0} y={0} width={width} height={LANE_H} fill={i % 2 ? 'var(--mui-palette-action-hover)' : 'transparent'} />
            <title>{l.label}</title>
            <text x={8} y={LANE_H / 2 + 4} fontSize={12} fill={l.kind === 'agent' ? 'var(--mui-palette-primary-main)' : 'var(--mui-palette-text-primary)'} fontWeight={l.kind === 'agent' ? 600 : 400}>
              {truncate(l.label, Math.floor(lw / 7))}
            </text>
          </g>
        ))}
        {/* grid + axis */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={AXIS_H - 4} y2={height} stroke="var(--mui-palette-divider)" />
            <text x={x(t) + 3} y={14} fontSize={11} fill="var(--mui-palette-text-secondary)">
              {tickLabel(t)}
            </text>
          </g>
        ))}
        <line x1={lw} x2={lw} y1={0} y2={height} stroke="var(--mui-palette-divider)" />
        {now >= t0 && now <= t1 && (
          <g>
            <line x1={x(now)} x2={x(now)} y1={AXIS_H - 6} y2={height} stroke="var(--mui-palette-error-main)" strokeDasharray="3 3" />
            <text x={x(now) + 3} y={AXIS_H - 2} fontSize={10} fill="var(--mui-palette-error-main)">
              now
            </text>
          </g>
        )}
        {/* spans */}
        {timeline.items.filter(isSpan).map((s) => {
          const row = laneIndex.get(s.lane);
          if (row === undefined) return null;
          const start = Math.max(Date.parse(s.start), t0);
          const end = Math.min(s.end ? Date.parse(s.end) : now, t1);
          if (end < t0 || start > t1) return null;
          const wait = s.category.startsWith('wait');
          const color = SPAN_COLORS[s.category];
          const y = AXIS_H + row * LANE_H + (wait ? 12 : 7);
          const h = wait ? LANE_H - 24 : LANE_H - 14;
          const w = Math.max(3, x(end) - x(start));
          const duration = (s.end ? Date.parse(s.end) : now) - Date.parse(s.start);
          return (
            <Tooltip
              key={s.id}
              title={
                <Box sx={{ maxWidth: 360 }}>
                  <strong>{SPAN_LABEL[s.category]}</strong> · {s.label}
                  <br />
                  {formatDateTime(s.start)} · {s.end ? formatDuration(duration) : `running for ${formatDuration(duration)}`}
                  {s.attempt && s.attempt > 1 ? ` · attempt ${s.attempt}` : ''}
                  {s.details?.tokens ? ` · ${s.details.tokens.toLocaleString()} tokens` : ''}
                  {s.details?.commit ? (
                    <>
                      <br />
                      commit {s.details.commit.slice(0, 10)}
                    </>
                  ) : null}
                  {s.details?.summary ? (
                    <>
                      <br />
                      {truncate(s.details.summary, 240)}
                    </>
                  ) : null}
                  {s.details?.error ? (
                    <>
                      <br />
                      Error: {truncate(s.details.error, 200)}
                    </>
                  ) : null}
                </Box>
              }
            >
              <g style={{ color }}>
                <rect
                  x={x(start)}
                  y={y}
                  width={w}
                  height={h}
                  rx={4}
                  fill={wait ? 'url(#cw-hatch)' : color}
                  fillOpacity={wait ? 1 : s.status === 'running' ? 0.55 : 0.9}
                  stroke={s.status === 'failed' ? 'var(--mui-palette-error-main)' : color}
                  strokeWidth={s.status === 'failed' ? 2 : 1}
                  strokeDasharray={wait || s.status === 'retried' ? '4 3' : undefined}
                >
                  {s.status === 'running' && <animate attributeName="fill-opacity" values="0.35;0.8;0.35" dur="2s" repeatCount="indefinite" />}
                </rect>
                {!wait && w > 44 && (
                  <text x={x(start) + 6} y={y + h / 2 + 4} fontSize={11} fill="#fff" pointerEvents="none">
                    {truncate(SPAN_LABEL[s.category], Math.floor(w / 7))}
                  </text>
                )}
              </g>
            </Tooltip>
          );
        })}
        {/* markers */}
        {timeline.items
          .filter((i): i is TimelineMarker => i.type === 'marker')
          .map((m) => {
            const row = laneIndex.get(m.lane);
            const t = Date.parse(m.at);
            if (row === undefined || t < t0 || t > t1) return null;
            const cx = x(t);
            const cy = AXIS_H + row * LANE_H + LANE_H / 2;
            const color = MARKER_COLORS[m.category];
            return (
              <Tooltip
                key={m.id}
                title={
                  <Box sx={{ maxWidth: 360 }}>
                    <strong>{m.label}</strong>
                    {m.by ? ` · ${m.by.name || m.by.upn}` : ''}
                    <br />
                    {formatDateTime(m.at)}
                    {m.text ? (
                      <>
                        <br />“{truncate(m.text, 300)}”
                      </>
                    ) : null}
                  </Box>
                }
              >
                <g>
                  {m.category === 'approved' || m.category === 'rejected' || m.category === 'revise' ? (
                    <rect x={cx - 6} y={cy - 6} width={12} height={12} transform={`rotate(45 ${cx} ${cy})`} fill={color} stroke="var(--mui-palette-background-paper)" strokeWidth={2} />
                  ) : (
                    <circle cx={cx} cy={cy} r={m.category === 'comment' ? 4.5 : 6} fill={color} stroke="var(--mui-palette-background-paper)" strokeWidth={2} />
                  )}
                </g>
              </Tooltip>
            );
          })}
      </svg>
      {showLegend && <TimelineLegend />}
    </Box>
  );
}

export function TimelineLegend() {
  const spans: SpanCategory[] = ['plan', 'run', 'verify', 'fix', 'finalize', 'wait-lock', 'wait-approval'];
  const markers: Array<[MarkerCategory, string]> = [
    ['requested', 'Requested'],
    ['approved', 'Approved'],
    ['revise', 'Changes requested'],
    ['rejected', 'Rejected / failed'],
    ['comment', 'Comment'],
    ['completed', 'Completed'],
  ];
  return (
    <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 2, mt: 1.5, color: 'text.secondary' }}>
      {spans.map((c) => (
        <Stack key={c} direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
          <Box sx={{ width: 18, height: 10, borderRadius: 0.5, bgcolor: c.startsWith('wait') ? 'transparent' : SPAN_COLORS[c], border: c.startsWith('wait') ? `2px dashed ${SPAN_COLORS[c]}` : undefined }} />
          <Typography variant="caption">{SPAN_LABEL[c]}</Typography>
        </Stack>
      ))}
      {markers.map(([c, label]) => (
        <Stack key={c} direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
          <Box sx={{ width: 10, height: 10, borderRadius: c === 'approved' || c === 'revise' || c === 'rejected' ? 0.25 : '50%', transform: c === 'approved' || c === 'revise' || c === 'rejected' ? 'rotate(45deg)' : undefined, bgcolor: MARKER_COLORS[c] }} />
          <Typography variant="caption">{label}</Typography>
        </Stack>
      ))}
    </Stack>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s;
}
