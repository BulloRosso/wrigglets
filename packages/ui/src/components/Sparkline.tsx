import Box from '@mui/material/Box';

/** Minimal SVG sparkline (area + line) for monitoring values such as CPU and memory. */
export function Sparkline({ values, max, height = 56, color = 'var(--mui-palette-primary-main)', label }: { values: number[]; max?: number; height?: number; color?: string; label?: string }) {
  const w = 240;
  const top = Math.max(max ?? Math.max(...values, 1), 1e-9);
  const n = Math.max(values.length, 2);
  const pts = values.map((v, i) => [(i / (n - 1)) * w, height - (Math.min(v, top) / top) * (height - 4) - 2] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = pts.length ? `${line} L${pts[pts.length - 1]![0].toFixed(1)},${height} L0,${height} Z` : '';
  return (
    <Box component="svg" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" role="img" aria-label={label} sx={{ width: '100%', height, display: 'block' }}>
      <line x1="0" x2={w} y1={height - 1} y2={height - 1} stroke="var(--mui-palette-divider)" />
      {pts.length > 1 && (
        <>
          <path d={area} fill={color} opacity={0.12} />
          <path d={line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </>
      )}
    </Box>
  );
}
