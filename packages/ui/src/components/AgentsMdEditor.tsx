import { useEffect, useRef, useState } from 'react';
import { useTheme } from '@mui/material/styles';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { ErrorAlert, Loading } from './common';

/*
 * Monaco editor for the agent's AGENTS.md (standing instructions). Monaco is loaded on demand and bundled locally
 * (no CDN), with only the editor core and Markdown highlighting. The host app supplies load/save, so the same
 * component serves agent-web (own API) and admin-web (proxied through the admin server).
 */

type Monaco = typeof import('monaco-editor/esm/vs/editor/editor.api');
let monacoPromise: Promise<Monaco> | undefined;

function loadMonaco(): Promise<Monaco> {
  monacoPromise ??= (async () => {
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker: () => new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), { type: 'module' }),
    };
    await import('monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution');
    return import('monaco-editor/esm/vs/editor/editor.api');
  })();
  return monacoPromise;
}

export interface AgentsMdEditorProps {
  load: () => Promise<string>;
  save: (content: string) => Promise<unknown>;
}

export function AgentsMdEditor({ load, save }: AgentsMdEditorProps) {
  const theme = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<import('monaco-editor/esm/vs/editor/editor.api').editor.IStandaloneCodeEditor>(undefined);
  const monaco = useRef<Monaco>(undefined);
  const saved = useRef('');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    let disposed = false;
    Promise.all([loadMonaco(), load()])
      .then(([m, text]) => {
        if (disposed || !host.current) return;
        monaco.current = m;
        saved.current = text;
        const ed = m.editor.create(host.current, {
          value: text,
          language: 'markdown',
          theme: theme.palette.mode === 'dark' ? 'vs-dark' : 'vs',
          automaticLayout: true,
          wordWrap: 'on',
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 13,
        });
        editor.current = ed;
        ed.onDidChangeModelContent(() => {
          setDirty(ed.getValue() !== saved.current);
          setJustSaved(false);
        });
        setState('ready');
      })
      .catch((e: unknown) => {
        if (disposed) return;
        setError(e);
        setState('error');
      });
    return () => {
      disposed = true;
      editor.current?.dispose();
      editor.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per mount
  }, []);

  useEffect(() => {
    monaco.current?.editor.setTheme(theme.palette.mode === 'dark' ? 'vs-dark' : 'vs');
  }, [theme.palette.mode]);

  const doSave = async () => {
    const ed = editor.current;
    if (!ed) return;
    const value = ed.getValue();
    setSaving(true);
    setError(undefined);
    try {
      await save(value);
      saved.current = value;
      setDirty(false);
      setJustSaved(true);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">
        Standing instructions for the agent. Saving commits the change to the workspace with you as author; it applies to the next task.
      </Typography>
      {state === 'loading' && <Loading />}
      <ErrorAlert error={error} />
      <Box ref={host} sx={{ height: '60vh', border: 1, borderColor: 'divider', borderRadius: 1, display: state === 'ready' ? 'block' : 'none' }} />
      {state === 'ready' && (
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end', alignItems: 'center' }}>
          {justSaved && (
            <Typography variant="body2" color="success.main">
              Saved and committed.
            </Typography>
          )}
          <Button disabled={!dirty || saving} onClick={() => editor.current?.setValue(saved.current)}>
            Discard changes
          </Button>
          <Button variant="contained" disabled={!dirty || saving} onClick={() => void doSave()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </Stack>
      )}
    </Stack>
  );
}
