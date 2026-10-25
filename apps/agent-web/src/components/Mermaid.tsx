import { useEffect, useId, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useColorScheme } from '@mui/material/styles';
import { Loading } from '@cw/ui';

let mermaidSeq = 0;

/** Renders Mermaid source to SVG (securityLevel strict: no HTML labels, no click handlers, sanitized output). */
export function MermaidDiagram({ code }: { code: string }) {
  const { mode, systemMode } = useColorScheme();
  const dark = (mode === 'system' ? systemMode : mode) === 'dark';
  const base = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', fontFamily: 'Roboto, sans-serif' });
        const { svg: out } = await mermaid.render(`mmd-${base}-${++mermaidSeq}`, code);
        if (!cancelled) {
          setSvg(out);
          setError(undefined);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, dark, base]);
  if (error)
    return (
      <Alert severity="warning" sx={{ my: 1 }}>
        <Typography variant="subtitle2">The diagram could not be rendered</Typography>
        <Box component="pre" sx={{ m: 0, mt: 1, whiteSpace: 'pre-wrap', fontSize: 12 }}>
          {error.slice(0, 600)}
        </Box>
      </Alert>
    );
  if (!svg) return <Loading />;
  return <Box sx={{ my: 1, overflow: 'auto', '& svg': { maxWidth: '100%', height: 'auto' } }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

