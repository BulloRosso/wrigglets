export function formatBytes(n?: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatNumber(n?: number): string {
  if (n === undefined || n === null) return '–';
  return new Intl.NumberFormat('en').format(n);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60 ? `${s % 60} s` : ''}`.trim();
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60 ? `${m % 60} min` : ''}`.trim();
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export function formatRelative(iso?: string, now = Date.now()): string {
  if (!iso) return '–';
  const diff = now - Date.parse(iso);
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const sign = diff >= 0 ? -1 : 1;
  if (abs < 45_000) return diff >= 0 ? 'just now' : 'in a moment';
  if (abs < 3_600_000) return rtf.format(sign * Math.round(abs / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(sign * Math.round(abs / 3_600_000), 'hour');
  if (abs < 30 * 86_400_000) return rtf.format(sign * Math.round(abs / 86_400_000), 'day');
  return new Date(iso).toLocaleDateString('en-GB');
}

export const formatDateTime = (iso?: string) => (iso ? new Date(iso).toLocaleString('en-GB') : '–');
