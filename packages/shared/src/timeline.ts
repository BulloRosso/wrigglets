export type SpanCategory =
  | 'plan'
  | 'run'
  | 'fix'
  | 'verify'
  | 'finalize'
  | 'upload'
  | 'maintenance'
  | 'wait-lock'
  | 'wait-approval';

export type MarkerCategory =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'revise'
  | 'comment'
  | 'cancelled'
  | 'reminder'
  | 'completed'
  | 'failed';

export interface TimelineSpan {
  type: 'span';
  lane: string;
  id: string;
  category: SpanCategory;
  label: string;
  start: string;
  end?: string;
  status: 'running' | 'ok' | 'failed' | 'retried';
  attempt?: number;
  details?: { summary?: string; commit?: string; tokens?: number; artifacts?: string[]; error?: string };
}

export interface TimelineMarker {
  type: 'marker';
  lane: string;
  id: string;
  category: MarkerCategory;
  label: string;
  at: string;
  by?: { upn: string; name: string };
  text?: string;
}

export type TimelineItem = TimelineSpan | TimelineMarker;

export interface TimelineLane {
  id: string;
  label: string;
  kind: 'task' | 'agent' | 'schedule';
  status?: string;
}

export interface Timeline {
  lanes: TimelineLane[];
  items: TimelineItem[];
}
