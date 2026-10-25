/** Sanitized harness events streamed to the UI (`GET /api/tasks/:id/live`). */
export type LiveEvent =
  | { type: 'idle'; at: string }
  | { type: 'step'; at: string; stepId: string; kind: string; phase: 'started' | 'finished' }
  | { type: 'text'; at: string; partId: string; text: string; truncated: boolean }
  | { type: 'reasoning'; at: string; partId: string; text: string; truncated: boolean }
  | {
      type: 'tool';
      at: string;
      partId: string;
      tool: string;
      status: 'pending' | 'running' | 'completed' | 'error';
      title?: string;
      files?: string[];
      output?: string;
    }
  | { type: 'tokens'; at: string; input: number; output: number; cost?: number }
  | { type: 'error'; at: string; message: string };

export const LIVE_EVENT_MAX_TEXT = 2048;
